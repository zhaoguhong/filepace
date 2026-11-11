import { call } from "./bridge";
import type { Entry } from "./model";

type Subscriber = (image: Blob | null) => void;
type Request = {
  key: string;
  path: string;
  nativeIcon: boolean;
  subscribers: Set<Subscriber>;
};
const cache = new Map<string, Blob | null>();
const requests = new Map<string, Request>();
const queue: Request[] = [];
let active = 0;
let cachedBytes = 0;

function drain() {
  while (active < 3 && queue.length) {
    const request = queue.shift()!;
    if (!request.subscribers.size) {
      requests.delete(request.key);
      continue;
    }
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
        cache.set(request.key, image);
        cachedBytes += image?.size ?? 0;
        while (cachedBytes > 12 * 1024 * 1024 || cache.size > 160) {
          const oldest = cache.keys().next().value!;
          cachedBytes -= cache.get(oldest)?.size ?? 0;
          cache.delete(oldest);
        }
        for (const subscriber of request.subscribers) subscriber(image);
      })
      .finally(() => {
        active--;
        requests.delete(request.key);
        drain();
      });
  }
}

export function subscribeThumbnail(entry: Entry, subscriber: Subscriber, nativeIcon = false) {
  const key = `${nativeIcon}:${entry.path}:${entry.modified}:${entry.size}`;
  if (cache.has(key)) {
    const image = cache.get(key)!;
    cache.delete(key);
    cache.set(key, image);
    subscriber(image);
    return () => {};
  }
  let request = requests.get(key);
  if (!request) {
    request = { key, path: entry.path, nativeIcon, subscribers: new Set() };
    requests.set(key, request);
    queue.push(request);
  }
  request.subscribers.add(subscriber);
  drain();
  return () => request.subscribers.delete(subscriber);
}

const waiting = new Map<Element, () => void>();
let observer: IntersectionObserver | undefined;
export function onVisible(element: Element, load: () => void) {
  observer ??= new IntersectionObserver((records) => {
    for (const record of records) {
      if (!record.isIntersecting) continue;
      const pending = waiting.get(record.target);
      waiting.delete(record.target);
      observer?.unobserve(record.target);
      pending?.();
    }
  });
  waiting.set(element, load);
  observer.observe(element);
  return () => {
    waiting.delete(element);
    observer?.unobserve(element);
  };
}
