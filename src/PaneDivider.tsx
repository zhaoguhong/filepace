import { useState } from "react";

export default function PaneDivider({
  ratio,
  onChange,
}: {
  ratio: number;
  onChange: (ratio: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const resize = (value: number) =>
    onChange(Math.max(0.25, Math.min(0.75, value)));
  return (
    <div
      className={`pane-divider${dragging ? " dragging" : ""}`}
      role="separator"
      aria-label="调整左右栏宽度"
      aria-orientation="vertical"
      aria-valuemin={25}
      aria-valuemax={75}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const bounds =
          event.currentTarget.parentElement!.getBoundingClientRect();
        resize((event.clientX - bounds.left) / bounds.width);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
      }}
      onLostPointerCapture={() => setDragging(false)}
      onDoubleClick={() => resize(0.5)}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        resize(
          event.key === "Home"
            ? 0.5
            : ratio + (event.key === "ArrowLeft" ? -0.05 : 0.05),
        );
      }}
    />
  );
}
