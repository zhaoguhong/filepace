import { useEffect, useLayoutEffect, useState } from "react";
import { viewLabels, type View } from "./model";

export const modeLabels = { system: "跟随系统", light: "浅色", dark: "深色" };
export const themeLabels = { default: "默认", mist: "雾蓝", sand: "暖砂" };
export type Preferences = {
  mode: keyof typeof modeLabels;
  theme: keyof typeof themeLabels;
  defaultView: View;
  autoUpdate: boolean;
};

const key = "filepace-preferences";
const defaults: Preferences = {
  mode: "system",
  theme: "default",
  defaultView: "columns",
  autoUpdate: true,
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
  function change(value: Partial<Preferences>) {
    const next = { ...readPreferences(), ...value };
    localStorage.setItem(key, JSON.stringify(next));
    setPreferences(next);
  }
  return { preferences, change };
}
