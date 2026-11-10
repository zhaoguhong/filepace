import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { call, desktop } from "./bridge";
import type { PaneSide } from "./browsePane";
import type { Entry } from "./model";

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

type DragSelection = { entry: Entry; paths: string[] };
type Source = DragSelection & { pane: PaneSide; directory: string };
type Preview = { entry: Entry; pane: PaneSide; paths: Set<string> };
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
  const copy =
    target.pane === gesture.pane || (isMac ? event.altKey : event.ctrlKey);
  return { ...target, kind: copy ? "copy" : "move" };
}

function positionPreview(element: HTMLElement, { x, y }: Position) {
  const offset = 14;
  const left =
    x + offset + element.offsetWidth <= window.innerWidth - 8
      ? x + offset
      : Math.max(8, x - offset - element.offsetWidth);
  const top =
    y + offset + element.offsetHeight <= window.innerHeight - 8
      ? y + offset
      : Math.max(8, y - offset - element.offsetHeight);
  element.style.transform = `translate3d(${left}px, ${top}px, 0)`;
}

function nativePreview(row: HTMLElement, { entry, paths }: DragSelection) {
  const canvas = document.createElement("canvas");
  canvas.width = 240;
  canvas.height = 46;
  const context = canvas.getContext("2d");
  if (!context) return;

  context.font = "600 13px system-ui, sans-serif";
  const suffix = paths.length > 1 ? ` · ${paths.length} 项` : "";
  const characters = Array.from(entry.name);
  let label = entry.name + suffix;
  while (characters.length && context.measureText(label).width > 190) {
    characters.pop();
    label = characters.join("") + "…" + suffix;
  }
  canvas.width = Math.ceil(49 + context.measureText(label).width);
  context.beginPath();
  if (context.roundRect)
    context.roundRect(1, 1, canvas.width - 2, canvas.height - 2, 8);
  else context.rect(1, 1, canvas.width - 2, canvas.height - 2);
  context.fillStyle = "#f7faff";
  context.fill();
  context.strokeStyle = "#b8cce7";
  context.stroke();

  const icon = row.querySelector<HTMLImageElement>(".entry-icon img");
  if (icon?.complete && icon.naturalWidth && icon.naturalHeight) {
    const scale = 29 / Math.max(icon.naturalWidth, icon.naturalHeight);
    const width = icon.naturalWidth * scale;
    const height = icon.naturalHeight * scale;
    context.drawImage(
      icon,
      8 + (29 - width) / 2,
      (46 - height) / 2,
      width,
      height,
    );
  } else {
    context.fillStyle = "#cdddf4";
    context.fillRect(14, 11, 18, 24);
  }
  context.font = "600 13px system-ui, sans-serif";
  context.fillStyle = "#26384f";
  context.textBaseline = "middle";
  context.fillText(label, 40, 23);
  const png = canvas.toDataURL("image/png").split(",")[1];
  return Array.from(atob(png), (byte) => byte.charCodeAt(0));
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
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  function nativeDrag(
    selection: DragSelection,
    row: HTMLElement,
    sourcePane?: PaneSide,
  ) {
    latest.current.onStart();
    let previewImage: number[] | undefined;
    try {
      previewImage = nativePreview(row, selection);
    } catch {
      // The native command has a bundled fallback if the image cannot be captured.
    }
    call("start_file_drag", {
      paths: selection.paths,
      sourcePane,
      previewImage,
    }).catch((error) => latest.current.onError(String(error)));
  }

  useLayoutEffect(() => {
    if (preview && previewRef.current && pointer.current)
      positionPreview(previewRef.current, pointer.current.position);
  }, [preview]);

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
    // Keep local drops in the webview and hand off to the OS at the window edge.
    function clear() {
      const gesture = pointer.current;
      pointer.current = null;
      if (gesture?.row.hasPointerCapture(gesture.pointerId))
        gesture.row.releasePointerCapture(gesture.pointerId);
      setHint(null);
      setPreview(null);
    }
    function move(event: PointerEvent) {
      const gesture = pointer.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
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
        setPreview({
          entry: gesture.entry,
          pane: gesture.pane,
          paths: new Set(gesture.paths),
        });
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
        nativeDrag(
          gesture,
          gesture.row,
          latest.current.split ? gesture.pane : undefined,
        );
        return;
      }
      if (previewRef.current)
        positionPreview(previewRef.current, gesture.position);
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
      const target = gesture.started ? pointerTarget(gesture, event) : null;
      clear();
      if (target)
        latest.current.transfer(
          target.kind,
          gesture.paths,
          target.path,
          !latest.current.split,
        );
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

  return { hint, preview, previewRef, suppressClick, begin };
}
