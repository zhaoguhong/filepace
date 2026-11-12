import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  CopyCheck,
  FolderSearch,
  RefreshCw,
  ShieldCheck,
  Square,
} from "lucide-react";
import { Channel } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { call, desktop } from "./bridge";
import ResultFiles from "./ResultFiles";
import { formatSize, type Entry } from "./model";
import {
  resultFile,
  snapshotResultMutations,
  type ResultActionProps,
  type ResultActionRequest,
  type ResultMutations,
} from "./resultActions";
import { mergeFileChanges } from "./resultMutations";
import { usePreservedScroll } from "./preservedScroll";
import {
  duplicateActionBlocked,
  duplicateParent,
  duplicatePathsOverlap,
  type DuplicateProgress,
  type DuplicateReport,
} from "./duplicateResults";
import "./duplicates.css";

type Snapshot = {
  id: string;
  report: DuplicateReport;
  baseline: number;
  createdAt: number;
};

export default function DuplicatePanel({
  path,
  hidden,
  visible = true,
  onBrowse,
  onClose,
  onFileAction,
  fileChanges,
  fileChangeBatches,
}: ResultActionProps & {
  path: string;
  hidden: boolean;
  visible?: boolean;
  onBrowse: (path: string, selected?: string) => void;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const preservedScroll = usePreservedScroll(visible);
  const [progress, setProgress] = useState<DuplicateProgress | null>(null);
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState("");
  const [keepers, setKeepers] = useState<Record<string, string>>({});
  const [shownGroups, setShownGroups] = useState(24);
  const [staleGroups, setStaleGroups] = useState<string[]>([]);
  const [localChanges, setLocalChanges] = useState<ResultMutations>({});
  const request = useRef("");
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const changedDuringScan = useRef<(string | null)[]>([]);
  const lastSequence = useRef(0);
  const report = snapshot?.report;
  const busy = progress !== null;

  function markChanged(paths: (string | null)[]) {
    const current = snapshotRef.current;
    if (!current) return;
    const ids = current.report.groups
      .filter((group) =>
        paths.some(
          (changed) =>
            changed === null ||
            group.files.some((entry) =>
              duplicatePathsOverlap(changed, entry.path),
            ),
        ),
      )
      .map((group) => group.id);
    if (ids.length) setStaleGroups((prior) => [...new Set([...prior, ...ids])]);
  }

  useEffect(() => {
    if (!snapshot) return;
    const pending =
      fileChangeBatches?.filter(
        (batch) => batch.sequence > lastSequence.current,
      ) ?? [];
    if (!pending.length) return;
    lastSequence.current = pending.at(-1)!.sequence;
    setLocalChanges((current) =>
      pending.reduce(
        (changes, batch) => mergeFileChanges(changes, batch.changes),
        current,
      ),
    );
    markChanged(
      pending.flatMap((batch) =>
        batch.changes.flatMap((change) =>
          change.to ? [change.from, change.to] : [change.from],
        ),
      ),
    );
  }, [fileChangeBatches, snapshot?.id]);

  useEffect(() => {
    if (!desktop) return;
    const listener = getCurrentWebview().listen<string[] | null>(
      "directory-changed",
      ({ payload }) => {
        const paths = payload?.length ? payload : [null];
        if (request.current) {
          if (changedDuringScan.current.length + paths.length <= 1_000)
            changedDuringScan.current.push(...paths);
          else changedDuringScan.current = [null];
        }
        markChanged(paths);
      },
    );
    return () => {
      void listener.then((stop) => stop()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    setSnapshot(null);
    setProgress(null);
    setKeepers({});
    setShownGroups(24);
    setStaleGroups([]);
    setLocalChanges({});
    setNotice("");
    return () => {
      const id = request.current;
      request.current = "";
      if (id) void call("cancel_duplicates", { id }).catch(() => {});
    };
  }, [path]);

  async function start() {
    if (request.current || !path) return;
    const id = crypto.randomUUID();
    request.current = id;
    lastSequence.current = fileChangeBatches?.at(-1)?.sequence ?? 0;
    const baseline = lastSequence.current;
    changedDuringScan.current = [];
    setSnapshot(null);
    setStaleGroups([]);
    setLocalChanges({});
    setKeepers({});
    setShownGroups(24);
    setNotice("");
    setStopping(false);
    setProgress({
      phase: "scan",
      scannedFiles: 0,
      scannedBytes: 0,
      checkedFiles: 0,
      checkedBytes: 0,
    });
    const onProgress = desktop ? new Channel<DuplicateProgress>() : undefined;
    if (onProgress)
      onProgress.onmessage = (value) => {
        if (request.current === id) setProgress(value);
      };
    try {
      const result = await call<DuplicateReport | null>("find_duplicates", {
        path,
        id,
        hidden,
        onProgress,
      });
      if (request.current !== id) return;
      if (!result) setNotice("检查已停止，未生成新的结果。");
      else {
        const next = { id, report: result, baseline, createdAt: Date.now() };
        setLocalChanges(
          snapshotResultMutations(
            result.groups.flatMap((group) =>
              group.files.map((entry) => ({
                entry,
                parent: duplicateParent(entry.path),
              })),
            ),
          ),
        );
        snapshotRef.current = next;
        setSnapshot(next);
        markChanged(changedDuringScan.current);
      }
    } catch (error) {
      if (request.current === id) setNotice(String(error));
    } finally {
      if (request.current === id) {
        request.current = "";
        setProgress(null);
        setStopping(false);
      }
    }
  }

  function stop() {
    if (!request.current || stopping) return;
    setStopping(true);
    void call("cancel_duplicates", { id: request.current }).catch((error) => {
      setNotice(String(error));
      setStopping(false);
    });
  }

  function act(
    requested: ResultActionRequest,
    keeper: Entry | undefined,
    stale: boolean,
    groupId: string,
  ) {
    const blocked = duplicateActionBlocked(requested, keeper, stale);
    if (blocked) {
      setNotice(blocked);
      return;
    }
    onFileAction?.(
      snapshot &&
        keeper &&
        ["trash", "cut", "move-to", "move-other", "rename"].includes(
          requested.action,
        )
        ? {
            ...requested,
            duplicateGuard: {
              scanId: snapshot.id,
              groupId,
              keeper: keeper.path,
            },
          }
        : requested,
    );
  }

  return (
    <section
      {...preservedScroll}
      className="storage-dashboard duplicate-panel"
      aria-label="检查重复文件"
      hidden={!visible}
    >
      <header className="storage-heading">
        <span className="storage-heading-mark">
          <CopyCheck size={23} />
        </span>
        <div>
          <h1>检查重复文件</h1>
          <p className="search-path" title={path}>
            {path}
          </p>
        </div>
        <button className="storage-secondary" onClick={onClose}>
          <ArrowLeft size={15} /> 返回文件
        </button>
      </header>
      {!desktop && (
        <p className="storage-demo">
          界面预览 · 以下为示例数据，真实检查在桌面应用中进行。
        </p>
      )}
      <section className="storage-card duplicate-intro">
        <div>
          <h2>查找内容完全相同的文件</h2>
          <p>
            先按大小筛选，再计算内容摘要并逐字节核对。每组先由你选择保留位置，其余副本再手动整理。
          </p>
        </div>
        {busy ? (
          <button
            className="storage-secondary"
            disabled={stopping}
            onClick={stop}
          >
            <Square size={14} />
            {stopping ? "正在停止" : "停止检查"}
          </button>
        ) : (
          <button
            className="storage-primary"
            onClick={() => void start()}
            disabled={!path}
          >
            {report ? <RefreshCw size={15} /> : <FolderSearch size={16} />}
            {report ? "重新检查" : "开始检查"}
          </button>
        )}
      </section>
      {notice && (
        <p className="storage-error" role="status">
          {notice}
        </p>
      )}
      {busy && progress && (
        <section className="storage-card duplicate-progress" role="status">
          <strong>
            {stopping
              ? "等待当前读取结束…"
              : {
                  scan: "正在枚举文件…",
                  hash: "正在读取候选文件的内容…",
                  verify: "正在逐字节核对…",
                }[progress.phase]}
          </strong>
          <span>
            已枚举 {progress.scannedFiles.toLocaleString("zh-CN")} 个文件 ·
            文件逻辑大小 {formatSize(progress.scannedBytes)}
          </span>
          {progress.phase !== "scan" && (
            <span>
              已读取 {formatSize(progress.checkedBytes)} · 已检查{" "}
              {progress.checkedFiles.toLocaleString("zh-CN")} 个候选
            </span>
          )}
          <small>总量尚未确定，读取量包含摘要和最终核对。</small>
        </section>
      )}
      {report && snapshot && (
        <>
          <div className="duplicate-summary">
            <strong>{report.groups.length} 组相同文件</strong>
            <span>
              枚举 {report.scannedFiles.toLocaleString("zh-CN")} 个文件 ·{" "}
              {formatSize(report.scannedBytes)}
            </span>
            <small>
              检查于{" "}
              {new Date(snapshot.createdAt).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </small>
          </div>
          {(report.limited || report.skipped > 0 || report.hardLinks > 0) && (
            <p className="duplicate-limit" role="status">
              {report.limited &&
                "已达到检查或显示上限，以下为部分结果；可缩小目录后重新检查。 "}
              {report.skipped > 0 &&
                `跳过 ${report.skipped.toLocaleString("zh-CN")} 个无法访问、已变化或不支持的项目。 `}
              {report.hardLinks > 0 &&
                `${report.hardLinks.toLocaleString("zh-CN")} 个硬链接别名不作为独立副本。`}
            </p>
          )}
          {!report.groups.length && (
            <div className="duplicate-empty">
              <ShieldCheck size={30} />
              <h2>
                {report.limited
                  ? "已检查的文件中没有发现完全相同的副本"
                  : "本次检查未发现完全相同的文件"}
              </h2>
              <p>仅代表本次可检查范围的结果；同名或大小相同不代表内容相同。</p>
            </div>
          )}
          <div className="duplicate-groups">
            {report.groups.slice(0, shownGroups).map((group, index) => {
              const keepPath = keepers[group.id] ?? "";
              const chosen = group.files.find(
                (entry) => entry.path === keepPath,
              );
              const keeper = chosen
                ? resultFile(
                    { entry: chosen, parent: duplicateParent(chosen.path) },
                    { ...fileChanges, ...localChanges },
                  )
                : undefined;
              const stale =
                staleGroups.includes(group.id) || Boolean(keeper?.unavailable);
              const copies = group.files
                .filter((entry) => entry.path !== keepPath)
                .map((entry) => ({
                  entry,
                  parent: duplicateParent(entry.path),
                }));
              return (
                <section
                  className="storage-card duplicate-group"
                  key={`${snapshot.id}:${group.id}`}
                  aria-label={`重复组 ${index + 1}`}
                >
                  <div className="duplicate-group-heading">
                    <h3>重复组 {index + 1}</h3>
                    <span>
                      {group.files.length} 个文件 · 每个{" "}
                      {formatSize(group.size)}
                    </span>
                  </div>
                  {stale && (
                    <p className="duplicate-limit" role="status">
                      这一组文件的内容或位置已有变化；请重新检查后继续整理。
                    </p>
                  )}
                  <label className="duplicate-keep">
                    <span>选择要保留的文件</span>
                    <select
                      aria-label={`重复组 ${index + 1} 保留位置`}
                      value={keepPath}
                      onChange={(event) => {
                        setKeepers((current) => ({
                          ...current,
                          [group.id]: event.target.value,
                        }));
                        setNotice("");
                      }}
                    >
                      <option value="">请选择保留位置…</option>
                      {group.files.map((entry) => (
                        <option value={entry.path} key={entry.path}>
                          {entry.path}
                        </option>
                      ))}
                    </select>
                  </label>
                  {chosen && keeper ? (
                    <>
                      <div className="duplicate-retained">
                        <ShieldCheck size={17} />
                        <div>
                          <strong>保留：{keeper.entry.name}</strong>
                          <small>{keeper.entry.path}</small>
                        </div>
                        <button
                          title="定位保留的文件"
                          aria-label={`定位保留的文件 ${keeper.entry.name}`}
                          disabled={keeper.unavailable}
                          onClick={() =>
                            onBrowse(keeper.parent, keeper.entry.path)
                          }
                        >
                          <ArrowUpRight size={15} />
                        </button>
                      </div>
                      <p className="duplicate-copies-label">
                        以下副本可选中后预览或整理，保留文件不会加入选区。
                      </p>
                      <ResultFiles
                        key={`${snapshot.id}:${group.id}:${keepPath}`}
                        items={copies}
                        scope={path}
                        label={`重复组 ${index + 1} 的副本`}
                        onBrowse={onBrowse}
                        onFileAction={(requested) =>
                          act(
                            requested,
                            keeper.unavailable ? undefined : keeper.entry,
                            stale,
                            group.id,
                          )
                        }
                        fileChanges={fileChanges}
                        fileChangeBatches={fileChangeBatches}
                        changeBaseline={snapshot.baseline}
                        visible={visible}
                      />
                    </>
                  ) : (
                    <ul className="duplicate-preview-paths">
                      {group.files.map((entry) => (
                        <li key={entry.path}>
                          <span title={entry.path}>{entry.path}</span>
                          <button
                            aria-label={`预览 ${entry.name}`}
                            onClick={() =>
                              onFileAction?.({
                                action: "preview",
                                entries: [entry],
                                allEntries: group.files,
                                scope: path,
                              })
                            }
                          >
                            预览
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
          {report.groups.length > shownGroups && (
            <button
              className="storage-secondary duplicate-more"
              onClick={() => setShownGroups((count) => count + 24)}
            >
              再显示 {Math.min(24, report.groups.length - shownGroups)} 组（共{" "}
              {report.groups.length} 组）
            </button>
          )}
        </>
      )}
      <p className="duplicate-footnote">
        结果是检查时的内容快照。仅检查当前文件系统，跳过链接；硬链接别名不重复计为副本。文件逻辑大小不代表可释放空间，移到回收站不会立即释放空间。删除前请确认保留文件的内容和用途。
        单次最多枚举 10 万个文件、读取 32 GiB 内容，最多展示 1000 组、1
        万个文件。
      </p>
    </section>
  );
}
