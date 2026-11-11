import { Check } from "lucide-react";
import type { GridSize, Tab } from "./model";

export const gridSizes: { value: GridSize; label: string }[] = [
  { value: "small", label: "小图标" },
  { value: "medium", label: "中图标" },
  { value: "large", label: "大图标" },
  { value: "extra-large", label: "超大图标" },
];

export default function BrowseOptions({
  tab,
  patch,
  hidden,
  showHidden,
}: {
  tab: Tab;
  patch: (value: Partial<Tab>) => void;
  hidden: boolean;
  showHidden: (value: boolean) => void;
}) {
  return (
    <>
      <div className="menu-section-label">排序</div>
      <div className="option-buttons" role="group" aria-label="排序依据">
        {(
          [
            ["name", "名称"],
            ["modified", "修改日期"],
            ["size", "大小"],
          ] as const
        ).map(([sort, label]) => (
          <button
            key={sort}
            aria-pressed={tab.sort === sort}
            onClick={() =>
              patch({ sort, descending: sort !== "name", scroll: 0 })
            }
          >
            {label}
          </button>
        ))}
      </div>
      <div className="option-buttons" role="group" aria-label="排序方向">
        <button
          aria-pressed={!tab.descending}
          onClick={() => patch({ descending: false, scroll: 0 })}
        >
          升序
        </button>
        <button
          aria-pressed={tab.descending}
          onClick={() => patch({ descending: true, scroll: 0 })}
        >
          降序
        </button>
      </div>
      {tab.view === "list" && (
        <label className="menu-option-row">
          列表分组
          <select
            aria-label="列表分组"
            value={tab.group ?? ""}
            onChange={(event) =>
              patch({
                group: (event.target.value || undefined) as Tab["group"],
                scroll: 0,
              })
            }
          >
            <option value="">不分组</option>
            <option value="kind">按类型分组</option>
            <option value="date">按修改日期分组</option>
          </select>
        </label>
      )}
      <hr />
      <button aria-pressed={hidden} onClick={() => showHidden(!hidden)}>
        <Check size={14} className={hidden ? "" : "size-menu-placeholder"} />
        显示隐藏文件
      </button>
      <div className="menu-section-label">图标大小</div>
      <div
        className="option-buttons icon-size-options"
        role="group"
        aria-label="选择图标大小"
      >
        {gridSizes.map(({ value, label }) => (
          <button
            key={value}
            aria-pressed={
              tab.view === "grid" && (tab.gridSize ?? "medium") === value
            }
            onClick={() => patch({ view: "grid", gridSize: value, scroll: 0 })}
          >
            {label}
          </button>
        ))}
      </div>
      {tab.view === "list" && (
        <button onClick={() => patch({ columnWidths: undefined })}>
          恢复默认列宽
        </button>
      )}
    </>
  );
}
