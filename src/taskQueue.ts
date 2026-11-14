import type { Task } from "./model";

export const activeTask = (task: { status: string }) =>
  ["queued", "running", "conflict", "pausing", "paused", "resuming"].includes(
    task.status,
  );

export function orderedTasks(tasks: Task[]): Task[] {
  const group = (task: Task) =>
    !activeTask(task) ? 2 : task.queuePosition != null ? 1 : 0;
  return [...tasks].sort((a, b) => {
    const difference = group(a) - group(b);
    if (difference) return difference;
    if (group(a) === 1) return a.queuePosition! - b.queuePosition!;
    return (b.sequence ?? 0) - (a.sequence ?? 0);
  });
}
