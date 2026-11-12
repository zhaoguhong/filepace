import { test, expect, type Page } from "@playwright/test";

type Fixture = {
  calls: { command: string; args: Record<string, unknown> }[];
  emit: (event: string, payload: unknown) => void;
};

async function setup(page: Page, slow = false, groupCount = 1) {
  await page.addInitScript(
    ({ slow, groupCount }) => {
      localStorage.setItem(
        "filepace-preferences",
        JSON.stringify({ defaultView: "list", autoUpdate: false }),
      );
      const root = "/Users/duplicate-fixture";
      const files = ["plan.md", "plan-copy.md"].map((name) => ({
        name,
        path: root + "/" + name,
        size: 256,
        modified: 1794380000,
        hidden: false,
        isDir: false,
        isLink: false,
      }));
      const calls: Fixture["calls"] = [];
      const callbacks = new Map<number, (value: unknown) => void>();
      const listeners = new Map<number, { event: string; handler: number }>();
      let sequence = 0;
      let finishScan: ((value: unknown) => void) | undefined;
      const emit = (event: string, payload: unknown) => {
        for (const [id, listener] of listeners)
          if (listener.event === event)
            callbacks.get(listener.handler)?.({ event, id, payload });
      };
      Object.assign(window, {
        isTauri: true,
        duplicateFixture: { calls, emit },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
        __TAURI_INTERNALS__: {
          metadata: {
            currentWindow: { label: "main" },
            currentWebview: { label: "main", windowLabel: "main" },
          },
          transformCallback: (handler: (value: unknown) => void) => {
            callbacks.set(++sequence, handler);
            return sequence;
          },
          invoke: async (
            command: string,
            args: Record<string, unknown> = {},
          ) => {
            calls.push({ command, args });
            if (command === "places")
              return [{ name: "个人目录", path: root, kind: "favorite" }];
            if (command === "tasks")
              return { tasks: [], revision: 0, undo: null };
            if (command === "list_directory")
              return {
                path: args.path,
                parent: "/Users",
                entries: args.path === root ? files : [],
              };
            if (command === "storage_volumes" || command === "diagnosis_agents")
              return [];
            if (command === "update_status")
              return { current: "fixture", phase: "current" };
            if (command === "read_preview") return "# Fixture\n\nSame content.";
            if (command === "start_task") return "duplicate-trash-fixture";
            if (command === "find_duplicates") {
              if (slow)
                return new Promise((resolve) => {
                  finishScan = resolve;
                });
              return {
                path: root,
                groups: Array.from({ length: groupCount }, (_, index) => ({
                  id: `same-bytes-${index}`,
                  files:
                    index === 0
                      ? files
                      : files.map((entry) => ({
                          ...entry,
                          path: `${root}/group-${index + 1}/${entry.name}`,
                        })),
                  size: 256,
                })),
                scannedFiles: 7,
                scannedBytes: 2048,
                skipped: 2,
                hardLinks: 1,
                limited: true,
              };
            }
            if (command === "cancel_duplicates") {
              finishScan?.(null);
              return null;
            }
            if (command === "plugin:event|listen") {
              listeners.set(++sequence, {
                event: String(args.event),
                handler: Number(args.handler),
              });
              return sequence;
            }
            if (command === "plugin:event|unlisten")
              listeners.delete(Number(args.eventId));
            return null;
          },
        },
      });
    },
    { slow, groupCount },
  );
  await page.goto("/");
  await page.getByRole("button", { name: /^命令面板/ }).click();
  await page.getByRole("combobox", { name: "搜索操作" }).fill("检查重复文件");
  await page.getByRole("option", { name: /检查重复文件/ }).click();
  await expect(
    page.getByRole("region", { name: "检查重复文件", exact: true }),
  ).toBeVisible();
}

async function taskCalls(page: Page) {
  return page.evaluate(() =>
    (
      window as unknown as { duplicateFixture: Fixture }
    ).duplicateFixture.calls.filter((call) => call.command === "start_task"),
  );
}

test("requires an explicit keeper and sends only manually selected copies to the task engine", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "开始检查", exact: true }).click();
  const group = page.getByRole("region", { name: "重复组 1", exact: true });
  await expect(group).toBeVisible();
  await expect(group.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByText(/以下为部分结果/)).toBeVisible();
  await expect(page.getByText(/硬链接别名不作为独立副本/)).toBeVisible();
  await group
    .getByRole("combobox", { name: "重复组 1 保留位置" })
    .selectOption("/Users/duplicate-fixture/plan.md");
  await expect(
    group
      .getByRole("listbox", { name: "重复组 1 的副本", exact: true })
      .getByRole("option", { name: /plan-copy.md/ }),
  ).toBeVisible();
  const all = group.getByRole("checkbox", {
    name: "全选重复组 1 的副本",
    exact: true,
  });
  await expect(all).not.toBeChecked();
  await expect(
    group.getByRole("button", { name: "将所选文件移到回收站", exact: true }),
  ).toBeDisabled();
  await all.check();
  await group
    .getByRole("button", { name: "将所选文件移到回收站", exact: true })
    .click();
  await expect.poll(async () => (await taskCalls(page)).length).toBe(1);
  expect((await taskCalls(page))[0].args).toMatchObject({
    kind: "trash",
    sources: ["/Users/duplicate-fixture/plan-copy.md"],
    duplicateGuard: {
      groupId: "same-bytes-0",
      keeper: "/Users/duplicate-fixture/plan.md",
      scanId: expect.any(String),
    },
  });
});

test("marks changed groups stale and prevents removal from an obsolete content snapshot", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "开始检查", exact: true }).click();
  const group = page.getByRole("region", { name: "重复组 1", exact: true });
  await group
    .getByRole("combobox", { name: "重复组 1 保留位置" })
    .selectOption("/Users/duplicate-fixture/plan.md");
  await group
    .getByRole("checkbox", { name: "全选重复组 1 的副本", exact: true })
    .check();
  await page.evaluate(() =>
    (window as unknown as { duplicateFixture: Fixture }).duplicateFixture.emit(
      "directory-changed",
      ["/Users/duplicate-fixture/plan-copy.md"],
    ),
  );
  await expect(group.getByText(/内容或位置已有变化/)).toBeVisible();
  await group
    .getByRole("button", { name: "将所选文件移到回收站", exact: true })
    .click();
  await expect(
    page.getByText("这一组文件已有变化，请重新检查后再整理。", { exact: true }),
  ).toBeVisible();
  expect(await taskCalls(page)).toHaveLength(0);
  await group
    .getByRole("combobox", { name: "重复组 1 保留位置" })
    .selectOption("/Users/duplicate-fixture/plan-copy.md");
  await expect(
    group.getByRole("checkbox", { name: "全选重复组 1 的副本", exact: true }),
  ).not.toBeChecked();
});

test("stops an active native check without accepting a report", async ({
  page,
}) => {
  await setup(page, true);
  await page.getByRole("button", { name: "开始检查", exact: true }).click();
  await expect(page.getByText("正在枚举文件…", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "停止检查", exact: true }).click();
  await expect(
    page.getByText("检查已停止，未生成新的结果。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "重复组 1", exact: true }),
  ).toHaveCount(0);
  expect(await taskCalls(page)).toHaveLength(0);
});

test("restores duplicate snapshot scroll, keeper and selection after locating a file", async ({
  page,
}) => {
  await setup(page, false, 24);
  await page.getByRole("button", { name: "开始检查", exact: true }).click();
  const panel = page.getByRole("region", { name: "检查重复文件", exact: true });
  const group = page.getByRole("region", { name: "重复组 20", exact: true });
  await group
    .getByRole("combobox", { name: "重复组 20 保留位置" })
    .selectOption("/Users/duplicate-fixture/group-20/plan.md");
  const selected = group.getByRole("checkbox", {
    name: "全选重复组 20 的副本",
    exact: true,
  });
  await selected.check();
  const before = await panel.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(500);
  await group
    .getByRole("button", { name: "打开所在目录并选中", exact: true })
    .click();
  await expect(panel).toBeHidden();
  await page
    .getByRole("button", { name: "返回重复检查结果", exact: true })
    .click();
  await expect(panel).toBeVisible();
  await expect
    .poll(() => panel.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(before * 0.8);
  await expect(
    group.getByRole("combobox", { name: "重复组 20 保留位置" }),
  ).toHaveValue("/Users/duplicate-fixture/group-20/plan.md");
  await expect(selected).toBeChecked();
  const scans = await page.evaluate(() =>
    (
      window as unknown as { duplicateFixture: Fixture }
    ).duplicateFixture.calls.filter(
      (call) => call.command === "find_duplicates",
    ),
  );
  expect(scans).toHaveLength(1);
});
