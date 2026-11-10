import { useEffect, useRef, useState, type ReactNode } from "react";
import { call, desktop } from "./bridge";
import type { Entry } from "./model";
const cache = new Map<string, string>();
export default function Thumbnail({
  entry,
  fallback,
}: {
  entry: Entry;
  fallback: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const key = `${entry.path}:${entry.modified}:${entry.size}`;
    const observer = new IntersectionObserver(async (records) => {
      if (!records.some((r) => r.isIntersecting)) return;
      observer.disconnect();
      if (cache.has(key)) {
        setUrl(cache.get(key)!);
        return;
      }
      try {
        const bytes = await call<number[]>("thumbnail", { path: entry.path });
        if (disposed) return;
        const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
        const reader = new FileReader();
        reader.onload = () => {
          if (disposed) return;
          const data = String(reader.result);
          cache.set(key, data);
          if (cache.size > 100) cache.delete(cache.keys().next().value!);
          setUrl(data);
        };
        reader.readAsDataURL(blob);
      } catch {
        /* Unsupported files retain the type icon. */
      }
    });
    if (ref.current) observer.observe(ref.current);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [entry.path, entry.modified, entry.size]);
  return (
    <span ref={ref} className="thumbnail">
      {url ? <img src={url} alt="" /> : fallback}
    </span>
  );
}
