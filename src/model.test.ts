import { describe, it, expect } from "vitest";
import {
  appendListing,
  makeTab,
  navigate,
  reuseUnchangedListing,
  sortedListing,
  sortEntries,
  visibleEntries,
  type Entry,
  type Tab,
} from "./model";
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
    const listing = { path: "/", parent: null, entries: items };
    const visible = sortedListing(listing, "name", false, false);
    expect(sortedListing(listing, "name", false, false)).toBe(visible);
    expect(sortedListing(listing, "name", true, true)).toHaveLength(4);
    expect(visible.map((entry) => entry.name)).toEqual([
      "folder",
      "file2",
      "file10",
    ]);
    expect(
      sortedListing({ ...listing, entries: [] }, "name", false, false),
    ).toEqual([]);
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

  it("extends a published ordering without changing snapshots or reordering equal keys", () => {
    const entries = Array.from({ length: 79 }, (_, i) => ({
      name: ["file2", "file02", "文件", ".hidden", "图.png"][i % 5],
      path: String(i),
      isDir: i % 7 === 0,
      isLink: false,
      size: i % 4,
      modified: i % 2,
      hidden: i % 5 === 3,
    }));
    for (const sort of ["name", "modified", "size"] as Tab["sort"][]) {
      for (const group of [undefined, "date", "kind"] as Tab["group"][]) {
        for (const descending of [false, true]) {
          for (const hidden of [false, true]) {
            let listing = {
              path: "/",
              parent: null as string | null,
              entries: entries.slice(0, 11),
            };
            for (let start = 11; start < entries.length; start += 13) {
              const before = sortedListing(
                listing,
                sort,
                descending,
                hidden,
                group,
              );
              const stable = [...before];
              listing = appendListing(
                listing,
                entries.slice(start, start + 13),
              );
              const after = sortedListing(
                listing,
                sort,
                descending,
                hidden,
                group,
              );
              expect(after).toEqual(
                sortEntries(listing.entries, sort, descending, hidden, group),
              );
              expect(before).toEqual(stable);
            }
          }
        }
      }
    }
  });

  it("reuses complete refreshes only when location, order and every displayed attribute match", () => {
    const entry: Entry = {
      path: "/a",
      name: "a",
      isDir: false,
      isLink: false,
      hidden: false,
      size: 7,
      modified: 11,
    };
    const original = {
      path: "/",
      parent: null,
      entries: [entry, { ...entry, path: "/b", name: "b" }],
    };
    const refresh = () => structuredClone(original);
    const ascending = sortedListing(original, "name", false, false);
    const descending = sortedListing(original, "name", true, false);
    const same = reuseUnchangedListing(original, refresh());
    expect(same).toBe(original);
    expect(sortedListing(same, "name", false, false)).toBe(ascending);
    expect(sortedListing(same, "name", true, false)).toBe(descending);
    const changed: Partial<Entry>[] = [
      { path: "/c" },
      { name: "c" },
      { isLink: true },
      { isDir: true },
      { hidden: true },
      { size: 8 },
      { modified: 12 },
    ];
    for (const fields of changed) {
      const next = refresh();
      Object.assign(next.entries[1], fields);
      expect(reuseUnchangedListing(original, next)).toBe(next);
    }
    for (const next of [
      { ...original, parent: "/vol" },
      { ...original, path: "/volume" },
      { ...original, entries: [...original.entries].reverse() },
      { ...original, entries: original.entries.slice(1) },
    ])
      expect(reuseUnchangedListing(original, next)).toBe(next);
  });
});
