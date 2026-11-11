export type StorageVolume = {
  name: string;
  path: string;
  total: number | null;
  available: number | null;
};
export type ScanCounts = {
  files: number;
  folders: number;
  bytes: number;
  allocatedBytes?: number;
  skipped: number;
};
export type RankedItem = {
  path: string;
  name: string;
  parent: string;
  size: number;
  files: number;
};
export type Category = { files: number; bytes: number; largest: RankedItem[] };
export type StorageReport = {
  path: string;
  counts: ScanCounts;
  categories: Record<string, Category>;
  folders: RankedItem[];
};
export type StorageSnapshot = {
  scope: string;
  id: string;
  report: StorageReport;
};
