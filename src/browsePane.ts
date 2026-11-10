import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { call } from "./bridge";
import { visibleEntries, type Listing, type Tab } from "./model";

export type PaneSide = "left" | "right";
export type PaneSession = { tabs: Tab[]; active: string };

export function useDirectoryListing(
  path: string | undefined,
  revision: number,
) {
  const [result, setResult] = useState<{
    path: string;
    listing?: Listing;
    error?: string;
  }>();
  const [loading, setLoading] = useState(false);
  const current = result?.path === path ? result : undefined;

  useEffect(() => {
    if (!path) return;
    let disposed = false;
    setLoading(true);
    call<Listing>("list_directory", { path }).then(
      (listing) => {
        if (disposed) return;
        setResult({ path, listing });
        setLoading(false);
      },
      (error) => {
        if (disposed) return;
        setResult({ path, error: String(error) });
        setLoading(false);
      },
    );
    return () => {
      disposed = true;
    };
  }, [path, revision]);
  return {
    listing: current?.listing,
    loading: loading || (!!path && !current),
    error: current?.error,
  };
}

export function useBrowsePane(
  session: PaneSession | undefined,
  hidden: boolean,
  revision: number,
) {
  const tab =
    session?.tabs.find((t) => t.id === session.active) ?? session?.tabs[0];
  const path = tab?.path;
  const directory = useDirectoryListing(path, revision);
  const { listing } = directory;
  const listRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ tab: string; path: string } | null>(null);
  const reveal = useRef<string | null>(null);
  const entries = useMemo(
    () => (tab && listing ? visibleEntries(listing.entries, tab, hidden) : []),
    [tab, listing, hidden],
  );

  useLayoutEffect(() => {
    if (listRef.current && tab) listRef.current.scrollTop = tab.scroll;
  }, [tab?.id, tab?.view, tab?.gridSize, path, listing]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const selected = reveal.current;
    if (!listing || !tab || !list || !selected) return;
    reveal.current = null;
    if (tab.view !== "grid") {
      const height = tab.view === "columns" ? 34 : 44;
      const index = entries.findIndex((entry) => entry.path === selected);
      if (index >= 0)
        list.scrollTop = Math.max(
          0,
          index * height - (list.clientHeight - height) / 2,
        );
    } else {
      list
        .querySelector(`[data-path="${CSS.escape(selected)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [listing, tab?.selected]);

  return {
    ...directory,
    tab,
    entries,
    listRef,
    anchor,
    reveal,
  };
}
