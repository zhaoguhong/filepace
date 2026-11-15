import { useEffect, useRef, useState } from "react";
import {
  defaultSidebarWidth,
  SIDEBAR_MIN,
  type SidebarLayout,
  type useSidebarLayout,
} from "./sidebarLayout";
import "./sidebarDivider.css";

export default function SidebarDivider({
  sidebar,
}: {
  sidebar: ReturnType<typeof useSidebarLayout>;
}) {
  const drag = useRef<{ pointer: number; start: SidebarLayout } | null>(null);
  const [dragging, setDragging] = useState(false);
  function stop() {
    drag.current = null;
    setDragging(false);
    document.documentElement.classList.remove("sidebar-resizing");
  }
  useEffect(
    () => () => document.documentElement.classList.remove("sidebar-resizing"),
    [],
  );
  return (
    <div
      className={`sidebar-divider${dragging ? " dragging" : ""}${sidebar.visible ? "" : " collapsed"}`}
      role="separator"
      aria-label="调整侧栏宽度"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={sidebar.maximum}
      aria-valuenow={sidebar.visible ? sidebar.width : 0}
      aria-valuetext={
        sidebar.visible ? `${sidebar.width} 像素` : "侧栏已隐藏，向右拖动可展开"
      }
      title={
        sidebar.visible
          ? "拖动调整侧栏宽度，拖到最左侧隐藏；双击恢复默认"
          : "向右拖动显示侧栏"
      }
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        drag.current = {
          pointer: event.pointerId,
          start: { ...sidebar.layout },
        };
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        document.documentElement.classList.add("sidebar-resizing");
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointer !== event.pointerId) return;
        const left =
          event.currentTarget.parentElement!.getBoundingClientRect().left;
        sidebar.resize(event.clientX - left);
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointer !== event.pointerId) return;
        sidebar.finishResize(drag.current.start);
        stop();
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => {
        if (drag.current?.pointer !== event.pointerId) return;
        sidebar.change(drag.current.start);
        stop();
      }}
      onLostPointerCapture={() => {
        if (drag.current) {
          sidebar.finishResize(drag.current.start);
          stop();
        }
      }}
      onDoubleClick={() =>
        sidebar.change({ visible: true, width: defaultSidebarWidth() })
      }
      onKeyDown={(event) => {
        if (event.key === "Escape" && drag.current) {
          event.preventDefault();
          event.stopPropagation();
          const pointer = drag.current.pointer;
          sidebar.change(drag.current.start);
          stop();
          if (event.currentTarget.hasPointerCapture(pointer))
            event.currentTarget.releasePointerCapture(pointer);
          return;
        }
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        event.stopPropagation();
        const width = sidebar.visible ? sidebar.width : 0;
        sidebar.resize(
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? sidebar.maximum
              : event.key === "ArrowLeft"
                ? width <= SIDEBAR_MIN
                  ? 0
                  : width - 16
                : width
                  ? width + 16
                  : SIDEBAR_MIN,
        );
        sidebar.commit();
      }}
    />
  );
}
