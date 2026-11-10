import Thumbnail from "./Thumbnail";
import { describeFile, type FileKind } from "./fileTypes";
import type { Entry } from "./model";

const sheet = "M8 2.5h12l7.5 7.5v17.5a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-23a2 2 0 0 1 2-2Z";

function page(accent: string, art = "", badge = "") {
  return `
    <path d="${sheet}" fill="#fff"/>
    <path d="${sheet}" fill="${accent}" fill-opacity=".15" stroke="${accent}" stroke-opacity=".58"/>
    <path d="M20 2.5V8a2 2 0 0 0 2 2h5.5Z" fill="${accent}" fill-opacity=".36" stroke="${accent}" stroke-opacity=".55" stroke-linejoin="round"/>
    <g fill="none" stroke="${accent}" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8">${art}</g>
    ${badge}`;
}

function folder(back: string, front: string, edge: string, highlight: string) {
  return `<path d="M2.5 9a2 2 0 0 1 2-2H12l3 3h12.5a2 2 0 0 1 2 2v12H2.5Z" fill="${back}" stroke="${edge}"/>
    <path d="M2.5 13.5a2 2 0 0 1 2-2h23a2 2 0 0 1 2 2v10.8a2 2 0 0 1-2 2h-23a2 2 0 0 1-2-2Z" fill="${front}" stroke="${edge}"/>
    <path d="M4.5 13h23" stroke="${highlight}" stroke-linecap="round"/>`;
}

function officeBadge(color: string, letter: string) {
  return `<rect x="2" y="14" width="14" height="13" rx="2.5" fill="${color}"/>
    <path d="${letter}" fill="none" stroke="white" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/>`;
}

const lines = '<path d="M11 14h11M11 18h11M11 22h8"/>';
const grid =
  '<rect x="11" y="13" width="12" height="11" rx="1"/><path d="M11 17h12m-12 3.5h12M17 13v11"/>';
const slide =
  '<rect x="11" y="13" width="12" height="10" rx="1"/><path d="M15 20v-3m3 3v-5m3 5v-2"/>';

const art: Record<FileKind, string> = {
  folder: folder("#70a3eb", "#a9cdfa", "#568cdb", "#d0e4ff"),
  word: page(
    "#517bc0",
    lines,
    officeBadge("#255eaf", "m5.1 18 1.4 5 2.5-4 2.5 4 1.4-5"),
  ),
  excel: page(
    "#52916c",
    grid,
    officeBadge("#217548", "m6.4 18 5.2 5m0-5-5.2 5"),
  ),
  powerpoint: page(
    "#c77751",
    slide,
    officeBadge("#be502e", "M7 23v-5h3a1.4 1.4 0 0 1 0 2.8H7"),
  ),
  pdf: page(
    "#c74a59",
    '<path d="M11 13h11M11 16h8"/>',
    `<rect x="3" y="18" width="22" height="9" rx="2" fill="#bb374a"/>
    <text x="14" y="24.7" fill="white" font-family="sans-serif" font-weight="700" font-size="6.8" text-anchor="middle">PDF</text>`,
  ),
  document: page("#607489", lines),
  markdown: page("#397d96", '<path d="M10.5 22v-7l3.4 3.2 3.4-3.2v7m4-7v7m-2.6-2.5 2.6 2.5 2.6-2.5"/>'),
  table: page("#378262", grid),
  slides: page("#be602e", slide),
  book: `<rect x="6.5" y="3" width="20" height="26" rx="3" fill="#7863a6" stroke="#5b4888"/>
    <path d="M10.5 4.5v22.8m4-15h8m-8 4h6" fill="none" stroke="#f2eaff" stroke-width="1.7" stroke-linecap="round"/>
    <path d="M10.5 25h14v2.5h-14Z" fill="#e9dff7"/>`,
  image: `<rect x="3" y="5" width="26" height="22" rx="4" fill="#daf3e7" stroke="#308872"/>
    <circle cx="21.5" cy="11.5" r="2.4" fill="#4ea58b"/>
    <path d="m4 22.5 7.5-8 5.2 5.3 3.5-3.8 7.8 7.2v.5a2.4 2.4 0 0 1-2.4 2.4H6.4A2.4 2.4 0 0 1 4 23.7Z" fill="#368d72"/>`,
  design: page(
    "#8d458c",
    '<path d="m11 24 2-6 7.4-5.5 3.1 3.1-5.5 7.4-7 1Z"/><path d="m11 24 5.2-5.2"/><circle cx="16.6" cy="18.4" r="1.4" fill="#8d458c" stroke="none"/>',
  ),
  video: `<rect x="3" y="6" width="26" height="20" rx="4" fill="#e9e0fa" stroke="#7452b4"/>
    <path d="M8.5 7v18m15-18v18M3.5 13h5m-5 6h5m15-6h5m-5 6h5" fill="none" stroke="#7452b4" stroke-width="1.45"/>
    <path d="m13 11.5 7.6 4.5-7.6 4.5Z" fill="#7452b4"/>`,
  audio: page(
    "#a7528a",
    '<path d="M15 21v-7l7-1.7v7.2"/><ellipse cx="12.9" cy="21.8" rx="2.1" ry="1.5"/><ellipse cx="19.9" cy="20.3" rx="2.1" ry="1.5"/>',
  ),
  archive: page(
    "#a36d2e",
    '<path d="M16 7v11m-2-8h4m-4 3h4m-4 3h4"/><rect x="14" y="18" width="4" height="5.5" rx="1"/>',
  ),
  code: page(
    "#345eaa",
    '<path d="m13 15-3 3.5 3 3.5m8-7 3 3.5-3 3.5m-2.5-8-3 9"/>',
  ),
  script: `<rect x="3" y="6" width="26" height="20" rx="4" fill="#285c59" stroke="#1c4946"/>
    <path d="m8.5 12 4 4-4 4m7.5 0h6.5" fill="none" stroke="#d5fae9" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`,
  web: page(
    "#227d99",
    '<circle cx="16.8" cy="18.4" r="6.3"/><ellipse cx="16.8" cy="18.4" rx="2.8" ry="6.3"/><path d="M10.5 18.4h12.6"/>',
  ),
  config: page(
    "#6b607d",
    '<path d="M11 14h12m-12 5h12m-12 5h12"/><path d="M14 12.5v3m6 2v3m-5 2v3" stroke-width="2.6"/>',
  ),
  database: `<path d="M5 8.5h22v14c0 3.1-4.9 5.5-11 5.5S5 25.6 5 22.5Z" fill="#c8ece8" stroke="#297e7b" stroke-width="1.4"/>
    <ellipse cx="16" cy="8.5" rx="11" ry="5.3" fill="#8fd4ce" stroke="#297e7b" stroke-width="1.4"/>
    <path d="M5 15.2c0 3 4.9 5.4 11 5.4s11-2.4 11-5.4" fill="none" stroke="#297e7b" stroke-width="1.4"/>`,
  font: page(
    "#8e4961",
    '<path d="m10.5 24 5.4-12h1.6l5.4 12m-10.5-3.6H21" stroke-width="2.1"/>',
  ),
  library: page(
    "#4c7a7e",
    '<rect x="10.5" y="13" width="8" height="8" rx="1.4"/><rect x="16" y="17" width="8" height="8" rx="1.4" fill="#dce9e9"/>',
  ),
  application: `<rect x="3.5" y="3.5" width="25" height="25" rx="7" fill="#526cc2" stroke="#4059a8"/>
    <path d="M8.5 10a1.5 1.5 0 0 1 1.5-1.5h4v5.5H8.5Zm9.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v4H18ZM8.5 18H14v5.5h-4A1.5 1.5 0 0 1 8.5 22Zm9.5 0h5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4Z" fill="#edf2ff"/>`,
  installer: `<path d="m4 9 12-5 12 5v15l-12 5-12-5Z" fill="#f3d0a9" stroke="#ab703a" stroke-width="1.35" stroke-linejoin="round"/>
    <path d="m4 9 12 5 12-5M16 14v15" fill="none" stroke="#ab703a" stroke-width="1.35" stroke-linejoin="round"/>
    <path d="m10 6.5 12 5v6l-4 1.7v-6.1l-12-5Z" fill="#bd7c40" opacity=".72"/>`,
  disk: `<path d="M6.5 7h19l4 11v5a3 3 0 0 1-3 3h-21a3 3 0 0 1-3-3v-5Z" fill="#d7e4f2" stroke="#577495" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M3 18.5h26M7 22h9" stroke="#577495" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="24" cy="22" r="1.6" fill="#328e76"/>`,
  shortcut: page(
    "#55738f",
    '<path d="M11 22v-2a4 4 0 0 1 4-4h7m-4-4 4 4-4 4"/>',
  ),
  generic: page("#8995a3"),
};

function iconUrl(markup: string) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${markup}</svg>`)}`;
}

const iconUrls = Object.fromEntries(
  Object.entries(art).map(([kind, markup]) => [kind, iconUrl(markup)]),
) as Record<FileKind, string>;
const windowsFolder = iconUrl(folder("#dfa64b", "#ffd277", "#bf8b36", "#ffebad"));

export default function FileIcon({
  entry,
  type = describeFile(entry),
  showThumbnail = true,
}: {
  entry: Entry;
  type?: ReturnType<typeof describeFile>;
  showThumbnail?: boolean;
}) {
  const src = type.kind === "folder" && type.windows ? windowsFolder : iconUrls[type.kind];
  const icon = <img src={src} alt="" draggable={false} />;
  return (
    <span className="entry-icon" data-file-kind={type.kind} aria-hidden="true">
      {type.applicationIcon || (type.thumbnail && showThumbnail) ? (
        <Thumbnail entry={entry} fallback={icon} applicationIcon={type.applicationIcon} />
      ) : (
        icon
      )}
    </span>
  );
}
