import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page) {
  await page.addInitScript(() => {
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
      sources: ["/fixture/source.bin"],
      destination: "/fixture/target",
      current: "source.bin",
      completed: 0,
      bytes: 1024,
      errors: [],
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
  });
  await page.goto("/");
  await page.getByRole("button", { name: "3 个文件任务", exact: true }).click();
}

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
