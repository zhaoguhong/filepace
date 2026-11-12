import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  ClipboardPaste,
  Copy,
  Eye,
  Scissors,
  Trash2,
} from "lucide-react";
import FileIcon from "./FileIcon";
import { desktop } from "./bridge";
import { isMac } from "./fileDrag";
import { formatSize } from "./model";
import {
  indexResultMutations,
  resultFile,
  snapshotResultMutations,
  selectResultPaths,
  type ResultAction,
  type ResultActionProps,
  type ResultFile,
} from "./resultActions";
import "./results.css";
import { mergeFileChanges } from "./resultMutations";
import type { ResultMutations } from "./resultActions";

const statusLabels = {
  moved: "已移动",
  renamed: "已改名",
  trashed: "已移到回收站",
  missing: "文件已不存在",
};

export default function ResultFiles({
  items,
  scope,
  label,
  onBrowse,
  onFileAction,
  fileChanges,
  fileChangeBatches,
  extra,
  showToolbar = true,
  visible = true,
  changeBaseline,
}: ResultActionProps & {
  items: ResultFile[];
  scope: string;
  label: string;
  onBrowse: (path: string, selected?: string) => void;
  extra?: (item: ResultFile) => ReactNode;
  showToolbar?: boolean;
  visible?: boolean;
  changeBaseline?: number;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    paths: string[];
    target?: ResultFile;
  } | null>(null);
  const anchor = useRef<string | null>(null);
  const focus = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const [localChanges, setLocalChanges] = useState<ResultMutations>(() =>
    snapshotResultMutations(items),
  );
  const trackedPaths = useRef(new Set(items.map((item) => item.entry.path)));
  const baseline = useRef(
    changeBaseline ?? fileChangeBatches?.at(-1)?.sequence ?? 0,
  );
  const lastSequence = useRef(
    changeBaseline ?? fileChangeBatches?.at(-1)?.sequence ?? 0,
  );
  useEffect(() => {
    const pending =
      fileChangeBatches?.filter(
        (batch) => batch.sequence > lastSequence.current,
      ) ?? [];
    const missing = items.filter(
      (item) => !trackedPaths.current.has(item.entry.path),
    );
    if (!pending.length && !missing.length) return;
    if (pending.length) {
      lastSequence.current = pending.at(-1)!.sequence;
      setMenu(null);
    }
    const historical =
      fileChangeBatches?.filter((batch) => batch.sequence > baseline.current) ??
      [];
    for (const item of missing) trackedPaths.current.add(item.entry.path);
    const tracked = [...trackedPaths.current];
    setLocalChanges((current) => {
      const added = historical.reduce(
        (changes, batch) => mergeFileChanges(changes, batch.changes),
        snapshotResultMutations(missing),
      );
      const updated = {
        ...pending.reduce(
          (changes, batch) => mergeFileChanges(changes, batch.changes),
          current,
        ),
      };
      // Each key represents one file in this snapshot. Keep those identities
      // separate from source-name aliases introduced by an unrelated operation.
      for (const item of missing)
        updated[item.entry.path] = added[item.entry.path];
      return Object.fromEntries(tracked.map((path) => [path, updated[path]]));
    });
  }, [fileChangeBatches, items]);
  const mutationIndex = useMemo(
    () => indexResultMutations({ ...localChanges, ...fileChanges }),
    [fileChanges, localChanges],
  );
  const rows = items.map((original) => ({
    original,
    ...resultFile(original, {}, mutationIndex),
  }));
  const paths = rows
    .filter((item) => !item.unavailable)
    .map((item) => item.original.entry.path);
  const selectedRows = rows.filter(
    (item) => selected.includes(item.original.entry.path) && !item.unavailable,
  );

  useEffect(() => {
    if (!visible) setMenu(null);
  }, [visible]);
  useEffect(() => {
    setMenu(null);
  }, [fileChanges]);

  useEffect(() => {
    if (!menu) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    const close = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  function focusResultRow(path?: string) {
    const preferred = rows.findIndex(
      (row) => !row.unavailable && row.original.entry.path === path,
    );
    const index =
      preferred >= 0 ? preferred : rows.findIndex((row) => !row.unavailable);
    if (index >= 0) focus.current = rows[index].original.entry.path;
    root.current
      ?.querySelector<HTMLButtonElement>(
        `[data-result-index="${index}"] .result-main`,
      )
      ?.focus({ preventScroll: true });
  }

  function act(
    action: ResultAction,
    requested = selectedRows,
    target?: ResultFile,
  ) {
    const origin =
      requested.find((item) => item.original.entry.path === focus.current) ??
      requested[0];
    focusResultRow(origin?.original.entry.path ?? focus.current ?? undefined);
    setMenu(null);
    if (onFileAction) {
      onFileAction({
        action,
        entries: requested.map((item) => item.entry),
        allEntries: rows
          .filter((row) => !row.unavailable)
          .map((row) => row.entry),
        scope,
        target: target?.entry,
      });
    } else if (action === "open" || action === "reveal") {
      const item = requested[0];
      if (item)
        onBrowse(
          item.entry.isDir && action === "open" ? item.entry.path : item.parent,
          item.entry.isDir && action === "open" ? undefined : item.entry.path,
        );
    }
  }

  return (
    <div
      className="result-files"
      ref={root}
      data-result-files="true"
      onKeyDown={(event) => {
        // Dialogs can leave focus on their invoking row. Let the shell own
        // Escape/Space and preview navigation while an overlay is open.
        if (document.querySelector(".overlay")) return;
        if ((event.target as Element).closest("input, select, textarea"))
          return;
        const modifier = isMac ? event.metaKey : event.ctrlKey;
        const key = event.key.toLowerCase();
        const button = (event.target as Element).closest("button");
        if (
          (key === "enter" || key === " ") &&
          button &&
          !button.classList.contains("result-main")
        )
          return;
        let action: ResultAction | undefined;
        if (modifier && key === "a") {
          event.preventDefault();
          event.stopPropagation();
          setSelected(paths);
          return;
        }
        if (modifier && key === "c")
          action = event.shiftKey ? "copy-other" : "copy";
        if (modifier && event.shiftKey && key === "m") action = "move-other";
        if (modifier && key === "x") action = "cut";
        if (modifier && key === "v") action = "paste";
        if (key === " " && !modifier && !event.altKey) action = "preview";
        if (key === "enter" && !modifier && !event.altKey)
          action = isMac ? "rename" : "open";
        if (
          (isMac && event.metaKey && key === "i") ||
          (!isMac && event.altKey && key === "enter")
        )
          action = "properties";
        if (isMac && event.metaKey && key === "arrowdown") action = "open";
        if (key === "f2") action = "rename";
        if (
          (!isMac && key === "delete") ||
          (isMac && modifier && key === "backspace")
        )
          action = "trash";
        if (key === "escape") {
          if (!menu && !selectedRows.length) return;
          event.preventDefault();
          event.stopPropagation();
          if (menu) {
            setMenu(null);
            focusResultRow(focus.current ?? undefined);
          } else setSelected([]);
          return;
        }
        if (key === "contextmenu" || (key === "f10" && event.shiftKey)) {
          event.preventDefault();
          event.stopPropagation();
          const primary =
            selectedRows.find(
              (row) => row.original.entry.path === focus.current,
            ) ?? selectedRows.at(-1);
          const element =
            primary &&
            root.current?.querySelector<HTMLElement>(
              `[data-result-index="${rows.indexOf(primary)}"]`,
            );
          const bounds = (element ?? root.current)?.getBoundingClientRect();
          if (bounds)
            setMenu({
              x: bounds.left + 20,
              y: bounds.top + 20,
              paths: selectedRows.map((row) => row.original.entry.path),
              target: primary,
            });
          return;
        }
        if (
          ["arrowdown", "arrowup", "home", "end"].includes(key) &&
          paths.length &&
          !action &&
          !modifier &&
          !event.altKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          const current = paths.indexOf(focus.current ?? selected.at(-1) ?? "");
          const index =
            key === "home"
              ? 0
              : key === "end"
                ? paths.length - 1
                : Math.min(
                    paths.length - 1,
                    Math.max(0, current + (key === "arrowdown" ? 1 : -1)),
                  );
          const path = paths[index];
          focus.current = path;
          setSelected(
            selectResultPaths(
              paths,
              selected,
              path,
              anchor.current,
              event.shiftKey,
              false,
            ),
          );
          if (!event.shiftKey) anchor.current = path;
          root.current
            ?.querySelector<HTMLElement>(
              `[data-result-index="${rows.findIndex((row) => row.original.entry.path === path)}"] .result-main`,
            )
            ?.focus();
          return;
        }
        if (!action) return;
        event.preventDefault();
        event.stopPropagation();
        if (action === "paste" || selectedRows.length) act(action);
      }}
      onContextMenu={(event) => {
        if ((event.target as Element).closest(".result-row")) return;
        event.preventDefault();
        event.stopPropagation();
        setMenu({
          x: event.clientX,
          y: event.clientY,
          paths: selectedRows.map((row) => row.original.entry.path),
        });
      }}
    >
      {showToolbar && items.length > 0 && (
        <div
          className="result-toolbar"
          role="toolbar"
          aria-label={`${label}操作`}
        >
          <label className="result-select-all">
            <input
              type="checkbox"
              aria-label={`全选${label}`}
              checked={paths.length > 0 && selectedRows.length === paths.length}
              disabled={!paths.length}
              onClick={() => focusResultRow(focus.current ?? paths[0])}
              onChange={(event) =>
                setSelected(event.target.checked ? paths : [])
              }
            />
            <span>
              {selectedRows.length
                ? `已选择 ${selectedRows.length} 项`
                : "选择文件可直接整理"}
            </span>
          </label>
          <button
            title="预览（空格）"
            aria-label="预览所选文件"
            disabled={selectedRows.length !== 1 || selectedRows[0]?.entry.isDir}
            onClick={() => act("preview")}
          >
            <Eye size={14} />
          </button>
          <button
            title="复制"
            aria-label="复制所选文件"
            disabled={!desktop || !selectedRows.length}
            onClick={() => act("copy")}
          >
            <Copy size={14} />
          </button>
          <button
            title="剪切"
            aria-label="剪切所选文件"
            disabled={!desktop || !selectedRows.length}
            onClick={() => act("cut")}
          >
            <Scissors size={14} />
          </button>
          <button
            title="选择粘贴位置"
            aria-label="选择粘贴位置"
            disabled={!desktop}
            onClick={() => act("paste")}
          >
            <ClipboardPaste size={14} />
          </button>
          <button
            title="移到回收站"
            aria-label="将所选文件移到回收站"
            disabled={!desktop || !selectedRows.length}
            onClick={() => act("trash")}
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
      <ul
        className="storage-items result-items"
        role="listbox"
        aria-label={label}
        aria-multiselectable="true"
      >
        {rows.map((item, index) => {
          const path = item.original.entry.path;
          const marked = selected.includes(path) && !item.unavailable;
          return (
            <li
              key={path}
              role="option"
              aria-selected={marked}
              aria-disabled={item.unavailable || undefined}
              className={`result-row${marked ? " selected" : ""}${item.unavailable ? " unavailable" : ""}`}
              data-result-index={index}
              data-path={item.entry.path}
            >
              <input
                type="checkbox"
                className="result-checkbox"
                aria-label={`选择 ${item.entry.name}`}
                tabIndex={-1}
                checked={marked}
                disabled={item.unavailable}
                onChange={() => {}}
                onClick={(event) => {
                  focusResultRow(path);
                  setSelected(
                    selectResultPaths(
                      paths,
                      selected,
                      path,
                      anchor.current,
                      event.shiftKey,
                      true,
                    ),
                  );
                  if (!event.shiftKey) anchor.current = path;
                  focus.current = path;
                }}
              />
              <button
                id={`${id}-${index}`}
                className="storage-item result-main"
                title={item.entry.path}
                disabled={item.unavailable}
                onClick={(event) => {
                  event.stopPropagation();
                  event.currentTarget.focus({ preventScroll: true });
                  setSelected(
                    selectResultPaths(
                      paths,
                      selected,
                      path,
                      anchor.current,
                      event.shiftKey,
                      event.metaKey || event.ctrlKey,
                    ),
                  );
                  if (!event.shiftKey) anchor.current = path;
                  focus.current = path;
                }}
                onDoubleClick={() => act("open", [item])}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.focus({ preventScroll: true });
                  focus.current = path;
                  const next = marked ? selected : [path];
                  setSelected(next);
                  setMenu({
                    x: event.clientX,
                    y: event.clientY,
                    paths: next,
                    target: item,
                  });
                }}
              >
                <FileIcon entry={item.entry} showThumbnail={false} />
                <span>
                  <b>{item.entry.name}</b>
                  <small>{item.detail ?? item.parent}</small>
                  {item.status && (
                    <small className="result-status">
                      {statusLabels[item.status]}
                      {item.status === "moved" &&
                      item.parent !== item.original.parent
                        ? ` · ${item.parent}`
                        : ""}
                    </small>
                  )}
                </span>
                <strong>{formatSize(item.entry.size)}</strong>
              </button>
              <button
                className="result-locate"
                title="打开所在目录并选中"
                aria-label="打开所在目录并选中"
                disabled={item.unavailable}
                onClick={() => onBrowse(item.parent, item.entry.path)}
              >
                <ArrowUpRight size={14} />
              </button>
              {!item.unavailable && extra?.(item)}
            </li>
          );
        })}
      </ul>
      {menu &&
        (() => {
          const chosen = rows.filter(
            (row) =>
              menu.paths.includes(row.original.entry.path) && !row.unavailable,
          );
          const single = chosen.length === 1;
          const target = menu.target?.entry.isDir ? menu.target : undefined;
          const shortcuts: Partial<Record<ResultAction, string>> = {
            open: isMac ? "⌘↓" : "Enter",
            preview: "Space",
            copy: isMac ? "⌘C" : "Ctrl+C",
            cut: isMac ? "⌘X" : "Ctrl+X",
            paste: isMac ? "⌘V" : "Ctrl+V",
            rename: isMac ? "Enter" : "F2",
            trash: isMac ? "⌘⌫" : "Delete",
            properties: isMac ? "⌘I" : "Alt+Enter",
          };
          const item = (
            action: ResultAction,
            name: string,
            enabled = true,
            native = false,
          ) => (
            <button
              role="menuitem"
              key={action}
              aria-label={name}
              disabled={!enabled || (native && !desktop)}
              onClick={() => act(action, chosen, target)}
            >
              <span>{name}</span>
              {shortcuts[action] && (
                <kbd aria-hidden="true">{shortcuts[action]}</kbd>
              )}
            </button>
          );
          return (
            <div
              className="result-menu"
              role="menu"
              aria-label="结果文件操作"
              ref={menuRef}
              onKeyDown={(event) => {
                if (
                  !["Escape", "ArrowDown", "ArrowUp", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                event.stopPropagation();
                if (event.key === "Escape") {
                  setMenu(null);
                  focusResultRow(focus.current ?? undefined);
                  return;
                }
                const buttons = Array.from(
                  menuRef.current?.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ) ?? [],
                );
                const current = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : (current +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          buttons.length) %
                        buttons.length;
                buttons[next]?.focus();
              }}
              style={{
                left: Math.max(8, Math.min(menu.x, window.innerWidth - 230)),
                top: Math.max(8, Math.min(menu.y, window.innerHeight - 470)),
              }}
            >
              {item("open", "打开", chosen.length > 0)}
              {item("preview", "预览", single && !chosen[0]?.entry.isDir)}
              {item(
                "open-with",
                "打开方式…",
                single && !chosen[0]?.entry.isDir,
                true,
              )}
              <hr />
              {item("copy", "复制", chosen.length > 0, true)}
              {item("cut", "剪切", chosen.length > 0, true)}
              {item(
                "paste",
                target ? "粘贴到此文件夹" : "选择粘贴位置…",
                true,
                true,
              )}
              {item("copy-to", "复制到…", chosen.length > 0, true)}
              {item("move-to", "移动到…", chosen.length > 0, true)}
              {item(
                "rename",
                chosen.length > 1 ? "批量重命名…" : "重命名…",
                chosen.length > 0,
                true,
              )}
              {item("trash", "移到回收站", chosen.length > 0, true)}
              <hr />
              {item("reveal", "打开所在目录", single)}
              {item("other-pane", "在另一栏定位", single)}
              {item("copy-path", "复制完整路径", chosen.length > 0)}
              {item("properties", "属性", single)}
            </div>
          );
        })()}
    </div>
  );
}
