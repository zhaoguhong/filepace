import { describe, expect, it } from "vitest";
import { taskProgress } from "./taskProgress";
import type { Task } from "./model";

const copying: Task = {
  id: "copy",
  kind: "copy",
  sources: ["/source"],
  destination: "/target",
  current: "/source/file",
  status: "running",
  phase: "写入暂存文件",
  completed: 0,
  bytes: 1024 * 1024,
  totalBytes: 4 * 1024 * 1024,
  currentBytes: 1024 * 1024,
  currentTotalBytes: 2 * 1024 * 1024,
  transferMillis: 2000,
  errors: [],
  conflict: null,
};

describe("task progress measurements", () => {
  it("reports scanned total with measured transfer rate and estimated transfer time", () => {
    expect(taskProgress(copying)).toMatchObject({
      overall: true,
      fraction: 0.25,
      rate: 512 * 1024,
      remaining: 6,
    });
  });
  it("uses current-file progress when the overall move size is unknown", () => {
    expect(
      taskProgress({ ...copying, kind: "move", totalBytes: null }),
    ).toMatchObject({
      overall: false,
      fraction: 0.5,
      remaining: 2,
    });
  });
  it("does not invent totals or rates during scanning or conflicts", () => {
    expect(
      taskProgress({
        ...copying,
        phase: "正在统计总量",
        totalBytes: null,
        currentTotalBytes: null,
      }),
    ).toMatchObject({
      total: null,
      fraction: null,
      rate: null,
      remaining: null,
    });
    expect(taskProgress({ ...copying, status: "conflict" }).rate).toBeNull();
    expect(taskProgress({ ...copying, transferMillis: 100 }).rate).toBeNull();
  });
  it("suppresses misleading estimates after skips, failures or source-size changes", () => {
    expect(taskProgress({ ...copying, skipped: 1 }).remaining).toBeNull();
    expect(
      taskProgress({ ...copying, errors: ["read error"] }).remaining,
    ).toBeNull();
    expect(taskProgress({ ...copying, totalBytes: 1 })).toMatchObject({
      fraction: 1,
      remaining: null,
    });
  });
});
