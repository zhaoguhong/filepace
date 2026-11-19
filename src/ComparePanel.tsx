import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { call } from "./bridge";
import { formatSize, type Entry } from "./model";
import ModalDialog from "./ModalDialog";

type Difference = {
  relative: string;
  left: Entry | null;
  right: Entry | null;
  leftParent: string | null;
  rightParent: string | null;
};
type Report = { differences: Difference[]; total: number; skipped: number };
type Side = "left" | "right";
type CopyGroup = {
  destination: string;
  sources: string[];
  rows: string[];
  result: "pending" | "submitted" | "failed";
  error?: string;
};
type CopySubmission = { within: string; groups: CopyGroup[] };

export default function ComparePanel({
  left,
  right,
  onClose,
  onCopy,
  returnFocus,
  active = true,
}: {
  left: string;
  right: string;
  onClose: () => void;
  onCopy: (
    sources: string[],
    destination: string,
    within: string,
  ) => Promise<unknown>;
  returnFocus?: HTMLElement | null;
  active?: boolean;
}) {
  const [content, setContent] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState(new Set<string>());
  const [submission, setSubmission] = useState<CopySubmission | null>(null);
  const request = useRef("");
  const retryButton = useRef<HTMLButtonElement>(null);
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
    setSubmission(null);
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

  function copyPlan(from: Side): CopySubmission {
    const within = from === "left" ? right : left;
    const sourceRoot = from === "left" ? left : right;
    const candidates = (report?.differences ?? []).filter(
      (item) => selected.has(item.relative) && item[from],
    );
    const target = (item: Difference) =>
      from === "left" ? item.rightParent : item.leftParent;
    const separator = sourceRoot.startsWith("/") ? "/" : "\\";
    const directories = new Map(
      candidates
        .filter((item) => item[from]?.isDir && target(item))
        .map((item) => [item.relative, item]),
    );
    const groups = new Map<string, CopyGroup>();
    for (const item of candidates) {
      let source = item;
      for (
        let end = item.relative.indexOf(separator);
        end !== -1;
        end = item.relative.indexOf(separator, end + 1)
      ) {
        const ancestor = directories.get(item.relative.slice(0, end));
        if (ancestor) {
          source = ancestor;
          break;
        }
      }
      const destination = target(source);
      if (!destination) continue;
      const group = groups.get(destination) ?? {
        destination,
        sources: [],
        rows: [],
        result: "pending",
      };
      if (source === item) group.sources.push(item[from]!.path);
      group.rows.push(item.relative);
      groups.set(destination, group);
    }
    return { within, groups: [...groups.values()] };
  }

  async function copy(plan: CopySubmission) {
    setQueued(true);
    const groups = plan.groups.map((group): CopyGroup =>
      group.result === "failed"
        ? { ...group, result: "pending", error: undefined }
        : group,
    );
    setSubmission({ ...plan, groups: [...groups] });
    try {
      for (const [index, group] of groups.entries()) {
        if (group.result === "submitted") continue;
        try {
          await onCopy(group.sources, group.destination, plan.within);
          groups[index] = { ...group, result: "submitted" };
        } catch (error) {
          groups[index] = {
            ...group,
            result: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        setSubmission({ ...plan, groups: [...groups] });
      }
      if (groups.every((group) => group.result === "submitted")) onClose();
    } finally {
      setQueued(false);
    }
  }

  const copyLeft = copyPlan("right");
  const copyRight = copyPlan("left");
  const failed =
    submission?.groups.filter((group) => group.result === "failed") ?? [];
  const canRetry = active && !queued && failed.length > 0;
  useLayoutEffect(() => {
    if (canRetry) retryButton.current?.focus({ preventScroll: true });
  }, [canRetry]);
  const submitted =
    submission?.groups.filter((group) => group.result === "submitted").length ??
    0;
  const rowResults = new Map(
    submission?.groups.flatMap((group) =>
      group.rows.map((row) => [row, group.result] as const),
    ),
  );

  return (
    <ModalDialog
      className="form-modal compare-panel"
      label="对比两个文件夹"
      onEscape={queued ? undefined : onClose}
      returnFocus={returnFocus}
      active={active}
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
              setSubmission(null);
            }}
          />
          比较文件内容
        </label>
        {busy ? (
          <button onClick={stop}>停止</button>
        ) : (
          <button
            className="primary"
            data-initial-focus={submission ? undefined : true}
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
      {submission && (
        <p role="status">
          {queued
            ? "正在提交复制任务…"
            : `已提交 ${submitted} 组，${failed.length} 组提交失败。`}
        </p>
      )}
      {failed.length > 0 && (
        <ul
          className="compare-errors"
          aria-label="提交失败的目标"
          tabIndex={queued ? undefined : 0}
        >
          {failed.map((group) => (
            <li key={group.destination}>
              <strong>{group.destination}</strong>
              <span>{group.error}</span>
            </li>
          ))}
        </ul>
      )}
      {report && (
        <div
          className="compare-results"
          tabIndex={submission && !queued ? 0 : undefined}
          aria-label="对比结果"
          role="region"
        >
          {report.differences.map((item) => {
            const result = rowResults.get(item.relative);
            return (
              <label key={item.relative} className="compare-row">
                <input
                  type="checkbox"
                  checked={
                    selected.has(item.relative) && result !== "submitted"
                  }
                  disabled={Boolean(submission)}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(item.relative);
                    else next.delete(item.relative);
                    setSelected(next);
                  }}
                />
                <span title={item.relative}>
                  {item.relative}
                  {result === "submitted" && <small>已入队</small>}
                  {result === "failed" && (
                    <small className="compare-copy-failed">提交失败</small>
                  )}
                </span>
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
            );
          })}
        </div>
      )}
      <div className="modal-buttons">
        <button disabled={queued} onClick={onClose}>
          关闭
        </button>
        {submission ? (
          <button
            ref={retryButton}
            className="primary"
            data-initial-focus
            disabled={queued || !failed.length}
            onClick={() => void copy(submission)}
          >
            重试未提交的项目
          </button>
        ) : (
          <>
            <button
              disabled={!copyLeft.groups.length}
              onClick={() => void copy(copyLeft)}
            >
              所选项目复制到左栏
            </button>
            <button
              disabled={!copyRight.groups.length}
              onClick={() => void copy(copyRight)}
            >
              所选项目复制到右栏
            </button>
          </>
        )}
      </div>
    </ModalDialog>
  );
}
