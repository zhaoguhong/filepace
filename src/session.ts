import type { PaneSession, PaneSide } from "./browsePane";
import { makeTab, type View } from "./model";

export type Session = PaneSession & {
  right?: PaneSession;
  focused?: PaneSide;
  splitRatio?: number;
};

export function cleanPane({ tabs, active }: PaneSession): PaneSession {
  return {
    tabs: tabs.map((tab) => ({
      ...tab,
      selected: [],
      locationState:
        tab.locationState &&
        Object.fromEntries(
          Object.entries(tab.locationState).map(([index, state]) => [
            index,
            { ...state, selected: [] },
          ]),
        ),
    })),
    active,
  };
}

export function restoreSession(
  saved: Session | null,
  fallbackPath: string,
  defaultView: View,
): Session {
  const tabs = saved?.tabs?.length
    ? saved.tabs
    : [makeTab(fallbackPath, defaultView)];
  const right = saved?.right?.tabs?.length
    ? {
        tabs: saved.right.tabs,
        active:
          saved.right.tabs.find((tab) => tab.id === saved.right?.active)?.id ??
          saved.right.tabs[0].id,
      }
    : undefined;
  return {
    tabs,
    active: tabs.find((tab) => tab.id === saved?.active)?.id ?? tabs[0].id,
    right,
    focused: right && saved?.focused === "right" ? "right" : "left",
    splitRatio:
      typeof saved?.splitRatio === "number" &&
      saved.splitRatio >= 0.25 &&
      saved.splitRatio <= 0.75
        ? saved.splitRatio
        : undefined,
  };
}
