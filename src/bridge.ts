import { invoke, isTauri } from "@tauri-apps/api/core";
import { describeFile } from "./fileTypes";
import type { Entry } from "./model";
import type { StorageReport, StorageVolume } from "./storageTypes";
import type { SearchReport } from "./SearchPanel";
import type { DiagnosisAgentInfo } from "./StorageDiagnosis";
import type { DuplicateReport } from "./duplicateResults";
export const desktop = isTauri();
const root = "/Users/demo";
const demo: Entry[] = [
  ["项目", true, 0],
  ["设计素材", true, 0],
  ["旅行照片", true, 0],
  ["品牌设计指南.pdf", false, 2349091],
  ["产品需求.md", false, 8240],
  ["会议纪要.docx", false, 24192],
  ["预算表.xlsx", false, 54208],
  ["季度汇报.pptx", false, 1805312],
  ["封面.png", false, 1520030],
  ["会议记录.txt", false, 4208],
  ["数据备份.zip", false, 29384012],
  [".配置", false, 120],
].map(([name, isDir, size], i) => ({
  name: String(name),
  isDir: Boolean(isDir),
  size: Number(size),
  path: `${root}/${name}`,
  isLink: false,
  hidden: String(name).startsWith("."),
  modified: 1794230000 - i * 20000,
}));
export async function call<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (desktop) return invoke<T>(command, args);
  if (command === "places")
    return [
      { name: "个人目录", path: root, kind: "favorite" },
      { name: "桌面", path: root + "/Desktop", kind: "favorite" },
      { name: "下载", path: root + "/Downloads", kind: "favorite" },
      { name: "文档", path: root + "/Documents", kind: "favorite" },
      { name: "图片", path: root + "/Pictures", kind: "favorite" },
      { name: "系统磁盘", path: "/", kind: "disk" },
    ] as T;
  if (command === "list_directory")
    return {
      path: args.path,
      parent: String(args.path).split("/").slice(0, -1).join("/") || null,
      entries: args.path === root ? demo : [],
    } as T;
  if (command === "tasks") return { tasks: [], undo: null, revision: 0 } as T;
  if (command === "search_files") {
    const query = String(args.query).toLowerCase();
    const hits = (args.path === root || args.path === "/" ? demo : [])
      .filter((entry) =>
        (args.hidden || !entry.hidden) &&
        entry.name.toLowerCase().includes(query) &&
        (args.minSize === undefined || (!entry.isDir && entry.size >= Number(args.minSize))) &&
        (args.modifiedAfter === undefined || entry.modified >= Number(args.modifiedAfter)) &&
        (!args.category || describeFile(entry).category === args.category ||
          (entry.isDir && args.category === "folder")),
      )
      .map((entry) => ({ entry, parent: root }));
    return { hits, indexed: false, limited: false, skipped: 0 } satisfies SearchReport as T;
  }
  if (command === "cancel_search") return undefined as T;
  if (command === "find_duplicates") {
    const path = String(args.path);
    const source = { ...demo.find((entry) => entry.name === "产品需求.md")!, path: path + "/产品需求.md" };
    return {
      path,
      groups: [{ id: "demo-identical-document", size: source.size, files: [source, { ...source, name: "产品需求-副本.md", path: path + "/归档/产品需求-副本.md" }] }],
      scannedFiles: 12,
      scannedBytes: 34 * 1024 ** 2,
      skipped: 0,
      limited: false,
      hardLinks: 0,
    } satisfies DuplicateReport as T;
  }
  if (command === "cancel_duplicates") return undefined as T;
  if (command === "storage_volumes") {
    return [
      {
        name: "系统磁盘",
        path: "/",
        total: 512 * 1024 ** 3,
        available: 203 * 1024 ** 3,
      },
      {
        name: "外接磁盘",
        path: "/Volumes/Workspace",
        total: 1024 ** 4,
        available: 761 * 1024 ** 3,
      },
    ] satisfies StorageVolume[] as T;
  }
  if (command === "scan_storage") {
    const path = String(args.path);
    const report: StorageReport = {
      path,
      counts: { bytes: 0, files: 0, folders: 0, skipped: 0 },
      categories: {},
      folders: [],
    };
    if (path === root || path === "/") {
      for (const entry of demo) {
        if (entry.isDir) {
          report.counts.folders++;
          report.folders.push({
            name: entry.name,
            path: entry.path,
            parent: root,
            size: 0,
            files: 0,
          });
          continue;
        }
        report.counts.files++;
        report.counts.bytes += entry.size;
        const category = describeFile(entry).category;
        const group = (report.categories[category] ??= {
          bytes: 0,
          files: 0,
          largest: [],
        });
        group.files++;
        group.bytes += entry.size;
        group.largest.push({
          name: entry.name,
          path: entry.path,
          parent: root,
          size: entry.size,
          files: 1,
        });
      }
    }
    return report as T;
  }
  if (command === "cancel_storage_scan") return undefined as T;
  if (command === "diagnosis_agents") return [
    { id: "codex", name: "Codex", path: null, error: null },
    { id: "claude", name: "Claude Code", path: null, error: null },
    { id: "opencode", name: "OpenCode", path: null, error: null },
    { id: "deepseek", name: "DeepSeek Harness", path: null, error: null },
  ] satisfies DiagnosisAgentInfo[] as T;
  if (command === "load_session") return null as T;
  if (command === "save_session") return undefined as T;
  if (command === "read_preview")
    return "Filepace 界面预览\n\n启动桌面应用以浏览和管理真实文件。" as T;
  throw new Error("浏览器为只读界面预览，请启动 Filepace 桌面应用使用此功能。");
}
