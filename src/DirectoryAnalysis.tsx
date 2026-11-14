import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  Folder,
  FolderSearch,
  ChartPie,
  Sparkles,
  ArrowRight,
  Square,
} from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { call, desktop } from "./bridge";
import { fileCategoryLabels } from "./fileTypes";
import { basename, formatSize, type Place } from "./model";
import StorageDiagnosis, { type DiagnosisCallbacks } from "./StorageDiagnosis";
import ResultFiles from "./ResultFiles";
import StorageTreemap from "./StorageTreemap";
import StorageComparison from "./StorageComparison";
import type { ResultActionProps } from "./resultActions";
import { usePreservedScroll } from "./preservedScroll";
import "./storage.css";

import type {
  StorageVolume,
  ScanCounts,
  RankedItem,
  StorageReport,
  StorageSnapshot,
} from "./storageTypes";

const categories: Record<string, { label: string; color: string }> = {
  documents: { label: fileCategoryLabels.documents, color: "#4978cb" },
  images: { label: fileCategoryLabels.images, color: "#288678" },
  videos: { label: fileCategoryLabels.videos, color: "#8359b8" },
  audio: { label: fileCategoryLabels.audio, color: "#ba618a" },
  archives: { label: fileCategoryLabels.archives, color: "#b77b38" },
  code: { label: fileCategoryLabels.code, color: "#6370ac" },
  apps: { label: fileCategoryLabels.apps, color: "#416f87" },
  other: { label: fileCategoryLabels.other, color: "#8292a9" },
};
const emptyCounts: ScanCounts = { files: 0, folders: 0, bytes: 0, skipped: 0 };
const number = new Intl.NumberFormat("zh-CN");
const recentScanLimit = 8;
const snapshotLifetime = 5 * 60_000;
type RecentScan = StorageSnapshot & {
  scannedAt: number;
  changed: boolean;
  changeBaseline: number;
};
const normalized = (path: string) => {
  const value = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(value) || value.startsWith("//")
    ? value.toLowerCase()
    : value;
};
const overlaps = (a: string, b: string) => {
  const left = normalized(a);
  const right = normalized(b);
  return (
    left === right ||
    left.startsWith(right + "/") ||
    right.startsWith(left + "/")
  );
};

function ItemList({
  title,
  items,
  folders = false,
  onBrowse,
  onChoose,
  onFileAction,
  fileChanges,
  fileChangeBatches,
  visible,
  scope,
  changeBaseline,
}: ResultActionProps & {
  title: string;
  items: RankedItem[];
  folders?: boolean;
  onBrowse: (path: string, selected?: string) => void;
  onChoose: (path: string) => void;
  visible: boolean;
  scope: string;
  changeBaseline?: number;
}) {
  return (
    <section className="storage-card">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="storage-muted">这个范围没有项目。</p>
      ) : (
        <ResultFiles
          items={items.map((item) => ({
            entry: {
              ...item,
              isDir: folders,
              isLink: false,
              hidden: false,
              modified: 0,
            },
            parent: item.parent,
            detail: folders
              ? `${number.format(item.files)} 个文件 · ${item.parent}`
              : undefined,
          }))}
          scope={scope}
          label={title}
          visible={visible}
          changeBaseline={changeBaseline}
          onBrowse={onBrowse}
          onFileAction={onFileAction}
          fileChanges={fileChanges}
          fileChangeBatches={fileChangeBatches}
          extra={
            folders
              ? (item) => (
                  <button
                    className="storage-scan-folder"
                    title="选为扫描范围"
                    aria-label={`选择 ${item.entry.name} 作为扫描范围`}
                    onClick={() => onChoose(item.entry.path)}
                  >
                    <FolderSearch size={16} />
                  </button>
                )
              : undefined
          }
        />
      )}
    </section>
  );
}

export default function DirectoryAnalysis({
  visible,
  currentPath,
  scope,
  places,
  onChoose,
  onBrowse,
  onClose,
  onFileAction,
  fileChanges,
  fileChangeBatches,
  onDiagnosisStatus,
  onDiagnosisComplete,
  diagnosisOpen,
}: ResultActionProps &
  DiagnosisCallbacks & {
    visible: boolean;
    currentPath: string;
    scope: string;
    places: Place[];
    onChoose: (path: string) => void;
    onBrowse: (path: string, selected?: string) => void;
    onClose: () => void;
    diagnosisOpen?: { scope: string; request: number };
  }) {
  const [volumes, setVolumes] = useState<StorageVolume[]>([]);
  const preservedScroll = usePreservedScroll(visible);
  const [view, setView] = useState<"usage" | "diagnosis">("usage");
  const [scanProgress, setScanProgress] = useState<ScanCounts | null>(null);
  const [stopping, setStopping] = useState(false);
  const [scanError, setScanError] = useState("");
  const [recentScans, setRecentScans] = useState<RecentScan[]>([]);
  const [now, setNow] = useState(Date.now);
  const [filter, setFilter] = useState("");
  const scanId = useRef("");
  const scanCancelled = useRef(false);
  const scanPath = useRef("");
  const scanForDiagnosis = useRef(false);
  const path = scope || currentPath;
  const currentPathRef = useRef(path);
  currentPathRef.current = path;
  const openedDiagnosis = useRef<number | undefined>(undefined);
  const scanResult = recentScans.find((snapshot) => snapshot.scope === path);
  const report = scanResult?.report ?? null;
  const scannedAt = scanResult?.scannedAt;
  const stale = Boolean(
    scanResult &&
    (scanResult.changed || now - scanResult.scannedAt > snapshotLifetime),
  );
  const counts =
    (scanPath.current === path ? scanProgress : null) ?? report?.counts;
  const busy = scanProgress !== null;
  const observedSequence = useRef(fileChangeBatches?.at(-1)?.sequence ?? 0);
  useEffect(() => {
    if (
      !visible ||
      !diagnosisOpen ||
      diagnosisOpen.scope !== path ||
      diagnosisOpen.request === openedDiagnosis.current
    )
      return;
    if (view !== "diagnosis") {
      setView("diagnosis");
      return;
    }
    let scrollFrame = 0;
    // Showing the page restores its old scroll position in the first frame.
    // A requested report takes precedence once that restoration has finished.
    const layoutFrame = requestAnimationFrame(() => {
      scrollFrame = requestAnimationFrame(() => {
        const container = preservedScroll.ref.current;
        const panel = container?.querySelector("#analysis-panel-diagnosis");
        const target =
          panel?.querySelector(".diagnosis-results") ??
          panel?.querySelector(".diagnosis-controls > .storage-error") ??
          panel?.querySelector(".storage-error") ??
          panel?.querySelector(".storage-section-heading");
        if (!container || !target) return;
        container.scrollTop +=
          target.getBoundingClientRect().top -
          container.getBoundingClientRect().top -
          16;
        openedDiagnosis.current = diagnosisOpen.request;
      });
    });
    return () => {
      cancelAnimationFrame(layoutFrame);
      cancelAnimationFrame(scrollFrame);
    };
  }, [diagnosisOpen, path, visible, view, preservedScroll.ref]);
  useEffect(() => {
    const batches =
      fileChangeBatches?.filter(
        (batch) => batch.sequence > observedSequence.current,
      ) ?? [];
    if (!batches.length) return;
    observedSequence.current = batches.at(-1)!.sequence;
    setRecentScans((scans) =>
      scans.map((snapshot) =>
        batches.some((batch) =>
          batch.changes.some(
            (change) =>
              overlaps(change.from, snapshot.scope) ||
              Boolean(change.to && overlaps(change.to, snapshot.scope)),
          ),
        )
          ? { ...snapshot, changed: true }
          : snapshot,
      ),
    );
  }, [fileChangeBatches]);

  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [visible]);
  useEffect(() => {
    if (!desktop) return;
    const listener = getCurrentWebview().listen<string[] | null>(
      "directory-changed",
      ({ payload }) => {
        setRecentScans((scans) =>
          scans.map((snapshot) =>
            !payload ||
            payload.some(
              (changed) =>
                overlaps(changed, snapshot.report.path) ||
                overlaps(changed, snapshot.scope),
            )
              ? { ...snapshot, changed: true }
              : snapshot,
          ),
        );
      },
    );
    return () => {
      void listener.then((stop) => stop()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (visible)
      void call<StorageVolume[]>("storage_volumes")
        .then(setVolumes)
        .catch(() => {});
  }, [visible]);
  useEffect(() => {
    if (!desktop) return;
    const listener = getCurrentWebview().listen<{
      id: string;
      counts: ScanCounts;
    }>("filepace-storage-progress", ({ payload }) => {
      if (scanId.current === payload.id) setScanProgress(payload.counts);
    });
    return () => {
      void listener.then((stop) => stop()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    setScanError("");
    setFilter("");
    // A volume or folder entry can change scope while a manual scan is running.
    // Stop the old scan before allowing another; never show its counts here.
    if (
      scanId.current &&
      scanPath.current !== path &&
      !scanForDiagnosis.current &&
      !scanCancelled.current
    ) {
      void cancelScan(scanId.current).catch((error) =>
        setScanError(String(error)),
      );
    }
  }, [path]);

  async function runScan(
    id: string,
    forDiagnosis = false,
  ): Promise<RecentScan | null> {
    if (!path) throw new Error("请先选择分析范围。");
    if (scanId.current) throw new Error("当前范围正在扫描，请等待扫描结束。");
    scanId.current = id;
    scanPath.current = path;
    scanForDiagnosis.current = forDiagnosis;
    scanCancelled.current = false;
    const startingSequence = observedSequence.current;
    setScanProgress(emptyCounts);
    setScanError("");
    setRecentScans((scans) =>
      scans.filter((snapshot) => snapshot.scope !== path),
    );
    setFilter("");
    try {
      const result = await call<StorageReport | null>("scan_storage", {
        path,
        id,
      });
      if (scanCancelled.current || !result) {
        if (currentPathRef.current === path) setScanError("扫描已停止。");
        return null;
      }
      const scannedAt = Date.now();
      const snapshot: RecentScan = {
        scope: path,
        id,
        report: result,
        scannedAt,
        changed: observedSequence.current !== startingSequence,
        changeBaseline: startingSequence,
      };
      setNow(scannedAt);
      setRecentScans((scans) =>
        [
          ...scans.filter(
            (previous) =>
              previous.scope !== path && previous.report.path !== result.path,
          ),
          snapshot,
        ].slice(-recentScanLimit),
      );
      return snapshot;
    } catch (error) {
      if (scanCancelled.current) return null;
      if (currentPathRef.current === path) setScanError(String(error));
      throw error;
    } finally {
      if (scanId.current === id) {
        scanId.current = "";
        scanForDiagnosis.current = false;
        setStopping(false);
        setScanProgress(null);
      }
    }
  }

  async function startScan() {
    // Errors are already displayed by runScan; the diagnosis path also awaits
    // and handles them so a failed scan never starts an agent.
    await runScan(crypto.randomUUID()).catch(() => {});
  }

  async function prepareDiagnosisScan(id: string, refresh: boolean) {
    if (!refresh && !stale && report && scanResult) return scanResult;
    return runScan(id, true);
  }

  async function cancelScan(id: string) {
    if (scanId.current === id) {
      scanCancelled.current = true;
      setStopping(true);
    }
    try {
      await call("cancel_storage_scan", { id });
    } catch (error) {
      if (scanId.current === id) setStopping(false);
      throw error;
    }
  }

  async function stopScan() {
    if (!scanId.current) return;
    try {
      await cancelScan(scanId.current);
    } catch (error) {
      setScanError(String(error));
    }
  }

  const locations = new Map<string, string>();
  for (const location of [
    ...places.filter((place) => place.kind !== "disk"),
    ...volumes,
  ]) {
    if (location.path !== currentPath)
      locations.set(location.path, location.name);
  }
  for (const snapshot of recentScans) {
    if (snapshot.scope !== currentPath && !locations.has(snapshot.scope))
      locations.set(
        snapshot.scope,
        `${basename(snapshot.scope) || snapshot.scope} · 最近扫描`,
      );
  }
  if (scope && scope !== currentPath && !locations.has(scope))
    locations.set(scope, scope);
  const groups = report
    ? Object.entries(report.categories).sort(
        ([, a], [, b]) => b.bytes - a.bytes || b.files - a.files,
      )
    : [];
  const largest = (
    filter
      ? (report?.categories[filter]?.largest ?? [])
      : groups.flatMap(([, group]) => group.largest)
  )
    .slice()
    .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
    .slice(0, 12);
  const choose = (next: string) => {
    setScanError("");
    setFilter("");
    onChoose(next);
  };
  const browseResult = (parent: string, selected?: string) => {
    onChoose(path);
    onBrowse(parent, selected);
  };

  let angle = 0;
  const segments = groups.map(([key, group]) => {
    const start = angle;
    angle += report?.counts.bytes
      ? (group.bytes / report.counts.bytes) * 360
      : 0;
    return `${categories[key]?.color ?? categories.other.color} ${start}deg ${angle}deg`;
  });

  return (
    <section
      className="storage-dashboard directory-analysis"
      {...preservedScroll}
      aria-label="目录分析"
      hidden={!visible}
    >
      <div className="analysis-container">
        <header className="storage-heading analysis-heading">
          <div className="storage-heading-mark">
            <ChartPie size={25} />
          </div>
          <div>
            <h1>目录分析</h1>
            <p>看清空间去向，让每一次整理都有依据。</p>
          </div>
          <button className="storage-secondary" onClick={onClose}>
            <ArrowLeft size={15} /> 返回文件
          </button>
        </header>
        {!desktop && (
          <div className="storage-demo">界面预览 · 以下为示例数据</div>
        )}
        <section className="storage-section" aria-label="分析工作区">
          <div className="storage-card storage-controls">
            <Folder size={20} />
            <div>
              <label htmlFor="storage-scope">扫描范围</label>
              <select
                id="storage-scope"
                disabled={busy && !scanForDiagnosis.current}
                value={scope === currentPath ? "" : scope}
                onChange={(event) => choose(event.target.value)}
              >
                <option value="">当前目录</option>
                {Array.from(locations, ([path, label]) => (
                  <option key={path} value={path}>
                    {label}
                  </option>
                ))}
              </select>
              <p title={path}>{path}</p>
            </div>
          </div>
          {scanError && (
            <p className="storage-error" role="status">
              {scanError}
            </p>
          )}
          {busy && (
            <p className="storage-muted" role="status">
              {stopping
                ? "等待当前读取结束…"
                : scanPath.current !== path
                  ? `正在后台读取目录：${scanPath.current}`
                  : "正在读取目录…"}
            </p>
          )}
          {stale && (
            <p className="analysis-stale" role="status">
              {scanResult?.changed ? "目录已有变化" : "扫描结果已超过 5 分钟"}
              ，以下为上次扫描快照；开始诊断时会自动重新扫描。
            </p>
          )}
          <div className="analysis-tabs" role="tablist" aria-label="分析视图">
            {(["usage", "diagnosis"] as const).map((id) => (
              <button
                key={id}
                role="tab"
                id={`analysis-tab-${id}`}
                aria-controls={`analysis-panel-${id}`}
                aria-selected={view === id}
                tabIndex={view === id ? 0 : -1}
                onClick={() => setView(id)}
                onKeyDown={(event) => {
                  if (
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? "usage"
                      : event.key === "End"
                        ? "diagnosis"
                        : view === "usage"
                          ? "diagnosis"
                          : "usage";
                  setView(next);
                  document.getElementById(`analysis-tab-${next}`)?.focus();
                }}
              >
                {id === "usage" ? (
                  <ChartPie size={16} />
                ) : (
                  <Sparkles size={16} />
                )}
                {id === "usage" ? "占用分析" : "智能诊断"}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id="analysis-panel-usage"
            aria-labelledby="analysis-tab-usage"
            hidden={view !== "usage"}
            tabIndex={0}
          >
            <div className="analysis-usage-actions">
              <div>
                <strong>
                  {report ? "目录占用概况" : "扫描目录，了解空间占用"}
                </strong>
                <span>
                  {busy
                    ? "正在读取目录信息…"
                    : report && scannedAt
                      ? `扫描于 ${new Date(scannedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · 扫描快照`
                      : "统计文件类型、大小与子目录占用"}
                </span>
              </div>
              {busy ? (
                <button
                  className="storage-secondary"
                  onClick={stopScan}
                  disabled={stopping}
                >
                  <Square size={14} />
                  {stopping ? "正在停止" : "停止扫描"}
                </button>
              ) : (
                <button
                  className={report ? "storage-secondary" : "storage-primary"}
                  onClick={startScan}
                  disabled={!path}
                >
                  <FolderSearch size={16} />
                  {report ? "重新扫描" : "开始扫描"}
                </button>
              )}
              {report && !busy && (
                <button
                  className="storage-primary"
                  onClick={() => setView("diagnosis")}
                >
                  <Sparkles size={16} /> 智能诊断 <ArrowRight size={15} />
                </button>
              )}
            </div>
            {counts ? (
              <dl className="storage-counts">
                <div>
                  <dt>文件大小</dt>
                  <dd>{formatSize(counts.bytes)}</dd>
                </div>
                {counts.allocatedBytes !== undefined && (
                  <div title="按文件路径累计已分配块，硬链接和共享块可能重复计入">
                    <dt>分配空间（按路径）</dt>
                    <dd>{formatSize(counts.allocatedBytes)}</dd>
                  </div>
                )}
                <div>
                  <dt>文件</dt>
                  <dd>{number.format(counts.files)}</dd>
                </div>
                <div>
                  <dt>子目录</dt>
                  <dd>{number.format(counts.folders)}</dd>
                </div>
                <div>
                  <dt title="符号链接、特殊文件或无法读取的条目">跳过项目</dt>
                  <dd>{number.format(counts.skipped)}</dd>
                </div>
              </dl>
            ) : (
              <div className="analysis-empty">
                <div className="analysis-empty-art" aria-hidden="true">
                  <FolderSearch size={42} />
                  <span />
                  <span />
                </div>
                <h2>
                  {busy ? "正在梳理目录" : "从这个文件夹开始，发现空间去向"}
                </h2>
                <p>
                  扫描「{basename(path) || path}
                  」，查看文件分类、体积最大的文件和子目录。
                </p>
                <div className="analysis-empty-steps">
                  <span>
                    <ChartPie size={16} /> 了解占用
                  </span>
                  <ArrowRight size={14} />
                  <span>
                    <FolderSearch size={16} /> 定位大文件
                  </span>
                  <ArrowRight size={14} />
                  <span>
                    <Sparkles size={16} /> 获取整理建议
                  </span>
                </div>
                <small>仅统计目录信息，不会修改文件。</small>
              </div>
            )}
            {report && (
              <>
                <div className="analysis-results">
                  <div className="analysis-overview">
                    <section className="storage-card storage-breakdown">
                      <div className="analysis-card-heading">
                        <h3>文件分类</h3>
                        <span>按文件逻辑大小</span>
                      </div>
                      <div className="analysis-composition">
                        <div
                          className="analysis-donut"
                          style={{
                            background:
                              report.counts.bytes > 0
                                ? `conic-gradient(${segments.join(",")})`
                                : "var(--inset)",
                          }}
                          role="img"
                          aria-label={`文件分类占用，总计 ${formatSize(report.counts.bytes)}`}
                        >
                          <div>
                            <small>文件总大小</small>
                            <strong>{formatSize(report.counts.bytes)}</strong>
                            <span>{groups.length} 种文件类型</span>
                          </div>
                        </div>
                        <div className="storage-categories">
                          <button
                            className="storage-category analysis-all"
                            aria-pressed={!filter}
                            onClick={() => setFilter("")}
                          >
                            <b>全部文件</b>
                            <small>
                              {number.format(report.counts.files)} 个
                            </small>
                            <strong>{formatSize(report.counts.bytes)}</strong>
                          </button>
                          {groups.map(([key, group]) => (
                            <button
                              key={key}
                              className="storage-category"
                              style={
                                {
                                  "--category-color":
                                    categories[key]?.color ??
                                    categories.other.color,
                                } as CSSProperties
                              }
                              aria-pressed={filter === key}
                              onClick={() => setFilter(key)}
                            >
                              <b>{categories[key]?.label ?? key}</b>
                              <small>{number.format(group.files)} 个</small>
                              <strong>{formatSize(group.bytes)}</strong>
                              <span>
                                {report.counts.bytes
                                  ? Math.round(
                                      (group.bytes / report.counts.bytes) * 100,
                                    )
                                  : 0}
                                %
                              </span>
                            </button>
                          ))}
                          {!groups.length && (
                            <p className="storage-muted">没有可统计的文件。</p>
                          )}
                        </div>
                      </div>
                    </section>
                  </div>
                  <div className="storage-rankings">
                    <ItemList
                      key={`files-${scanResult?.id}`}
                      title={
                        filter
                          ? `最大的文件 · ${categories[filter]?.label ?? filter}`
                          : "最大的文件"
                      }
                      items={largest}
                      onBrowse={browseResult}
                      onChoose={choose}
                      scope={path}
                      visible={visible && view === "usage"}
                      changeBaseline={scanResult?.changeBaseline}
                      onFileAction={onFileAction}
                      fileChanges={fileChanges}
                      fileChangeBatches={fileChangeBatches}
                    />
                    <ItemList
                      key={`folders-${scanResult?.id}`}
                      title="占用最多的子目录"
                      items={report.folders}
                      folders
                      onBrowse={browseResult}
                      onChoose={choose}
                      scope={path}
                      visible={visible && view === "usage"}
                      changeBaseline={scanResult?.changeBaseline}
                      onFileAction={onFileAction}
                      fileChanges={fileChanges}
                      fileChangeBatches={fileChangeBatches}
                    />
                  </div>
                </div>
                <StorageTreemap
                  key={`map-${scanResult?.id}`}
                  report={report}
                  visible={visible && view === "usage"}
                  onBrowse={browseResult}
                  onFileAction={onFileAction}
                  fileChanges={fileChanges}
                  fileChangeBatches={fileChangeBatches}
                  changeBaseline={scanResult?.changeBaseline}
                />
                <StorageComparison
                  report={report}
                  scannedAt={scannedAt!}
                  stale={stale}
                  onBrowse={browseResult}
                />
              </>
            )}
          </div>
          <div
            role="tabpanel"
            id="analysis-panel-diagnosis"
            aria-labelledby="analysis-tab-diagnosis"
            hidden={view !== "diagnosis"}
            tabIndex={0}
          >
            <StorageDiagnosis
              visible={visible}
              scopePath={path}
              report={report}
              scanId={report ? scanResult!.id : ""}
              scanBusy={busy}
              scanStale={stale}
              scanProgress={scanProgress}
              onPrepare={prepareDiagnosisScan}
              onCancelScan={cancelScan}
              onBrowse={browseResult}
              onFileAction={onFileAction}
              fileChanges={fileChanges}
              fileChangeBatches={fileChangeBatches}
              resultsVisible={visible && view === "diagnosis"}
              changeBaseline={scanResult?.changeBaseline}
              onDiagnosisStatus={onDiagnosisStatus}
              onDiagnosisComplete={onDiagnosisComplete}
              onShowUsage={() => {
                setView("usage");
                document.getElementById("analysis-tab-usage")?.focus();
              }}
            />
          </div>
        </section>
      </div>
    </section>
  );
}
