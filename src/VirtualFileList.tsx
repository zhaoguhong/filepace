import {
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import { visibleRange, type FileLayout } from "./fileViewport";
import type { Entry, Tab } from "./model";
import type { ScrollPositions } from "./scrollPositions";

export default function VirtualFileList({
  positions,
  tab,
  entries,
  height,
  layout,
  renderRow,
  children,
  ...listProps
}: ComponentProps<"div"> & {
  positions: ScrollPositions;
  tab: Tab;
  entries: Entry[];
  height: number;
  layout: FileLayout;
  renderRow: (entry: Entry, index: number) => ReactNode;
}) {
  const maximum = Math.max(
    0,
    Math.ceil(entries.length / layout.columns) * layout.step +
      2 * layout.padding -
      height,
  );
  // Keep the exact pixel offset for history, but update rows only at a row boundary.
  const scroll = useSyncExternalStore(positions.subscribe, () => {
    const top = Math.min(positions.read(tab), maximum);
    return (
      layout.padding +
      Math.floor((top - layout.padding) / layout.step) * layout.step
    );
  });
  const range = visibleRange(entries.length, scroll, height, layout);
  const shown = entries.slice(range.start, range.end);
  const lead = tab.selected.at(-1);
  const activeId =
    !children && lead && shown.some((entry) => entry.path === lead)
      ? `entry-${tab.id}-${encodeURIComponent(lead)}`
      : undefined;
  return (
    <div {...listProps} aria-activedescendant={activeId}>
      {children ?? (
        <>
          <div role="presentation" style={{ height: range.above }} />
          <div
            role="presentation"
            className={tab.view === "grid" ? "grid-items" : undefined}
            style={
              tab.view === "grid"
                ? {
                    gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
                  }
                : undefined
            }
          >
            {shown.map((entry, index) => renderRow(entry, index + range.start))}
          </div>
          <div role="presentation" style={{ height: range.below }} />
        </>
      )}
    </div>
  );
}
