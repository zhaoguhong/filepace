import { useId, useState } from "react";
import { call } from "./bridge";
import { basename, type Entry } from "./model";
import type { DuplicateGuard } from "./duplicateResults";

export type FileOperation = {
  kind: "copy" | "move" | "rename";
  entries: Entry[];
  sources?: string[];
  destination: string;
  duplicateGuard?: DuplicateGuard;
};

export default function FileOperationDialog({
  operation,
  locations,
  onClose,
  onSubmitted,
  onRenamed,
}: {
  operation: FileOperation;
  locations: string[];
  onClose: () => void;
  onSubmitted: (id: string) => void;
  onRenamed: (from: string, to: string) => void;
}) {
  const [value, setValue] = useState(
    operation.kind === "rename"
      ? operation.entries[0].name
      : operation.destination,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const options = useId();
  const renaming = operation.kind === "rename";
  const sources =
    operation.sources ?? operation.entries.map((entry) => entry.path);
  const title = renaming
    ? "重命名"
    : operation.kind === "copy"
      ? "复制到文件夹"
      : "移动到文件夹";
  return (
    <div
      className="overlay"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !busy) onClose();
      }}
    >
      <form
        className="modal form-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !value.trim()) return;
          setBusy(true);
          setError("");
          try {
            if (renaming) {
              const from = operation.entries[0].path;
              await call("rename_entry", {
                path: from,
                name: value,
                duplicateGuard: operation.duplicateGuard,
              });
              onRenamed(
                from,
                from.slice(
                  0,
                  Math.max(from.lastIndexOf("/"), from.lastIndexOf("\\")) + 1,
                ) + value,
              );
            } else {
              const id = await call<string>("start_task", {
                kind: operation.kind,
                sources,
                destination: value,
                duplicateGuard: operation.duplicateGuard,
              });
              onSubmitted(id);
            }
            onClose();
          } catch (error) {
            setError(String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <h3>{title}</h3>
        <p>
          {renaming
            ? operation.entries[0].path
            : `已选择 ${sources.length} 项。确认后加入文件任务。`}
        </p>
        {!renaming && (
          <div className="operation-sources">
            {sources.slice(0, 5).map((path) => (
              <small key={path} title={path}>
                {basename(path)}
              </small>
            ))}
            {sources.length > 5 && <small>等 {sources.length} 项</small>}
          </div>
        )}
        <label>
          {renaming ? "新名称" : "目标文件夹完整路径"}
          <input
            aria-label={renaming ? "新名称" : "目标文件夹完整路径"}
            autoFocus
            value={value}
            readOnly={busy}
            list={renaming ? undefined : options}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        {!renaming && (
          <>
            <datalist id={options}>
              {locations.map((path) => (
                <option key={path} value={path} />
              ))}
            </datalist>
            <p className="operation-destination">
              最终目标：{value || "请选择一个文件夹"}
            </p>
            <div className="operation-locations">
              {locations.slice(0, 5).map((path) => (
                <button
                  type="button"
                  key={path}
                  title={path}
                  disabled={busy}
                  onClick={() => setValue(path)}
                >
                  {basename(path)}
                </button>
              ))}
            </div>
          </>
        )}
        {error && (
          <p className="danger-text" role="alert">
            {error}
          </p>
        )}
        <div className="modal-buttons">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            type="submit"
            disabled={busy || !value.trim()}
          >
            {busy ? "正在提交…" : renaming ? "应用改名" : "确认目标并开始"}
          </button>
        </div>
      </form>
    </div>
  );
}
