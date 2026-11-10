import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { GridSize, View } from "./model";

const tiles: Record<GridSize, [number, number]> = {
  small: [82, 81],
  medium: [116, 107],
  large: [148, 143],
  "extra-large": [184, 198],
};

export type FileLayout = {
  columns: number;
  width: number;
  height: number;
  step: number;
  gap: number;
  padding: number;
};

export function fileLayout(
  view: View,
  size: GridSize,
  width: number,
): FileLayout {
  if (view !== "grid") {
    const height = view === "columns" ? 34 : 44;
    return { columns: 1, width, height, step: height, gap: 0, padding: 0 };
  }
  const [minimum, height] = tiles[size];
  const gap = 10;
  const padding = 16;
  const available = Math.max(1, width - 2 * padding);
  const columns = Math.max(1, Math.floor((available + gap) / (minimum + gap)));
  return {
    columns,
    width: (available - (columns - 1) * gap) / columns,
    height,
    step: height + gap,
    gap,
    padding,
  };
}

export function visibleRange(
  count: number,
  scroll: number,
  height: number,
  layout: FileLayout,
) {
  const rows = Math.ceil(count / layout.columns);
  const first = Math.max(
    0,
    Math.min(rows - 1, Math.floor((scroll - layout.padding) / layout.step) - 5),
  );
  const end = Math.min(
    rows,
    first + Math.ceil(Math.max(height, 300) / layout.step) + 12,
  );
  return {
    start: first * layout.columns,
    end: Math.min(count, end * layout.columns),
    above: first * layout.step,
    below: (rows - end) * layout.step,
  };
}

export function revealItem(
  element: HTMLElement,
  index: number,
  layout: FileLayout,
  center = false,
) {
  const top = layout.padding + Math.floor(index / layout.columns) * layout.step;
  if (
    center ||
    top < element.scrollTop ||
    top + layout.height > element.scrollTop + element.clientHeight
  ) {
    element.scrollTop = Math.max(
      0,
      top - (center ? (element.clientHeight - layout.height) / 2 : 20),
    );
  }
}

export function useFileViewport(
  view: View = "list",
  size: GridSize = "medium",
) {
  const listRef = useRef<HTMLDivElement>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const attachList = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    setElement(node);
  }, []);
  useLayoutEffect(() => {
    if (!element) return;
    function measure() {
      if (!element) return;
      const { clientWidth: width, clientHeight: height } = element;
      setViewport((prior) =>
        prior.width === width && prior.height === height
          ? prior
          : { width, height },
      );
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, view, size]);
  return {
    listRef,
    attachList,
    element,
    height: viewport.height,
    layout: fileLayout(view, size, viewport.width),
  };
}
