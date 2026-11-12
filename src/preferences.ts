import { useEffect, useLayoutEffect, useState } from "react";
import { viewLabels, type Place, type View } from "./model";

export const modeLabels = { system: "跟随系统", light: "浅色", dark: "深色" };
export const themeLabels = {
  default: "默认（纯白）",
  mist: "雾蓝",
  sand: "暖砂",
  sage: "松雾绿",
  teal: "海盐青",
  lilac: "暮藤紫",
  rose: "蔷薇粉",
  slate: "石板灰",
};
export type SidebarSection = "common" | "favorites";
export type Shortcut = Pick<Place, "name" | "path">;
export type Preferences = {
  mode: keyof typeof modeLabels;
  theme: keyof typeof themeLabels;
  defaultView: View;
  autoUpdate: boolean;
  density: "comfortable" | "compact";
  commonPlaces: Shortcut[] | null;
  collapsedSidebar: SidebarSection[];
};

const key = "filepace-preferences";
const defaults: Preferences = {
  mode: "system",
  theme: "default",
  defaultView: "list",
  autoUpdate: true,
  density: "comfortable",
  commonPlaces: null,
  collapsedSidebar: [],
};

function readPreferences(): Preferences {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const value = JSON.parse(stored) as Partial<Preferences>;
      return {
        mode:
          value.mode && Object.hasOwn(modeLabels, value.mode)
            ? value.mode
            : defaults.mode,
        theme:
          value.theme && Object.hasOwn(themeLabels, value.theme)
            ? value.theme
            : defaults.theme,
        defaultView:
          value.defaultView && Object.hasOwn(viewLabels, value.defaultView)
            ? value.defaultView
            : defaults.defaultView,
        autoUpdate:
          typeof value.autoUpdate === "boolean"
            ? value.autoUpdate
            : defaults.autoUpdate,
        density: value.density === "compact" ? "compact" : "comfortable",
        commonPlaces: Array.isArray(value.commonPlaces)
          ? value.commonPlaces.filter(
              (place) =>
                place &&
                typeof place.name === "string" &&
                typeof place.path === "string" &&
                place.path,
            )
          : null,
        collapsedSidebar: Array.isArray(value.collapsedSidebar)
          ? value.collapsedSidebar.filter(
              (section) => section === "common" || section === "favorites",
            )
          : [],
      };
    }
    const legacy = localStorage.getItem("filepace-theme");
    if (legacy === "light" || legacy === "dark")
      return { ...defaults, mode: legacy };
    if (legacy === "mist" || legacy === "sand")
      return { ...defaults, theme: legacy };
  } catch {}
  return defaults;
}

export function usePreferences() {
  const [preferences, setPreferences] = useState(readPreferences);
  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key === key) setPreferences(readPreferences());
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  useLayoutEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    function apply() {
      document.documentElement.dataset.theme = preferences.theme;
      document.documentElement.dataset.mode =
        preferences.mode === "system"
          ? media.matches
            ? "dark"
            : "light"
          : preferences.mode;
    }
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preferences.mode, preferences.theme]);
  function change(
    value:
      Partial<Preferences> | ((current: Preferences) => Partial<Preferences>),
  ) {
    const current = readPreferences();
    const next = {
      ...current,
      ...(typeof value === "function" ? value(current) : value),
    };
    localStorage.setItem(key, JSON.stringify(next));
    setPreferences(next);
  }
  return { preferences, change };
}
