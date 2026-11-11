import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  HardDrive,
  RefreshCw,
  FolderSearch,
} from "lucide-react";
import { call, desktop } from "./bridge";
import { formatSize } from "./model";
import { isMac } from "./fileDrag";
import type { StorageVolume } from "./storageTypes";
import "./storage.css";

const volumeUnit = isMac ? 1000 : 1024;
export default function StorageDashboard({
  visible,
  onAnalyze,
  onBrowse,
  onClose,
}: {
  visible: boolean;
  onAnalyze: (path?: string) => void;
  onBrowse: (path: string) => void;
  onClose: () => void;
}) {
  const [volumes, setVolumes] = useState<StorageVolume[]>([]);
  const [volumeLoading, setVolumeLoading] = useState(false);
  const [volumeError, setVolumeError] = useState("");
  const [updated, setUpdated] = useState("");
  const readingVolumes = useRef(false);
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
  return (
    <section
      className="storage-dashboard"
      aria-label="存储概览"
      hidden={!visible}
    >
      <header className="storage-heading">
        <div className="storage-heading-mark">
          <BarChart3 size={24} />
        </div>
        <div>
          <h1>存储概览</h1>
          <p>查看磁盘容量，从一个目录开始了解空间占用。</p>
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
                  <button onClick={() => onAnalyze(volume.path)}>
                    分析此磁盘
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
      <button className="storage-analysis-link" onClick={() => onAnalyze()}>
        <span className="storage-heading-mark">
          <FolderSearch size={24} />
        </span>
        <span>
          <b>目录分析</b>
          <small>查看文件分布、大文件与子目录占用，获取智能整理建议。</small>
        </span>
        <ArrowUpRight size={20} />
      </button>
    </section>
  );
}
