import { useEffect, useMemo, useState } from "react";
import { call } from "./bridge";
import type { Entry } from "./model";

type Rule = "replace" | "affix" | "number";

export default function BatchRename({
  entries,
  onClose,
  onStarted,
}: {
  entries: Entry[];
  onClose: () => void;
  onStarted: (id: string) => void;
}) {
  const [rule, setRule] = useState<Rule>("replace");
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [check, setCheck] = useState<{
    edits: { path: string; name: string }[];
    token?: string;
    error?: string;
  }>();
  const [running, setRunning] = useState(false);
  const edits = useMemo(
    () =>
      entries.map((entry, index) => {
        const dot = entry.isDir ? -1 : entry.name.lastIndexOf(".");
        const stem = dot > 0 ? entry.name.slice(0, dot) : entry.name;
        const extension = dot > 0 ? entry.name.slice(dot) : "";
        const name =
          rule === "replace"
            ? first
              ? stem.replaceAll(first, () => second)
              : stem
            : rule === "affix"
              ? first + stem + second
              : (first || stem + "-") +
                String(index + 1).padStart(String(entries.length).length, "0");
        return { path: entry.path, name: name + extension };
      }),
    [entries, first, second, rule],
  );

  const changed = edits.reduce(
    (count, edit, index) => count + Number(edit.name !== entries[index].name),
    0,
  );
  useEffect(() => {
    if (!changed) return;
    let closed = false;
    const timer = setTimeout(() => {
      void call<string>("preview_batch_rename", { edits }).then(
        (token) => {
          if (!closed) setCheck({ edits, token });
        },
        (error) => {
          if (!closed) setCheck({ edits, error: String(error) });
        },
      );
    }, 180);
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  }, [edits, changed]);
  const current = check?.edits === edits ? check : undefined;

  return (
    <div className="overlay">
      <form
        className="modal form-modal batch-rename"
        role="dialog"
        aria-modal="true"
        aria-label="批量重命名"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!current?.token || running) return;
          setRunning(true);
          try {
            onStarted(
              await call<string>("batch_rename", { token: current.token }),
            );
          } catch (error) {
            setCheck({ edits, error: String(error) });
          } finally {
            setRunning(false);
          }
        }}
      >
        <h3>批量重命名</h3>
        <label>
          规则
          <select
            value={rule}
            onChange={(event) => {
              setRule(event.target.value as Rule);
              setFirst("");
              setSecond("");
            }}
          >
            <option value="replace">查找并替换</option>
            <option value="affix">添加前缀或后缀</option>
            <option value="number">连续编号</option>
          </select>
        </label>
        <label>
          {rule === "replace" ? "查找" : "前缀"}
          <input
            autoFocus
            value={first}
            onChange={(event) => setFirst(event.target.value)}
          />
        </label>
        {rule !== "number" && (
          <label>
            {rule === "replace" ? "替换为" : "后缀"}
            <input
              value={second}
              onChange={(event) => setSecond(event.target.value)}
            />
          </label>
        )}
        <p aria-live="polite">
          {changed} / {entries.length} 项将改名，保留原扩展名。
          {changed > 0 && !current && " 正在检查名称…"}
        </p>
        <div className="batch-preview" role="region" aria-label="改名预览">
          {edits.slice(0, 300).map((edit, index) => (
            <div key={edit.path}>
              <span>{entries[index].name}</span>
              <span>{edit.name}</span>
            </div>
          ))}
        </div>
        {entries.length > 300 && <p>显示前 300 项，预检覆盖全部项目。</p>}
        {current?.error && <p role="alert">{current.error}</p>}
        <div className="modal-buttons">
          <button type="button" disabled={running} onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="primary"
            disabled={!current?.token || running}
          >
            应用改名
          </button>
        </div>
      </form>
    </div>
  );
}
