import { useLayoutEffect, useRef, type UIEvent } from "react";

/** Hidden WebKit scroll containers may reset their native scroll position. */
export function usePreservedScroll<T extends HTMLElement = HTMLElement>(
  visible: boolean,
) {
  const ref = useRef<T>(null);
  const position = useRef(0);
  const restoring = useRef(false);

  useLayoutEffect(() => {
    if (!visible) return;
    const element = ref.current;
    if (!element) return;
    const top = position.current;
    restoring.current = true;
    element.scrollTop = top;
    // Restore once more after focus effects and WebKit's show/hide layout.
    const frame = requestAnimationFrame(() => {
      element.scrollTop = top;
      restoring.current = false;
    });
    return () => {
      cancelAnimationFrame(frame);
      restoring.current = false;
    };
  }, [visible]);

  return {
    ref,
    onScroll(event: UIEvent<T>) {
      if (visible && !restoring.current)
        position.current = event.currentTarget.scrollTop;
    },
  };
}
