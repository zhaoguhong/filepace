import type { ResultMutations, ResultMutation } from "./resultActions";

export type FileChange = {
  from: string;
  to?: string;
  kind: "move" | "rename" | "trash";
};
const normalize = (path: string) => {
  const value = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(value) || value.startsWith("//")
    ? value.toLowerCase()
    : value;
};

/** Apply one committed batch simultaneously, including cycles and folder descendants. */
export function mergeFileChanges(
  current: ResultMutations,
  changes: FileChange[],
): ResultMutations {
  if (!changes.length) return current;
  const next = { ...current };
  const mutation = (change: FileChange, path = change.to): ResultMutation => ({
    status:
      change.kind === "trash"
        ? "trashed"
        : change.kind === "rename"
          ? "renamed"
          : "moved",
    path,
  });
  const indexed = new Map(
    changes.map((change) => [normalize(change.from), change]),
  );
  function findChange(path: string) {
    let candidate = normalize(path);
    while (candidate) {
      const change = indexed.get(candidate);
      if (change) return change;
      const separator = candidate.lastIndexOf("/");
      if (separator < 0) break;
      candidate = candidate.slice(0, separator);
    }
    return undefined;
  }
  for (const [original, existing] of Object.entries(current)) {
    if (existing.status === "trashed" || existing.status === "missing")
      continue;
    const location = existing.path ?? existing.entry?.path ?? original;
    const change = findChange(location);
    if (!change) continue;
    next[original] = mutation(
      change,
      change.to
        ? change.to.replace(/[\\/]+$/, "") +
            location.slice(change.from.replace(/[\\/]+$/, "").length)
        : undefined,
    );
  }
  for (const change of changes) {
    // A prior alias may already track a different file at the original name.
    // Keep that alias; fresh snapshots carry the new current path instead.
    if (!current[change.from]) next[change.from] = mutation(change);
  }
  return next;
}
