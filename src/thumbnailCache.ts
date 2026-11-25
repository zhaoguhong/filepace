import { call } from "./bridge";
import type { Entry } from "./model";

type Subscriber = (image: Blob | null) => void;
type Request = {
  key: string;
  path: string;
  nativeIcon: boolean;
  subscribers: Set<Subscriber>;
};
const cache = new Map<string, { path: string; image: Blob | null }>();
const requests = new Map<string, Request>();
const queue = new Set<Request>();
const invalidationListeners = new Map<string, Set<() => void>>();
let active = 0;
let cachedBytes = 0;

function drain() {
  while (active < 3 && queue.size) {
    const request = queue.values().next().value!;
    queue.delete(request);
    active++;
    void call<ArrayBuffer>("thumbnail", {
      path: request.path,
      nativeIcon: request.nativeIcon,
    })
      .then(
        (bytes) => new Blob([bytes], { type: "image/png" }),
        () => null,
      )
      .then((image) => {
        if (requests.get(request.key) !== request) return;
        cache.set(request.key, { path: request.path, image });
        cachedBytes += image?.size ?? 0;
        while (cachedBytes > 12 * 1024 * 1024 || cache.size > 160) {
          const oldest = cache.keys().next().value!;
          cachedBytes -= cache.get(oldest)?.image?.size ?? 0;
          cache.delete(oldest);
        }
        for (const subscriber of request.subscribers) subscriber(image);
      })
      .finally(() => {
        active--;
        if (requests.get(request.key) === request) requests.delete(request.key);
        drain();
      });
  }
}

export function subscribeThumbnail(
  entry: Entry,
  subscriber: Subscriber,
  nativeIcon = false,
) {
  const key = `${nativeIcon}:${entry.path}:${entry.modified}:${entry.size}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    subscriber(cached.image);
    return () => {};
  }
  let request = requests.get(key);
  if (!request) {
    request = { key, path: entry.path, nativeIcon, subscribers: new Set() };
    requests.set(key, request);
    queue.add(request);
  }
  request.subscribers.add(subscriber);
  drain();
  return () => {
    request.subscribers.delete(subscriber);
    if (!request.subscribers.size && queue.delete(request))
      requests.delete(request.key);
  };
}

function normalizedPath(path: string) {
  const value = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(value) || value.startsWith("//")
    ? value.toLowerCase()
    : value;
}

export function watchThumbnailChanges(path: string, invalidate: () => void) {
  const key = normalizedPath(path);
  const listeners = invalidationListeners.get(key) ?? new Set<() => void>();
  listeners.add(invalidate);
  invalidationListeners.set(key, listeners);
  return () => {
    listeners.delete(invalidate);
    if (!listeners.size) invalidationListeners.delete(key);
  };
}

export function invalidateThumbnails(paths: string[] | null) {
  if (!cache.size && !requests.size && !invalidationListeners.size) return;
  const changed = paths && new Set(paths.map(normalizedPath));
  function affected(path: string) {
    if (!changed) return true;
    let candidate = normalizedPath(path);
    for (;;) {
      if (changed.has(candidate)) return true;
      const separator = candidate.lastIndexOf("/");
      if (separator < 0) return false;
      candidate = candidate.slice(0, separator);
    }
  }
  for (const [key, cached] of cache) {
    if (!affected(cached.path)) continue;
    cachedBytes -= cached.image?.size ?? 0;
    cache.delete(key);
  }
  for (const [key, request] of requests) {
    if (!affected(request.path)) continue;
    queue.delete(request);
    requests.delete(key);
  }
  for (const [key, listeners] of invalidationListeners) {
    if (affected(key)) for (const invalidate of listeners) invalidate();
  }
}

const waiting = new Map<Element, (visible: boolean) => void>();
let observer: IntersectionObserver | undefined;
export function watchVisibility(
  element: Element,
  change: (visible: boolean) => void,
) {
  observer ??= new IntersectionObserver((records) => {
    for (const record of records)
      waiting.get(record.target)?.(record.isIntersecting);
  });
  waiting.set(element, change);
  observer.observe(element);
  return () => {
    waiting.delete(element);
    observer?.unobserve(element);
  };
}
