import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareStorageBaseline,
  createStorageBaseline,
  readStorageBaselines,
  removeStorageBaseline,
  saveStorageBaseline,
  storageBaselineKey,
  storagePathKey,
} from "./storageBaseline";
import type { StorageReport } from "./storageTypes";

function report(path = "/data", size = 10): StorageReport {
  return {
    path,
    counts: { bytes: size, files: 1, folders: 1, skipped: 0 },
    categories: {},
    folders: [],
    treeComplete: true,
    tree: [
      {
        path: `${path}/work`,
        parent: path,
        name: "work",
        size,
        files: 1,
        isDir: true,
        modified: 0,
      },
    ],
  };
}
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

describe("storage baselines", () => {
  it("retains eight recent canonical scopes and replaces a Windows alias", () => {
    for (let i = 0; i < 10; i++)
      saveStorageBaseline(createStorageBaseline(report(`/data/${i}`), i));
    expect(readStorageBaselines().map((item) => item.path)).toEqual(
      Array.from({ length: 8 }, (_, i) => `/data/${i + 2}`),
    );
    saveStorageBaseline(createStorageBaseline(report("C:\\Data"), 20));
    saveStorageBaseline(createStorageBaseline(report("c:/data/"), 21));
    expect(
      readStorageBaselines().filter(
        (item) => storagePathKey(item.path) === "c:/data",
      ),
    ).toHaveLength(1);
    removeStorageBaseline("C:\\DATA");
    expect(
      readStorageBaselines().some(
        (item) => storagePathKey(item.path) === "c:/data",
      ),
    ).toBe(false);
  });
  it("rejects corrupt, oversized and malformed persisted data", () => {
    for (const raw of [
      "broken",
      "{}",
      JSON.stringify([{ path: "/data", counts: { bytes: -1 } }]),
      " ".repeat(1_000_001),
    ]) {
      localStorage.setItem(storageBaselineKey, raw);
      expect(readStorageBaselines()).toEqual([]);
    }
  });
  it("compares complete scans and detects added, removed and growing folders", () => {
    const before = report();
    const baseline = createStorageBaseline(before, 10);
    const after = report("/data", 15);
    after.tree![0] = { ...after.tree![0], name: "new", path: "/data/new" };
    const result = compareStorageBaseline(after, baseline)!;
    expect(result.bytes).toBe(5);
    expect(result.complete).toBe(true);
    expect(result.changes.map((item) => [item.name, item.delta])).toEqual([
      ["new", 15],
      ["work", -10],
    ]);
    expect(compareStorageBaseline(report("/elsewhere"), baseline)).toBeNull();
  });
  it("never infers deletion from skipped or truncated scans", () => {
    const before = report();
    const baseline = createStorageBaseline(before, 10);
    for (const partial of [
      { ...report(), tree: [], treeComplete: false },
      { ...report(), tree: [], counts: { ...report().counts, skipped: 1 } },
    ]) {
      const result = compareStorageBaseline(partial, baseline)!;
      expect(result.complete).toBe(false);
      expect(result.changes).toEqual([]);
    }
    const legacy = { ...report(), tree: undefined, treeComplete: undefined };
    expect(createStorageBaseline(legacy, 0).foldersComplete).toBe(false);
  });
  it("caps root folder detail and marks the saved baseline incomplete", () => {
    const large = report();
    large.tree = Array.from({ length: 300 }, (_, i) => ({
      ...large.tree![0],
      name: String(i),
      path: `/data/${i}`,
    }));
    const baseline = createStorageBaseline(large, 10);
    expect(baseline.folders).toHaveLength(256);
    expect(baseline.foldersComplete).toBe(false);
    saveStorageBaseline(baseline);
    expect(readStorageBaselines()).toHaveLength(1);
  });
});
