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
export type View = "columns" | "list" | "grid";
export const viewLabels: Record<View, string> = {
  columns: "列视图",
  list: "列表",
  grid: "图标",
};
export type Tab = {
  id: string;
  path: string;
  history: string[];
  index: number;
  query: string;
  view: View;
  columns?: string[];
  gridSize?: GridSize;
  sort: "name" | "modified" | "size";
  descending: boolean;
  selected: string[];
  scroll: number;
};
export type Task = {
  id: string;
  kind: string;
  sources: string[];
  destination: string;
  status: string;
  current: string;
  completed: number;
  bytes: number;
  errors: string[];
  conflict: string | null;
};
export type FileActivity = { tasks: Task[]; undo: string | null };
export type Place = { name: string; path: string; kind: string };
export const basename = (p: string) =>
  p
    .replace(/[\\/]$/, "")
    .split(/[\\/]/)
    .pop() || p;
export const makeTab = (path: string, view: View = "columns"): Tab => ({
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
    index: tab.index + 1,
    query: "",
    selected: [],
    scroll: 0,
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
export function visibleEntries(entries: Entry[], tab: Tab, hidden: boolean) {
  return entries
    .filter(
      (e) =>
        (hidden || !e.hidden) &&
        e.name.toLocaleLowerCase().includes(tab.query.toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(b.isDir) - Number(a.isDir) ||
        (tab.descending ? -1 : 1) *
          (tab.sort === "name"
            ? a.name.localeCompare(b.name, "zh-CN", { numeric: true })
            : a[tab.sort] - b[tab.sort]),
    );
}
export function formatSize(size: number, base = 1024) {
  if (size < base) return `${size} B`;
  if (size < base ** 2) return `${(size / base).toFixed(1)} KB`;
  if (size < base ** 3) return `${(size / base ** 2).toFixed(1)} MB`;
  if (size < base ** 4) return `${(size / base ** 3).toFixed(1)} GB`;
  return `${(size / base ** 4).toFixed(1)} TB`;
}
