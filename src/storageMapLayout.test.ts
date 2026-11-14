import { expect, it } from "vitest";
import { layoutStorageTiles } from "./storageMapLayout";
it("partitions the full area proportional to sizes without overlap", () => {
  const tiles = layoutStorageTiles(
    [80, 10, 7, 3].map((size, i) => ({ size, label: String(i) })),
  );
  expect(tiles).toHaveLength(4);
  expect(
    tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0),
  ).toBeCloseTo(10000);
  for (const tile of tiles) {
    expect(tile.width * tile.height).toBeCloseTo(tile.size * 100);
    expect(tile.x + tile.width).toBeLessThanOrEqual(100);
    expect(tile.y + tile.height).toBeLessThanOrEqual(100);
  }
  for (let i = 0; i < tiles.length; i++)
    for (let j = i + 1; j < tiles.length; j++) {
      const a = tiles[i],
        b = tiles[j];
      const intersection =
        Math.max(
          0,
          Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
        ) *
        Math.max(
          0,
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
        );
      expect(intersection).toBeCloseTo(0);
    }
  expect(layoutStorageTiles([{ size: 0, label: "empty" }])).toEqual([]);
});
