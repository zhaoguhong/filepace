import { useEffect, useRef, useState, type ReactNode } from "react";
import { desktop } from "./bridge";
import { onVisible, subscribeThumbnail } from "./thumbnailCache";
import type { Entry } from "./model";

export default function Thumbnail({
  entry,
  fallback,
  applicationIcon = false,
}: {
  entry: Entry;
  fallback: ReactNode;
  applicationIcon?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState("");
  useEffect(() => {
    setUrl("");
    if (!desktop || !ref.current) return;
    let unsubscribe: (() => unknown) | undefined;
    let imageUrl = "";
    const unobserve = onVisible(ref.current, () => {
      unsubscribe = subscribeThumbnail(
        entry,
        (image) => {
          if (!image) return;
          imageUrl = URL.createObjectURL(image);
          setUrl(imageUrl);
        },
        applicationIcon,
      );
    });
    return () => {
      unobserve();
      unsubscribe?.();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [entry.path, entry.modified, entry.size, applicationIcon]);
  return (
    <span ref={ref} className="thumbnail">
      {url ? <img src={url} alt="" draggable={false} /> : fallback}
    </span>
  );
}
