import { useState } from "react";
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
}: {
  session: Session;
  onRestore: (session: Session) => void;
  onClose: () => void;
}) {
  const [layouts, setLayouts] = useState(readLayouts);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
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
    <div
      className="overlay"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onClose();
      }}
    >
      <section
        className="modal form-modal"
        role="dialog"
        aria-modal="true"
        aria-label="工作布局"
      >
        <h3>工作布局</h3>
        <p>
          保存当前左右目录、标签页与视图，之后一次恢复。最多保存 12 个布局。
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || layouts.length >= 12) return;
            const saved = {
              ...session,
              ...cleanPane(session),
              right: session.right && cleanPane(session.right),
            };
            if (
              save([
                ...layouts,
                { id: crypto.randomUUID(), name: name.trim(), session: saved },
              ])
            )
              setName("");
          }}
        >
          <label>
            布局名称
            <input
              aria-label="布局名称"
              autoFocus
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={!name.trim() || layouts.length >= 12}
          >
            保存当前布局
          </button>
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
                    restoreSession(
                      layout.session,
                      session.tabs[0].path,
                      "list",
                    ),
                  );
                  onClose();
                }}
              >
                恢复
              </button>
              <button
                aria-label={`删除布局 ${layout.name}`}
                onClick={() =>
                  save(layouts.filter((item) => item.id !== layout.id))
                }
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
      </section>
    </div>
  );
}
