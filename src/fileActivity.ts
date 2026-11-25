import { useEffect, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { call, desktop } from "./bridge";
import type { FileActivity, Task } from "./model";

type Delta = {
  revision: number;
  updates: Task[];
  removed: string[];
  undo: string | null;
};

type WindowTask = Pick<Task, "id" | "kind" | "status" | "conflict"> & {
  sourceCount: number;
};

function applyDelta(current: FileActivity, delta: Delta): FileActivity {
  if (delta.revision <= current.revision) return current;
  const updates = new Map(delta.updates.map((task) => [task.id, task]));
  const removed = new Set(delta.removed);
  const tasks: Task[] = [];
  for (const task of current.tasks) {
    if (!removed.has(task.id)) tasks.push(updates.get(task.id) ?? task);
    updates.delete(task.id);
  }
  if (updates.size) {
    tasks.push(...updates.values());
    tasks.sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0));
  }
  return { revision: delta.revision, tasks, undo: delta.undo };
}

export class ActivityStore {
  private activity: FileActivity = { tasks: [], undo: null, revision: 0 };
  private windowState: { tasks: WindowTask[]; undo: string | null } = {
    tasks: [],
    undo: null,
  };
  private pending: Delta[] | null = [];
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  windowSnapshot = () => this.windowState;
  taskSnapshot = () => this.activity.tasks;

  private publish(next: FileActivity, refreshWindow = false) {
    if (next === this.activity || next.revision < this.activity.revision)
      return;
    this.activity = next;
    const previous = this.windowState;
    if (
      refreshWindow ||
      previous.undo !== next.undo ||
      previous.tasks.length !== next.tasks.length ||
      next.tasks.some((task, i) => {
        const prior = previous.tasks[i];
        return (
          prior.id !== task.id ||
          prior.status !== task.status ||
          prior.kind !== task.kind ||
          prior.conflict?.id !== task.conflict?.id
        );
      })
    ) {
      this.windowState = {
        undo: next.undo,
        tasks: next.tasks.map(
          ({ id, kind, status, conflict, sourceCount, sources }) => ({
            id,
            kind,
            status,
            conflict,
            sourceCount: sourceCount ?? sources?.length ?? 0,
          }),
        ),
      };
    }
    for (const listener of this.listeners) listener();
  }

  receive = (delta: Delta) => {
    if (this.pending) this.pending.push(delta);
    else this.publish(applyDelta(this.activity, delta));
  };

  restore(snapshot: FileActivity) {
    const next = (this.pending ?? []).reduce(applyDelta, snapshot);
    this.pending = null;
    // Explicit refresh also reconciles tasks that finished before the caller
    // received its submission ID and registered the terminal notification.
    this.publish(next, true);
  }

  refresh = async () => {
    try {
      this.restore(await call<FileActivity>("tasks"));
    } catch {
      // A failed first snapshot must not keep subsequent deltas buffered forever.
      if (this.pending) this.restore(this.activity);
    }
  };
}

export function useFileActivity() {
  const [store] = useState(() => new ActivityStore());
  const activity = useSyncExternalStore(store.subscribe, store.windowSnapshot);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const stop = listen<Delta>("task-activity", ({ payload }) => {
      if (active) store.receive(payload);
    });
    const refresh = () => {
      if (active) void store.refresh();
    };
    void stop.then(refresh, refresh);
    return () => {
      active = false;
      void stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [store]);

  return { ...activity, refreshActivity: store.refresh, activityStore: store };
}
