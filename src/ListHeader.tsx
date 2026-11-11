import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ListColumnWidths, Tab } from "./model";

const columns = [
  { label: "名称", sort: "name", minimum: 100 },
  { label: "修改日期", sort: "modified", minimum: 70 },
  { label: "类型", minimum: 65 },
  { label: "大小", sort: "size", minimum: 48 },
] as const;

export function listColumnStyle(
  widths: Tab["columnWidths"],
): CSSProperties | undefined {
  if (
    !Array.isArray(widths) ||
    widths.length !== 4 ||
    !widths.every((value) => Number.isFinite(value) && value > 0)
  )
    return;
  return Object.fromEntries(
    widths.map((width, index) => [`--list-column-${index}`, `${width}fr`]),
  ) as CSSProperties;
}

export function changeSort(tab: Tab, sort: Tab["sort"]): Partial<Tab> {
  return {
    sort,
    descending: tab.sort === sort ? !tab.descending : sort !== "name",
    scroll: 0,
  };
}

export default function ListHeader({
  tab,
  patch,
  list,
}: {
  tab: Tab;
  patch: (value: Partial<Tab>) => void;
  list: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    index: number;
    next: number;
    widths: ListColumnWidths;
    original: Tab["columnWidths"];
  } | null>(null);
  const [gutter, setGutter] = useState(0);
  const [measured, setMeasured] = useState([300, 145, 125, 85]);
  useLayoutEffect(() => {
    if (!list) return;
    const measure = () => {
      setGutter(
        list.offsetWidth -
          list.clientWidth +
          parseFloat(getComputedStyle(list).paddingRight),
      );
      const value = sizes().map(Math.round);
      setMeasured((prior) =>
        prior.every((width, index) => width === value[index]) ? prior : value,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    for (const cell of ref.current?.children ?? []) observer.observe(cell);
    return () => observer.disconnect();
  }, [list]);

  function sizes() {
    return Array.from(
      ref.current!.children,
      (cell) => cell.getBoundingClientRect().width,
    ) as ListColumnWidths;
  }
  function nextVisible(index: number, widths: ListColumnWidths) {
    return widths.findIndex((width, next) => next > index && width > 0);
  }
  function resize(
    index: number,
    next: number,
    widths: ListColumnWidths,
    delta: number,
  ) {
    const amount = Math.max(
      Math.min(columns[index].minimum, widths[index]) - widths[index],
      Math.min(
        delta,
        widths[next] - Math.min(columns[next].minimum, widths[next]),
      ),
    );
    const value = [...widths] as ListColumnWidths;
    value[index] += amount;
    value[next] -= amount;
    // Preserve the hidden type column's weight when resizing a narrow pane.
    for (let i = 0; i < value.length; i++)
      if (!value[i]) value[i] = tab.columnWidths?.[i] ?? [300, 145, 125, 85][i];
    patch({ columnWidths: value });
  }
  return (
    <div
      className="column-head"
      ref={ref}
      style={{ paddingRight: `calc(var(--list-padding) + ${gutter}px)` }}
    >
      {columns.map((column, index) => (
        <div
          className={`list-heading${index === 2 ? " type-heading" : ""}`}
          key={column.label}
        >
          {"sort" in column ? (
            <button
              aria-label={`按${column.label}排序`}
              title={
                tab.sort === column.sort
                  ? `${column.label}：${tab.descending ? "降序" : "升序"}`
                  : `按${column.label}排序`
              }
              onClick={() => patch(changeSort(tab, column.sort))}
            >
              {column.label}{" "}
              {tab.sort === column.sort && (
                <span aria-hidden="true">{tab.descending ? "↓" : "↑"}</span>
              )}
            </button>
          ) : (
            <span>{column.label}</span>
          )}
          {index < 3 && (
            <div
              className="column-resizer"
              role="separator"
              aria-label={`调整${column.label}列宽`}
              aria-orientation="vertical"
              aria-valuemin={Math.min(column.minimum, measured[index])}
              aria-valuenow={measured[index]}
              tabIndex={0}
              title="拖动调整列宽，双击恢复默认"
              onDoubleClick={() => patch({ columnWidths: undefined })}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                const widths = sizes();
                const next = nextVisible(index, widths);
                if (next < 0) return;
                drag.current = {
                  x: event.clientX,
                  index,
                  next,
                  widths,
                  original: tab.columnWidths,
                };
                event.currentTarget.focus({ preventScroll: true });
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const current = drag.current;
                if (current)
                  resize(
                    current.index,
                    current.next,
                    current.widths,
                    event.clientX - current.x,
                  );
              }}
              onPointerUp={() => {
                drag.current = null;
              }}
              onPointerCancel={() => {
                if (drag.current)
                  patch({ columnWidths: drag.current.original });
                drag.current = null;
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && drag.current) {
                  event.preventDefault();
                  patch({ columnWidths: drag.current.original });
                  drag.current = null;
                } else if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                  event.preventDefault();
                  event.stopPropagation();
                  const widths = sizes();
                  const next = nextVisible(index, widths);
                  if (next >= 0)
                    resize(
                      index,
                      next,
                      widths,
                      (event.key === "ArrowRight" ? 1 : -1) *
                        (event.shiftKey ? 30 : 10),
                    );
                }
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
