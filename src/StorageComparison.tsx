import { useEffect, useState } from "react";
import { formatSize } from "./model";
import type { StorageReport } from "./storageTypes";
import {
  compareStorageBaseline,
  createStorageBaseline,
  readStorageBaselines,
  removeStorageBaseline,
  saveStorageBaseline,
  storageBaselinesChanged,
  storagePathKey,
} from "./storageBaseline";

const signedSize = (value: number) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatSize(Math.abs(value))}`;
export default function StorageComparison({
  report,
  scannedAt,
  stale,
  onBrowse,
}: {
  report: StorageReport;
  scannedAt: number;
  stale: boolean;
  onBrowse: (path: string) => void;
}) {
  const [baselines, setBaselines] = useState(readStorageBaselines);
  const [error, setError] = useState("");
  useEffect(() => {
    const refresh = () => setBaselines(readStorageBaselines());
    window.addEventListener("storage", refresh);
    window.addEventListener(storageBaselinesChanged, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(storageBaselinesChanged, refresh);
    };
  }, []);
  const baseline = baselines.find(
    (item) => storagePathKey(item.path) === storagePathKey(report.path),
  );
  const comparison = baseline ? compareStorageBaseline(report, baseline) : null;
  function update(action: () => void) {
    try {
      action();
      setError("");
    } catch {
      setError("无法保存扫描基线，请检查本机存储空间后重试。");
    }
  }
  return (
    <section
      className="storage-card storage-comparison"
      aria-label="扫描前后对比"
    >
      <div className="analysis-card-heading">
        <h3>扫描前后对比</h3>
        <div className="storage-baseline-actions">
          <button
            className="storage-secondary"
            disabled={stale}
            title={stale ? "请先重新扫描，确保基线反映当前目录" : undefined}
            onClick={() =>
              update(() =>
                saveStorageBaseline(createStorageBaseline(report, scannedAt)),
              )
            }
          >
            {baseline ? "替换对比基线" : "保存为对比基线"}
          </button>
          {baseline && (
            <button
              className="storage-secondary"
              onClick={() => update(() => removeStorageBaseline(report.path))}
            >
              清除基线
            </button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="storage-error">
          {error}
        </p>
      )}
      <p className="storage-muted">{report.path}</p>
      {baseline && comparison ? (
        <>
          <p className="storage-muted">
            基线：{new Date(baseline.scannedAt).toLocaleString("zh-CN")} ·
            当前扫描：{new Date(scannedAt).toLocaleString("zh-CN")}
          </p>
          {baseline.scannedAt === scannedAt ? (
            <p role="status">基线已保存，重新扫描后可查看变化。</p>
          ) : (
            <>
              <div className="storage-deltas">
                <strong>文件大小变化 {signedSize(comparison.bytes)}</strong>
                <span>
                  文件数量变化 {comparison.files > 0 ? "+" : ""}
                  {comparison.files}
                </span>
              </div>
              {!comparison.complete && (
                <p className="storage-muted">
                  结果包含跳过项目或目录明细不完整。总量差值仅代表已读取部分，以下仅对比两次都记录到的子目录，不推断新增或移除。
                </p>
              )}
              {comparison.changes.length ? (
                <ul className="storage-folder-changes">
                  {comparison.changes.slice(0, 24).map((change) => (
                    <li key={change.path}>
                      <button
                        disabled={!change.after}
                        onClick={() => onBrowse(change.path)}
                        title={change.path}
                      >
                        {change.name}
                      </button>
                      <small>
                        {!change.before
                          ? "新增目录"
                          : !change.after
                            ? "已移除目录"
                            : "目录变化"}
                      </small>
                      <strong>{signedSize(change.delta)}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="storage-muted">记录到的子目录没有变化。</p>
              )}
              {comparison.changes.length > 24 && (
                <p className="storage-muted">显示变化最大的 24 个子目录。</p>
              )}
            </>
          )}
        </>
      ) : (
        <p className="storage-muted">
          将本次扫描保存为基线，下次扫描同一目录时查看文件大小、数量和子目录变化。最多保留
          8 个目录，重启后仍可对比。
        </p>
      )}
      <p className="storage-muted">
        基于扫描时的文件逻辑大小；差值不等于磁盘已释放空间。
      </p>
    </section>
  );
}
