import { describeFile } from "./fileTypes";

export type Entry = {
  name: string;
  path: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  modified: number;
  hidden: boolean;
};
export type Listing = { path: string; parent: string | null; entries: Entry[] };
export type GridSize = "small" | "medium" | "large" | "extra-large";
export type View = "list" | "columns" | "grid";
export type ListColumnWidths = [number, number, number, number];
export const viewLabels: Record<View, string> = {
  list: "列表",
  columns: "列视图",
  grid: "图标",
};
export type Tab = {
  id: string;
  path: string;
  history: string[];
  index: number;
  locationState?: Record<number, LocationState>;
  query: string;
  view: View;
  columns?: string[];
  gridSize?: GridSize;
  columnWidths?: ListColumnWidths;
  sort: "name" | "modified" | "size";
  group?: "kind" | "date";
  descending: boolean;
  selected: string[];
  scroll: number;
};
type LocationState = Pick<Tab, "columns" | "query" | "selected" | "scroll">;

function locationState(tab: Tab): LocationState {
  return { columns: tab.columns, query: tab.query, selected: tab.selected, scroll: tab.scroll };
}
export type ConflictItem = {
  path: string;
  isDir: boolean;
  size: number | null;
  modified: number | null;
};
export type Task = {
  id: string;
  sequence?: number;
  queuePosition?: number | null;
  pauseRequested?: boolean;
  canPause?: boolean;
  kind: string;
  sources: string[];
  destination: string;
  status: string;
  current: string;
  phase?: string;
  completed: number;
  skipped?: number;
  bytes: number;
  totalBytes?: number | null;
  currentBytes?: number;
  currentTotalBytes?: number | null;
  transferMillis?: number;
  fileChanges?: { from: string; to?: string; kind: "move" | "rename" | "trash" }[];
  errors: string[];
  failedSources?: string[];
  conflict: { id: string; source: ConflictItem | null; destination: ConflictItem } | null;
};
export type FileActivity = { tasks: Task[]; undo: string | null; revision: number };
export type Place = { name: string; path: string; kind: string };
export const basename = (p: string) =>
  p
    .replace(/[\\/]$/, "")
    .split(/[\\/]/)
    .pop() || p;
export const makeTab = (path: string, view: View = "list"): Tab => ({
  id: crypto.randomUUID(),
  path,
  history: [path],
  index: 0,
  query: "",
  view,
  sort: "name",
  descending: false,
  selected: [],
  scroll: 0,
});
export function navigate(tab: Tab, path: string): Tab {
  return {
    ...tab,
    path,
    columns: undefined,
    history: [...tab.history.slice(0, tab.index + 1), path],
    locationState: {
      ...Object.fromEntries(Object.entries(tab.locationState ?? {}).filter(([index]) => Number(index) < tab.index)),
      [tab.index]: locationState(tab),
    },
    index: tab.index + 1,
    query: "",
    selected: [],
    scroll: 0,
  };
}

export function travelTab(tab: Tab, index: number): Partial<Tab> {
  const path = tab.history[index];
  const remembered = tab.locationState?.[index];
  return {
    index,
    path,
    columns: tab.view === "columns" ? remembered?.columns ?? travelColumns(tab, path) : undefined,
    query: remembered?.query ?? "",
    selected: remembered?.selected ?? [],
    scroll: remembered?.scroll ?? 0,
    locationState: { ...tab.locationState, [tab.index]: locationState(tab) },
  };
}

export function columnPaths(tab: Tab) {
  return Array.isArray(tab.columns) && tab.columns.at(-1) === tab.path
    ? tab.columns
    : [tab.path];
}

export function travelColumns(tab: Tab, path: string) {
  const columns = columnPaths(tab);
  const existing = columns.indexOf(path);
  if (existing >= 0) return columns.slice(0, existing + 1);
  const stem = tab.path.replace(/[\\/]+$/, "");
  const suffix = path.slice(stem.length);
  return path.startsWith(stem) && /^[\\/][^\\/]+[\\/]?$/.test(suffix)
    ? [...columns, path]
    : [path];
}
const fileNames = new Intl.Collator("zh-CN", { numeric: true });
const dayFormat = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });

export function entryGroup(entry: Entry, group: NonNullable<Tab["group"]>) {
  return group === "kind" ? describeFile(entry).label : dayFormat.format(entry.modified * 1000);
}

export function sortEntries(
  entries: Entry[],
  sort: Tab["sort"],
  descending: boolean,
  hidden: boolean,
  group?: Tab["group"],
) {
  const visible = entries.filter((entry) => hidden || !entry.hidden);
  const groups = group && new Map(visible.map((entry) => [entry, entryGroup(entry, group)]));
  return visible.sort(
      (a, b) =>
        (groups ? fileNames.compare(groups.get(a)!, groups.get(b)!) * (group === "date" ? -1 : 1) : 0) ||
        Number(b.isDir) - Number(a.isDir) ||
        (descending ? -1 : 1) *
          (sort === "name" ? fileNames.compare(a.name, b.name) : a[sort] - b[sort]),
    );
}

export function filterEntries(entries: Entry[], query: string) {
  const needle = query.toLocaleLowerCase();
  return needle
    ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(needle))
    : entries;
}

export function visibleEntries(entries: Entry[], tab: Tab, hidden: boolean) {
  return filterEntries(sortEntries(entries, tab.sort, tab.descending, hidden, tab.group), tab.query);
}
export function formatSize(size: number, base = 1024) {
  if (size < base) return `${size} B`;
  if (size < base ** 2) return `${(size / base).toFixed(1)} KB`;
  if (size < base ** 3) return `${(size / base ** 2).toFixed(1)} MB`;
  if (size < base ** 4) return `${(size / base ** 3).toFixed(1)} GB`;
  return `${(size / base ** 4).toFixed(1)} TB`;
}
