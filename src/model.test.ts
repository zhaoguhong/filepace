import { describe, it, expect } from "vitest";
import { makeTab, navigate, visibleEntries, type Entry } from "./model";
describe("tab navigation", () => {
  it("truncates forward history on a new navigation", () => {
    let tab = navigate(navigate(makeTab("/a"), "/b"), "/c");
    tab = { ...tab, index: 1, path: "/b", query: "old", selected: ["x"] };
    const next = navigate(tab, "/d");
    expect(next.history).toEqual(["/a", "/b", "/d"]);
    expect(next.index).toBe(2);
    expect(next.query).toBe("");
    expect(next.selected).toEqual([]);
  });
  it("keeps independent state for duplicate locations", () => {
    const a = makeTab("/a"),
      b = makeTab("/a");
    a.selected.push("x");
    expect(a.id).not.toBe(b.id);
    expect(b.selected).toEqual([]);
  });
  it("filters hidden entries and sorts folders first in both directions", () => {
    const items: Entry[] = [
      { name: "file10", isDir: false, hidden: false },
      { name: "folder", isDir: true, hidden: false },
      { name: ".secret", isDir: false, hidden: true },
      { name: "file2", isDir: false, hidden: false },
    ].map((e, i) => ({
      ...e,
      path: e.name,
      size: i,
      isLink: false,
      modified: i,
    }));
    const tab = makeTab("/");
    expect(visibleEntries(items, tab, false).map((e) => e.name)).toEqual([
      "folder",
      "file2",
      "file10",
    ]);
    expect(
      visibleEntries(items, { ...tab, descending: true }, false)[0].name,
    ).toBe("folder");
    expect(
      visibleEntries(items, { ...tab, query: "FILE" }, false),
    ).toHaveLength(2);
  });
});
