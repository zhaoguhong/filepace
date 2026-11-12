import { describe, expect, it } from "vitest";
import {
  resultFile,
  selectResultPaths,
  snapshotResultMutations,
  type ResultFile,
} from "./resultActions";
import { mergeFileChanges } from "./resultMutations";

describe("result selection", () => {
  const paths = ["a", "b", "c", "d"];
  it("extends in display order and toggles without selecting another pane", () => {
    expect(selectResultPaths(paths, ["b"], "d", "b", true, false)).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect(selectResultPaths(paths, ["b", "d"], "b", "b", false, true)).toEqual(
      ["d"],
    );
    expect(selectResultPaths(paths, ["d"], "a", "d", false, false)).toEqual([
      "a",
    ]);
  });
  it("does not apply a vanished range anchor to an unrelated result set", () => {
    expect(
      selectResultPaths(paths, ["a"], "c", "missing", true, false),
    ).toEqual(["c"]);
  });
});

describe("result mutation snapshots", () => {
  const item: ResultFile = {
    parent: "/one",
    entry: {
      name: "a.txt",
      path: "/one/a.txt",
      isDir: false,
      isLink: false,
      hidden: false,
      modified: 0,
      size: 12,
    },
  };
  it("retains a deleted reference but prevents stale operations", () => {
    expect(
      resultFile(item, { "/one/a.txt": { status: "trashed" } }),
    ).toMatchObject({
      entry: item.entry,
      status: "trashed",
      unavailable: true,
    });
  });
  it("uses the verified destination for subsequent actions", () => {
    const moved = { ...item.entry, path: "/two/a.txt" };
    expect(
      resultFile(item, {
        "/one/a.txt": { status: "moved", entry: moved, parent: "/two" },
      }),
    ).toMatchObject({ entry: moved, parent: "/two", unavailable: false });
    expect(item.entry.path).toBe("/one/a.txt");
  });
  it("updates descendants when their containing folder moves", () => {
    expect(
      resultFile(item, { "/one": { status: "moved", path: "/three" } }),
    ).toMatchObject({
      entry: { path: "/three/a.txt", name: "a.txt" },
      parent: "/three",
      unavailable: false,
    });
    expect(
      resultFile(item, { "/one": { status: "trashed" } }).unavailable,
    ).toBe(true);
  });
  it("handles Windows paths and drive-root parents", () => {
    const windows = {
      ...item,
      parent: "C:\\one",
      entry: { ...item.entry, path: "C:\\one\\a.txt" },
    };
    expect(
      resultFile(windows, { "c:\\ONE": { status: "moved", path: "D:" } }),
    ).toMatchObject({ entry: { path: "D:\\a.txt" }, parent: "D:\\" });
  });
  it("tracks a child through a parent move, child rename and undo", () => {
    const original = snapshotResultMutations([item]);
    const folderMoved = mergeFileChanges(original, [
      { from: "/one", to: "/two", kind: "move" },
    ]);
    const childRenamed = mergeFileChanges(folderMoved, [
      { from: "/two/a.txt", to: "/two/b.txt", kind: "rename" },
    ]);
    expect(resultFile(item, childRenamed)).toMatchObject({
      entry: { path: "/two/b.txt", name: "b.txt" },
      status: "renamed",
    });
    const renameUndone = mergeFileChanges(childRenamed, [
      { from: "/two/b.txt", to: "/two/a.txt", kind: "rename" },
    ]);
    const moveUndone = mergeFileChanges(renameUndone, [
      { from: "/two", to: "/one", kind: "move" },
    ]);
    expect(resultFile(item, moveUndone)).toMatchObject({
      entry: { path: "/one/a.txt", name: "a.txt" },
      status: undefined,
      unavailable: false,
    });
  });
});
