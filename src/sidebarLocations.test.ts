import { describe, expect, it } from "vitest";
import {
  insertLocationPlaces,
  migrateLocations,
  uniquePlaces,
  type LocationGroup,
} from "./sidebarLocations";
import { normalizeSidebarLayout } from "./sidebarLayout";
const defaults = [
  { name: "个人目录", path: "/Users/test" },
  { name: "下载", path: "/Users/test/Downloads" },
];
describe("sidebar location migration", () => {
  it("provides default locations for a first installation", () => {
    expect(migrateLocations(defaults, {}, [])[0].places).toEqual(defaults);
  });
  it("merges favorites after customized common locations without bringing removed defaults back", () => {
    const groups = migrateLocations(
      defaults,
      { commonPlaces: [defaults[0]], collapsedSidebar: ["common"] },
      ["/Users/test", "/work"],
    );
    expect(groups).toEqual([
      {
        id: "common",
        name: "常用位置",
        collapsed: true,
        places: [defaults[0], { name: "work", path: "/work" }],
      },
    ]);
  });
  it("keeps an intentionally empty custom list empty", () => {
    expect(
      migrateLocations(defaults, { commonPlaces: [] }, [])[0].places,
    ).toEqual([]);
  });
  it("deduplicates Windows aliases while retaining distinct case-sensitive Unix names", () => {
    expect(
      uniquePlaces([
        { name: "first", path: "C:\\Work\\" },
        { name: "second", path: "c:/work" },
        { name: "A", path: "/A" },
        { name: "a", path: "/a" },
      ]).map((place) => place.name),
    ).toEqual(["first", "A", "a"]);
  });
});

describe("location insertion", () => {
  const place = (name: string) => ({ name, path: `/folders/${name}` });
  const groups = (): LocationGroup[] => [
    {
      id: "one",
      name: "One",
      collapsed: false,
      places: [place("a"), place("b"), place("c")],
    },
    { id: "two", name: "Two", collapsed: true, places: [] },
  ];
  it("places a downward drag after its target without duplicating or skipping neighbors", () => {
    const next = insertLocationPlaces(
      groups(),
      [place("a")],
      { group: "one", path: place("b").path, after: true },
      { group: "one", path: place("a").path },
    );
    expect(next[0].places.map((place) => place.name)).toEqual(["b", "a", "c"]);
  });
  it("moves between groups and expands only the destination", () => {
    const next = insertLocationPlaces(
      groups(),
      [place("b")],
      { group: "two" },
      { group: "one", path: place("b").path },
    );
    expect(next[0].places.map((place) => place.name)).toEqual(["a", "c"]);
    expect(next[1]).toMatchObject({ collapsed: false, places: [place("b")] });
  });
  it("keeps the order of multiple added folders and relocates an existing entry without duplicating it", () => {
    const next = insertLocationPlaces(
      groups(),
      [place("c"), place("new"), place("new")],
      { group: "one", path: place("b").path },
    );
    expect(next[0].places.map((place) => place.name)).toEqual([
      "a",
      "c",
      "new",
      "b",
    ]);
  });
  it("allows an empty sidebar to receive a folder and ignores vanished targets", () => {
    expect(
      insertLocationPlaces([], [place("a")], { group: "common" })[0].places,
    ).toEqual([place("a")]);
    expect(
      insertLocationPlaces(groups(), [place("new")], { group: "deleted" }),
    ).toEqual(groups());
  });
});

describe("sidebar layout restoration", () => {
  it("keeps the expanded width when hidden and rejects invalid stored widths", () => {
    expect(normalizeSidebarLayout({ visible: false, width: 292 })).toEqual({
      visible: false,
      width: 292,
    });
    expect(normalizeSidebarLayout({ width: NaN }, 180).width).toBe(180);
    expect(normalizeSidebarLayout({ width: 900 }).width).toBe(420);
    expect(normalizeSidebarLayout({ width: 10 }).width).toBe(160);
  });
});
