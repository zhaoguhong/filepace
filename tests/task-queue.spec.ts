import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page, sourceCount = 1) {
  await page.addInitScript((sourceCount) => {
    localStorage.setItem(
      "filepace-preferences",
      JSON.stringify({ autoUpdate: false }),
    );
    let callback = 0;
    let revision = 1;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const base = {
      kind: "copy",
      firstSource: "/fixture/source.bin",
      sourceCount,
      destination: "/fixture/target",
      current: "source.bin",
      completed: 0,
      bytes: 1024,
      errorCount: 0,
      failedCount: 0,
      conflict: null,
      canPause: true,
      phase: "写入暂存文件",
      totalBytes: 4096,
      currentBytes: 1024,
    };
    const tasks = [
      {
        ...base,
        id: "running",
        sequence: 1,
        status: "running",
        queuePosition: null,
        pauseRequested: false,
      },
      {
        ...base,
        id: "one",
        sequence: 2,
        status: "queued",
        queuePosition: 0,
        pauseRequested: false,
      },
      {
        ...base,
        id: "two",
        sequence: 3,
        status: "queued",
        queuePosition: 1,
        pauseRequested: false,
      },
    ];
    const emit = () => {
      const payload = {
        revision: ++revision,
        updates: [...tasks],
        removed: [],
        undo: null,
      };
      for (const [id, listener] of listeners)
        if (listener.event === "task-activity")
          callbacks.get(listener.handler)?.({
            event: listener.event,
            id,
            payload,
          });
    };
    Object.assign(window, {
      isTauri: true,
      taskFixture: {
        calls,
        preparing: () => {
          tasks[0].status = "preparing";
          tasks[0].canPause = false;
          emit();
        },
        progress: () => {
          tasks[0].bytes += 1024;
          tasks[0].currentBytes += 1024;
          emit();
        },
        finishPause: () => {
          tasks[0].status = "paused";
          emit();
        },
        finishResume: () => {
          tasks[0].status = "running";
          emit();
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main", windowLabel: "main" },
        },
        transformCallback: (handler: (value: unknown) => void) => {
          callbacks.set(++callback, handler);
          return callback;
        },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args });
          if (command === "places")
            return [{ name: "个人目录", path: "/fixture", kind: "favorite" }];
          if (command === "tasks") return { tasks, revision, undo: null };
          if (command === "task_details") {
            const offset = Number(args.offset);
            return Array.from(
              { length: Math.min(100, sourceCount - offset) },
              (_, i) => "/fixture/source-" + (offset + i),
            );
          }
          if (command === "list_directory")
            return { path: args.path, parent: "/", entries: [] };
          if (command === "update_status")
            return { current: "fixture", phase: "current" };
          if (command === "task_action") {
            const task = tasks.find((item) => item.id === args.id)!;
            if (args.decision === "pause") {
              task.status = "pausing";
              task.pauseRequested = true;
            }
            if (args.decision === "resume") {
              task.status = task.queuePosition === null ? "resuming" : "queued";
              task.pauseRequested = false;
            }
            if (args.decision === "cancel") {
              task.status = "cancelled";
              task.queuePosition = null;
              task.pauseRequested = false;
            }
            emit();
          }
          if (command === "reorder_task") {
            const task = tasks.find((item) => item.id === args.id)!;
            const other = tasks.find(
              (item) =>
                item.queuePosition ===
                task.queuePosition! + (args.direction === "up" ? -1 : 1),
            )!;
            [task.queuePosition, other.queuePosition] = [
              other.queuePosition,
              task.queuePosition,
            ];
            emit();
          }
          if (command === "plugin:event|listen") {
            listeners.set(++callback, {
              event: String(args.event),
              handler: Number(args.handler),
            });
            return callback;
          }
          if (command === "plugin:event|unlisten")
            listeners.delete(Number(args.eventId));
          return null;
        },
      },
    });
  }, sourceCount);
  await page.goto("/");
  await page.getByRole("button", { name: "3 个文件任务", exact: true }).click();
}

test("large task details are fetched by page only while expanded and progress remains live", async ({
  page,
}) => {
  await setup(page, 10_000);
  const row = page.locator('[data-task-id="running"]');
  const details = row.locator("details");
  const countRequests = () =>
    page.evaluate(
      () =>
        (
          window as unknown as { taskFixture: { calls: { command: string }[] } }
        ).taskFixture.calls.filter(({ command }) => command === "task_details")
          .length,
    );
  await expect(details.locator("p")).toHaveCount(0);
  expect(await countRequests()).toBe(0);
  await details.locator("summary").click();
  await expect(details.locator("p")).toHaveCount(100);
  await expect(
    details.getByText("/fixture/source-0", { exact: true }),
  ).toBeVisible();
  await details.getByRole("button", { name: "下一页" }).click();
  await expect(
    details.getByText("/fixture/source-100", { exact: true }),
  ).toBeVisible();
  await expect(details.locator("p")).toHaveCount(100);
  await page.evaluate(() =>
    (
      window as unknown as { taskFixture: { progress: () => void } }
    ).taskFixture.progress(),
  );
  await expect(row.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "50",
  );
  expect(await countRequests()).toBe(2);
  await details.locator("summary").click();
  await expect(details.locator("p")).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { taskFixture: { preparing: () => void } }).taskFixture.preparing());
  await expect(row.getByText("正在校验源和目标")).toBeVisible();
  await expect(row.getByRole("button", { name: "暂停" })).toHaveCount(0);
  await row.getByRole("button", { name: "取消", exact: true }).click();
  await expect(row.getByText("已取消", { exact: true })).toBeVisible();
});

test("pause acknowledges safe boundary, resumes, cancels paused work and reorders the backend queue", async ({
  page,
}) => {
  await setup(page);
  const panel = page.getByRole("region", { name: "文件任务", exact: true });
  const running = panel.locator('[data-task-id="running"]');
  await running.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(running.getByText("正在暂停", { exact: true })).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { taskFixture: { finishPause: () => void } }
    ).taskFixture.finishPause(),
  );
  await expect(running.getByText("已暂停", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "3 个文件任务", exact: true }),
  ).toBeVisible();
  await running.getByRole("button", { name: "继续", exact: true }).click();
  await expect(running.getByText("等待继续", { exact: true })).toBeVisible();
  await expect(
    running.getByRole("button", { name: "继续", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "3 个文件任务", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { taskFixture: { finishResume: () => void } }
    ).taskFixture.finishResume(),
  );
  await expect(running.getByText("进行中", { exact: true })).toBeVisible();
  await panel
    .locator('[data-task-id="two"]')
    .getByRole("button", { name: "任务上移" })
    .click();
  await expect
    .poll(() =>
      panel
        .locator(".task")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-task-id")),
        ),
    )
    .toEqual(["running", "two", "one"]);
  await expect(
    panel
      .locator('[data-task-id="two"]')
      .getByRole("button", { name: "任务上移" }),
  ).toBeDisabled();
  await running.getByRole("button", { name: "暂停", exact: true }).click();
  await page.evaluate(() =>
    (
      window as unknown as { taskFixture: { finishPause: () => void } }
    ).taskFixture.finishPause(),
  );
  await running.getByRole("button", { name: "取消", exact: true }).click();
  await expect(running.getByText("已取消", { exact: true })).toBeVisible();
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          taskFixture: { calls: { command: string; args: unknown }[] };
        }
      ).taskFixture.calls,
  );
  expect(calls.filter((call) => call.command === "reorder_task")).toEqual([
    { command: "reorder_task", args: { id: "two", direction: "up" } },
  ]);
});
