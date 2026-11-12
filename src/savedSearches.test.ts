import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSavedSearches, writeSavedSearches } from "./savedSearches";

describe("saved searches", () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal("localStorage", {
      get length() {
        return storage.size;
      },
      key: (index: number) => [...storage.keys()][index] ?? null,
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("preserves searches from older releases and adds names and scope", () => {
    storage.set(
      "filepace-searches:/work",
      JSON.stringify([
        {
          id: "one",
          query: "invoice",
          category: "documents",
          date: "",
          size: "20",
        },
      ]),
    );
    expect(readSavedSearches()).toEqual([
      {
        id: "one",
        name: "invoice",
        path: "/work",
        pinned: false,
        query: "invoice",
        category: "documents",
        date: "",
        size: "20",
      },
    ]);
    expect(readSavedSearches("/other")).toEqual([]);
  });
  it("does not resurrect removed legacy searches after the new store is saved", () => {
    storage.set(
      "filepace-searches:/work",
      JSON.stringify([
        { id: "one", query: "invoice", category: "", date: "", size: "" },
      ]),
    );
    writeSavedSearches([]);
    expect(readSavedSearches()).toEqual([]);
  });
  it("keeps other scopes when one legacy value is invalid", () => {
    storage.set("filepace-searches:/broken", "not-json");
    storage.set(
      "filepace-searches:/work",
      JSON.stringify([
        { id: "one", query: "invoice", category: "", date: "", size: "" },
        { id: "invalid" },
      ]),
    );
    expect(readSavedSearches()).toHaveLength(1);
  });
});
