import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import "./commands.css";

export type FileCommand = {
  id: string;
  label: string;
  detail?: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
};

export default function CommandPalette({
  commands,
  onClose,
}: {
  commands: FileCommand[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const filtered = commands.filter((command) =>
    `${command.label} ${command.detail ?? ""}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  useEffect(() => {
    list.current
      ?.querySelector(`[data-command-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const execute = (command: FileCommand) => {
    if (!command.disabled) {
      onClose();
      command.run();
    }
  };
  return (
    <div
      className="overlay command-overlay"
      onClick={onClose}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setActive((current) =>
            Math.max(
              0,
              Math.min(
                filtered.length - 1,
                current + (event.key === "ArrowDown" ? 1 : -1),
              ),
            ),
          );
        }
        if (event.key === "Enter" && filtered[active]) {
          event.preventDefault();
          execute(filtered[active]);
        }
      }}
    >
      <section
        className="modal command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="command-input">
          <Search size={19} />
          <input
            autoFocus
            role="combobox"
            aria-label="搜索操作"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="filepace-commands"
            aria-activedescendant={
              filtered[active] ? `command-${filtered[active].id}` : undefined
            }
            placeholder="搜索操作…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div
          id="filepace-commands"
          role="listbox"
          aria-label="可用操作"
          ref={list}
          className="command-list"
        >
          {filtered.map((command, index) => (
            <div
              key={command.id}
              role="option"
              id={`command-${command.id}`}
              aria-selected={index === active}
              aria-disabled={command.disabled}
              data-command-index={index}
              className="command-option"
              onPointerMove={() => setActive(index)}
              onClick={() => execute(command)}
            >
              <span>
                <b>{command.label}</b>
                {command.detail && <small>{command.detail}</small>}
              </span>
              {command.shortcut && <kbd>{command.shortcut}</kbd>}
            </div>
          ))}
          {!filtered.length && <p>没有匹配的操作</p>}
        </div>
        <footer>↑ ↓ 选择 · Enter 执行</footer>
      </section>
    </div>
  );
}
