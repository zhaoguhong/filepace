import { useEffect, useRef, useState } from "react";
import ModalDialog from "./ModalDialog";
import { cleanPane, restoreSession, type Session } from "./session";

type Layout = { id: string; name: string; session: Session };
const key = "filepace-work-layouts";
function readLayouts(): Layout[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is Layout =>
          item &&
          typeof item.id === "string" &&
          typeof item.name === "string" &&
          item.session?.tabs?.length &&
          item.session.tabs.every(
            (tab: { path?: unknown }) => typeof tab?.path === "string",
          ),
      )
      .slice(0, 12);
  } catch {
    return [];
  }
}
export default function WorkLayouts({
  session,
  onRestore,
  onClose,
  returnFocus,
  active,
}: {
  session: Session;
  onRestore: (session: Session) => void;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
  active?: boolean;
}) {
  const [layouts, setLayouts] = useState(readLayouts);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [replaceLayout, setReplaceLayout] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setLayouts(readLayouts());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  function resetEditor() {
    setEditing(null);
    setName("");
    setReplaceLayout(false);
    setError("");
    nameInput.current?.focus();
  }
  function save(next: Layout[]) {
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setLayouts(next);
      setError("");
      return true;
    } catch (error) {
      setError(String(error));
      return false;
    }
  }
  return (
    <ModalDialog
      className="form-modal"
      label="工作布局"
      onEscape={editing ? resetEditor : onClose}
      returnFocus={returnFocus}
      active={active}
    >
      <h3>工作布局</h3>
      <p>保存当前左右目录、标签页与视图，之后一次恢复。最多保存 12 个布局。</p>
      <form
        className="work-layout-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          const latest = readLayouts();
          if (editing && !latest.some((layout) => layout.id === editing)) {
            setError("此布局已在其他窗口删除，请取消编辑后重新保存。");
            setLayouts(latest);
            return;
          }
          if (!editing && latest.length >= 12) {
            setError("最多保存 12 个布局，请编辑现有布局或删除一个后再保存。");
            setLayouts(latest);
            return;
          }
          const saved = {
            ...session,
            ...cleanPane(session),
            right: session.right && cleanPane(session.right),
          };
          const next = editing
            ? latest.map((layout) =>
                layout.id === editing
                  ? {
                      ...layout,
                      name: name.trim(),
                      session: replaceLayout ? saved : layout.session,
                    }
                  : layout,
              )
            : [
                ...latest,
                {
                  id: crypto.randomUUID(),
                  name: name.trim(),
                  session: saved,
                },
              ];
          if (save(next)) resetEditor();
        }}
      >
        <label>
          布局名称
          <input
            ref={nameInput}
            aria-label="布局名称"
            data-initial-focus
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {editing && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={replaceLayout}
              onChange={(event) => setReplaceLayout(event.target.checked)}
            />
            同时更新为当前标签页与分栏
          </label>
        )}
        {editing && <p>未勾选时只修改名称，保留原布局。</p>}
        <button
          className="primary"
          disabled={!name.trim() || (!editing && layouts.length >= 12)}
        >
          {editing ? "保存修改" : "保存当前布局"}
        </button>
        {editing && (
          <button type="button" onClick={resetEditor}>
            取消编辑
          </button>
        )}
      </form>
      <div className="work-layout-list">
        {layouts.map((layout) => (
          <div key={layout.id}>
            <span
              title={[
                ...layout.session.tabs,
                ...(layout.session.right?.tabs ?? []),
              ]
                .map((tab) => tab.path)
                .join("\n")}
            >
              <b>{layout.name}</b>
              <small>
                {layout.session.tabs.length +
                  (layout.session.right?.tabs.length ?? 0)}{" "}
                个标签 · {layout.session.right ? "左右分栏" : "单栏"}
              </small>
            </span>
            <button
              onClick={() => {
                onRestore(
                  restoreSession(layout.session, session.tabs[0].path, "list"),
                );
                onClose();
              }}
            >
              恢复
            </button>
            <button
              aria-label={`编辑布局 ${layout.name}`}
              onClick={() => {
                setEditing(layout.id);
                setName(layout.name);
                setReplaceLayout(false);
                setError("");
                nameInput.current?.focus();
              }}
            >
              编辑
            </button>
            <button
              aria-label={`删除布局 ${layout.name}`}
              onClick={() => {
                if (
                  save(readLayouts().filter((item) => item.id !== layout.id)) &&
                  editing === layout.id
                )
                  resetEditor();
              }}
            >
              删除
            </button>
          </div>
        ))}
        {!layouts.length && <p>还没有保存的布局。</p>}
      </div>
      {error && (
        <p className="danger-text" role="alert">
          {error}
        </p>
      )}
      <div className="modal-buttons">
        <button onClick={onClose}>关闭</button>
      </div>
    </ModalDialog>
  );
}
