import { useEffect, useRef, useState } from "react";
import { call } from "./bridge";
import { formatSize, type Entry } from "./model";

type Difference = {
  relative: string;
  left: Entry | null;
  right: Entry | null;
  leftParent: string | null;
  rightParent: string | null;
};
type Report = { differences: Difference[]; total: number; skipped: number };
type Side = "left" | "right";

export default function ComparePanel({
  left,
  right,
  onClose,
  onCopy,
}: {
  left: string;
  right: string;
  onClose: () => void;
  onCopy: (
    sources: string[],
    destination: string,
    within: string,
  ) => Promise<unknown>;
}) {
  const [content, setContent] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState(new Set<string>());
  const request = useRef("");
  const stop = () => {
    if (request.current)
      void call("cancel_compare", { id: request.current }).catch(() => {});
  };
  useEffect(
    () => () => {
      stop();
      request.current = "";
    },
    [],
  );

  async function compare() {
    if (request.current) return;
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true);
    setReport(null);
    setSelected(new Set());
    setNotice("");
    try {
      const next = await call<Report | null>("compare_directories", {
        id,
        left,
        right,
        content,
      });
      if (request.current === id) {
        setReport(next);
        if (!next) setNotice("目录对比已停止。");
      }
    } catch (error) {
      if (request.current === id) setNotice(String(error));
    } finally {
      if (request.current === id) {
        request.current = "";
        setBusy(false);
      }
    }
  }

  function copyPlan(from: Side) {
    const possible = (report?.differences ?? []).filter(
      (item) =>
        selected.has(item.relative) &&
        item[from] &&
        (from === "left" ? item.rightParent : item.leftParent),
    );
    const directories = new Set(
      possible
        .filter((item) => item[from]?.isDir)
        .map((item) => item.relative.replaceAll("\\", "/")),
    );
    return possible.filter((item) => {
      const parts = item.relative.replaceAll("\\", "/").split("/");
      for (let count = 1; count < parts.length; count++) {
        if (directories.has(parts.slice(0, count).join("/"))) return false;
      }
      return true;
    });
  }

  async function copy(from: Side) {
    setQueued(true);
    const groups = new Map<string, string[]>();
    for (const item of copyPlan(from)) {
      const destination = (
        from === "left" ? item.rightParent : item.leftParent
      )!;
      const sources = groups.get(destination) ?? [];
      sources.push(item[from]!.path);
      groups.set(destination, sources);
    }
    try {
      for (const [destination, sources] of groups) {
        await onCopy(sources, destination, from === "left" ? right : left);
      }
      onClose();
    } finally {
      setQueued(false);
    }
  }

  return (
    <div className="overlay">
      <section
        className="modal form-modal compare-panel"
        role="dialog"
        aria-modal="true"
        aria-label="对比两个文件夹"
      >
        <h3>对比两个文件夹</h3>
        <div className="batch-preview">
          <div>
            <span>左栏 · {left}</span>
            <span>右栏 · {right}</span>
          </div>
        </div>
        <div className="compare-controls">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={content}
              disabled={busy || queued}
              onChange={(event) => {
                setContent(event.target.checked);
                setReport(null);
              }}
            />
            比较文件内容
          </label>
          {busy ? (
            <button onClick={stop}>停止</button>
          ) : (
            <button
              className="primary"
              autoFocus
              disabled={queued}
              onClick={() => void compare()}
            >
              开始对比
            </button>
          )}
        </div>
        <p role="status">
          {notice ||
            (busy
              ? "正在读取两个文件夹…"
              : report
                ? `${report.total} 项不同${report.total > report.differences.length ? `，显示前 ${report.differences.length} 项` : ""}${report.skipped ? `，跳过 ${report.skipped} 项` : ""}`
                : "按相对路径匹配，默认比较文件大小和修改时间。")}
        </p>
        {report && (
          <div className="compare-results">
            {report.differences.map((item) => (
              <label key={item.relative} className="compare-row">
                <input
                  type="checkbox"
                  checked={selected.has(item.relative)}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(item.relative);
                    else next.delete(item.relative);
                    setSelected(next);
                  }}
                />
                <span title={item.relative}>{item.relative}</span>
                <span>
                  {!item.left
                    ? "仅右侧"
                    : !item.right
                      ? "仅左侧"
                      : item.left.isDir !== item.right.isDir
                        ? "类型不同"
                        : `${formatSize(item.left.size)} / ${formatSize(item.right.size)}`}
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="modal-buttons">
          <button disabled={queued} onClick={onClose}>
            关闭
          </button>
          <button
            disabled={queued || copyPlan("right").length === 0}
            onClick={() => void copy("right")}
          >
            所选项目复制到左栏
          </button>
          <button
            disabled={queued || copyPlan("left").length === 0}
            onClick={() => void copy("left")}
          >
            所选项目复制到右栏
          </button>
        </div>
      </section>
    </div>
  );
}
