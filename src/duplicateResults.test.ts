import { describe, expect, it } from "vitest";
import {
  duplicateActionBlocked,
  duplicateParent,
  duplicatePathsOverlap,
} from "./duplicateResults";
import type { Entry } from "./model";
import { resultFile, snapshotResultMutations } from "./resultActions";
import { mergeFileChanges } from "./resultMutations";

const keeper: Entry = {
  path: "/fixtures/a.txt",
  name: "a.txt",
  size: 42,
  modified: 0,
  hidden: false,
  isDir: false,
  isLink: false,
};
const copy: Entry = { ...keeper, path: "/fixtures/b.txt", name: "b.txt" };

describe("duplicate group file safety", () => {
  it("tracks a keeper through a parent move followed by a child rename", () => {
    const original = {
      entry: { ...keeper, path: "/fixtures/sub/a.txt" },
      parent: "/fixtures/sub",
    };
    const snapshot = snapshotResultMutations([original]);
    const moved = mergeFileChanges(snapshot, [
      { from: "/fixtures", to: "/renamed", kind: "move" },
    ]);
    const renamed = mergeFileChanges(moved, [
      {
        from: "/renamed/sub/a.txt",
        to: "/renamed/sub/kept.txt",
        kind: "rename",
      },
    ]);
    const retained = resultFile(original, renamed);
    expect(retained.entry.path).toBe("/renamed/sub/kept.txt");
    expect(
      duplicateActionBlocked(
        { action: "trash", entries: [retained.entry], scope: "/renamed" },
        retained.entry,
        false,
      ),
    ).toContain("不能");
  });
  it("requires an explicitly retained, current file before removing or moving copies", () => {
    for (const action of ["trash", "cut", "move-to", "rename"] as const) {
      const request = { action, entries: [copy], scope: "/fixtures" };
      expect(duplicateActionBlocked(request, undefined, false)).toContain(
        "保留",
      );
      expect(duplicateActionBlocked(request, keeper, true)).toContain(
        "重新检查",
      );
      expect(duplicateActionBlocked(request, keeper, false)).toBe("");
      expect(
        duplicateActionBlocked(
          { ...request, entries: [copy, keeper] },
          keeper,
          false,
        ),
      ).toContain("不能");
    }
  });
  it("allows read-only inspection of a stale snapshot", () => {
    expect(
      duplicateActionBlocked(
        { action: "preview", entries: [copy], scope: "/fixtures" },
        undefined,
        true,
      ),
    ).toBe("");
    expect(
      duplicateActionBlocked(
        { action: "copy-path", entries: [keeper], scope: "/fixtures" },
        keeper,
        true,
      ),
    ).toBe("");
  });
  it("treats Windows retained paths case-insensitively", () => {
    const retained = { ...keeper, path: "C:\\Photos\\a.JPG" };
    expect(
      duplicateActionBlocked(
        {
          action: "trash",
          entries: [{ ...retained, path: "c:/photos/A.jpg" }],
          scope: "C:\\Photos",
        },
        retained,
        false,
      ),
    ).toContain("不能");
  });
  it("maps parent folders for root files on both platforms", () => {
    expect(duplicateParent("/a.txt")).toBe("/");
    expect(duplicateParent("/fixtures/a.txt")).toBe("/fixtures");
    expect(duplicateParent("C:\\a.txt")).toBe("C:\\");
    expect(duplicateParent("C:/a.txt")).toBe("C:/");
    expect(duplicateParent("\\\\server\\share\\a.txt")).toBe(
      "\\\\server\\share",
    );
  });
  it("only invalidates affected duplicate paths and normalizes Windows paths", () => {
    expect(duplicatePathsOverlap("/fixtures", "/fixtures/a.txt")).toBe(true);
    expect(duplicatePathsOverlap("/fixture", "/fixtures/a.txt")).toBe(false);
    expect(duplicatePathsOverlap("C:\\PHOTOS", "c:/photos/a.jpg")).toBe(true);
    expect(duplicatePathsOverlap("/Fixtures/a", "/fixtures/a")).toBe(false);
  });
});
