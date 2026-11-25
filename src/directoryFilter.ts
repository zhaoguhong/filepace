import { filterEntries, type Entry, type Listing } from "./model";

type NameIndex = {
  listing: Listing;
  firstOrder: Entry[];
  firstNames: string[];
  otherOrders: WeakMap<Entry[], string[]>;
  byEntry?: Map<Entry, string>;
};
// Only panes with an active query hold strong references to the index.
// Different sort orders and hidden-file settings can share the same names.
const indexes = new WeakMap<Listing, WeakRef<NameIndex>>();

function namesByEntry(index: NameIndex) {
  if (!index.byEntry) {
    index.byEntry = new Map();
    for (let i = 0; i < index.firstOrder.length; i++) {
      index.byEntry.set(index.firstOrder[i], index.firstNames[i]);
    }
  }
  return index.byEntry;
}

export class DirectoryFilter {
  private active?: NameIndex;

  match(entries: Entry[], query: string, completeListing?: Listing): Entry[] {
    if (!query || !completeListing || entries.length < 10_000) {
      this.active = undefined;
      return filterEntries(entries, query);
    }
    if (this.active?.listing !== completeListing) {
      this.active = indexes.get(completeListing)?.deref();
    }
    const needle = query.toLocaleLowerCase();
    const index = this.active;
    const ordered =
      entries === index?.firstOrder
        ? index.firstNames
        : index?.otherOrders.get(entries);
    if (ordered) return entries.filter((_, i) => ordered[i].includes(needle));

    // The usual single ordering only needs an array. Build a lookup by entry
    // when another filtered ordering actually needs to reuse those names.
    const previous = index && namesByEntry(index);
    const names = new Array<string>(entries.length);
    const matches: Entry[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      let name = previous?.get(entry);
      if (name === undefined) {
        name = entry.name.toLocaleLowerCase();
        previous?.set(entry, name);
      }
      names[i] = name;
      if (name.includes(needle)) matches.push(entry);
    }
    if (index) index.otherOrders.set(entries, names);
    else {
      this.active = {
        listing: completeListing,
        firstOrder: entries,
        firstNames: names,
        otherOrders: new WeakMap(),
      };
      indexes.set(completeListing, new WeakRef(this.active));
    }
    return matches;
  }
}
