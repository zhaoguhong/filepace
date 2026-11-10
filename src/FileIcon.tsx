import Thumbnail from "./Thumbnail";
import { describeFile, type FileKind } from "./fileTypes";
import type { Entry } from "./model";

function page(accent: string, art = "", badge = "") {
  return `
    <path d="M8 2.5h12l7.5 7.5v17.5a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-23a2 2 0 0 1 2-2Z" fill="#fbfdff" stroke="#b8c7da"/>
    <path d="M20 2.5V8a2 2 0 0 0 2 2h5.5Z" fill="${accent}" fill-opacity=".2" stroke="#b8c7da" stroke-linejoin="round"/>
    <g fill="none" stroke="${accent}" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6">${art}</g>
    ${badge}`;
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
  folder: `<path d="M2.5 9a2 2 0 0 1 2-2H12l3 3h12.5a2 2 0 0 1 2 2v12H2.5Z" fill="#70a3eb" stroke="#5185d5"/>
    <path d="M2.5 13.5a2 2 0 0 1 2-2h23a2 2 0 0 1 2 2v10.8a2 2 0 0 1-2 2h-23a2 2 0 0 1-2-2Z" fill="#a9cdfa" stroke="#659be5"/>
    <path d="M4.5 13h23" stroke="#d0e4ff" stroke-linecap="round"/>`,
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
  document: page("#67839e", lines),
  table: page("#378262", grid),
  slides: page("#be602e", slide),
  image: page(
    "#248472",
    '<rect x="10" y="12" width="14" height="12" rx="1.5"/><circle cx="20" cy="15.5" r="1"/><path d="m10 22 4.5-5 3.5 4 2-2 4 3"/>',
  ),
  video: page(
    "#7155b5",
    '<rect x="10" y="12" width="14" height="12" rx="2"/><path d="m15 15 5 3-5 3Z" fill="#7155b5" stroke="none"/>',
  ),
  audio: page(
    "#a7528a",
    '<path d="M15 21v-7l7-1.7v7.2"/><ellipse cx="12.9" cy="21.8" rx="2.1" ry="1.5"/><ellipse cx="19.9" cy="20.3" rx="2.1" ry="1.5"/>',
  ),
  archive: page(
    "#a36d2e",
    '<path d="M16 7v11m-2-8h4m-4 3h4m-4 3h4"/><rect x="14" y="18" width="4" height="5.5" rx="1"/>',
  ),
  code: page(
    "#5764af",
    '<path d="m13 15-3 3.5 3 3.5m8-7 3 3.5-3 3.5m-2.5-8-3 9"/>',
  ),
  installer: page(
    "#4c6a98",
    '<path d="M10.5 18v6h13v-6M17 12v8m-3-3 3 3 3-3"/>',
  ),
  shortcut: page(
    "#55738f",
    '<path d="M11 22v-2a4 4 0 0 1 4-4h7m-4-4 4 4-4 4"/>',
  ),
  generic: page("#9baec4"),
};

const iconUrls = Object.fromEntries(
  Object.entries(art).map(([kind, markup]) => [
    kind,
    `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${markup}</svg>`)}`,
  ]),
) as Record<FileKind, string>;

export default function FileIcon({
  entry,
  type = describeFile(entry),
  showThumbnail = true,
}: {
  entry: Entry;
  type?: ReturnType<typeof describeFile>;
  showThumbnail?: boolean;
}) {
  const icon = <img src={iconUrls[type.kind]} alt="" draggable={false} />;
  return (
    <span className="entry-icon" data-file-kind={type.kind} aria-hidden="true">
      {type.thumbnail && showThumbnail ? (
        <Thumbnail entry={entry} fallback={icon} />
      ) : (
        icon
      )}
    </span>
  );
}
