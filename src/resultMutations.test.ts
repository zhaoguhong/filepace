import { describe, expect, it } from "vitest";
import { mergeFileChanges } from "./resultMutations";
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
