import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { call } from "./bridge";
import { visibleEntries, type Listing, type Tab } from "./model";

export type PaneSide = "left" | "right";
export type PaneSession = { tabs: Tab[]; active: string };

export function useBrowsePane(
  session: PaneSession | undefined,
  hidden: boolean,
  revision: number,
) {
  const tab =
    session?.tabs.find((t) => t.id === session.active) ?? session?.tabs[0];
  const path = tab?.path;
  const [result, setResult] = useState<{
    path: string;
    listing?: Listing;
    error?: string;
  }>();
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ tab: string; path: string } | null>(null);
  const reveal = useRef<string | null>(null);
  const current = result?.path === path ? result : undefined;
  const listing = current?.listing;
  const entries = useMemo(
    () => (tab && listing ? visibleEntries(listing.entries, tab, hidden) : []),
    [tab, listing, hidden],
  );

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

  useLayoutEffect(() => {
    if (listRef.current && tab) listRef.current.scrollTop = tab.scroll;
  }, [tab?.id, tab?.view, tab?.gridSize, path, listing]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const selected = reveal.current;
    if (!listing || !tab || !list || !selected) return;
    reveal.current = null;
    if (tab.view === "list") {
      const index = entries.findIndex((entry) => entry.path === selected);
      if (index >= 0)
        list.scrollTop = Math.max(0, index * 44 - (list.clientHeight - 44) / 2);
    } else {
      list
        .querySelector(`[data-path="${CSS.escape(selected)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [listing, tab?.selected]);

  return {
    tab,
    entries,
    listing,
    loading: loading || (!!path && !current),
    error: current?.error,
    listRef,
    anchor,
    reveal,
  };
}
