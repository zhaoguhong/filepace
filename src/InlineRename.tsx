import { useEffect, useRef, useState } from "react";
import type { Entry } from "./model";

export default function InlineRename({
  entry,
  onCommit,
  onCancel,
}: {
  entry: Entry;
  onCommit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const [busy, setBusy] = useState(false);
  const latest = useRef({ onCommit, onCancel });
  latest.current = { onCommit, onCancel };

  async function commit() {
    if (finished.current || !input.current) return;
    const name = input.current.value;
    finished.current = true;
    if (name === entry.name) {
      latest.current.onCancel();
      return;
    }
    setBusy(true);
    if (!(await latest.current.onCommit(name))) {
      finished.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    // Commit before another pane's pointer handler can unmount the editor.
    const outside = (event: PointerEvent) => {
      if (event.target !== input.current) void commit();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, []);

  return (
    <input
      ref={input}
      autoFocus
      aria-label="新文件名"
      defaultValue={entry.name}
      readOnly={busy}
      onFocus={(event) =>
        event.target.setSelectionRange(
          0,
          entry.isDir
            ? entry.name.length
            : Math.max(0, entry.name.lastIndexOf(".")) || entry.name.length,
        )
      }
      onBlur={() => void commit()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
          return;
        if (event.key === "Enter") {
          event.preventDefault();
          void commit();
        } else if (event.key === "Escape" && !finished.current) {
          event.preventDefault();
          finished.current = true;
          latest.current.onCancel();
        }
      }}
    />
  );
}
