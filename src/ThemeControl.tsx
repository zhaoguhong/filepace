import { useEffect, useLayoutEffect, useState } from "react";
import { Palette } from "lucide-react";

const key = "filepace-theme";
const themes = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
  mist: "雾蓝",
  sand: "暖砂",
} as const;
type Theme = keyof typeof themes;

function decode(value: string | null): Theme {
  return value && Object.hasOwn(themes, value) ? (value as Theme) : "system";
}

export default function ThemeControl() {
  const [theme, setTheme] = useState(() => decode(localStorage.getItem(key)));
  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key === key) setTheme(decode(event.newValue));
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  useLayoutEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    function apply() {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    }
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  return (
    <label className="theme-control" title="主题">
      <Palette size={16} />
      <select
        aria-label="主题"
        value={theme}
        onChange={(event) => {
          const selected = decode(event.target.value);
          setTheme(selected);
          localStorage.setItem(key, selected);
        }}
      >
        {Object.entries(themes).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
