import { useEffect, useMemo, useState } from "react";
import { basename, type Place } from "./model";
import type { Shortcut } from "./preferences";
import type { LocationDrop } from "./locationDrop";

export type LocationGroup = {
  id: string;
  name: string;
  collapsed: boolean;
  places: Shortcut[];
};
export const sidebarKey = "filepace-location-groups-v1";
const changed = "filepace-locations-changed";
export const pathKey = (path: string) => {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:|^\/\//i.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
};
export function uniquePlaces(places: Shortcut[]) {
  const seen = new Set<string>();
  return places.filter((place) => {
    if (
      !place ||
      typeof place.path !== "string" ||
      !place.path ||
      typeof place.name !== "string"
    )
      return false;
    const key = pathKey(place.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function insertLocationPlaces(
  groups: LocationGroup[],
  places: Shortcut[],
  target: LocationDrop,
  source?: { group: string; path: string },
): LocationGroup[] {
  const next = groups.length
    ? groups
    : [{ id: "common", name: "常用位置", collapsed: false, places: [] }];
  const destination = next.find((group) => group.id === target.group);
  if (!destination) return groups;
  const valid = uniquePlaces(places);
  if (
    !valid.length ||
    (source?.group === target.group &&
      target.path &&
      pathKey(source.path) === pathKey(target.path))
  )
    return groups;
  const keys = new Set(valid.map((place) => pathKey(place.path)));
  const anchor = target.path
    ? destination.places.findIndex(
        (place) => pathKey(place.path) === pathKey(target.path!),
      )
    : destination.places.length;
  const split =
    target.path && anchor >= 0
      ? anchor + (target.after ? 1 : 0)
      : destination.places.length;
  const before = destination.places
    .slice(0, split)
    .filter((place) => !keys.has(pathKey(place.path)));
  const after = destination.places
    .slice(split)
    .filter((place) => !keys.has(pathKey(place.path)));
  return next.map((group) =>
    group.id === destination.id
      ? { ...group, collapsed: false, places: [...before, ...valid, ...after] }
      : source?.group === group.id
        ? {
            ...group,
            places: group.places.filter(
              (place) => pathKey(place.path) !== pathKey(source.path),
            ),
          }
        : group,
  );
}
export function migrateLocations(
  defaults: Shortcut[],
  preferences: {
    commonPlaces?: Shortcut[] | null;
    collapsedSidebar?: string[];
  },
  favorites: string[],
): LocationGroup[] {
  return [
    {
      id: "common",
      name: "常用位置",
      collapsed: preferences.collapsedSidebar?.includes("common") ?? false,
      places: uniquePlaces([
        ...(preferences.commonPlaces ?? defaults),
        ...favorites.map((path) => ({ path, name: basename(path) })),
      ]),
    },
  ];
}
function read(defaults: Shortcut[]): LocationGroup[] {
  try {
    const value = JSON.parse(localStorage.getItem(sidebarKey) ?? "null");
    if (Array.isArray(value)) {
      const ids = new Set<string>();
      return value
        .filter(
          (group) =>
            group &&
            typeof group.id === "string" &&
            typeof group.name === "string" &&
            Array.isArray(group.places) &&
            !ids.has(group.id) &&
            ids.add(group.id),
        )
        .map((group) => ({
          id: group.id,
          name: group.name,
          collapsed: Boolean(group.collapsed),
          places: uniquePlaces(group.places),
        }));
    }
    const preferences = JSON.parse(
      localStorage.getItem("filepace-preferences") ?? "{}",
    );
    const legacy = JSON.parse(
      localStorage.getItem("filepace-favorites") ?? "[]",
    );
    return migrateLocations(
      defaults,
      preferences,
      Array.isArray(legacy)
        ? legacy.filter((p): p is string => typeof p === "string" && Boolean(p))
        : [],
    );
  } catch {
    return migrateLocations(defaults, {}, []);
  }
}
const favoritePlaces = (places: Place[]) =>
  places.filter((place) => place.kind === "favorite");

export function useSidebarLocations(
  placesFromSystem: Place[],
  loadingPlaces: Promise<Place[]> | null,
) {
  const defaults = useMemo(
    () => favoritePlaces(placesFromSystem),
    [placesFromSystem],
  );
  const [revision, setRevision] = useState(0);
  const groups = useMemo(() => read(defaults), [defaults, revision]);
  const places = useMemo(
    () => uniquePlaces(groups.flatMap((group) => group.places)),
    [groups],
  );
  useEffect(() => {
    const sync = () => setRevision((value) => value + 1);
    window.addEventListener("storage", sync);
    window.addEventListener(changed, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(changed, sync);
    };
  }, []);
  useEffect(() => {
    if (defaults.length && localStorage.getItem(sidebarKey) === null) {
      localStorage.setItem(sidebarKey, JSON.stringify(read(defaults)));
      window.dispatchEvent(new Event(changed));
    }
  }, [defaults.length]);
  function change(
    edit: (groups: LocationGroup[], available: Shortcut[]) => LocationGroup[],
    needsDefaults = false,
  ) {
    const save = (available: Shortcut[]) => {
      localStorage.setItem(
        sidebarKey,
        JSON.stringify(edit(read(available), available)),
      );
      window.dispatchEvent(new Event(changed));
    };
    // During legacy migration, an early edit must include the system defaults.
    if (
      loadingPlaces &&
      (needsDefaults || localStorage.getItem(sidebarKey) === null)
    ) {
      void loadingPlaces.then(
        (places) => save(favoritePlaces(places)),
        () => save(defaults),
      );
    } else save(defaults);
  }
  function add(place: Shortcut, groupId?: string) {
    change((groups) => {
      const next = groups.length
        ? groups
        : [{ id: "common", name: "常用位置", collapsed: false, places: [] }];
      return next.map((group, index) =>
        (groupId ? group.id === groupId : index === 0)
          ? {
              ...group,
              collapsed: false,
              places: uniquePlaces([...group.places, place]),
            }
          : group,
      );
    });
  }
  function insert(
    places: Shortcut[],
    target: LocationDrop,
    source?: { group: string; path: string },
  ) {
    change((groups) => insertLocationPlaces(groups, places, target, source));
  }
  function remove(path: string) {
    change((groups) =>
      groups.map((group) => ({
        ...group,
        places: group.places.filter(
          (place) => pathKey(place.path) !== pathKey(path),
        ),
      })),
    );
  }
  function restoreDefaults() {
    change((groups, available) => {
      const existing = new Set(
        groups.flatMap((group) =>
          group.places.map((place) => pathKey(place.path)),
        ),
      );
      const missing = available.filter(
        (place) => !existing.has(pathKey(place.path)),
      );
      const next = groups.length
        ? groups
        : [{ id: "common", name: "常用位置", collapsed: false, places: [] }];
      return next.map((group, index) =>
        index === 0
          ? {
              ...group,
              collapsed: false,
              places: uniquePlaces([...group.places, ...missing]),
            }
          : group,
      );
    }, true);
  }
  return {
    groups,
    places,
    change,
    add,
    insert,
    remove,
    restoreDefaults,
  };
}
export type SidebarLocations = ReturnType<typeof useSidebarLocations>;
