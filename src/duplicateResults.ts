import type { Entry } from "./model";
import type { ResultActionRequest } from "./resultActions";

export type DuplicateGroup = { id: string; files: Entry[]; size: number };
export type DuplicateGuard = {
  scanId: string;
  groupId: string;
  keeper: string;
};
export type DuplicateReport = {
  path: string;
  groups: DuplicateGroup[];
  scannedFiles: number;
  scannedBytes: number;
  skipped: number;
  limited: boolean;
  hardLinks: number;
};
export type DuplicateProgress = {
  phase: "scan" | "hash" | "verify";
  scannedFiles: number;
  scannedBytes: number;
  checkedFiles: number;
  checkedBytes: number;
};

function normalize(path: string) {
  const value = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(value) || value.startsWith("//")
    ? value.toLowerCase()
    : value;
}
export function duplicatePathsOverlap(a: string, b: string) {
  const left = normalize(a);
  const right = normalize(b);
  return (
    left === right ||
    left.startsWith(right + "/") ||
    right.startsWith(left + "/")
  );
}
export function duplicateParent(path: string) {
  if (/^[a-z]:[\\/][^\\/]+$/i.test(path)) return path.slice(0, 3);
  return path.replace(/[\\/][^\\/]+$/, "") || "/";
}

export function duplicateActionBlocked(
  action: ResultActionRequest,
  keeper: Entry | undefined,
  stale: boolean,
) {
  if (
    !["trash", "cut", "move-to", "move-other", "rename"].includes(action.action)
  )
    return "";
  if (!keeper) return "请先选择并确认要保留的文件。";
  if (stale) return "这一组文件已有变化，请重新检查后再整理。";
  if (
    action.entries.some(
      (entry) => normalize(entry.path) === normalize(keeper.path),
    )
  )
    return "要保留的文件不能加入本组的整理操作。";
  return "";
}
