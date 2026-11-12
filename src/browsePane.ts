import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { call, desktop } from "./bridge";
import { filterEntries, sortEntries, type Listing, type Tab } from "./model";
import { revealItem, useFileViewport } from "./fileViewport";

export type PaneSide = "left" | "right";
export type PaneSession = { tabs: Tab[]; active: string };

type DirectoryState = { listing?: Listing; error?: string; loading: boolean };
type CachedDirectory = {
  state: DirectoryState;
  listeners: Set<(state: DirectoryState) => void>;
  requested: string | null;
  cancel?: () => void;
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
  const id = crypto.randomUUID();
  item.requested = id;
  item.stale = false;
  publish(item, { ...item.state, error: undefined, loading: true });
  const existing = item.state.listing;
  const onBatch = desktop ? new Channel<Listing>() : undefined;
  let partial: Listing | undefined;
  let succeeded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (item.requested === id && partial)
      publish(item, {
        listing: { ...partial, entries: [...partial.entries] },
        loading: true,
      });
  };
  if (onBatch)
    onBatch.onmessage = (batch) => {
      // Keep an existing complete snapshot visible during refresh. First loads
      // can show useful rows before the filesystem has enumerated everything.
      if (item.requested !== id || existing) return;
      if (!partial) partial = { ...batch, entries: [...batch.entries] };
      else partial.entries.push(...batch.entries);
      if (!item.state.listing) flush();
      else timer ??= setTimeout(flush, 80);
    };
  item.cancel = () => {
    if (item.requested !== id) return;
    item.requested = null;
    item.cancel = undefined;
    item.stale = true;
    clearTimeout(timer);
    // A partial listing must never become a reusable complete snapshot.
    item.state = { listing: existing, loading: false };
    if (desktop) void call("cancel_directory_listing", { id }).catch(() => {});
  };
  void call<Listing | null>("list_directory", { path, id, onBatch })
    .then(
      (listing) => {
        if (item.requested !== id) return;
        if (listing) {
          succeeded = true;
          publish(item, { listing, loading: false });
          item.loadedAt = Date.now();
        } else {
          item.stale = true;
          publish(item, { listing: existing, loading: false });
        }
      },
      (error) => {
        if (item.requested !== id) return;
        publish(item, {
          listing: existing,
          error: String(error),
          loading: false,
        });
        item.stale = true;
      },
    )
    .finally(() => {
      clearTimeout(timer);
      if (item.requested !== id) return;
      item.requested = null;
      item.cancel = undefined;
      // A filesystem event during enumeration requests one fresh snapshot.
      // Errors stay visible until an explicit refresh or a new subscription.
      if (succeeded && item.stale && item.listeners.size)
        requestDirectory(path, item);
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
        requested: null,
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
      if (!item.listeners.size) item.cancel?.();
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
  const restoringScroll = useRef(false);
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
  const hiddenEntries = useMemo(
    () => listing?.entries.filter((entry) => entry.hidden) ?? [],
    [listing],
  );
  const hiddenMatches = useMemo(
    () => filterEntries(hiddenEntries, tab?.query ?? "").length,
    [hiddenEntries, tab?.query],
  );
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
    const list = listRef.current;
    if (!list || !tab) return;
    // A partial list may clamp the viewport. Keep the intended offset in the
    // session while showing available rows; ignore that temporary scroll event.
    restoringScroll.current =
      directory.loading && list.scrollHeight - list.clientHeight < tab.scroll;
    list.scrollTop = tab.scroll;
  }, [
    tab?.id,
    tab?.view,
    tab?.gridSize,
    path,
    listing,
    viewport.element,
    directory.loading,
  ]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const selected = reveal.current;
    if (!listing || !tab || !list || !selected) return;
    if (!tab.selected.includes(selected)) {
      reveal.current = null;
      return;
    }
    if (tab.view === "grid" && viewport.height === 0) return;
    const index = entries.findIndex((entry) => entry.path === selected);
    if (index < 0 && directory.loading) return;
    if (!directory.loading) reveal.current = null;
    if (index >= 0) revealItem(list, index, layout, true);
  }, [entries, tab?.selected, viewport.height, directory.loading]);

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
    restoringScroll,
  };
}
