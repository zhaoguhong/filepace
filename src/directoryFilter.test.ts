import { describe, expect, it } from "vitest";
import { DirectoryFilter } from "./directoryFilter";
import { filterEntries, sortedListing, type Listing } from "./model";

function fixture(): Listing {
  const entries = Array.from({ length: 10_002 }, (_, i) => {
    const name = (i % 2 ? "Årchive-" : "REPORT-") + i;
    return {
      name,
      path: "/files/" + name,
      isDir: false,
      isLink: false,
      size: i,
      hidden: i < 2,
      modified: i,
    };
  });
  return { path: "/files", parent: "/", entries };
}

describe("large directory filtering", () => {
  it("preserves pane ordering and visibility through typing, replacement, backspace and clearing", () => {
    const listing = fixture();
    const visible = sortedListing(listing, "name", false, false);
    const all = sortedListing(listing, "size", true, true);
    const left = new DirectoryFilter();
    const right = new DirectoryFilter();
    for (const query of [
      "r",
      "ReP",
      "REPORT-2",
      "REPORT-",
      "årCHIVE-9",
      "missing",
    ]) {
      expect(left.match(visible, query, listing)).toEqual(
        filterEntries(visible, query),
      );
      expect(right.match(all, query, listing)).toEqual(
        filterEntries(all, query),
      );
    }
    expect(left.match(all, "report-0", listing)).toEqual([listing.entries[0]]);
    expect(right.match(visible, "report-0", listing)).toEqual([]);
    expect(left.match(all, "", listing)).toBe(all);
    expect(left.match(visible, "ÅRCHIVE-1", listing)).toEqual(
      filterEntries(visible, "ÅRCHIVE-1"),
    );
  });

  it("shares normalized names across orders only for complete large listings", () => {
    const listing = fixture();
    const rows = listing.entries;
    const reversed = [...rows].reverse();
    const original = rows[0].name;
    let reads = 0;
    Object.defineProperty(rows[0], "name", {
      get: () => {
        reads++;
        return original;
      },
    });
    const left = new DirectoryFilter();
    const right = new DirectoryFilter();
    const small = rows.slice(0, 2);
    left.match(small, "re", listing);
    left.match(small, "rep", listing);
    left.match(rows, "re");
    left.match(rows, "rep");
    expect(reads).toBe(4);

    left.match(rows, "re", listing);
    right.match(reversed, "rep", listing);
    left.match(reversed, "report", listing);
    expect(reads).toBe(5);
    const other = { ...listing, path: "/other" };
    left.match(rows, "rep", other);
    expect(reads).toBe(6);
  });
});
