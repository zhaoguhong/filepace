export type LocationDrop = { group: string; path?: string; after?: boolean };
export type Position = { x: number; y: number };

export function locationDropAt({ x, y }: Position): LocationDrop | null {
  const element = document.elementFromPoint(x, y);
  const section = element?.closest<HTMLElement>("[data-location-group]");
  const group = section?.dataset.locationGroup;
  if (!group) return null;
  const row = element?.closest<HTMLElement>("[data-location-path]");
  if (row && row.closest("[data-location-group]") === section) {
    const bounds = row.getBoundingClientRect();
    return {
      group,
      path: row.dataset.locationPath,
      after: y >= bounds.top + bounds.height / 2,
    };
  }
  return { group };
}

export function sameLocationDrop(
  a: LocationDrop | null,
  b: LocationDrop | null,
) {
  return a?.group === b?.group && a?.path === b?.path && a?.after === b?.after;
}

export function scrollLocations({ x, y }: Position, elapsed: number) {
  const list = document
    .elementFromPoint(x, y)
    ?.closest<HTMLElement>(".sidebar-locations");
  if (!list || list.scrollHeight <= list.clientHeight) return false;
  const bounds = list.getBoundingClientRect();
  const edge = Math.min(42, bounds.height / 4);
  const proximity =
    (Math.max(0, edge - (bounds.bottom - y)) -
      Math.max(0, edge - (y - bounds.top))) /
    edge;
  const before = list.scrollTop;
  list.scrollTop += proximity * elapsed * 0.65;
  return list.scrollTop !== before;
}
