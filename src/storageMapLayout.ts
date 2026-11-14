import type { StorageTreeNode } from "./storageTypes";

type Tile = { node?: StorageTreeNode; size: number; label: string };
type Rect = Tile & { x: number; y: number; width: number; height: number };
// Balanced binary partition preserves every represented byte, including the
// aggregate for omitted nodes. Zero-byte entries remain available in the list.
export function layoutStorageTiles(
  items: Tile[],
  x = 0,
  y = 0,
  width = 100,
  height = 100,
): Rect[] {
  const total = items.reduce((sum, item) => sum + item.size, 0);
  if (!items.length || total <= 0) return [];
  if (items.length === 1) return [{ ...items[0], x, y, width, height }];
  let sum = 0,
    split = 1;
  for (let i = 0; i < items.length - 1; i++) {
    sum += items[i].size;
    split = i + 1;
    if (sum >= total / 2) break;
  }
  const fraction = sum / total;
  return width >= height
    ? [
        ...layoutStorageTiles(
          items.slice(0, split),
          x,
          y,
          width * fraction,
          height,
        ),
        ...layoutStorageTiles(
          items.slice(split),
          x + width * fraction,
          y,
          width * (1 - fraction),
          height,
        ),
      ]
    : [
        ...layoutStorageTiles(
          items.slice(0, split),
          x,
          y,
          width,
          height * fraction,
        ),
        ...layoutStorageTiles(
          items.slice(split),
          x,
          y + height * fraction,
          width,
          height * (1 - fraction),
        ),
      ];
}
