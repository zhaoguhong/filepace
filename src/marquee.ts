import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import type { PaneSide } from "./browsePane";
import type { FileLayout } from "./fileViewport";
import type { Entry } from "./model";

type Point = { x: number; y: number };
type Bounds = { left: number; top: number; right: number; bottom: number };
type Source = {
  pane: PaneSide;
  directory: string;
  entries: Entry[];
  rowHeight?: number;
  grid?: FileLayout;
  selected: string[];
  commit: (paths: string[]) => void;
};
type Gesture = Source & {
  list: HTMLDivElement;
  pointerId: number;
  origin: Point;
  pointer: Point;
  additive: boolean;
  toggle: boolean;
  rows?: { path: string; bounds: Bounds }[];
};

function scrollOrigin(list: HTMLDivElement) {
  const rect = list.getBoundingClientRect();
  return { x: rect.left - list.scrollLeft, y: rect.top - list.scrollTop };
}

function readRow(list: HTMLDivElement) {
  const { x, y } = scrollOrigin(list);
  const row = list.querySelector<HTMLElement>("[role=option][data-path]");
  if (!row) return [];
  const { left, top, right, bottom } = row.getBoundingClientRect();
  return [{ path: row.dataset.path!, bounds: { left: left - x, top: top - y, right: right - x, bottom: bottom - y } }];
}

function selection(gesture: Gesture) {
  const { list, origin, pointer, rowHeight, grid, entries, rows } = gesture;
  const view = list.getBoundingClientRect();
  const { x, y } = scrollOrigin(list);
  const endX =
    Math.max(view.left, Math.min(pointer.x, view.left + list.clientWidth)) - x;
  const endY =
    Math.max(view.top, Math.min(pointer.y, view.top + list.clientHeight)) - y;
  const left = Math.min(origin.x, endX),
    right = Math.max(origin.x, endX);
  const top = Math.min(origin.y, endY),
    bottom = Math.max(origin.y, endY);
  let hits: string[] = [];
  if (rowHeight) {
    const row = rows?.[0]?.bounds;
    if (row && left < row.right && right > row.left) {
      hits = entries
        .slice(Math.max(0, Math.floor(top / rowHeight)), Math.ceil(bottom / rowHeight))
        .map((entry) => entry.path);
    }
  } else if (grid) {
    const columnStep = grid.width + grid.gap;
    const firstRow = Math.max(0, Math.floor((top - grid.padding) / grid.step));
    const lastRow = Math.min(Math.ceil(entries.length / grid.columns), Math.ceil((bottom - grid.padding) / grid.step));
    const firstColumn = Math.max(0, Math.floor((left - grid.padding) / columnStep));
    const lastColumn = Math.min(grid.columns, Math.ceil((right - grid.padding) / columnStep));
    for (let row = firstRow; row < lastRow; row++) {
      if (grid.padding + row * grid.step + grid.height <= top) continue;
      for (let column = firstColumn; column < lastColumn; column++) {
        if (grid.padding + column * columnStep + grid.width <= left) continue;
        const entry = entries[row * grid.columns + column];
        if (entry) hits.push(entry.path);
      }
    }
  }
  const paths = new Set(gesture.additive ? gesture.selected : []);
  for (const hit of hits) {
    if (gesture.toggle && paths.has(hit)) paths.delete(hit);
    else paths.add(hit);
  }
  const visibleLeft = Math.max(view.left, left + x);
  const visibleTop = Math.max(view.top, top + y);
  return {
    pane: gesture.pane,
    directory: gesture.directory,
    paths,
    style: {
      left: visibleLeft,
      top: visibleTop,
      width: Math.max(
        0,
        Math.min(view.left + list.clientWidth, right + x) - visibleLeft,
      ),
      height: Math.max(
        0,
        Math.min(view.top + list.clientHeight, bottom + y) - visibleTop,
      ),
    },
  };
}

export function useMarquee(suppressClick: RefObject<boolean>) {
  const gesture = useRef<Gesture | null>(null);
  const [frame, setFrame] = useState<ReturnType<typeof selection> | null>(null);

  useEffect(() => {
    let animation = 0;
    function clear() {
      const current = gesture.current;
      gesture.current = null;
      cancelAnimationFrame(animation);
      if (current?.list.hasPointerCapture(current.pointerId))
        current.list.releasePointerCapture(current.pointerId);
      setFrame(null);
    }
    function autoscroll() {
      const current = gesture.current;
      if (!current?.rows) return;
      const { list, pointer } = current;
      const { top } = list.getBoundingClientRect();
      const bottom = top + list.clientHeight;
      const before = list.scrollTop;
      if (pointer.y < top + 20) list.scrollTop -= 14;
      else if (pointer.y > bottom - 20) list.scrollTop += 14;
      if (before !== list.scrollTop) setFrame(selection(current));
      animation = requestAnimationFrame(autoscroll);
    }
    function move(event: globalThis.PointerEvent) {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const { x, y } = scrollOrigin(current.list);
      current.pointer = { x: event.clientX, y: event.clientY };
      if (!current.rows) {
        if (
          Math.hypot(
            event.clientX - x - current.origin.x,
            event.clientY - y - current.origin.y,
          ) < 5
        )
          return;
        current.rows = current.grid ? [] : readRow(current.list);
        suppressClick.current = true;
        animation = requestAnimationFrame(autoscroll);
      }
      event.preventDefault();
      setFrame(selection(current));
    }
    function finish(event: globalThis.PointerEvent) {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if (current.rows) {
        current.pointer = { x: event.clientX, y: event.clientY };
        current.commit([...selection(current).paths]);
      }
      clear();
    }
    function cancel(event: globalThis.PointerEvent) {
      if (event.pointerId === gesture.current?.pointerId) clear();
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || !gesture.current?.rows) return;
      event.stopImmediatePropagation();
      clear();
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("lostpointercapture", cancel);
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", escape, true);
    return () => {
      cancelAnimationFrame(animation);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", escape, true);
    };
  }, [suppressClick]);

  function begin(event: PointerEvent<HTMLDivElement>, source: Source) {
    const list = event.currentTarget;
    const view = list.getBoundingClientRect();
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      event.pointerType === "touch" ||
      !source.entries.length ||
      (event.target as Element).closest("[data-path], button, input") ||
      event.clientX >= view.left + list.clientWidth ||
      event.clientY >= view.top + list.clientHeight
    )
      return;
    const { x, y } = scrollOrigin(list);
    const toggle = event.metaKey || event.ctrlKey;
    gesture.current = {
      ...source,
      list,
      pointerId: event.pointerId,
      origin: { x: event.clientX - x, y: event.clientY - y },
      pointer: { x: event.clientX, y: event.clientY },
      additive: toggle || event.shiftKey,
      toggle,
    };
    list.setPointerCapture(event.pointerId);
    list.focus({ preventScroll: true });
  }

  return { frame, begin };
}
