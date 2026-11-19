import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

const focusable =
  "a[href],button,input,select,textarea,summary,[contenteditable],[tabindex]";

function isTabbable(element: HTMLElement) {
  return (
    element.tabIndex >= 0 &&
    !element.matches(":disabled") &&
    !element.closest("[inert]") &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility === "visible"
  );
}

function tabStops(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusable)).filter(
    isTabbable,
  );
}

export default function ModalDialog({
  label,
  className,
  children,
  onEscape,
  returnFocus,
  active = true,
}: {
  label: string;
  className?: string;
  children: ReactNode;
  onEscape?: () => void;
  returnFocus?: HTMLElement | null;
  active?: boolean;
}) {
  const dialog = useRef<HTMLElement>(null);
  const lastFocus = useRef<HTMLElement>(null);
  const [opener] = useState(() => returnFocus ?? document.activeElement);

  useLayoutEffect(() => {
    const element = dialog.current;
    return () => {
      if (
        opener instanceof HTMLElement &&
        opener.isConnected &&
        !element?.closest("[inert]") &&
        (document.activeElement === document.body ||
          element?.contains(document.activeElement))
      )
        opener.focus({ preventScroll: true });
    };
  }, [opener]);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!active || !element) return;
    const current = document.activeElement;
    if (
      current instanceof HTMLElement &&
      element.contains(current) &&
      isTabbable(current)
    )
      return;
    const stops = tabStops(element);
    const target =
      (lastFocus.current && stops.includes(lastFocus.current)
        ? lastFocus.current
        : stops.find((stop) => stop.hasAttribute("data-initial-focus"))) ??
      stops[0] ??
      element;
    target.focus({ preventScroll: true });
  });

  return (
    <div
      className="overlay"
      inert={!active}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
    >
      <section
        ref={dialog}
        className={className ? `modal ${className}` : "modal"}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onFocus={(event) => {
          if (
            event.target !== event.currentTarget &&
            event.target instanceof HTMLElement
          )
            lastFocus.current = event.target;
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Tab") {
            event.preventDefault();
            const stops = tabStops(event.currentTarget);
            const current = document.activeElement;
            const index = stops.findIndex((stop) => stop === current);
            const next = event.shiftKey
              ? (stops[index - 1] ?? stops.at(-1))
              : (stops[index + 1] ?? stops[0]);
            (next ?? event.currentTarget).focus();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onEscape?.();
          }
        }}
      >
        {children}
      </section>
    </div>
  );
}
