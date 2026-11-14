import { describe, expect, it } from "vitest";
import { activeTask, orderedTasks } from "./taskQueue";
import type { Task } from "./model";

const task = (
  id: string,
  status: string,
  sequence: number,
  queuePosition?: number,
): Task => ({
  id,
  status,
  sequence,
  queuePosition,
  kind: "copy",
  sources: [],
  destination: "/target",
  current: "",
  completed: 0,
  bytes: 0,
  errors: [],
  conflict: null,
});

describe("task queue presentation", () => {
  it("keeps paused and pausing work active for close/update/undo guards", () => {
    for (const status of [
      "queued",
      "running",
      "conflict",
      "pausing",
      "paused",
      "resuming",
    ])
      expect(activeTask({ status })).toBe(true);
    for (const status of ["done", "error", "cancelled"])
      expect(activeTask({ status })).toBe(false);
  });
  it("shows backend queue order ahead of history without changing source data", () => {
    const tasks = [
      task("old", "done", 1),
      task("last", "queued", 4, 1),
      task("first", "paused", 2, 0),
      task("running", "running", 3),
      task("recent", "error", 5),
    ];
    expect(orderedTasks(tasks).map((item) => item.id)).toEqual([
      "running",
      "first",
      "last",
      "recent",
      "old",
    ]);
    expect(tasks[0].id).toBe("old");
  });
});
