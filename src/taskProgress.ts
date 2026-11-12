import type { Task } from "./model";

export function taskProgress(task: Task) {
  const overall = typeof task.totalBytes === "number" && task.totalBytes >= 0;
  const total = overall ? task.totalBytes! : task.currentTotalBytes;
  const done = overall ? task.bytes : (task.currentBytes ?? 0);
  const known = typeof total === "number" && total >= 0;
  const fraction =
    known && total > 0 ? Math.min(1, Math.max(0, done / total)) : null;
  const seconds = (task.transferMillis ?? 0) / 1000;
  const measured =
    task.status === "running" &&
    task.phase === "写入暂存文件" &&
    seconds >= 1.5 &&
    task.bytes >= 64 * 1024 &&
    task.errors.length === 0;
  const rate = measured ? task.bytes / seconds : null;
  // Skipped files remain part of the scan total. Do not estimate an ETA from
  // that denominator, or from files whose size changed after the scan.
  const remaining =
    rate && known && total >= done && !task.skipped
      ? (total - done) / rate
      : null;
  return {
    overall,
    total: known ? total : null,
    done,
    fraction,
    rate,
    remaining,
  };
}

export function formatRemaining(seconds: number): string {
  if (seconds < 1) return "不足 1 秒";
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${Math.ceil(seconds / 3600)} 小时`;
}
