import { describe, expect, it, vi } from "vitest";
import type { Task } from "./model";
import { ActivityStore } from "./fileActivity";

vi.mock("./bridge", () => ({ call: vi.fn(), desktop: true }));

const job: Task = {
  id: "move",
  sequence: 1,
  kind: "move",
  sourceCount: 10_000,
  destination: "/destination",
  current: "/source/1",
  status: "running",
  completed: 0,
  bytes: 0,
  conflict: null,
};

describe("window and panel task subscriptions", () => {
  it("keeps the window snapshot stable for byte, item, phase and path progress", () => {
    const store = new ActivityStore();
    store.restore({ tasks: [job], undo: null, revision: 1 });
    const shell = store.windowSnapshot();
    for (let i = 1; i <= 1000; i++) {
      const task = {
        ...job,
        bytes: i * 1024,
        completed: i,
        current: `/source/${i}`,
      };
      store.receive({
        updates: [task],
        removed: [],
        revision: i + 1,
        undo: null,
      });
      expect(store.taskSnapshot()[0]).toBe(task);
      expect(store.windowSnapshot()).toBe(shell);
    }
    store.receive({
      revision: 1002,
      updates: [
        {
          ...job,
          status: "conflict",
          conflict: {
            id: "conflict",
            source: null,
            destination: {
              path: "/destination",
              size: null,
              modified: null,
              isDir: true,
            },
          },
        },
      ],
      removed: [],
      undo: null,
    });
    expect(store.windowSnapshot().tasks[0]).toMatchObject({
      status: "conflict",
      sourceCount: 10_000,
    });
    store.receive({
      revision: 1003,
      updates: [],
      removed: [job.id],
      undo: "撤销移动",
    });
    expect(store.windowSnapshot()).toEqual({ tasks: [], undo: "撤销移动" });
  });

  it("replays deltas received before the initial snapshot, ignoring older replies", () => {
    const store = new ActivityStore();
    store.receive({
      revision: 7,
      updates: [{ ...job, status: "done" }],
      removed: [],
      undo: null,
    });
    store.restore({ revision: 6, tasks: [job], undo: null });
    store.restore({ revision: 2, tasks: [], undo: null });
    expect(store.taskSnapshot()[0].status).toBe("done");
    expect(store.windowSnapshot().tasks[0].status).toBe("done");
  });
});
