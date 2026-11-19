import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Folder, RefreshCw, Trash2, Undo2 } from "lucide-react";
import FileIcon from "./FileIcon";
import { isMac } from "./fileDrag";
import { call, desktop } from "./bridge";
import { useFileViewport, visibleRange } from "./fileViewport";
import { formatSize, type Task } from "./model";
import type { Shortcut } from "./preferences";
import "./trash.css";
import "./sidebarDialogs.css";

export const TRASH_PATH = "filepace://trash";
export type TrashItem = {
  id: string;
  name: string;
  originalPath: string | null;
  deletedAt: number | null;
  size: number | null;
  isDir: boolean;
};
type Report = { items: TrashItem[]; warnings: string[] };
export default function TrashPanel({
  tasks,
  locations,
  onSubmitted,
  onError,
  onBack,
  onForward,
}: {
  tasks: Task[];
  locations: Shortcut[];
  onSubmitted: (id: string) => void;
  onError: (error: string) => void;
  onBack?: () => void;
  onForward?: () => void;
}) {
  const [report, setReport] = useState<Report>({ items: [], warnings: [] });
  const destinationId = useId();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<{
    action: "restore" | "purge" | "empty";
    items: TrashItem[];
    destination: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [scroll, setScroll] = useState(0);
  const { listRef, attachList, height, layout } = useFileViewport();
  const generation = useRef(0);
  const anchor = useRef<string | null>(null);
  const visible = useMemo(() => {
    const needle = query.toLocaleLowerCase();
    return needle
      ? report.items.filter((item) =>
          `${item.name}\n${item.originalPath ?? ""}`
            .toLocaleLowerCase()
            .includes(needle),
        )
      : report.items;
  }, [query, report.items]);
  const chosen = useMemo(
    () => visible.filter((item) => selected.has(item.id)),
    [visible, selected],
  );
  const range = visibleRange(visible.length, scroll, height, layout);
  const taskState = JSON.stringify(
    tasks
      .filter((task) => ["restore", "purge", "trash"].includes(task.kind))
      .map((task) => [task.id, task.status]),
  );
  async function refresh() {
    const request = ++generation.current;
    setLoading(true);
    try {
      const report = await call<Report>("list_trash");
      if (generation.current === request) {
        setReport(report);
        setError("");
        setSelected((previous) => {
          if (!previous.size) return previous;
          const available = new Set(report.items.map((item) => item.id));
          const retained = new Set(
            [...previous].filter((id) => available.has(id)),
          );
          return retained.size === previous.size ? previous : retained;
        });
      }
    } catch (error) {
      if (generation.current === request) setError(String(error));
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [taskState]);
  useEffect(() => {
    const update = () => void refresh();
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, []);
  function selectItem(id: string, checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function confirm(action: "restore" | "purge" | "empty", items = chosen) {
    setError("");
    setDialog({ action, items: [...items], destination: "" });
  }
  return (
    <section
      className="trash-panel"
      aria-label="回收站内容"
      onKeyDown={(event) => {
        const key = event.key.toLowerCase();
        if (
          ((event.metaKey || event.ctrlKey) &&
            (["t", "n", "w", "f", "k", ","].includes(key) ||
              (event.shiftKey && key === "p"))) ||
          (event.ctrlKey && key === "tab") ||
          (event.altKey && ["arrowleft", "arrowright"].includes(key))
        )
          return;
        event.stopPropagation();
        if (
          (event.target as HTMLElement).closest(
            "input:not([type=checkbox]), select, button",
          )
        )
          return;
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "a"
        ) {
          event.preventDefault();
          setSelected(new Set(visible.map((item) => item.id)));
        }
        if (event.key === "Escape") setSelected(new Set());
      }}
    >
      <div className="trash-toolbar">
        <button aria-label="后退" disabled={!onBack} onClick={onBack}>
          ←
        </button>
        <button aria-label="前进" disabled={!onForward} onClick={onForward}>
          →
        </button>
        <h2>
          <Trash2 size={19} />
          回收站
        </h2>
        <button
          aria-label="刷新回收站"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw size={15} />
        </button>
        <input
          aria-label="筛选回收站"
          placeholder="筛选名称或原位置"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (listRef.current) listRef.current.scrollTop = 0;
            setScroll(0);
          }}
        />
        <button
          disabled={!desktop || !chosen.length || loading}
          onClick={() => confirm("restore")}
        >
          <Undo2 size={14} />
          恢复所选
        </button>
        <button
          disabled={!desktop || !chosen.length || loading}
          onClick={() => confirm("purge")}
        >
          <Trash2 size={14} />
          永久删除
        </button>
        <button
          disabled={!desktop || !report.items.length || loading}
          onClick={() => confirm("empty", report.items)}
        >
          清空回收站
        </button>
      </div>
      {!desktop && (
        <p className="trash-message">
          浏览器仅预览界面，请在桌面应用中管理系统回收站。
        </p>
      )}
      {report.warnings.map((warning) => (
        <p className="trash-message" key={warning}>
          {warning}
        </p>
      ))}
      {desktop &&
        report.warnings.some((warning) => warning.includes("完全磁盘访问")) && (
          <div className="trash-message">
            <button
              onClick={() =>
                void call("open_trash_permissions").catch((error) =>
                  onError(String(error)),
                )
              }
            >
              打开系统隐私设置
            </button>
          </div>
        )}
      {error && (
        <p role="alert" className="trash-message error">
          {error}
          <button onClick={() => void refresh()}>重新读取</button>
        </p>
      )}
      <div
        className="trash-scroll"
        ref={attachList}
        role="region"
        aria-label="回收站列表"
        tabIndex={0}
        onScroll={(event) => {
          const list = event.currentTarget;
          setScroll(list.scrollTop);
          const focusedRow = document.activeElement?.closest(
            "tbody tr[aria-rowindex]",
          );
          if (focusedRow && list.contains(focusedRow)) {
            const rowIndex =
              Number(focusedRow.getAttribute("aria-rowindex")) - 2;
            const nextRange = visibleRange(
              visible.length,
              list.scrollTop,
              height,
              layout,
            );
            if (rowIndex < nextRange.start || rowIndex >= nextRange.end)
              list.focus({ preventScroll: true });
          }
        }}
      >
        <table className="trash-table" aria-rowcount={visible.length + 1}>
          <thead>
            <tr aria-rowindex={1}>
              <th>
                <input
                  type="checkbox"
                  aria-label="选择回收站全部可见项目"
                  checked={
                    Boolean(visible.length) && chosen.length === visible.length
                  }
                  onChange={(event) =>
                    setSelected(
                      new Set(
                        event.target.checked
                          ? visible.map((item) => item.id)
                          : [],
                      ),
                    )
                  }
                />
              </th>
              <th>名称</th>
              <th>原位置</th>
              <th>删除时间</th>
              <th>大小</th>
            </tr>
          </thead>
          <tbody>
            {range.above > 0 && (
              <tr className="trash-spacer" aria-hidden="true">
                <td colSpan={5} style={{ height: range.above }} />
              </tr>
            )}
            {visible.slice(range.start, range.end).map((item, index) => {
              const rowIndex = range.start + index;
              const isSelected = selected.has(item.id);
              return (
                <tr
                  key={item.id}
                  tabIndex={isSelected ? 0 : -1}
                  aria-rowindex={rowIndex + 2}
                  aria-selected={isSelected}
                  className={isSelected ? "selected" : ""}
                  style={{ height: layout.height }}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("input")) return;
                    event.currentTarget.focus({ preventScroll: true });
                    if (event.shiftKey && anchor.current) {
                      const anchorIndex = visible.findIndex(
                        (row) => row.id === anchor.current,
                      );
                      setSelected(
                        new Set(
                          visible
                            .slice(
                              Math.max(0, Math.min(anchorIndex, rowIndex)),
                              Math.max(anchorIndex, rowIndex) + 1,
                            )
                            .map((row) => row.id),
                        ),
                      );
                    } else if (event.metaKey || event.ctrlKey) {
                      selectItem(item.id, !isSelected);
                    } else {
                      setSelected(new Set([item.id]));
                    }
                    anchor.current = item.id;
                  }}
                >
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${item.name}`}
                      checked={isSelected}
                      onChange={(event) => {
                        anchor.current = item.id;
                        selectItem(item.id, event.target.checked);
                      }}
                    />
                  </td>
                  <td title={item.name}>
                    <div className="trash-file-name">
                      <FileIcon
                        entry={{
                          name: item.name,
                          path:
                            item.originalPath ??
                            (isMac
                              ? `/filepace-trash/${item.id}`
                              : `filepace-trash:${item.id}`),
                          isDir: item.isDir,
                          isLink: false,
                          size: item.size ?? 0,
                          modified: item.deletedAt ?? 0,
                          hidden: item.name.startsWith("."),
                        }}
                        showThumbnail={false}
                        showNativeIcon={false}
                      />
                      <span className="trash-file-label">{item.name}</span>
                    </div>
                  </td>
                  <td title={item.originalPath ?? ""}>
                    {item.originalPath ?? "原位置不可用"}
                  </td>
                  <td>
                    {item.deletedAt
                      ? new Date(item.deletedAt * 1000).toLocaleString("zh-CN")
                      : "未知"}
                  </td>
                  <td>{item.size === null ? "—" : formatSize(item.size)}</td>
                </tr>
              );
            })}
            {range.below > 0 && (
              <tr className="trash-spacer" aria-hidden="true">
                <td colSpan={5} style={{ height: range.below }} />
              </tr>
            )}
          </tbody>
        </table>
        {!visible.length && !error && (
          <div className="empty">
            <Trash2 size={38} />
            <h3>
              {loading
                ? "正在读取回收站…"
                : query
                  ? "没有匹配的项目"
                  : "回收站是空的"}
            </h3>
          </div>
        )}
      </div>
      <div className="trash-summary">
        {report.items.length} 项 · 已选择 {chosen.length} 项
      </div>
      {dialog && (
        <div
          className="overlay sidebar-dialog-overlay"
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape" && !busy) setDialog(null);
          }}
        >
          <form
            className="modal form-modal sidebar-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={
              dialog.action === "restore"
                ? "恢复回收站项目"
                : dialog.action === "empty"
                  ? "确认清空回收站"
                  : "确认永久删除"
            }
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setError("");
              try {
                const id = await call<string>("start_trash_task", {
                  action: dialog.action === "restore" ? "restore" : "purge",
                  ids: dialog.items.map((item) => item.id),
                  destination: dialog.destination.trim() || null,
                  confirmed: dialog.action !== "restore",
                });
                onSubmitted(id);
                setDialog(null);
              } catch (error) {
                setError(String(error));
                onError(String(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            <h3>
              <span
                className={`sidebar-dialog-icon${dialog.action !== "restore" ? " is-danger" : ""}`}
                aria-hidden="true"
              >
                {dialog.action === "restore" ? (
                  <Undo2 size={18} />
                ) : (
                  <Trash2 size={18} />
                )}
              </span>
              {dialog.action === "restore"
                ? "恢复回收站项目"
                : dialog.action === "empty"
                  ? "清空回收站"
                  : "永久删除"}
            </h3>
            <p className="sidebar-dialog-description">
              {dialog.action === "restore"
                ? `恢复所选 ${dialog.items.length} 项。留空将恢复到各自原位置；同名项目会询问如何处理。`
                : `将永久删除这 ${dialog.items.length} 项，无法撤销。${dialog.action === "empty" ? "确认后新进入回收站的项目不会删除。" : ""}`}
            </p>
            {dialog.action === "restore" && (
              <>
                <div className="sidebar-dialog-field">
                  <label htmlFor={destinationId}>恢复到文件夹（可选）</label>
                  <div className="sidebar-dialog-input-row">
                    <input
                      id={destinationId}
                      autoFocus
                      disabled={busy}
                      aria-label="恢复目标文件夹"
                      value={dialog.destination}
                      title={dialog.destination}
                      list={`${destinationId}-locations`}
                      onChange={(event) => {
                        setDialog({
                          ...dialog,
                          destination: event.target.value,
                        });
                        setError("");
                      }}
                      placeholder="留空：恢复到原位置"
                    />
                    <datalist id={`${destinationId}-locations`}>
                      {locations.map((place) => (
                        <option key={place.path} value={place.path}>
                          {place.name}
                        </option>
                      ))}
                    </datalist>
                    {desktop && (
                      <button
                        className="sidebar-dialog-browse"
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          try {
                            const destination = await call<string | null>(
                              "choose_location",
                            );
                            if (destination) {
                              setDialog({ ...dialog, destination });
                              setError("");
                            }
                          } catch (error) {
                            setError(String(error));
                          }
                        }}
                      >
                        <Folder size={14} />
                        选择其他文件夹…
                      </button>
                    )}
                  </div>
                </div>
                {!dialog.destination.trim() &&
                  dialog.items.some((item) => !item.originalPath) && (
                    <p role="alert">
                      部分项目没有原位置记录，请选择恢复目标文件夹。
                    </p>
                  )}
              </>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                autoFocus={dialog.action !== "restore"}
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                取消
              </button>
              <button
                className={
                  dialog.action === "restore"
                    ? "primary"
                    : "sidebar-dialog-danger"
                }
                type="submit"
                disabled={
                  busy ||
                  (dialog.action === "restore" &&
                    !dialog.destination.trim() &&
                    dialog.items.some((item) => !item.originalPath))
                }
              >
                {dialog.action === "restore" ? "恢复" : "永久删除"}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
