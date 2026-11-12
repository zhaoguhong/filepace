import { useEffect, useState } from "react";
import { call, desktop } from "./bridge";
import { subscribeThumbnail } from "./thumbnailCache";
import type { Entry } from "./model";
import { textPreviewKind } from "./textPreviewFormat";

export function useFilePreview(entry: Entry | null, inline = false) {
  const path = entry?.path;
  const name = entry?.name;
  const [result, setResult] = useState<{
    path: string;
    text?: string;
    image?: string;
    error?: string;
  }>();
  useEffect(() => {
    setResult(undefined);
    if (!entry || !path || !name) return;
    const picture = /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
    const nativePicture = /\.(heic|heif)$/i.test(name);
    const pdf = /\.pdf$/i.test(name);
    const text =
      textPreviewKind(name) !== "text" ||
      /\.(txt|log|ini)$/i.test(name) ||
      /^(?:readme|license|makefile|dockerfile|\.env(?:\..*)?)$/i.test(name);
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
          setResult({ path, error: "此文件暂时无法生成预览" });
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
          if (!disposed) setResult({ path, error: String(error) });
        });
    } else {
      void call<unknown>("read_preview", { path })
        .then((text) => {
          if (disposed) return;
          setResult(
            typeof text === "string"
              ? { path, text }
              : {
                  path,
                  error: "此文件暂时无法生成文本预览，请用默认应用打开。",
                },
          );
        })
        .catch((error) => {
          if (!disposed) setResult({ path, error: String(error) });
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
