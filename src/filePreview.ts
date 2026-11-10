import { useEffect, useState } from "react";
import { call, desktop } from "./bridge";
import { subscribeThumbnail } from "./thumbnailCache";
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
    if (!entry || !path || !name) return;
    const picture = /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
    const nativePicture = /\.(heic|heif)$/i.test(name);
    const pdf = /\.pdf$/i.test(name);
    const text =
      /\.(txt|md|markdown|csv|tsv|log|json|xml|ini|toml|ya?ml|html|css|jsx?|tsx?|rs|py|sh)$/i.test(
        name,
      );
    if (inline && !picture && !nativePicture && !pdf && !text) return;
    let disposed = false;
    let url = "";
    let stop: (() => unknown) | undefined;
    if (desktop && ((inline && (picture || pdf)) || nativePicture)) {
      stop = subscribeThumbnail(entry, (image) => {
        if (disposed) return;
        if (image) {
          url = URL.createObjectURL(image);
          setResult({ path, image: url });
        } else if (!inline) {
          setResult({ path, text: "此文件暂时无法生成预览" });
        }
      });
    } else if (desktop && picture) {
      void call<ArrayBuffer>("read_image", { path })
        .then((bytes) => {
          if (disposed) return;
          url = URL.createObjectURL(new Blob([bytes]));
          setResult({ path, image: url });
        })
        .catch((error) => {
          if (!disposed) setResult({ path, text: String(error) });
        });
    } else {
      void call<string>("read_preview", { path })
        .then((text) => {
          if (!disposed) setResult({ path, text });
        })
        .catch((error) => {
          if (!disposed) setResult({ path, text: inline ? "" : String(error) });
        });
    }
    return () => {
      disposed = true;
      stop?.();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, name, entry?.size, entry?.modified, inline]);
  return result?.path === path ? result : undefined;
}
