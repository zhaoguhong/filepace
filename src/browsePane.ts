import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { call } from "./bridge";
import { filterEntries, sortEntries, type Listing, type Tab } from "./model";
import { revealItem, useFileViewport } from "./fileViewport";

export type PaneSide = "left" | "right";
export type PaneSession = { tabs: Tab[]; active: string };

type DirectoryState = { listing?: Listing; error?: string; loading: boolean };
type CachedDirectory = {
  state: DirectoryState;
  listeners: Set<(state: DirectoryState) => void>;
  requested: boolean;
  stale: boolean;
  loadedAt: number;
};
const loadingDirectory: DirectoryState = { loading: true };
const emptyDirectory: DirectoryState = { loading: false };
const cache = new Map<string, CachedDirectory>();

function pruneCache() {
  const idle = [...cache].filter(
    ([, item]) => !item.listeners.size && !item.requested,
  );
  let total = idle.reduce(
    (sum, [, item]) => sum + (item.state.listing?.entries.length ?? 0),
    0,
  );
  for (const [path, item] of idle) {
    if (cache.size <= 20 && total <= 75_000) break;
    total -= item.state.listing?.entries.length ?? 0;
    cache.delete(path);
  }
}

function publish(item: CachedDirectory, state: DirectoryState) {
  item.state = state;
  for (const listener of item.listeners) listener(state);
}

function requestDirectory(path: string, item: CachedDirectory) {
  if (item.requested) return;
  item.requested = true;
  item.stale = false;
  if (!item.state.loading)
    publish(item, { ...item.state, error: undefined, loading: true });
  void call<Listing>("list_directory", { path })
    .then(
      (listing) => publish(item, { listing, loading: false }),
      (error) => publish(item, { error: String(error), loading: false }),
    )
    .finally(() => {
      item.requested = false;
      item.loadedAt = Date.now();
      if (item.stale && item.listeners.size) requestDirectory(path, item);
      pruneCache();
    });
}

const normalizePath = (path: string) =>
  path.replaceAll("\\", "/").replace(/\/+$/, "");
export function invalidateDirectories(paths: string[] | null) {
  const changes = paths?.map(normalizePath);
  for (const [path, item] of cache) {
    const locations = [path, item.state.listing?.path ?? path].map(
      normalizePath,
    );
    if (
      changes &&
      !changes.some((change) =>
        locations.some(
          (location) =>
            location === change ||
            location.startsWith(change + "/") ||
            change.slice(0, change.lastIndexOf("/")) === location,
        ),
      )
    )
      continue;
    item.stale = true;
    if (item.listeners.size) requestDirectory(path, item);
  }
}

export function useDirectoryListing(path: string | undefined) {
  const [result, setResult] = useState<{
    path: string;
    state: DirectoryState;
  }>();
  useEffect(() => {
    if (!path) return;
    let item = cache.get(path);
    if (!item) {
      item = {
        state: loadingDirectory,
        listeners: new Set(),
        requested: false,
        stale: true,
        loadedAt: 0,
      };
      cache.set(path, item);
    }
    const onResult = (state: DirectoryState) => setResult({ path, state });
    item.listeners.add(onResult);
    onResult(item.state);
    if (item.stale || Date.now() - item.loadedAt > 30_000)
      requestDirectory(path, item);
    return () => {
      item.listeners.delete(onResult);
      pruneCache();
    };
  }, [path]);
  return path
    ? result?.path === path
      ? result.state
      : loadingDirectory
    : emptyDirectory;
}

export function useBrowsePane(
  session: PaneSession | undefined,
  hidden: boolean,
) {
  const tab =
    session?.tabs.find((t) => t.id === session.active) ?? session?.tabs[0];
  const path = tab?.path;
  const directory = useDirectoryListing(path);
  const { listing } = directory;
  const viewport = useFileViewport(tab?.view, tab?.gridSize);
  const { listRef, layout } = viewport;
  const anchor = useRef<{ tab: string; path: string; lead: string } | null>(
    null,
  );
  const reveal = useRef<string | null>(null);
  const group = tab?.view === "list" ? tab.group : undefined;
  const selected = useMemo(() => new Set(tab?.selected ?? []), [tab?.selected]);
  const sorted = useMemo(
    () =>
      listing
        ? sortEntries(
            listing.entries,
            tab?.sort ?? "name",
            Boolean(tab?.descending),
            hidden,
            group,
          )
        : [],
    [listing, tab?.sort, tab?.descending, hidden, group],
  );
  const entries = useMemo(
    () => filterEntries(sorted, tab?.query ?? ""),
    [sorted, tab?.query],
  );
  const hiddenEntries = useMemo(() => listing?.entries.filter((entry) => entry.hidden) ?? [], [listing]);
  const hiddenMatches = useMemo(() => filterEntries(hiddenEntries, tab?.query ?? "").length, [hiddenEntries, tab?.query]);
  const selectedBytes = useMemo(
    () =>
      selected.size
        ? entries.reduce(
            (sum, entry) =>
              sum + (!entry.isDir && selected.has(entry.path) ? entry.size : 0),
            0,
          )
        : 0,
    [selected, entries],
  );

  useLayoutEffect(() => {
    if (listRef.current && tab) listRef.current.scrollTop = tab.scroll;
  }, [tab?.id, tab?.view, tab?.gridSize, path, listing, viewport.element]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const selected = reveal.current;
    if (!listing || !tab || !list || !selected) return;
    if (tab.view === "grid" && viewport.height === 0) return;
    const index = entries.findIndex((entry) => entry.path === selected);
    reveal.current = null;
    if (index >= 0) revealItem(list, index, layout, true);
  }, [entries, tab?.selected, viewport.height]);

  return {
    ...directory,
    tab,
    entries,
    total: sorted.length,
    hiddenCount: hiddenEntries.length,
    hiddenMatches,
    selected,
    selectedBytes,
    ...viewport,
    anchor,
    reveal,
  };
}
