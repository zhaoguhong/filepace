import { basename, type Entry } from "./model";
import type { DuplicateGuard } from "./duplicateResults";

export type ResultAction =
  | "open"
  | "preview"
  | "copy"
  | "cut"
  | "paste"
  | "trash"
  | "rename"
  | "reveal"
  | "other-pane"
  | "copy-path"
  | "properties"
  | "open-with"
  | "copy-to"
  | "move-to"
  | "copy-other"
  | "move-other";

export type ResultActionRequest = {
  action: ResultAction;
  entries: Entry[];
  allEntries?: Entry[];
  scope: string;
  target?: Entry;
  duplicateGuard?: DuplicateGuard;
};

export type ResultMutation = {
  status?: "moved" | "renamed" | "trashed" | "missing";
  entry?: Entry;
  path?: string;
  parent?: string;
};
export type ResultMutations = Record<string, ResultMutation>;
export type ResultChangeBatch = {
  sequence: number;
  changes: { from: string; to?: string; kind: "move" | "rename" | "trash" }[];
};
export type ResultFile = { entry: Entry; parent: string; detail?: string };
export type ResultActionProps = {
  onFileAction?: (request: ResultActionRequest) => void;
  fileChanges?: ResultMutations;
  fileChangeBatches?: ResultChangeBatch[];
};

const normalize = (path: string) => {
  const value = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(value) || value.startsWith("//")
    ? value.toLowerCase()
    : value;
};
export function indexResultMutations(changes: ResultMutations) {
  return new Map(
    Object.entries(changes).map(([key, change]) => [
      normalize(key),
      { key, change },
    ]),
  );
}

export function snapshotResultMutations(items: ResultFile[]): ResultMutations {
  return Object.fromEntries(
    items.map(({ entry }) => [entry.path, { path: entry.path, entry }]),
  );
}

/** Keep selection keys tied to the snapshot even when a file gets a new path. */
export function resultFile(
  item: ResultFile,
  changes: ResultMutations = {},
  index = indexResultMutations(changes),
) {
  const original = normalize(item.entry.path);
  let match: ReturnType<typeof index.get>;
  for (
    let candidate = original;
    candidate;
    candidate = candidate.slice(0, candidate.lastIndexOf("/"))
  ) {
    match = index.get(candidate);
    if (match) break;
    if (!candidate.includes("/")) break;
  }
  const key = match?.key;
  const change = match?.change;
  const exact = key && normalize(key) === original;
  const destination = change?.path ?? change?.entry?.path;
  const path =
    destination && key
      ? destination.replace(/[\\/]+$/, "") +
        item.entry.path.slice(key.replace(/[\\/]+$/, "").length)
      : undefined;
  const entry =
    exact && change?.entry
      ? change.entry
      : path
        ? { ...item.entry, path, name: basename(path) }
        : item.entry;
  const parent = path
    ? /^[a-z]:[\\/][^\\/]+$/i.test(path)
      ? path.slice(0, 3)
      : path.replace(/[\\/][^\\/]+$/, "") || "/"
    : item.parent;
  return {
    ...item,
    entry,
    parent: exact && change?.parent ? change.parent : parent,
    status:
      path === item.entry.path &&
      (change?.status === "moved" || change?.status === "renamed")
        ? undefined
        : change?.status,
    unavailable:
      change?.status === "trashed" ||
      change?.status === "missing" ||
      (change?.status === "moved" && !destination),
  };
}

export function selectResultPaths(
  paths: string[],
  selected: string[],
  path: string,
  anchor: string | null,
  extend: boolean,
  toggle: boolean,
) {
  const current = paths.indexOf(path);
  const start = anchor ? paths.indexOf(anchor) : -1;
  if (extend && start >= 0 && current >= 0) {
    const range = paths.slice(
      Math.min(start, current),
      Math.max(start, current) + 1,
    );
    return toggle ? Array.from(new Set([...selected, ...range])) : range;
  }
  return toggle
    ? selected.includes(path)
      ? selected.filter((item) => item !== path)
      : [...selected, path]
    : [path];
}
