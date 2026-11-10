import { useEffect, useState } from "react";
import { call, desktop } from "./bridge";
import type { Entry } from "./model";

export function useFilePreview(entry: Entry | null, inline = false) {
  const path = entry?.path;
  const name = entry?.name;
  const [result, setResult] = useState<{
    path: string;
    text?: string;
    image?: string;
  }>();
  useEffect(() => {
    setResult(undefined);
    if (!path || !name) return;
    const picture = /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
    const text =
      /\.(txt|md|markdown|csv|tsv|log|json|xml|ini|toml|ya?ml|html|css|jsx?|tsx?|rs|py|sh)$/i.test(
        name,
      );
    if (inline && !picture && !text) return;
    let disposed = false;
    let url = "";
    if (picture && desktop) {
      call<number[]>(inline ? "thumbnail" : "read_image", { path })
        .then((bytes) => {
          if (disposed) return;
          url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
          setResult({ path, image: url });
        })
        .catch((error) => {
          if (!disposed) setResult({ path, text: inline ? "" : String(error) });
        });
    } else {
      call<string>("read_preview", { path })
        .then((text) => {
          if (!disposed) setResult({ path, text });
        })
        .catch((error) => {
          if (!disposed) setResult({ path, text: inline ? "" : String(error) });
        });
    }
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, name, inline]);
  return result?.path === path ? result : undefined;
}
