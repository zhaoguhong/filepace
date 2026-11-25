import { expect, it, vi } from "vitest";
import { call } from "./bridge";
import {
  invalidateThumbnails,
  subscribeThumbnail,
  watchThumbnailChanges,
} from "./thumbnailCache";
import type { Entry } from "./model";

vi.mock("./bridge", () => ({ call: vi.fn() }));

it("drops offscreen queued thumbnails and shares work still needed by another pane", async () => {
  const finish: (() => void)[] = [];
  const load = vi.mocked(call);
  load.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish.push(() => resolve(new ArrayBuffer(1)));
      }),
  );
  const entry = (name: string): Entry => ({
    name,
    path: "/" + name,
    size: 1,
    modified: 1,
    hidden: false,
    isDir: false,
    isLink: false,
  });
  const ignore = () => {};
  for (const name of ["1.jpg", "2.jpg", "3.jpg"])
    subscribeThumbnail(entry(name), ignore);
  const leave = subscribeThumbnail(entry("4.jpg"), ignore);
  const receive = vi.fn();
  subscribeThumbnail(entry("4.jpg"), receive);
  leave();
  subscribeThumbnail(entry("5.jpg"), ignore)();
  expect(load).toHaveBeenCalledTimes(3);

  finish.splice(0, 3).forEach((done) => done());
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(4));
  expect(load.mock.calls[3][1]?.path).toBe("/4.jpg");
  finish.shift()!();
  await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
  expect(load).toHaveBeenCalledTimes(4);
});

it("reloads changed paths and discards an older request finishing after its replacement", async () => {
  const finish: ((bytes: ArrayBuffer) => void)[] = [];
  const load = vi.mocked(call).mockClear();
  load.mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
  const entry: Entry = {
    path: "C:\\Pictures\\photo.png",
    name: "photo.png",
    size: 73,
    modified: 1,
    hidden: false,
    isDir: false,
    isLink: false,
  };
  const old = vi.fn();
  const fresh = vi.fn();
  const neighbor = vi.fn();
  const leave = watchThumbnailChanges(entry.path, () =>
    subscribeThumbnail(entry, fresh),
  );
  const leaveNeighbor = watchThumbnailChanges(
    "C:/Picturesque/other.png",
    neighbor,
  );
  subscribeThumbnail(entry, old);
  invalidateThumbnails(["c:/PICTURES"]);
  expect(load).toHaveBeenCalledTimes(2);
  expect(neighbor).not.toHaveBeenCalled();
  finish[1](Uint8Array.of(220).buffer);
  await vi.waitFor(() => expect(fresh).toHaveBeenCalledOnce());
  finish[0](Uint8Array.of(30).buffer);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(old).not.toHaveBeenCalled();
  const cached = await new Promise<Blob | null>((resolve) =>
    subscribeThumbnail(entry, resolve),
  );
  expect([...new Uint8Array(await cached!.arrayBuffer())]).toEqual([220]);
  expect(load).toHaveBeenCalledTimes(2);
  leave();
  leaveNeighbor();
  invalidateThumbnails(null);
  expect(load).toHaveBeenCalledTimes(2);
});
