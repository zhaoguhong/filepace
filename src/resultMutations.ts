import type { ResultMutations, ResultMutation } from "./resultActions";

export type FileChange = {
  from: string;
  to?: string;
  kind: "move" | "rename" | "trash";
};
type ChangeLink = { next?: { changes: FileChange[]; link: ChangeLink } };
type ChangeTail = { sequence: number; link: ChangeLink };

// Render tokens share only the window's current tail. A long-lived listener
// may capture an old token without retaining any previous file changes.
export class ChangeCursor {
  readonly sequence: number;
  constructor(private readonly tail: ChangeTail = { sequence: 0, link: {} }) {
    this.sequence = tail.sequence;
  }

  retain() {
    return new ChangeBookmark(this.tail.sequence, this.tail.link);
  }

  append(changes: FileChange[]) {
    const link: ChangeLink = {};
    this.tail.link.next = { changes, link };
    this.tail.link = link;
    this.tail.sequence++;
    return new ChangeCursor(this.tail);
  }
}

// Only scans and results hold a starting link. Advance to the rendered
// revision, even if the window received more events before the effect ran.
export class ChangeBookmark {
  constructor(
    readonly sequence: number,
    private readonly link: ChangeLink,
  ) {}

  readThrough(end?: ChangeCursor) {
    const batches: FileChange[][] = [];
    let link = this.link;
    let sequence = this.sequence;
    while (end && sequence < end.sequence && link.next) {
      batches.push(link.next.changes);
      link = link.next.link;
      sequence++;
    }
    return {
      batches,
      after: batches.length ? new ChangeBookmark(sequence, link) : this,
    };
  }
}

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
  scope: "all" | "tracked" = "all",
): ResultMutations {
  if (!changes.length) return current;
  let next = current;
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
    if (next === current) next = { ...current };
    next[original] = mutation(
      change,
      change.to
        ? change.to.replace(/[\\/]+$/, "") +
            location.slice(change.from.replace(/[\\/]+$/, "").length)
        : undefined,
    );
  }
  if (scope === "tracked") return next;
  for (const change of changes) {
    // A prior alias may already track a different file at the original name.
    // Keep that alias; fresh snapshots carry the new current path instead.
    if (!current[change.from]) {
      if (next === current) next = { ...current };
      next[change.from] = mutation(change);
    }
  }
  return next;
}
