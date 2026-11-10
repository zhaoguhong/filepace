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
export type Tab = {
  id: string;
  path: string;
  history: string[];
  index: number;
  query: string;
  view: "list" | "grid";
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
export type Place = { name: string; path: string; kind: string };
export const basename = (p: string) =>
  p
    .replace(/[\\/]$/, "")
    .split(/[\\/]/)
    .pop() || p;
export const makeTab = (path: string): Tab => ({
  id: crypto.randomUUID(),
  path,
  history: [path],
  index: 0,
  query: "",
  view: "list",
  sort: "name",
  descending: false,
  selected: [],
  scroll: 0,
});
export function navigate(tab: Tab, path: string): Tab {
  return {
    ...tab,
    path,
    history: [...tab.history.slice(0, tab.index + 1), path],
    index: tab.index + 1,
    query: "",
    selected: [],
    scroll: 0,
  };
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
export function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}
export function typeOf(entry: Entry) {
  if (entry.isLink) return "符号链接";
  if (entry.isDir) return "文件夹";
  const ext = entry.name.split(".").pop()?.toLowerCase();
  return (
    (
      {
        pdf: "PDF 文档",
        png: "PNG 图像",
        jpg: "JPEG 图像",
        jpeg: "JPEG 图像",
        webp: "WebP 图像",
        md: "Markdown 文档",
        txt: "文本文档",
        zip: "ZIP 压缩包",
        mp4: "MP4 视频",
        ts: "TypeScript",
        tsx: "React 组件",
        json: "JSON 文档",
      } as Record<string, string>
    )[ext || ""] || "文件"
  );
}
