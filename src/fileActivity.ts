import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { call, desktop } from "./bridge";
import type { FileActivity, Task } from "./model";

type Delta = {
  revision: number;
  updates: Task[];
  removed: string[];
  undo: string | null;
};

function applyDelta(current: FileActivity, delta: Delta): FileActivity {
  if (delta.revision <= current.revision) return current;
  const tasks = new Map(current.tasks.map((task) => [task.id, task]));
  for (const id of delta.removed) tasks.delete(id);
  for (const task of delta.updates) tasks.set(task.id, task);
  return {
    revision: delta.revision,
    tasks: [...tasks.values()].sort(
      (a, b) => (b.sequence ?? 0) - (a.sequence ?? 0),
    ),
    undo: delta.undo,
  };
}

export function useFileActivity() {
  const [activity, setActivity] = useState<FileActivity>({
    tasks: [],
    undo: null,
    revision: 0,
  });
  const beforeSnapshot = useRef<Delta[] | null>([]);

  function refreshActivity() {
    return call<FileActivity>("tasks")
      .then((snapshot) => {
        const pending = beforeSnapshot.current;
        beforeSnapshot.current = null;
        const next = (pending ?? []).reduce(applyDelta, snapshot);
        setActivity((current) =>
          next.revision >= current.revision ? next : current,
        );
      })
      .catch(() => {});
  }

  useEffect(() => {
    if (!desktop) return;
    const stop = listen<Delta>("task-activity", ({ payload }) => {
      if (beforeSnapshot.current) beforeSnapshot.current.push(payload);
      else setActivity((current) => applyDelta(current, payload));
    });
    void stop.then(refreshActivity).catch(() => refreshActivity());
    return () => {
      void stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  return { ...activity, refreshActivity };
}
