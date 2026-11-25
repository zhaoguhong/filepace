import { describe, expect, it } from "vitest";
import { ChangeCursor, mergeFileChanges } from "./resultMutations";
import { resultFile } from "./resultActions";
const file = (path: string) => ({
  entry: {
    path,
    name: path.split("/").at(-1)!,
    isDir: false,
    isLink: false,
    size: 10,
    modified: 1,
    hidden: false,
  },
  parent: path.slice(0, path.lastIndexOf("/")),
});

describe("committed result changes", () => {
  it("replays only the batches between a result snapshot and its render", () => {
    const initial = new ChangeCursor();
    const start = initial.retain();
    const move = [{ kind: "move" as const, from: "/a", to: "/b" }];
    const trash = [{ kind: "trash" as const, from: "/b" }];
    const afterMove = initial.append(move);
    const halfway = afterMove.retain();
    const afterTrash = afterMove.append(trash);
    expect(start.readThrough(afterMove).batches).toEqual([move]);
    expect(start.readThrough(afterTrash).batches).toEqual([move, trash]);
    expect(halfway.readThrough(afterTrash).batches).toEqual([trash]);
    expect(afterTrash.retain().readThrough(afterMove).batches).toEqual([]);
    expect(
      start.readThrough(afterMove).after.readThrough(afterTrash).batches,
    ).toEqual([trash]);
    // A new scan can start from a stale render, after the window has moved on.
    const lateScan = initial.retain();
    const final = afterTrash.append(move);
    expect(lateScan.readThrough(final).batches).toEqual([move]);
  });
  it("keeps the original snapshot address through move, rename and trash", () => {
    let changes = mergeFileChanges({}, [
      { kind: "move", from: "/a/x.txt", to: "/b/x (2).txt" },
    ]);
    changes = mergeFileChanges(changes, [
      { kind: "rename", from: "/b/x (2).txt", to: "/b/new.txt" },
    ]);
    expect(resultFile(file("/a/x.txt"), changes).entry.path).toBe("/b/new.txt");
    changes = mergeFileChanges(changes, [
      { kind: "trash", from: "/b/new.txt" },
    ]);
    expect(resultFile(file("/a/x.txt"), changes).unavailable).toBe(true);
  });
  it("keeps unrelated changes out of a tracked snapshot", () => {
    const current = { "/a": { status: "moved" as const, path: "/b" } };
    expect(
      mergeFileChanges(current, [{ kind: "trash", from: "/other" }], "tracked"),
    ).toBe(current);
    expect(
      mergeFileChanges(current, [{ kind: "trash", from: "/b" }], "tracked"),
    ).toEqual({ "/a": { status: "trashed", path: undefined } });
  });
  it("updates folder descendants and compares Windows paths without case", () => {
    const changes = mergeFileChanges({}, [
      { kind: "move", from: "C:\\Work", to: "D:\\Archive" },
    ]);
    expect(resultFile(file("c:\\work\\notes.txt"), changes).entry.path).toBe(
      "D:\\Archive\\notes.txt",
    );
  });
  it("applies rename cycles simultaneously", () => {
    const changes = mergeFileChanges({}, [
      { kind: "rename", from: "/a/one", to: "/a/two" },
      { kind: "rename", from: "/a/two", to: "/a/one" },
    ]);
    expect(resultFile(file("/a/one"), changes).entry.path).toBe("/a/two");
    expect(resultFile(file("/a/two"), changes).entry.path).toBe("/a/one");
  });
});
