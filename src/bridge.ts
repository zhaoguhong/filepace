import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Entry } from "./model";
export const desktop = isTauri();
const root = "/Users/demo";
const demo: Entry[] = [
  ["项目", true, 0],
  ["设计素材", true, 0],
  ["旅行照片", true, 0],
  ["品牌设计指南.pdf", false, 2349091],
  ["产品需求.md", false, 8240],
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
  if (command === "tasks") return [] as T;
  if (command === "load_session") return null as T;
  if (command === "save_session") return undefined as T;
  if (command === "read_preview")
    return "Filepace 界面预览\n\n启动桌面应用以浏览和管理真实文件。" as T;
  throw new Error("浏览器为只读界面预览，请启动 Filepace 桌面应用使用此功能。");
}
