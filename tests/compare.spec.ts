import { expect, test } from "@playwright/test";

test("directory comparison keeps failed copy groups and retries only those groups", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const left = "/compare/left";
    const right = "/compare/right";
    const tab = (path: string, id: string) => ({
      id,
      path,
      history: [path],
      index: 0,
      query: "",
      view: "list",
      sort: "name",
      descending: false,
      selected: [],
      scroll: 0,
    });
    const difference = (
      relative: string,
      rightParent: string | null,
      isDir = false,
    ) => ({
      relative,
      left: {
        name: relative.split("/").at(-1),
        path: `${left}/${relative}`,
        size: 10,
        modified: 1_794_490_000,
        isDir,
        isLink: false,
        hidden: false,
      },
      right: null,
      leftParent: left,
      rightParent,
    });
    const differences = [
      difference("docs", right, true),
      difference("docs/guide.txt", null),
      difference("offline/first.txt", right + "/offline"),
      difference("offline/second.txt", right + "/offline"),
      difference("ready/notes.txt", right + "/ready"),
    ];
    let sequence = 0;
    let revision = 0;
    let task: Record<string, unknown> | null = null;
    let activityListener: [number, number] | undefined;
    const callbacks = new Map<number, (value: unknown) => void>();
    let rejectFirstOfflineSubmission = true;
    const submissions: Record<string, unknown>[] = [];
    Object.assign(window, {
      isTauri: true,
      compareSubmissions: submissions,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main", windowLabel: "main" },
        },
        transformCallback: (callback: (value: unknown) => void) => {
          callbacks.set(++sequence, callback);
          return sequence;
        },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === "places")
            return [{ name: "个人目录", path: left, kind: "favorite" }];
          if (command === "load_session")
            return {
              tabs: [tab(left, "left")],
              active: "left",
              right: { tabs: [tab(right, "right")], active: "right" },
              focused: "left",
            };
          if (command === "list_directory")
            return { path: args.path, parent: "/compare", entries: [] };
          if (command === "tasks")
            return { tasks: task ? [task] : [], undo: null, revision };
          if (command === "update_status")
            return { current: "fixture", phase: "current" };
          if (command === "compare_directories")
            return { differences, total: differences.length, skipped: 0 };
          if (command === "start_task") {
            submissions.push(args);
            const id = `copy-${submissions.length}`;
            if (submissions.length === 1) {
              task = {
                id,
                kind: "copy",
                sources: args.sources,
                destination: right,
                status: "conflict",
                current: left + "/docs",
                completed: 0,
                bytes: 0,
                errors: [],
                conflict: {
                  id: "compare-conflict",
                  source: null,
                  destination: {
                    path: right + "/docs",
                    isDir: true,
                    size: null,
                    modified: null,
                  },
                },
              };
              revision++;
            }
            if (
              args.destination === right + "/offline" &&
              rejectFirstOfflineSubmission
            ) {
              rejectFirstOfflineSubmission = false;
              throw "目标目录已离线";
            }
            return id;
          }
          if (command === "task_action") {
            const id = task?.id;
            task = null;
            revision++;
            if (activityListener) {
              const [eventId, handler] = activityListener;
              callbacks.get(handler)?.({
                event: "task-activity",
                id: eventId,
                payload: { revision, updates: [], removed: [id], undo: null },
              });
            }
          }
          if (command === "plugin:event|listen") {
            const id = ++sequence;
            if (args.event === "task-activity")
              activityListener = [id, Number(args.handler)];
            return id;
          }
          return null;
        },
      },
    });
  });

  await page.goto("/");
  const opener = page.getByRole("button", { name: "对比目录", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "对比两个文件夹" });
  const start = dialog.getByRole("button", { name: "开始对比" });
  const close = dialog.getByRole("button", { name: "关闭" });
  await expect(start).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("checkbox", { name: "比较文件内容" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();

  await opener.click();
  await start.click();
  const rows = dialog.locator(".compare-row");
  await expect(rows).toHaveCount(5);
  for (const row of await rows.all()) await row.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "所选项目复制到右栏" }).click();
  const conflict = page.getByRole("dialog", { name: "目标位置已有同名项目" });
  const keep = conflict.getByRole("button", { name: "保留两者" });
  await expect(keep).toBeFocused();
  await expect(page.locator(".compare-panel").locator("..")).toHaveAttribute(
    "inert",
    "",
  );
  await page.keyboard.press("Tab");
  await expect(conflict.getByRole("checkbox")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(keep).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(conflict).toBeVisible();
  await keep.press("Enter");
  await expect(conflict).toBeHidden();
  await expect(dialog.getByText("已提交 2 组，1 组提交失败。")).toBeVisible();
  await expect(
    dialog.getByRole("list", { name: "提交失败的目标" }),
  ).toContainText("/compare/right/offline");
  await expect(dialog.getByText("目标目录已离线")).toBeVisible();
  for (const row of [rows.nth(0), rows.nth(1), rows.nth(4)]) {
    await expect(row).toContainText("已入队");
    await expect(row.getByRole("checkbox")).not.toBeChecked();
  }
  for (const row of [rows.nth(2), rows.nth(3)]) {
    await expect(row).toContainText("提交失败");
    await expect(row.getByRole("checkbox")).toBeChecked();
  }

  const retry = dialog.getByRole("button", { name: "重试未提交的项目" });
  await expect(retry).toBeFocused();
  await retry.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  const calls = await page.evaluate(
    () =>
      (window as unknown as { compareSubmissions: unknown[] })
        .compareSubmissions,
  );
  expect(calls).toEqual([
    {
      kind: "copy",
      within: "/compare/right",
      destination: "/compare/right",
      sources: ["/compare/left/docs"],
    },
    {
      kind: "copy",
      within: "/compare/right",
      destination: "/compare/right/offline",
      sources: [
        "/compare/left/offline/first.txt",
        "/compare/left/offline/second.txt",
      ],
    },
    {
      kind: "copy",
      within: "/compare/right",
      destination: "/compare/right/ready",
      sources: ["/compare/left/ready/notes.txt"],
    },
    {
      kind: "copy",
      within: "/compare/right",
      destination: "/compare/right/offline",
      sources: [
        "/compare/left/offline/first.txt",
        "/compare/left/offline/second.txt",
      ],
    },
  ]);
});
