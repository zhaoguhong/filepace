import { useEffect, useRef, useState } from "react";
import { RefreshCw, Sparkles, Square } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { call, desktop } from "./bridge";
import { formatSize } from "./model";
import ResultFiles from "./ResultFiles";
import type { ResultActionProps } from "./resultActions";
import type {
  ScanCounts,
  StorageReport,
  StorageSnapshot,
} from "./storageTypes";

export type DiagnosisAgent = "codex" | "claude" | "opencode" | "deepseek";
export type DiagnosisGoal =
  "overview" | "cleanup" | "organize" | "understand" | "custom";
export type DiagnosisAgentInfo = {
  id: DiagnosisAgent;
  name: string;
  path: string | null;
  error: string | null;
  configurationError?: string | null;
  configuration?: {
    source: string;
    model: string | null;
    provider: string | null;
    profile: string | null;
    profiles: string[];
    note: string;
  } | null;
};
export type DiagnosisItem = {
  id: string;
  name: string;
  path: string;
  parent: string;
  size: number;
  files: number;
  isDir: boolean;
};
export type DiagnosisReport = {
  agent: DiagnosisAgent;
  goal: DiagnosisGoal;
  instructions: string;
  scanId: string;
  createdAt: number;
  summary: string;
  findings: {
    title: string;
    kind: "cleanup" | "organize" | "review";
    reason: string;
    suggestion: string;
    items: DiagnosisItem[];
  }[];
  limitations: string[];
};

const agentNames: Record<DiagnosisAgent, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  deepseek: "DeepSeek Harness",
};
const findingLabels = {
  cleanup: "清理候选",
  organize: "整理建议",
  review: "需要核查",
};
const goals: Record<DiagnosisGoal, { label: string; description: string }> = {
  overview: { label: "综合诊断", description: "了解占用，发现值得处理的项目" },
  cleanup: { label: "清理空间", description: "优先检查占用较大的清理候选" },
  organize: { label: "整理归档", description: "梳理分类、命名和归档方向" },
  understand: { label: "了解目录", description: "介绍目录构成与空间分布" },
  custom: { label: "自定义", description: "按你填写的方向分析" },
};
type DiagnosisRun = {
  id: string;
  scope: string;
  scanId: string;
  phase: "preparing" | "analyzing";
  cancelled: boolean;
  changeBaseline?: number;
};
export type DiagnosisStatus = {
  id: string;
  scope: string;
  phase: DiagnosisRun["phase"] | "complete" | "error" | "cancelled" | "empty";
  message?: string;
};
export type DiagnosisCallbacks = {
  onDiagnosisStatus?: (status: DiagnosisStatus) => void;
  onDiagnosisComplete?: (status: DiagnosisStatus) => void;
};
type DiagnosisRecord = {
  result?: DiagnosisReport | null;
  error?: string;
  message?: string;
  changeBaseline?: number;
};
const preferenceKey = "filepace-diagnosis";
type Preferences = {
  agent: DiagnosisAgent;
  paths: Partial<Record<DiagnosisAgent, string>>;
  profiles: Partial<Record<DiagnosisAgent, string>>;
};

function preferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? "null");
    const paths: Preferences["paths"] = {};
    const profiles: Preferences["profiles"] = {};
    for (const key of Object.keys(agentNames) as DiagnosisAgent[]) {
      if (typeof saved?.paths?.[key] === "string")
        paths[key] = saved.paths[key].slice(0, 4096);
      if (typeof saved?.profiles?.[key] === "string")
        profiles[key] = saved.profiles[key].slice(0, 100);
    }
    return {
      agent: Object.hasOwn(agentNames, saved?.agent) ? saved.agent : "codex",
      paths,
      profiles,
    };
  } catch {
    return { agent: "codex", paths: {}, profiles: {} };
  }
}

export default function StorageDiagnosis({
  visible,
  scopePath,
  report,
  scanId,
  scanBusy,
  scanStale,
  scanProgress,
  onPrepare,
  onCancelScan,
  onBrowse,
  onShowUsage,
  onFileAction,
  fileChanges,
  fileChangeBatches,
  resultsVisible = visible,
  changeBaseline,
  onDiagnosisStatus,
  onDiagnosisComplete,
}: ResultActionProps &
  DiagnosisCallbacks & {
    visible: boolean;
    scopePath: string;
    report: StorageReport | null;
    scanId: string;
    scanBusy: boolean;
    scanStale: boolean;
    scanProgress: ScanCounts | null;
    onPrepare: (
      id: string,
      refresh: boolean,
    ) => Promise<(StorageSnapshot & { changeBaseline?: number }) | null>;
    onCancelScan: (id: string) => Promise<void>;
    onBrowse: (path: string, selected?: string) => void;
    onShowUsage: () => void;
    resultsVisible?: boolean;
    changeBaseline?: number;
  }) {
  const [saved] = useState(preferences);
  const [agent, setAgent] = useState(saved.agent);
  const [goal, setGoal] = useState<DiagnosisGoal>("overview");
  const [instructions, setInstructions] = useState("");
  const [refresh, setRefresh] = useState(false);
  const [paths, setPaths] = useState(saved.paths);
  const [profiles, setProfiles] = useState(saved.profiles);
  const profilesRef = useRef(profiles);
  const autoSelected = useRef(false);
  const [selectionNotice, setSelectionNotice] = useState("");
  const [agents, setAgents] = useState<DiagnosisAgentInfo[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detectionError, setDetectionError] = useState("");
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<DiagnosisRun["phase"]>("preparing");
  const [stopping, setStopping] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [records, setRecords] = useState<Record<string, DiagnosisRecord>>({});
  const record = records[scopePath];
  const message = record?.message ?? "";
  const error = record?.error || detectionError;
  const result = record?.result ?? null;
  const request = useRef<DiagnosisRun | null>(null);
  const callbacks = useRef({ onDiagnosisStatus, onDiagnosisComplete });
  callbacks.current = { onDiagnosisStatus, onDiagnosisComplete };
  const detection = useRef(0);
  const pathsRef = useRef(paths);
  const tool = agents.find((item) => item.id === agent);
  const runningHere = running && request.current?.scope === scopePath;
  const noToolsDetected =
    desktop &&
    !detecting &&
    agents.length > 0 &&
    !agents.some((item) => item.path);
  const agentOptions = (
    Object.entries(agentNames) as [DiagnosisAgent, string][]
  )
    .map(([id, name]) => {
      const info = agents.find((item) => item.id === id);
      return {
        id,
        name,
        info,
        rank: !info?.path ? 2 : info.configurationError ? 1 : 0,
      };
    })
    .sort((a, b) => a.rank - b.rank);

  function updateRecord(scope: string, update: Partial<DiagnosisRecord>) {
    setRecords((previous) => {
      const next = { ...previous };
      const entry = { ...next[scope], ...update };
      delete next[scope];
      return Object.fromEntries(
        [...Object.entries(next), [scope, entry]].slice(-8),
      );
    });
  }
  function setMessage(message: string) {
    updateRecord(scopePath, { message });
  }
  function setError(error: string) {
    updateRecord(scopePath, { error });
  }
  function publish(
    current: DiagnosisRun,
    phase: DiagnosisStatus["phase"],
    message?: string,
  ) {
    const status = { id: current.id, scope: current.scope, phase, message };
    callbacks.current.onDiagnosisStatus?.(status);
    if (phase === "complete" || phase === "error" || phase === "empty")
      callbacks.current.onDiagnosisComplete?.(status);
  }

  async function detect() {
    if (!desktop) return;
    const revision = ++detection.current;
    setDetecting(true);
    setDetectionError("");
    try {
      const next = await call<DiagnosisAgentInfo[]>("diagnosis_agents", {
        paths: pathsRef.current,
        profiles: profilesRef.current,
      });
      if (detection.current === revision) {
        setAgents(next);
        if (!autoSelected.current) {
          autoSelected.current = true;
          const preferred = next.find(
            (item) =>
              item.id === agent && item.path && !item.configurationError,
          );
          const available = next.find(
            (item) => item.path && !item.configurationError,
          );
          if (!preferred && available) {
            setAgent(available.id);
            setSelectionNotice(
              `已自动选择本机检测到的 ${agentNames[available.id]}。尚未验证登录与连接。`,
            );
          }
        }
      }
    } catch (error) {
      if (detection.current === revision) {
        setAgents([]);
        setDetectionError(String(error));
      }
    } finally {
      if (detection.current === revision) setDetecting(false);
    }
  }

  function cancelRequest() {
    const current = request.current;
    request.current = null;
    if (current) {
      current.cancelled = true;
      void cancelRun(current).catch(() => {});
    }
  }

  function cancelRun(current: DiagnosisRun) {
    return current.phase === "preparing"
      ? onCancelScan(current.scanId)
      : call<void>("cancel_storage_diagnosis", { id: current.id });
  }

  useEffect(() => {
    try {
      localStorage.setItem(
        preferenceKey,
        JSON.stringify({ agent, paths, profiles }),
      );
    } catch {
      /* Optional preference storage. */
    }
  }, [agent, paths, profiles]);
  useEffect(() => {
    if (visible) void detect();
    else {
      ++detection.current;
      setDetecting(false);
    }
  }, [visible]);
  useEffect(
    () => () => {
      ++detection.current;
      cancelRequest();
    },
    [],
  );
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(
      () => setSeconds((value) => value + 1),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (!desktop) return;
    const listener = getCurrentWebview().listen<{
      id: string;
      message: string;
    }>("filepace-diagnosis-progress", ({ payload }) => {
      const current = request.current;
      if (current?.id === payload.id && !current.cancelled)
        updateRecord(current.scope, { message: payload.message });
    });
    return () => {
      void listener.then((stop) => stop()).catch(() => {});
    };
  }, []);

  async function start() {
    if (
      !desktop ||
      !scopePath ||
      scanBusy ||
      !tool?.path ||
      !!tool?.configurationError ||
      detecting ||
      request.current ||
      (goal === "custom" && !instructions.trim())
    )
      return;
    const id = crypto.randomUUID();
    const current: DiagnosisRun = {
      id,
      scope: scopePath,
      scanId: !refresh && !scanStale && report && scanId ? scanId : id,
      phase: "preparing",
      cancelled: false,
      changeBaseline,
    };
    request.current = current;
    setRunning(true);
    setPhase("preparing");
    setStopping(false);
    setSeconds(0);
    updateRecord(current.scope, {
      error: "",
      result: null,
      message: "正在准备目录信息…",
      changeBaseline,
    });
    publish(current, "preparing", "正在准备目录信息…");
    try {
      const snapshot = await onPrepare(id, refresh || scanStale);
      if (request.current !== current) return;
      if (current.cancelled || !snapshot) {
        setMessage("诊断已停止。");
        publish(current, "cancelled");
        return;
      }
      if (snapshot.scope !== current.scope || snapshot.id !== current.scanId) {
        throw new Error("目录信息与当前分析范围不一致，请重新诊断。");
      }
      if (snapshot.report.counts.files === 0) {
        setMessage("");
        publish(current, "empty", "这个范围没有可分析的文件。");
        return;
      }
      current.phase = "analyzing";
      current.changeBaseline = snapshot.changeBaseline ?? changeBaseline;
      updateRecord(current.scope, {
        changeBaseline: current.changeBaseline,
      });
      setPhase("analyzing");
      setMessage(`正在启动 ${agentNames[agent]}…`);
      publish(current, "analyzing", `正在使用 ${agentNames[agent]} 进行诊断…`);
      const next = await call<DiagnosisReport | null>("diagnose_storage", {
        id,
        scanId: snapshot.id,
        agent,
        goal,
        instructions: instructions.trim(),
        executablePath: tool.path,
        configurationProfile: profiles[agent] || null,
      });
      if (request.current !== current) return;
      if (current.cancelled) {
        setMessage("诊断已停止。");
        publish(current, "cancelled");
        return;
      }
      if (
        next &&
        next.scanId === current.scanId &&
        next.agent === agent &&
        next.goal === goal &&
        next.instructions === instructions.trim()
      ) {
        updateRecord(current.scope, { result: next, message: "", error: "" });
        publish(current, "complete");
      } else if (next) {
        const message = "诊断结果与当前请求不一致，请重新诊断。";
        setError(message);
        setMessage("");
        publish(current, "error", message);
      } else {
        setMessage("诊断已停止。");
        publish(current, "cancelled");
      }
    } catch (error) {
      if (request.current === current) {
        if (current.cancelled) {
          setMessage("诊断已停止。");
          publish(current, "cancelled");
        } else {
          setError(String(error));
          setMessage("");
          publish(current, "error", String(error));
        }
      }
    } finally {
      if (request.current === current) {
        request.current = null;
        setRunning(false);
        setStopping(false);
      }
    }
  }

  async function stop() {
    const current = request.current;
    if (!current) return;
    current.cancelled = true;
    setStopping(true);
    try {
      await cancelRun(current);
      if (request.current === current)
        updateRecord(current.scope, { message: "正在停止诊断…" });
    } catch (error) {
      if (request.current === current) {
        updateRecord(current.scope, { error: String(error) });
        setStopping(false);
      }
    }
  }

  return (
    <section
      className="storage-section storage-diagnosis"
      aria-labelledby="diagnosis-title"
    >
      <div className="storage-section-heading">
        <div>
          <h2 id="diagnosis-title">
            <Sparkles size={18} /> 智能诊断
          </h2>
          <p>使用本机的 AI 工具，分析占用情况并提出清理、分类和归档建议。</p>
        </div>
        {running ? (
          <button
            className="storage-secondary diagnosis-start"
            disabled={stopping}
            onClick={stop}
          >
            <Square size={14} /> {stopping ? "正在停止" : "停止诊断"}
          </button>
        ) : (
          <button
            className="storage-primary diagnosis-start"
            disabled={
              !desktop ||
              !scopePath ||
              scanBusy ||
              detecting ||
              !tool?.path ||
              !!tool?.configurationError ||
              (goal === "custom" && !instructions.trim()) ||
              (!refresh && report?.counts.files === 0)
            }
            onClick={start}
          >
            <Sparkles size={15} />{" "}
            {result?.agent === agent ? "重新诊断" : "开始诊断"}
          </button>
        )}
      </div>
      {noToolsDetected && (
        <section
          className="storage-card diagnosis-no-tools"
          aria-label="AI 工具提示"
        >
          <div role="status">
            <strong>未检测到 AI 工具</strong>
            <p>
              安装并配置任一支持的 AI 工具后，即可使用智能诊断。占用分析不依赖
              AI 工具，可正常使用。
            </p>
          </div>
          <button className="storage-secondary" onClick={onShowUsage}>
            查看占用分析
          </button>
        </section>
      )}
      <div className="storage-card diagnosis-controls">
        <fieldset className="diagnosis-goal-settings" disabled={running}>
          <legend>诊断方向</legend>
          <div className="diagnosis-goals">
            {(
              Object.entries(goals) as [
                DiagnosisGoal,
                { label: string; description: string },
              ][]
            ).map(([id, option]) => (
              <label
                key={id}
                className={`diagnosis-goal${goal === id ? " selected" : ""}`}
              >
                <input
                  type="radio"
                  name="diagnosis-goal"
                  value={id}
                  checked={goal === id}
                  onChange={() => setGoal(id)}
                />
                <span>
                  <b>{option.label}</b>
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
          </div>
          <label
            className="diagnosis-instructions-label"
            htmlFor="diagnosis-instructions"
          >
            {goal === "custom" ? "自定义诊断方向" : "补充要求（可选）"}
          </label>
          <textarea
            id="diagnosis-instructions"
            rows={2}
            maxLength={2000}
            value={instructions}
            required={goal === "custom"}
            aria-describedby="diagnosis-instructions-hint"
            placeholder={
              goal === "custom"
                ? "例如：帮我梳理这个目录的归档方向，照片和源码都要保留。"
                : "例如：保留照片和源码，优先检查安装包和压缩包。"
            }
            onChange={(event) => setInstructions(event.target.value)}
          />
          <small
            id="diagnosis-instructions-hint"
            className="diagnosis-instructions-hint"
          >
            <span>
              {goal === "custom"
                ? "填写你想重点分析的问题后即可开始。"
                : "可以补充希望保留的文件、处理重点或其他偏好。"}
            </span>
            <span>{instructions.length}/2000</span>
          </small>
          {(report || refresh) && (
            <label className="diagnosis-refresh">
              <input
                type="checkbox"
                checked={refresh || scanStale}
                disabled={scanBusy || !report || scanStale}
                onChange={(event) => setRefresh(event.target.checked)}
              />
              重新扫描后诊断
            </label>
          )}
        </fieldset>
        <div className="diagnosis-toolbar">
          <label htmlFor="diagnosis-agent">AI 工具</label>
          <select
            id="diagnosis-agent"
            value={agent}
            disabled={running || detecting}
            onChange={(event) => {
              setAgent(event.target.value as DiagnosisAgent);
              autoSelected.current = true;
              setSelectionNotice("");
              setError("");
              setMessage("");
            }}
          >
            {agentOptions.map(({ id, name, info }) => (
              <option key={id} value={id}>
                {name}
                {desktop && agents.length > 0
                  ? !info?.path
                    ? " · 未找到"
                    : info.configurationError
                      ? " · 配置需要处理"
                      : ""
                  : ""}
              </option>
            ))}
          </select>
          <button
            className="storage-secondary"
            disabled={!desktop || running || detecting}
            onClick={() => void detect()}
          >
            <RefreshCw size={14} className={detecting ? "spin" : undefined} />{" "}
            {detecting ? "正在检测" : "重新检测"}
          </button>
        </div>
        <p className="diagnosis-tool-path" title={tool?.path ?? undefined}>
          {!desktop
            ? "浏览器仅预览界面，请在桌面应用中使用智能诊断。"
            : detecting
              ? "正在查找本机命令…"
              : tool?.path
                ? `已找到 ${agentNames[agent]}：${tool.path}`
                : (tool?.error ?? "尚未检测到可用命令。")}
        </p>
        {selectionNotice && (
          <p className="storage-muted" role="status">
            {selectionNotice}
          </p>
        )}
        {desktop && tool?.path && (
          <details
            key={agent}
            className="diagnosis-connection"
            aria-label="AI 连接配置"
            aria-busy={detecting}
            open={tool.configurationError ? true : undefined}
          >
            <summary className="diagnosis-connection-summary">
              <span>连接配置</span>
              <small>
                {tool.configurationError
                  ? "配置需要处理"
                  : [
                      tool.configuration?.model || "工具默认模型",
                      tool.configuration?.provider,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </small>
            </summary>
            <div className="diagnosis-connection-heading">
              <strong>使用已有配置</strong>
              <span>
                {detecting
                  ? "正在读取配置…"
                  : tool.configurationError
                    ? "配置需要处理"
                    : "已找到程序 · 连接待验证"}
              </span>
            </div>
            {(agent === "codex" || agent === "deepseek") && (
              <label className="diagnosis-profile">
                配置方案
                <select
                  aria-label="配置方案"
                  value={profiles[agent] ?? ""}
                  disabled={running || detecting}
                  onChange={(event) => {
                    const next = { ...profiles, [agent]: event.target.value };
                    profilesRef.current = next;
                    setProfiles(next);
                    setMessage("");
                    void detect();
                  }}
                >
                  <option value="">
                    {agent === "deepseek" ? "默认（headless）" : "工具默认配置"}
                  </option>
                  {Array.from(
                    new Set([
                      ...(tool.configuration?.profiles ?? []),
                      ...(profiles[agent] ? [profiles[agent]!] : []),
                    ]),
                  ).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {tool.configurationError ? (
              <p className="storage-error" role="alert">
                {tool.configurationError}
              </p>
            ) : (
              <>
                <dl>
                  <div>
                    <dt>配置模型</dt>
                    <dd>{tool.configuration?.model || "由工具决定"}</dd>
                  </div>
                  <div>
                    <dt>服务商</dt>
                    <dd>{tool.configuration?.provider || "由工具决定"}</dd>
                  </div>
                </dl>
                <p className="diagnosis-config-source">
                  来源：{tool.configuration?.source || "该工具的已有配置"}
                </p>
                <p>
                  {tool.configuration?.note ||
                    "沿用已有连接配置；开始诊断时验证登录与连通性。"}
                </p>
              </>
            )}
          </details>
        )}
        <details className="diagnosis-path-settings">
          <summary>指定命令路径</summary>
          <label htmlFor="diagnosis-command">
            {agentNames[agent]} 可执行文件
          </label>
          <input
            id="diagnosis-command"
            type="text"
            disabled={!desktop || running || detecting}
            value={paths[agent] ?? ""}
            placeholder="留空自动检测，或填写完整路径"
            spellCheck={false}
            onChange={(event) => {
              const next = { ...paths, [agent]: event.target.value };
              pathsRef.current = next;
              setPaths(next);
              setAgents((items) =>
                items.map((item) =>
                  item.id === agent
                    ? { ...item, path: null, error: "路径已修改，请重新检测。" }
                    : item,
                ),
              );
            }}
          />
          <p>只填写文件路径，不附加命令参数；修改后点击“重新检测”。</p>
          <p>
            诊断复用已保存的模型与服务连接，继续隔离项目规则、用户插件和文件操作工具。不会修改原工具的配置。
          </p>
        </details>
        <p className="diagnosis-disclosure">
          仅提供目录扫描中的文件名、相对路径、统计，以及你选择的方向和补充要求，不读取文件内容。所选工具可能联网、使用账号额度并按其设置保留记录。
        </p>
        {!report && (
          <p className="storage-muted">
            开始诊断后，将自动收集当前范围的目录信息。
          </p>
        )}
        {report && !running && (
          <p className="storage-muted">
            已有目录扫描结果，将直接复用；也可选择重新扫描。
          </p>
        )}
        {report?.counts.files === 0 && (
          <p className="storage-muted">这个范围没有可分析的文件。</p>
        )}
        {running && !runningHere && (
          <p className="diagnosis-progress" role="status">
            <RefreshCw size={14} className="spin" />
            正在后台诊断：{request.current?.scope}。完成后会通知你。
          </p>
        )}
        {(message || runningHere) && (
          <p className="diagnosis-progress" role="status">
            {runningHere && <RefreshCw size={14} className="spin" />}{" "}
            {runningHere && stopping
              ? "正在停止诊断…"
              : runningHere && phase === "preparing"
                ? `正在收集目录信息${scanProgress ? `：${scanProgress.files.toLocaleString("zh-CN")} 个文件，${formatSize(scanProgress.bytes)}` : "…"}`
                : message}
            {runningHere && <span aria-hidden="true">已等待 {seconds} 秒</span>}
          </p>
        )}
        {error && (
          <p className="storage-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {result && (
        <div className="diagnosis-results" aria-label="智能诊断报告">
          <section className="storage-card diagnosis-summary">
            <div>
              <b>占用概况</b>
              <small>
                {goals[result.goal].label} · {agentNames[result.agent]} ·{" "}
                {new Date(result.createdAt * 1000).toLocaleString("zh-CN")}
              </small>
            </div>
            <p>{result.summary}</p>
            {result.instructions && (
              <p className="diagnosis-request">
                本次要求：{result.instructions}
              </p>
            )}
          </section>
          <div className="diagnosis-findings">
            {result.findings.map((finding, index) => (
              <article className="storage-card diagnosis-finding" key={index}>
                <span className="diagnosis-kind" data-kind={finding.kind}>
                  {findingLabels[finding.kind]}
                </span>
                <h3>{finding.title}</h3>
                <p>{finding.reason}</p>
                <p className="diagnosis-suggestion">{finding.suggestion}</p>
                {finding.items.length > 0 && (
                  <ResultFiles
                    key={`${result.scanId}-${result.createdAt}`}
                    scope={scopePath}
                    label={`相关文件 · ${finding.title}`}
                    visible={resultsVisible}
                    changeBaseline={record?.changeBaseline}
                    items={finding.items.map((item) => ({
                      entry: {
                        ...item,
                        isLink: false,
                        hidden: item.name.startsWith("."),
                        modified: 0,
                      },
                      parent: item.parent,
                    }))}
                    onBrowse={onBrowse}
                    onFileAction={onFileAction}
                    fileChanges={fileChanges}
                    fileChangeBatches={fileChangeBatches}
                  />
                )}
              </article>
            ))}
          </div>
          <section className="storage-card diagnosis-limitations">
            <h3>分析依据与限制</h3>
            <p>
              基于本次扫描统计和有限排行；未校验重复、文件用途或备份状态。清理候选需要核查，文件大小不代表实际可释放空间。
            </p>
            {result.limitations.length > 0 && (
              <ul>
                {result.limitations.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
