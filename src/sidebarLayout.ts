import { useEffect, useRef, useState } from "react";

export const sidebarLayoutKey = "filepace-sidebar-layout-v1";
export const SIDEBAR_MIN = 160;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_COLLAPSE = 64;
export type SidebarLayout = { visible: boolean; width: number };
export const defaultSidebarWidth = () => (window.innerWidth < 1000 ? 180 : 210);
export function normalizeSidebarLayout(
  value: Partial<SidebarLayout> | null,
  fallback = 210,
): SidebarLayout {
  return {
    visible: value?.visible !== false,
    width:
      typeof value?.width === "number" && Number.isFinite(value.width)
        ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, value.width))
        : fallback,
  };
}
function read() {
  try {
    return normalizeSidebarLayout(
      JSON.parse(localStorage.getItem(sidebarLayoutKey) ?? "null"),
      defaultSidebarWidth(),
    );
  } catch {
    return normalizeSidebarLayout(null, defaultSidebarWidth());
  }
}
export function useSidebarLayout() {
  const [layout, setLayout] = useState(read);
  const latest = useRef(layout);
  const [viewport, setViewport] = useState(window.innerWidth);
  const maximum = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, viewport - 420));
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  function change(value: SidebarLayout, persist = true) {
    latest.current = normalizeSidebarLayout(value);
    setLayout(latest.current);
    if (persist) commit();
  }
  function commit() {
    localStorage.setItem(sidebarLayoutKey, JSON.stringify(latest.current));
  }
  function resize(pixels: number) {
    change(
      {
        visible: pixels > SIDEBAR_COLLAPSE,
        width:
          pixels > SIDEBAR_COLLAPSE
            ? Math.max(SIDEBAR_MIN, Math.min(maximum, Math.round(pixels)))
            : latest.current.width,
      },
      false,
    );
  }
  function finishResize(start: SidebarLayout) {
    if (!latest.current.visible)
      change({ ...latest.current, width: start.width });
    else commit();
  }
  return {
    layout,
    visible: layout.visible,
    width: Math.min(layout.width, maximum),
    maximum,
    resize,
    change,
    commit,
    finishResize,
    toggle: () =>
      change({ ...latest.current, visible: !latest.current.visible }),
  };
}
