import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  Folder,
  FolderSearch,
  HardDrive,
  RefreshCw,
  Square,
} from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { call, desktop } from "./bridge";
import FileIcon from "./FileIcon";
import { isMac } from "./fileDrag";
import { fileCategoryLabels } from "./fileTypes";
import { formatSize, type Place } from "./model";
import "./storage.css";

export type StorageVolume = {
  name: string;
  path: string;
  total: number | null;
  available: number | null;
};
export type ScanCounts = {
  files: number;
  folders: number;
  bytes: number;
  skipped: number;
};
export type RankedItem = {
  path: string;
  name: string;
  parent: string;
  size: number;
  files: number;
};
export type Category = { files: number; bytes: number; largest: RankedItem[] };
export type StorageReport = {
  path: string;
  counts: ScanCounts;
  categories: Record<string, Category>;
  folders: RankedItem[];
};

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
const volumeUnit = isMac ? 1000 : 1024;

function ItemList({
  title,
  items,
  folders = false,
  onBrowse,
  onChoose,
}: {
  title: string;
  items: RankedItem[];
  folders?: boolean;
  onBrowse: (path: string, selected?: string) => void;
  onChoose: (path: string) => void;
}) {
  return (
    <section className="storage-card">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="storage-muted">这个范围没有项目。</p>
      ) : (
        <ul className="storage-items">
          {items.map((item) => (
            <li key={item.path}>
              <button
                className="storage-item"
                title={item.path}
                onClick={() =>
                  folders
                    ? onBrowse(item.path)
                    : onBrowse(item.parent, item.path)
                }
              >
                <FileIcon
                  entry={{
                    ...item,
                    isDir: folders,
                    isLink: false,
                    hidden: false,
                    modified: 0,
                  }}
                  showThumbnail={false}
                />
                <span>
                  <b>{item.name}</b>
                  <small>
                    {folders
                      ? `${number.format(item.files)} 个文件`
                      : item.parent}
                  </small>
                </span>
                <strong>{formatSize(item.size)}</strong>
                <ArrowUpRight size={14} />
              </button>
              {folders && (
                <button
                  className="storage-scan-folder"
                  title="选为扫描范围"
                  aria-label={`选择 ${item.name} 作为扫描范围`}
                  onClick={() => onChoose(item.path)}
                >
                  <FolderSearch size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function StorageDashboard({
  visible,
  currentPath,
  scope,
  places,
  onChoose,
  onBrowse,
  onClose,
}: {
  visible: boolean;
  currentPath: string;
  scope: string;
  places: Place[];
  onChoose: (path: string) => void;
  onBrowse: (path: string, selected?: string) => void;
  onClose: () => void;
}) {
  const [volumes, setVolumes] = useState<StorageVolume[]>([]);
  const [volumeLoading, setVolumeLoading] = useState(false);
  const [volumeError, setVolumeError] = useState("");
  const [updated, setUpdated] = useState("");
  const [scanProgress, setScanProgress] = useState<ScanCounts | null>(null);
  const [stopping, setStopping] = useState(false);
  const [scanError, setScanError] = useState("");
  const [scanResult, setScanResult] = useState<{
    scope: string;
    report: StorageReport;
  } | null>(null);
  const [filter, setFilter] = useState("");
  const scanId = useRef("");
  const readingVolumes = useRef(false);
  const path = scope || currentPath;
  const report = scanResult?.scope === path ? scanResult.report : null;
  const counts = scanProgress ?? report?.counts;
  const busy = scanProgress !== null;

  async function refreshVolumes() {
    if (readingVolumes.current) return;
    readingVolumes.current = true;
    setVolumeLoading(true);
    setVolumeError("");
    try {
      setVolumes(await call<StorageVolume[]>("storage_volumes"));
      setUpdated(
        new Date().toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
    } catch (error) {
      setVolumeError(String(error));
    } finally {
      readingVolumes.current = false;
      setVolumeLoading(false);
    }
  }

  useEffect(() => {
    if (visible) void refreshVolumes();
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

  async function startScan() {
    if (!path || scanId.current) return;
    const id = crypto.randomUUID();
    scanId.current = id;
    setScanProgress(emptyCounts);
    setScanError("");
    setScanResult(null);
    setFilter("");
    try {
      const result = await call<StorageReport | null>("scan_storage", {
        path,
        id,
      });
      if (result) setScanResult({ scope: path, report: result });
      else setScanError("扫描已停止。");
    } catch (error) {
      setScanError(String(error));
    } finally {
      scanId.current = "";
      setStopping(false);
      setScanProgress(null);
    }
  }

  async function stopScan() {
    if (!scanId.current) return;
    setStopping(true);
    try {
      await call("cancel_storage_scan", { id: scanId.current });
    } catch (error) {
      setStopping(false);
      setScanError(String(error));
    }
  }

  if (!visible) return null;
  const locations = new Map<string, string>();
  for (const location of [
    ...places.filter((place) => place.kind !== "disk"),
    ...volumes,
  ]) {
    if (location.path !== currentPath)
      locations.set(location.path, location.name);
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

  return (
    <section className="storage-dashboard" aria-label="存储概览">
      <header className="storage-heading">
        <div className="storage-heading-mark">
          <BarChart3 size={24} />
        </div>
        <div>
          <h1>存储概览</h1>
          <p>查看各卷剩余空间，找出目录里占用最多的文件。</p>
        </div>
        <button className="storage-secondary" onClick={onClose}>
          <ArrowLeft size={15} /> 返回文件
        </button>
      </header>
      {!desktop && (
        <div className="storage-demo">界面预览 · 以下为示例数据</div>
      )}
      <section className="storage-section" aria-labelledby="volume-title">
        <div className="storage-section-heading">
          <div>
            <h2 id="volume-title">磁盘与卷</h2>
            <p>{updated ? `容量更新于 ${updated}` : "容量来自操作系统"}</p>
          </div>
          <button
            className="storage-secondary"
            disabled={volumeLoading}
            onClick={refreshVolumes}
          >
            <RefreshCw
              size={15}
              className={volumeLoading ? "spin" : undefined}
            />{" "}
            刷新容量
          </button>
          <button
            className="storage-secondary"
            disabled={!desktop}
            onClick={() => {
              void call("open_system_storage").catch((error) =>
                setVolumeError(String(error)),
              );
            }}
          >
            系统存储工具 <ArrowUpRight size={14} />
          </button>
        </div>
        {volumeError && (
          <p className="storage-error" role="alert">
            {volumeError}
          </p>
        )}
        {!volumeError && !volumeLoading && !volumes.length && (
          <p className="storage-muted">没有检测到已挂载的卷。</p>
        )}
        <div className="storage-volumes">
          {volumes.map((volume) => {
            const known =
              volume.total !== null &&
              volume.total > 0 &&
              volume.available !== null;
            const used = known ? volume.total! - volume.available! : 0;
            const percent = known
              ? Math.round((used / volume.total!) * 100)
              : 0;
            return (
              <article
                className="storage-card storage-volume"
                key={volume.path}
              >
                <div className="storage-volume-name">
                  <HardDrive size={19} />
                  <div>
                    <b>{volume.name}</b>
                    <small title={volume.path}>{volume.path}</small>
                  </div>
                  {known && (
                    <span className={percent >= 90 ? "storage-high" : ""}>
                      {percent}% 已用
                    </span>
                  )}
                </div>
                {known ? (
                  <>
                    <div
                      className="storage-meter"
                      role="meter"
                      aria-label={`${volume.name}已用比例`}
                      aria-valuenow={percent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <span style={{ width: `${percent}%` }} />
                    </div>
                    <div className="storage-volume-values">
                      <b>{formatSize(volume.available!, volumeUnit)} 可用</b>
                      <span>
                        总容量 {formatSize(volume.total!, volumeUnit)}
                      </span>
                    </div>
                  </>
                ) : (
                  <p className="storage-muted">容量暂不可用</p>
                )}
                <div className="storage-volume-actions">
                  <button onClick={() => onBrowse(volume.path)}>
                    浏览 <ArrowUpRight size={13} />
                  </button>
                  <button disabled={busy} onClick={() => choose(volume.path)}>
                    选为扫描范围
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
      <section className="storage-section" aria-labelledby="scan-title">
        <div className="storage-section-heading">
          <div>
            <h2 id="scan-title">目录分析</h2>
            <p>按文件逻辑大小统计，包含可读取的子目录。</p>
          </div>
        </div>
        <div className="storage-card storage-controls">
          <Folder size={20} />
          <div>
            <label htmlFor="storage-scope">扫描范围</label>
            <select
              id="storage-scope"
              disabled={busy}
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
              className="storage-primary"
              onClick={startScan}
              disabled={!path}
            >
              <FolderSearch size={16} />
              {report ? "重新扫描" : "开始扫描"}
            </button>
          )}
        </div>
        {scanError && (
          <p className="storage-error" role="status">
            {scanError}
          </p>
        )}
        {busy && (
          <p className="storage-muted" role="status">
            {stopping ? "等待当前读取结束…" : "正在读取目录…"}
          </p>
        )}
        {counts ? (
          <dl className="storage-counts">
            <div>
              <dt>文件大小</dt>
              <dd>{formatSize(counts.bytes)}</dd>
            </div>
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
          <p className="storage-muted storage-start-note">
            选择扫描范围后开始扫描，即可查看文件分类和占用最多的项目。
          </p>
        )}
        {report && (
          <>
            <section className="storage-card storage-breakdown">
              <h3>文件分类</h3>
              {groups.length === 0 ? (
                <p className="storage-muted">没有可统计的文件。</p>
              ) : (
                <>
                  {report.counts.bytes > 0 && (
                    <div className="storage-distribution" aria-hidden="true">
                      {groups.map(([key, group]) => (
                        <span
                          key={key}
                          style={{
                            flexGrow: group.bytes,
                            background: categories[key].color,
                          }}
                        />
                      ))}
                    </div>
                  )}
                  <div className="storage-categories">
                    <button
                      className="storage-category"
                      aria-pressed={!filter}
                      onClick={() => setFilter("")}
                    >
                      <b>全部文件</b>
                      <small>{number.format(report.counts.files)} 个</small>
                    </button>
                    {groups.map(([key, group]) => (
                      <button
                        key={key}
                        className="storage-category"
                        style={
                          {
                            "--category-color": categories[key].color,
                          } as CSSProperties
                        }
                        aria-pressed={filter === key}
                        onClick={() => setFilter(key)}
                      >
                        <b>{categories[key].label}</b>
                        <small>{number.format(group.files)} 个</small>
                        <strong>{formatSize(group.bytes)}</strong>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </section>
            <div className="storage-rankings">
              <ItemList
                title={
                  filter
                    ? `最大的文件 · ${categories[filter].label}`
                    : "最大的文件"
                }
                items={largest}
                onBrowse={browseResult}
                onChoose={choose}
              />
              <ItemList
                title="占用最多的子目录"
                items={report.folders}
                folders
                onBrowse={browseResult}
                onChoose={choose}
              />
            </div>
          </>
        )}
      </section>
    </section>
  );
}
