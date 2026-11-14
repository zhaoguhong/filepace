import type { RankedItem, ScanCounts, StorageReport } from "./storageTypes";

export type StorageBaseline = {
  path: string;
  scannedAt: number;
  counts: ScanCounts;
  folders: RankedItem[];
  foldersComplete: boolean;
};
export const storageBaselineKey = "filepace-storage-baselines-v1";
export const storageBaselinesChanged = "filepace-storage-baselines-changed";
export function storagePathKey(path: string) {
  const value = path.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  return /^[a-z]:/i.test(value) || value.startsWith("//")
    ? value.toLowerCase()
    : value;
}
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 8192;
function valid(value: unknown): value is StorageBaseline {
  if (!value || typeof value !== "object") return false;
  const item = value as StorageBaseline;
  return (
    text(item.path) &&
    nonnegative(item.scannedAt) &&
    Boolean(item.counts) &&
    [
      item.counts.files,
      item.counts.folders,
      item.counts.bytes,
      item.counts.skipped,
    ].every(nonnegative) &&
    typeof item.foldersComplete === "boolean" &&
    Array.isArray(item.folders) &&
    item.folders.length <= 256 &&
    item.folders.every(
      (folder) =>
        folder &&
        text(folder.path) &&
        text(folder.name) &&
        text(folder.parent) &&
        storagePathKey(folder.parent) === storagePathKey(item.path) &&
        nonnegative(folder.size) &&
        nonnegative(folder.files),
    ) &&
    new Set(item.folders.map((folder) => storagePathKey(folder.path))).size ===
      item.folders.length
  );
}
export function createStorageBaseline(
  report: StorageReport,
  scannedAt: number,
): StorageBaseline {
  const folders = report.tree
    ? report.tree.filter(
        (node) =>
          node.isDir &&
          storagePathKey(node.parent) === storagePathKey(report.path),
      )
    : report.folders;
  return {
    path: report.path,
    scannedAt,
    counts: { ...report.counts },
    folders: folders
      .slice(0, 256)
      .map(({ path, name, parent, size, files }) => ({
        path,
        name,
        parent,
        size,
        files,
      })),
    foldersComplete: report.treeComplete === true && folders.length <= 256,
  };
}
export function readStorageBaselines(): StorageBaseline[] {
  try {
    const raw = localStorage.getItem(storageBaselineKey);
    if (!raw || raw.length > 1_000_000) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Map(
        parsed.filter(valid).map((item) => [storagePathKey(item.path), item]),
      ).values(),
    ).slice(-8);
  } catch {
    return [];
  }
}
function write(values: StorageBaseline[]) {
  let bounded = values.slice(-8);
  while (JSON.stringify(bounded).length > 1_000_000 && bounded.length > 1)
    bounded = bounded.slice(1);
  while (
    JSON.stringify(bounded).length > 1_000_000 &&
    bounded[0]?.folders.length
  ) {
    bounded[0] = {
      ...bounded[0],
      folders: bounded[0].folders.slice(
        0,
        Math.floor(bounded[0].folders.length / 2),
      ),
      foldersComplete: false,
    };
  }
  localStorage.setItem(storageBaselineKey, JSON.stringify(bounded));
  window.dispatchEvent(new Event(storageBaselinesChanged));
}
export function saveStorageBaseline(baseline: StorageBaseline) {
  if (!valid(baseline)) throw new Error("扫描基线数据无效，请重新扫描。");
  write([
    ...readStorageBaselines().filter(
      (item) => storagePathKey(item.path) !== storagePathKey(baseline.path),
    ),
    baseline,
  ]);
}
export function removeStorageBaseline(path: string) {
  write(
    readStorageBaselines().filter(
      (item) => storagePathKey(item.path) !== storagePathKey(path),
    ),
  );
}
export function compareStorageBaseline(
  report: StorageReport,
  baseline: StorageBaseline,
) {
  if (storagePathKey(report.path) !== storagePathKey(baseline.path))
    return null;
  const current = createStorageBaseline(report, 0);
  const previous = new Map(
    baseline.folders.map((item) => [storagePathKey(item.path), item]),
  );
  const next = new Map(
    current.folders.map((item) => [storagePathKey(item.path), item]),
  );
  const complete =
    baseline.foldersComplete &&
    current.foldersComplete &&
    baseline.counts.skipped === 0 &&
    report.counts.skipped === 0;
  const changes = [...new Set([...previous.keys(), ...next.keys()])]
    .flatMap((key) => {
      const before = previous.get(key),
        after = next.get(key);
      // An omitted or unreadable folder cannot be classified as added or removed.
      if ((!before || !after) && !complete) return [];
      const delta = (after?.size ?? 0) - (before?.size ?? 0);
      if (!delta && before && after && before.files === after.files) return [];
      return [
        {
          path: (after ?? before)!.path,
          name: (after ?? before)!.name,
          delta,
          before,
          after,
        },
      ];
    })
    .sort(
      (a, b) =>
        Math.abs(b.delta) - Math.abs(a.delta) || a.path.localeCompare(b.path),
    );
  return {
    bytes: report.counts.bytes - baseline.counts.bytes,
    files: report.counts.files - baseline.counts.files,
    complete,
    changes,
  };
}
