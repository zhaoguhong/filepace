import type { Entry } from "./model";
import fileKinds from "./fileKinds.json";

export type FileKind = keyof typeof fileKinds;

export const fileCategoryLabels = {
  folder: "文件夹",
  documents: "文档",
  images: "图片",
  videos: "视频",
  audio: "音频",
  archives: "压缩包",
  code: "代码",
  apps: "应用与安装包",
  other: "其他",
};

const byExtension = new Map<string, FileKind>(
  (Object.keys(fileKinds) as FileKind[]).flatMap((kind) =>
    fileKinds[kind][1]
      .split(" ")
      .filter(Boolean)
      .map((extension) => [extension, kind]),
  ),
);

const formatLabels: Record<string, string> = {
  png: "PNG 图像",
  jpg: "JPEG 图像",
  jpeg: "JPEG 图像",
  webp: "WebP 图像",
  txt: "文本文档",
  pages: "Pages 文档",
  numbers: "Numbers 表格",
  key: "Keynote 演示文稿",
  zip: "ZIP 压缩包",
  mp4: "MP4 视频",
  ts: "TypeScript",
  json: "JSON 文档",
};

export function describeFile(entry: Entry) {
  const name = entry.name.toLowerCase();
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  // @ keys match complete file names; native search and storage use the same table.
  const typeKey = name.startsWith(".env.")
    ? "@.env"
    : /^(dockerfile|containerfile)\./.test(name)
      ? `@${name.slice(0, name.indexOf("."))}`
      : extension || `@${name}`;
  const windows = !entry.path.startsWith("/");
  const macPackage =
    !windows &&
    entry.isDir &&
    !entry.isLink &&
    /^(app|pkg|mpkg|sparsebundle|framework)$/.test(extension);
  const kind =
    entry.isDir && !macPackage
      ? "folder"
      : entry.isLink
        ? "shortcut"
        : (byExtension.get(typeKey) ?? "generic");
  return {
    kind,
    windows,
    shortcut: entry.isLink || kind === "shortcut",
    category: fileKinds[kind][2],
    label: entry.isLink
      ? "符号链接"
      : kind === "folder"
        ? fileKinds.folder[0]
        : Object.hasOwn(formatLabels, extension)
          ? formatLabels[extension]
          : fileKinds[kind][0],
    thumbnail:
      kind === "pdf" ||
      (kind === "image" &&
        /^(png|jpe?g|webp|gif|bmp|heic|heif)$/.test(extension)),
    nativeIcon:
      !entry.isLink &&
      (windows
        ? !entry.isDir &&
          /^(exe|com|scr|cpl|lnk|url|website|appref-ms|msi|msix|msixbundle|appx|appxbundle|ico)$/.test(
            extension,
          )
        : macPackage ||
          (!entry.isDir && /^(pkg|mpkg|dmg|icns|webloc)$/.test(extension))),
  };
}
