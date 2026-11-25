import { useEffect, useRef, useState, type ReactNode } from "react";
import { desktop } from "./bridge";
import {
  watchVisibility,
  subscribeThumbnail,
  watchThumbnailChanges,
} from "./thumbnailCache";
import type { Entry } from "./model";

export default function Thumbnail({
  entry,
  fallback,
  nativeIcon = false,
}: {
  entry: Entry;
  fallback: ReactNode;
  nativeIcon?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (desktop)
      return watchThumbnailChanges(entry.path, () => setRevision((n) => n + 1));
  }, [entry.path]);
  useEffect(() => {
    setUrl("");
    if (!desktop || !ref.current) return;
    let unsubscribe: (() => void) | undefined;
    let imageUrl = "";
    const unobserve = watchVisibility(ref.current, (visible) => {
      if (!visible) {
        unsubscribe?.();
        unsubscribe = undefined;
        return;
      }
      if (unsubscribe) return;
      unsubscribe = subscribeThumbnail(
        entry,
        (image) => {
          unobserve();
          if (!image) return;
          imageUrl = URL.createObjectURL(image);
          setUrl(imageUrl);
        },
        nativeIcon,
      );
    });
    return () => {
      unobserve();
      unsubscribe?.();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [entry.path, entry.modified, entry.size, nativeIcon, revision]);
  return (
    <span ref={ref} className="thumbnail">
      {url ? (
        <img src={url} alt="" draggable={false} onError={() => setUrl("")} />
      ) : (
        fallback
      )}
    </span>
  );
}
