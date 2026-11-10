import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { call, desktop } from "./bridge";
import type { PaneSide } from "./browsePane";

export const isMac = navigator.platform.includes("Mac");
type FileTransfer = "copy" | "move";
type Position = { x: number; y: number };
type Target = { pane: PaneSide; path: string; folder?: string };
type DropHint = Target & { kind: FileTransfer };
type NativeDrag =
  | {
      type: "hover";
      position: Position;
      kind: FileTransfer;
      sourcePane?: PaneSide;
    }
  | {
      type: "drop";
      position: Position;
      kind: FileTransfer;
      paths: string[];
      betweenWindows: boolean;
      sourcePane?: PaneSide;
    }
  | { type: "leave" };

type Source = { pane: PaneSide; directory: string; paths: string[] };
type Gesture = Source & {
  pointerId: number;
  row: HTMLElement;
  origin: Position;
  position: Position;
  started: boolean;
};

function targetAt({ x, y }: Position): Target | null {
  const element = document.elementFromPoint(x, y);
  const list = element?.closest<HTMLElement>("[data-drop-path]");
  const pane = list?.dataset.pane;
  const path = list?.dataset.dropPath;
  if (!path || (pane !== "left" && pane !== "right")) return null;
  const folder =
    element?.closest<HTMLElement>("[data-directory]")?.dataset.directory;
  return { pane, path: folder ?? path, folder };
}

function pointerTarget(
  gesture: Gesture,
  event: { altKey: boolean; ctrlKey: boolean },
): DropHint | null {
  const target = targetAt(gesture.position);
  if (
    !target ||
    target.path === gesture.directory ||
    gesture.paths.includes(target.path)
  )
    return null;
  if (target.pane === gesture.pane && !target.folder) return null;
  const copy =
    target.pane === gesture.pane || (isMac ? event.altKey : event.ctrlKey);
  return { ...target, kind: copy ? "copy" : "move" };
}

export function useFileDrag(options: {
  split: boolean;
  focusedPath?: string;
  transfer: (
    kind: FileTransfer,
    paths: string[],
    path: string,
    showTasks: boolean,
  ) => void;
  onError: (error: string) => void;
  onStart: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const pointer = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const [hint, setHint] = useState<DropHint | null>(null);
  const [dragging, setDragging] = useState(false);

  function nativeDrag(paths: string[], sourcePane?: PaneSide) {
    latest.current.onStart();
    call("start_file_drag", { paths, sourcePane }).catch((error) =>
      latest.current.onError(String(error)),
    );
  }

  useEffect(() => {
    if (!desktop) return;
    const stop = getCurrentWebview().listen<NativeDrag>(
      "filepace-file-drag",
      ({ payload: event }) => {
        if (event.type === "leave") {
          setHint(null);
          return;
        }
        const target = targetAt(event.position);
        const kind =
          event.sourcePane && target?.pane === event.sourcePane
            ? "copy"
            : event.kind;
        if (event.type === "hover") {
          setHint(target ? { ...target, kind } : null);
          return;
        }
        setHint(null);
        const internal = event.betweenWindows || Boolean(event.sourcePane);
        const path =
          target?.path ?? (!internal ? latest.current.focusedPath : undefined);
        if (path)
          latest.current.transfer(kind, event.paths, path, !event.sourcePane);
      },
    );
    return () => {
      stop.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    // Captured pointer events keep the two panes independent of the OS file-drag loop.
    function clear() {
      const gesture = pointer.current;
      pointer.current = null;
      if (gesture?.row.hasPointerCapture(gesture.pointerId))
        gesture.row.releasePointerCapture(gesture.pointerId);
      setHint(null);
      setDragging(false);
    }
    function move(event: PointerEvent) {
      const gesture = pointer.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      if (!latest.current.split) {
        clear();
        return;
      }
      gesture.position = { x: event.clientX, y: event.clientY };
      if (!gesture.started) {
        const distance = Math.hypot(
          event.clientX - gesture.origin.x,
          event.clientY - gesture.origin.y,
        );
        if (distance < 5) return;
        gesture.started = true;
        suppressClick.current = true;
        latest.current.onStart();
        setDragging(true);
      }
      event.preventDefault();
      if (
        desktop &&
        (event.clientX < 0 ||
          event.clientY < 0 ||
          event.clientX >= window.innerWidth ||
          event.clientY >= window.innerHeight)
      ) {
        clear();
        nativeDrag(gesture.paths, gesture.pane);
        return;
      }
      const next = pointerTarget(gesture, event);
      setHint((previous) =>
        previous?.pane === next?.pane &&
        previous?.path === next?.path &&
        previous?.kind === next?.kind
          ? previous
          : next,
      );
    }
    function end(event: PointerEvent) {
      const gesture = pointer.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      gesture.position = { x: event.clientX, y: event.clientY };
      const target =
        gesture.started && latest.current.split
          ? pointerTarget(gesture, event)
          : null;
      clear();
      if (target)
        latest.current.transfer(target.kind, gesture.paths, target.path, false);
    }
    function cancel(event: PointerEvent) {
      if (pointer.current?.pointerId === event.pointerId) clear();
    }
    function key(event: KeyboardEvent) {
      const gesture = pointer.current;
      if (!gesture?.started) return;
      if (event.key === "Escape") clear();
      else if (event.key === "Alt" || event.key === "Control")
        setHint(pointerTarget(gesture, event));
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("lostpointercapture", cancel);
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
    };
  }, []);

  function begin(event: ReactPointerEvent<HTMLElement>, source: Source) {
    if (
      !latest.current.split ||
      !event.isPrimary ||
      event.button !== 0 ||
      event.pointerType === "touch" ||
      (event.target as Element).closest("input")
    )
      return;
    const position = { x: event.clientX, y: event.clientY };
    pointer.current = {
      ...source,
      row: event.currentTarget,
      pointerId: event.pointerId,
      origin: position,
      position,
      started: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  return { hint, dragging, suppressClick, begin, nativeDrag };
}
