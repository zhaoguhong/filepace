import { expect, test, type Page, type Locator } from "@playwright/test";

async function nativeFixture(page: Page, platform = "MacIntel") {
  await page.addInitScript((platform: string) => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      get: () => platform,
    });
    localStorage.setItem(
      "filepace-preferences",
      JSON.stringify({ autoUpdate: false }),
    );
    const root = "/Users/trash-fixture";
    const items = [
      {
        id: "one",
        name: "sample.txt",
        originalPath: root + "/sample.txt",
        deletedAt: 1794650000,
        size: 25,
        isDir: false,
      },
      {
        id: "two",
        name: "unknown.txt",
        originalPath: null,
        deletedAt: null,
        size: 14,
        isDir: false,
      },
    ];
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const folders = ["Project", "Reference"].map((name) => ({
      name,
      path: root + "/" + name,
      isDir: true,
      isLink: false,
      size: 0,
      modified: 1794650000,
      hidden: false,
    }));
    let next = 0;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    Object.assign(window, {
      isTauri: true,
      trashFixture: {
        items,
        calls,
        root,
        emit: (event: string, payload: unknown) => {
          for (const [id, listener] of listeners)
            if (listener.event === event)
              callbacks.get(listener.handler)?.({ event, id, payload });
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main", windowLabel: "main" },
        },
        transformCallback: (callback: (value: unknown) => void) => {
          callbacks.set(++next, callback);
          return next;
        },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args });
          if (command === "places")
            return [{ name: "个人目录", path: root, kind: "favorite" }];
          if (command === "load_session") return null;
          if (command === "update_status")
            return { current: "0.9.0", phase: "current" };
          if (command === "tasks")
            return { tasks: [], revision: 0, undo: null };
          if (command === "list_directory")
            return {
              path: args.path,
              parent: "/Users",
              entries: [
                ...folders,
                {
                  name: "retained.txt",
                  path: root + "/retained.txt",
                  isDir: false,
                  isLink: false,
                  size: 18,
                  modified: 1794650000,
                  hidden: false,
                },
              ],
            };
          if (command === "resolve_location_shortcuts") {
            const paths = args.paths as string[];
            const places = folders
              .filter((folder) => paths.includes(folder.path))
              .map(({ name, path }) => ({ name, path }));
            return { places, skipped: paths.length - places.length };
          }
          if (command === "list_trash")
            return { items: items.map((item) => ({ ...item })), warnings: [] };
          if (command === "start_trash_task") return "trash-task";
          if (command === "choose_location")
            return "/Users/trash-fixture/Restore";
          if (command === "validate_location") return args.path;
          if (command === "plugin:event|listen") {
            const id = ++next;
            listeners.set(id, {
              event: args.event as string,
              handler: args.handler as number,
            });
            return id;
          }
          return null;
        },
      },
    });
  }, platform);
  await page.goto("/");
}

for (const platform of ["MacIntel", "Win32"]) {
  test(`trash shows colored file type icons without reading original paths on ${platform}`, async ({
    page,
  }) => {
    await nativeFixture(page, platform);
    await page.evaluate((platform) => {
      const fixture = (
        window as unknown as {
          trashFixture: { items: Record<string, unknown>[] };
        }
      ).trashFixture;
      const samples = [
        ["report.pdf", false],
        ["notes.docx", false],
        ["budget.xlsx", false],
        ["picture.png", false],
        ["main.ts", false],
        ["Archive", true],
        [
          platform === "MacIntel" ? "Example.app" : "Example.exe",
          platform === "MacIntel",
        ],
      ];
      fixture.items.splice(
        0,
        fixture.items.length,
        ...samples.map(([name, isDir], index) => ({
          id: `icon-${index}`,
          name,
          isDir,
          size: isDir ? null : 128,
          deletedAt: null,
          originalPath:
            index === 5
              ? null
              : platform === "MacIntel"
                ? `/Users/trash-fixture/${name}`
                : `C:\\Users\\trash-fixture\\${name}`,
        })),
      );
    }, platform);
    await page.getByRole("button", { name: "回收站", exact: true }).click();
    const panel = page.getByRole("region", { name: "回收站内容", exact: true });
    for (const kind of [
      "pdf",
      "word",
      "excel",
      "image",
      "typescript",
      "folder",
      "application",
    ]) {
      const icon = panel.locator(`[data-file-kind="${kind}"] img`);
      await expect(icon).toBeVisible();
      await expect
        .poll(() =>
          icon.evaluate((image) => (image as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
    }
    const sources = await panel
      .locator(".entry-icon img")
      .evaluateAll((images) =>
        images.map((image) => (image as HTMLImageElement).src),
      );
    expect(new Set(sources).size).toBe(7);
    const calls = await page.evaluate(
      () =>
        (
          window as unknown as {
            trashFixture: { calls: { command: string }[] };
          }
        ).trashFixture.calls,
    );
    expect(calls.filter((call) => call.command === "thumbnail")).toEqual([]);
    if (platform === "MacIntel") {
      await page.setViewportSize({ width: 800, height: 650 });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: "test-results/trash-colored-icons.png" });
    }
  });
}

test("trash stays in its pane, restores to a chosen folder and retains the other pane selection", async ({
  page,
}) => {
  await nativeFixture(page);
  await page.getByRole("option", { name: /retained.txt/ }).click();
  await page.getByRole("button", { name: "左右分栏", exact: true }).click();
  await page.getByRole("region", { name: "右栏", exact: true }).click();
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  const left = page.getByRole("region", { name: "左栏", exact: true });
  const right = page.getByRole("region", { name: "右栏", exact: true });
  await expect(
    left.getByRole("option", { name: /retained.txt/, selected: true }),
  ).toBeVisible();
  await expect(right.getByRole("region", { name: "回收站内容" })).toBeVisible();
  await right.getByLabel("选择 unknown.txt", { exact: true }).check();
  await right.getByRole("button", { name: "恢复所选", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "恢复回收站项目",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "恢复", exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: "test-results/sidebar-restore-dialog.png" });
  await dialog
    .getByRole("button", { name: "选择其他文件夹…", exact: true })
    .click();
  await dialog.getByRole("button", { name: "恢复", exact: true }).click();
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          trashFixture: {
            calls: { command: string; args: Record<string, unknown> }[];
          };
        }
      ).trashFixture.calls,
  );
  expect(
    calls.find((call) => call.command === "start_trash_task")?.args,
  ).toMatchObject({
    action: "restore",
    ids: ["two"],
    destination: "/Users/trash-fixture/Restore",
    confirmed: false,
  });
  expect(
    calls
      .filter((call) => call.command === "list_directory")
      .some((call) => call.args.path === "filepace://trash"),
  ).toBe(false);
  await right.getByRole("button", { name: "后退", exact: true }).click();
  await expect(
    right.getByRole("option", { name: /retained.txt/ }),
  ).toBeVisible();
});

test("empty trash is bound to the confirmed snapshot and cancellation never starts a task", async ({
  page,
}) => {
  await nativeFixture(page);
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  await page.getByRole("button", { name: "清空回收站", exact: true }).click();
  let dialog = page.getByRole("dialog", {
    name: "确认清空回收站",
    exact: true,
  });
  await page.screenshot({
    path: "test-results/sidebar-empty-trash-dialog.png",
  });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            trashFixture: { calls: { command: string }[] };
          }
        ).trashFixture.calls.filter(
          (call) => call.command === "start_trash_task",
        ).length,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "清空回收站", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "确认清空回收站", exact: true });
  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        trashFixture: { items: Record<string, unknown>[] };
      }
    ).trashFixture;
    fixture.items.push({
      id: "new",
      name: "newly-deleted.txt",
      originalPath: null,
      deletedAt: null,
      size: 10,
      isDir: false,
    });
    window.dispatchEvent(new Event("focus"));
  });
  await expect(
    page.getByLabel("选择 newly-deleted.txt", { exact: true }),
  ).toHaveCount(1);
  await dialog.getByRole("button", { name: "永久删除", exact: true }).click();
  const args = await page.evaluate(
    () =>
      (
        window as unknown as {
          trashFixture: {
            calls: { command: string; args: Record<string, unknown> }[];
          };
        }
      ).trashFixture.calls.find((call) => call.command === "start_trash_task")
        ?.args,
  );
  expect(args).toMatchObject({
    action: "purge",
    ids: ["one", "two"],
    confirmed: true,
  });
  await expect(
    page.getByLabel("选择 newly-deleted.txt", { exact: true }),
  ).toBeVisible();
});

test("virtualizes 10,000 trash rows while selecting and confirming all matching items", async ({
  page,
}) => {
  await nativeFixture(page);
  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        trashFixture: { root: string; items: Record<string, unknown>[] };
      }
    ).trashFixture;
    fixture.items.splice(
      0,
      fixture.items.length,
      ...Array.from({ length: 10_000 }, (_, index) => {
        const id = String(index).padStart(5, "0");
        const name = `item-${id}.txt`;
        return {
          id,
          name,
          originalPath: `${fixture.root}/${index >= 9900 ? "Archive" : "Other"}/${name}`,
          deletedAt: 1794650000,
          size: 25,
          isDir: false,
        };
      }),
    );
  });
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  const panel = page.getByRole("region", { name: "回收站内容", exact: true });
  const list = panel.getByRole("region", { name: "回收站列表" });
  const table = list.getByRole("table");
  const first = list.getByRole("cell", { name: "item-00000.txt", exact: true });
  const last = list.getByRole("cell", { name: "item-09999.txt", exact: true });
  const allSelected = panel.getByText("10000 项 · 已选择 10000 项");
  await expect(table).toHaveAttribute("aria-rowcount", "10001");
  await expect(first).toBeInViewport();
  expect(await table.getByRole("row").count()).toBeLessThan(60);
  await first.click();
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(last).toBeInViewport();
  await expect(first).toHaveCount(0);
  await expect(list).toBeFocused();
  expect(await table.getByRole("row").count()).toBeLessThan(60);

  await last.click({ modifiers: ["Shift"] });
  await expect(allSelected).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel.getByText("10000 项 · 已选择 0 项")).toBeVisible();
  await page.keyboard.press("Meta+a");
  const selectAll = list.getByRole("checkbox", {
    name: "选择回收站全部可见项目",
  });
  await expect(selectAll).toBeChecked();
  await expect(allSelected).toBeVisible();
  const purge = panel.getByRole("button", { name: "永久删除", exact: true });
  await purge.click();
  const dialog = panel.getByRole("dialog", { name: "确认永久删除" });
  await expect(dialog.getByText(/将永久删除这 10000 项/)).toBeVisible();
  await dialog.getByRole("button", { name: "取消" }).click();

  await panel.getByRole("textbox", { name: "筛选回收站" }).fill("/archive/");
  await expect(table).toHaveAttribute("aria-rowcount", "101");
  await expect(
    list.getByRole("cell", { name: "item-09900.txt", exact: true }),
  ).toBeInViewport();
  await selectAll.uncheck();
  await expect(purge).toBeDisabled();
  await selectAll.check();
  await expect(panel.getByText("10000 项 · 已选择 100 项")).toBeVisible();
  await purge.click();
  await expect(dialog.getByText(/将永久删除这 100 项/)).toBeVisible();
  await dialog.getByRole("button", { name: "永久删除", exact: true }).click();
  const args = await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        trashFixture: {
          calls: { command: string; args: Record<string, unknown> }[];
        };
      }
    ).trashFixture;
    return fixture.calls.find(({ command }) => command === "start_trash_task")
      ?.args;
  });
  expect(args).toMatchObject({
    action: "purge",
    ids: Array.from({ length: 100 }, (_, index) =>
      String(index + 9900).padStart(5, "0"),
    ),
    confirmed: true,
  });
});

test("trash preserves tab shortcuts even while its filter has focus", async ({
  page,
}) => {
  await nativeFixture(page);
  await page.getByRole("button", { name: "新建标签", exact: true }).click();
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  await page.getByRole("textbox", { name: "筛选回收站", exact: true }).focus();
  await page.keyboard.press("Meta+w");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(
    page.getByRole("option", { name: /retained.txt/ }),
  ).toBeVisible();
  const calls = await page.evaluate(
    () =>
      (window as unknown as { trashFixture: { calls: { command: string }[] } })
        .trashFixture.calls,
  );
  expect(calls.some((call) => call.command === "plugin:window|close")).toBe(
    false,
  );
});

test("trash rejects directory commands and native file drops without sending its virtual path to the backend", async ({
  page,
}) => {
  await nativeFixture(page);
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  await page.getByRole("button", { name: /命令面板（/ }).click();
  const dialog = page.getByRole("dialog", { name: "命令面板", exact: true });
  for (const name of [
    "搜索子文件夹",
    "分析当前目录",
    "检查重复文件",
    "粘贴到当前目录",
    "新建文件夹",
  ]) {
    await expect(
      dialog.getByRole("option", { name: new RegExp(name) }),
    ).toHaveAttribute("aria-disabled", "true");
  }
  await dialog
    .getByRole("combobox", { name: "搜索操作" })
    .fill("粘贴到当前目录");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  const panel = page.getByRole("region", { name: "回收站内容", exact: true });
  const bounds = await panel.boundingBox();
  await page.evaluate(
    ({ x, y }) => {
      const fixture = (
        window as unknown as {
          trashFixture: { emit: (event: string, payload: unknown) => void };
        }
      ).trashFixture;
      fixture.emit("filepace-file-drag", {
        type: "drop",
        position: { x, y },
        kind: "copy",
        paths: ["/Users/trash-fixture/external.txt"],
        betweenWindows: false,
      });
    },
    { x: bounds!.x + 80, y: bounds!.y + 150 },
  );
  await expect(panel).toBeVisible();
  const calls = await page.evaluate(
    () =>
      (window as unknown as { trashFixture: { calls: { command: string }[] } })
        .trashFixture.calls,
  );
  expect(
    calls.some((call) =>
      [
        "clipboard_get",
        "start_task",
        "search_files",
        "scan_storage",
        "find_duplicates",
      ].includes(call.command),
    ),
  ).toBe(false);
});

test("custom groups support folder addition, drag sorting, rename and removal without reviving old defaults", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "管理分组 常用位置", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "新建分组", exact: true }).click();
  await page.getByLabel("分组名称", { exact: true }).fill("工作");
  await page.screenshot({
    path: "test-results/sidebar-create-group-dialog.png",
  });
  await page
    .getByRole("dialog", { name: "新建分组", exact: true })
    .getByRole("button", { name: "保存", exact: true })
    .click();
  let work = page.getByRole("region", { name: "工作", exact: true });
  await work
    .getByRole("button", { name: "管理分组 工作", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "添加文件夹…", exact: true })
    .click();
  await page.getByLabel("文件夹路径", { exact: true }).fill("/Users/demo/Work");
  await page
    .getByRole("dialog", { name: "添加常用位置", exact: true })
    .getByRole("button", { name: "保存", exact: true })
    .click();
  const common = page.getByRole("region", { name: "常用位置", exact: true });
  await common.getByRole("button", { name: "下载", exact: true }).dragTo(work);
  await expect(
    work.getByRole("button", { name: "下载", exact: true }),
  ).toBeVisible();
  await work
    .getByRole("button", { name: "下载", exact: true })
    .dragTo(work.getByRole("button", { name: "Work", exact: true }), {
      targetPosition: { x: 25, y: 5 },
    });
  await expect(work.locator(".place").first()).toHaveText("下载");
  await work
    .getByRole("button", { name: "管理分组 工作", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "重命名分组", exact: true }).click();
  await page.getByLabel("分组名称", { exact: true }).fill("项目");
  await page.screenshot({
    path: "test-results/sidebar-rename-group-dialog.png",
  });
  await page
    .getByRole("dialog", { name: "重命名分组", exact: true })
    .getByRole("button", { name: "保存", exact: true })
    .click();
  work = page.getByRole("region", { name: "项目", exact: true });
  await work
    .getByRole("button", { name: "管理分组 项目", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "移除分组", exact: true }).click();
  await page.screenshot({
    path: "test-results/sidebar-remove-group-dialog.png",
  });
  await page
    .getByRole("dialog", { name: "移除分组", exact: true })
    .getByRole("button", { name: "移除分组", exact: true })
    .click();
  await page.reload();
  await expect(work).toHaveCount(0);
  await expect(
    common.getByRole("button", { name: "下载", exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 800, height: 650 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "清空回收站", exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: "test-results/trash-sidebar-dark.png" });
});

test("sidebar management stays in an anchored keyboard menu and an empty sidebar can be rebuilt", async ({
  page,
}) => {
  await page.goto("/");
  const sidebar = page.getByRole("complementary", {
    name: "位置侧栏",
    exact: true,
  });
  const trigger = sidebar.getByRole("button", {
    name: "管理分组 常用位置",
    exact: true,
  });
  await expect(
    sidebar.getByRole("button", { name: "新建分组", exact: true }),
  ).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "恢复默认位置", exact: true }),
  ).toHaveCount(0);
  await trigger.focus();
  await trigger.press("Enter");
  const menu = page.getByRole("menu", { name: "分组操作", exact: true });
  await expect(
    menu.getByRole("menuitem", { name: "新建分组", exact: true }),
  ).toBeFocused();
  const anchor = (await trigger.boundingBox())!;
  const bounds = (await menu.boundingBox())!;
  expect(Math.abs(bounds.y - (anchor.y + anchor.height + 6))).toBeLessThan(2);
  expect(bounds.x).toBeLessThan(anchor.x + anchor.width);
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitem", { name: "添加文件夹…", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 800, height: 520 });
  await trigger.click();
  await expect(menu).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: "test-results/sidebar-management-menu.png" });
  await menu.getByRole("menuitem", { name: "移除分组", exact: true }).click();
  await page
    .getByRole("dialog", { name: "移除分组", exact: true })
    .getByRole("button", { name: "移除分组", exact: true })
    .click();
  await page.reload();
  await expect(
    sidebar.getByRole("region", { name: "常用位置", exact: true }),
  ).toHaveCount(0);
  await sidebar.getByRole("button", { name: "新建分组", exact: true }).click();
  await page.getByLabel("分组名称", { exact: true }).fill("工作");
  await page
    .getByRole("dialog", { name: "新建分组", exact: true })
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await sidebar
    .getByRole("button", { name: "管理分组 工作", exact: true })
    .click();
  await menu
    .getByRole("menuitem", { name: "恢复默认位置", exact: true })
    .click();
  const work = sidebar.getByRole("region", { name: "工作", exact: true });
  await expect(work.locator(".place")).toHaveCount(5);
  await expect(
    work.getByRole("button", { name: "个人目录", exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("button", { name: "新建分组", exact: true }),
  ).toHaveCount(0);
  await page.emulateMedia({ colorScheme: "dark" });
  await sidebar
    .getByRole("button", { name: "管理分组 工作", exact: true })
    .click();
  await expect(menu).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: "test-results/sidebar-management-menu-dark.png",
  });
  await page.keyboard.press("Escape");
  const download = work.getByRole("button", { name: "下载", exact: true });
  await download.click({ button: "right" });
  await expect(
    page.getByRole("menu", { name: "管理常用位置", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(download).toBeFocused();
});

test("adding a sidebar folder supports typed paths, validation and the folder picker in light and dark dialogs", async ({
  page,
}) => {
  await nativeFixture(page);
  const trigger = page.getByRole("button", {
    name: "管理分组 常用位置",
    exact: true,
  });
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "添加文件夹…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "添加常用位置",
    exact: true,
  });
  const input = dialog.getByRole("textbox", {
    name: "文件夹路径",
    exact: true,
  });
  await expect(input).toBeFocused();
  await expect(dialog).toContainText("添加到「常用位置」");
  await page.screenshot({ path: "test-results/sidebar-add-folder-light.png" });
  await input.fill("");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("请选择文件夹");
  await dialog
    .getByRole("button", { name: "选择文件夹…", exact: true })
    .click();
  await expect(input).toHaveValue("/Users/trash-fixture/Restore");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "常用位置", exact: true })
      .getByRole("button", { name: "Restore", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 800, height: 520 });
  await page.emulateMedia({ colorScheme: "dark" });
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "添加文件夹…", exact: true })
    .click();
  await input.fill(
    "/Users/trash-fixture/团队共享/项目参考资料/2026/设计与开发文档/归档",
  );
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(
    dialog.getByRole("button", { name: "保存", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: "test-results/sidebar-add-folder-dark.png" });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "常用位置", exact: true })
      .locator(".place"),
  ).toHaveCount(2);
});

test("location context menus stay compact and preserve files and selection while organizing shortcuts", async ({
  page,
}) => {
  await nativeFixture(page);
  await page.evaluate(() => {
    localStorage.setItem(
      "filepace-location-groups-v1",
      JSON.stringify([
        {
          id: "common",
          name: "常用位置",
          collapsed: false,
          places: [
            { name: "Project", path: "/Users/trash-fixture/Project" },
            { name: "Reference", path: "/Users/trash-fixture/Reference" },
          ],
        },
        { id: "work", name: "工作", collapsed: true, places: [] },
      ]),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: "filepace-location-groups-v1" }),
    );
  });
  const common = page.getByRole("region", { name: "常用位置", exact: true });
  const project = common.getByRole("button", { name: "Project", exact: true });
  const retained = page.getByRole("option", { name: /retained.txt/ });
  await retained.click();
  await project.click({ button: "right", position: { x: 60, y: 15 } });
  const menu = page.getByRole("menu", { name: "管理常用位置", exact: true });
  await expect(menu).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const anchor = (await project.boundingBox())!;
  const bounds = (await menu.boundingBox())!;
  expect(Math.abs(bounds.x - anchor.x - 60)).toBeLessThan(2);
  expect(Math.abs(bounds.y - anchor.y - 15)).toBeLessThan(2);
  expect(bounds.width).toBeLessThanOrEqual(230);
  expect(bounds.height).toBeLessThan(220);
  await expect(
    menu.getByRole("menuitem", { name: "上移", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: "test-results/location-context-menu-light.png",
  });
  await menu.getByRole("menuitem", { name: "下移", exact: true }).click();
  await expect(common.locator(".place")).toHaveText(["Reference", "Project"]);
  await expect(project).toBeFocused();
  await project.click({ button: "right" });
  await expect(
    menu.getByRole("menuitem", { name: "下移", exact: true }),
  ).toBeDisabled();
  const move = menu.getByRole("menuitem", { name: "移动到分组", exact: true });
  await move.focus();
  await page.keyboard.press("ArrowRight");
  const groups = page.getByRole("menu", { name: "移动到分组", exact: true });
  await expect(
    groups.getByRole("menuitemradio", { name: "常用位置", exact: true }),
  ).toBeDisabled();
  await expect(
    groups.getByRole("menuitemradio", { name: "常用位置", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(move).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("End");
  await expect(
    groups.getByRole("menuitemradio", { name: "工作", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  const moved = page
    .getByRole("region", { name: "工作", exact: true })
    .getByRole("button", { name: "Project", exact: true });
  await expect(moved).toBeVisible();
  await page.setViewportSize({ width: 800, height: 520 });
  await page.emulateMedia({ colorScheme: "dark" });
  await moved.click({ button: "right" });
  await expect(menu).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: "test-results/location-context-menu-dark.png",
  });
  await page.mouse.click(780, 490);
  await expect(menu).toHaveCount(0);
  await expect(moved).toBeFocused();
  await moved.dispatchEvent("contextmenu", { clientX: 795, clientY: 515 });
  await expect(menu).toBeInViewport({ ratio: 1 });
  await menu
    .getByRole("menuitem", { name: "从常用位置移除", exact: true })
    .click();
  await expect(moved).toHaveCount(0);
  await expect(retained).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("option", { name: /Project/ })).toBeVisible();
  const calls = await page.evaluate(
    () =>
      (window as unknown as { trashFixture: { calls: { command: string }[] } })
        .trashFixture.calls,
  );
  expect(
    calls.some((call) =>
      ["start_task", "start_trash_task"].includes(call.command),
    ),
  ).toBe(false);
  await page.reload();
  await expect(common.locator(".place")).toHaveText(["Reference"]);
  await expect(moved).toHaveCount(0);
});

async function dragPointer(
  page: Page,
  source: Locator,
  target: Locator,
  fraction = 0.25,
) {
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(
    from.x + Math.min(from.width / 2, 70),
    from.y + from.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    to.x + Math.min(to.width / 2, 45),
    to.y + to.height * fraction,
    { steps: 14 },
  );
}

test("dragging folders to the sidebar adds and reorders shortcuts while ordinary files never become transfers", async ({
  page,
}) => {
  await nativeFixture(page);
  const common = page.getByRole("region", { name: "常用位置", exact: true });
  const files = page.getByRole("listbox", { name: "文件列表", exact: true });
  const project = files.getByRole("option", { name: /Project/ });
  const home = common.getByRole("button", { name: "个人目录", exact: true });
  await expect(common.getByRole("button", { name: /^添加目录到/ })).toHaveCount(
    0,
  );
  await dragPointer(page, project, home, 0.8);
  await expect(home).toHaveClass(/location-drop-after/);
  await expect(page.locator(".drag-preview-operation")).toHaveText(
    "添加到常用位置",
  );
  await page.mouse.up();
  const shortcut = common.getByRole("button", { name: "Project", exact: true });
  await expect(shortcut).toBeVisible();
  await expect(common.locator(".place")).toHaveText(["个人目录", "Project"]);
  await expect(project).toBeVisible();
  await dragPointer(page, shortcut, home, 0.2);
  await expect(home).toHaveClass(/location-drop-before/);
  await page.mouse.up();
  await expect(common.locator(".place")).toHaveText(["Project", "个人目录"]);
  await dragPointer(
    page,
    files.getByRole("option", { name: /retained.txt/ }),
    home,
  );
  await page.mouse.up();
  await expect(page.getByRole("status")).toContainText("请拖入文件夹");
  await expect(common.locator(".place")).toHaveCount(2);
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          trashFixture: {
            calls: { command: string; args: Record<string, unknown> }[];
          };
        }
      ).trashFixture.calls,
  );
  expect(calls.some((call) => call.command === "start_task")).toBe(false);
  expect(
    calls
      .filter((call) => call.command === "list_directory")
      .every((call) => call.args.path === "/Users/trash-fixture"),
  ).toBe(true);
  await page.reload();
  await expect(common.locator(".place")).toHaveText(["Project", "个人目录"]);
  await page.evaluate(() => {
    localStorage.setItem("filepace-location-groups-v1", "[]");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "filepace-location-groups-v1" }),
    );
  });
  await dragPointer(
    page,
    files.getByRole("option", { name: /Reference/ }),
    page.getByRole("button", { name: "新建分组", exact: true }),
  );
  await page.mouse.up();
  await expect(common.locator(".place")).toHaveText(["Reference"]);
});

for (const platform of ["MacIntel", "Win32"]) {
  test(`sidebar accepts native folder drops and cross-group ordering without moving files on ${platform}`, async ({
    page,
  }) => {
    await nativeFixture(page, platform);
    await page.evaluate(() => {
      localStorage.setItem(
        "filepace-location-groups-v1",
        JSON.stringify([
          {
            id: "common",
            name: "常用位置",
            collapsed: false,
            places: [{ name: "Project", path: "/Users/trash-fixture/Project" }],
          },
          { id: "work", name: "工作", collapsed: true, places: [] },
        ]),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: "filepace-location-groups-v1" }),
      );
    });
    const common = page.getByRole("region", { name: "常用位置", exact: true });
    const work = page.getByRole("region", { name: "工作", exact: true });
    await dragPointer(
      page,
      common.getByRole("button", { name: "Project", exact: true }),
      work,
    );
    await page.mouse.up();
    await expect(common.locator(".place")).toHaveCount(0);
    await expect(
      work.getByRole("button", { name: "Project", exact: true }),
    ).toBeVisible();
    const bounds = (await work.boundingBox())!;
    const position = { x: bounds.x + 35, y: bounds.y + 10 };
    await page.evaluate((position) => {
      const fixture = (
        window as unknown as {
          trashFixture: { emit: (event: string, payload: unknown) => void };
        }
      ).trashFixture;
      fixture.emit("filepace-file-drag", {
        type: "hover",
        position,
        kind: "move",
      });
    }, position);
    await expect(work).toHaveClass(/location-drop-active/);
    await page.evaluate((position) => {
      (
        window as unknown as {
          trashFixture: { emit: (event: string, payload: unknown) => void };
        }
      ).trashFixture.emit("filepace-file-drag", {
        type: "drop",
        position,
        kind: "move",
        paths: [
          "/Users/trash-fixture/Reference",
          "/Users/trash-fixture/retained.txt",
        ],
        betweenWindows: true,
      });
    }, position);
    await expect(work.locator(".place")).toHaveText(["Project", "Reference"]);
    await expect(page.getByRole("status")).toContainText("已忽略其他项目");
    const calls = await page.evaluate(
      () =>
        (
          window as unknown as {
            trashFixture: { calls: { command: string }[] };
          }
        ).trashFixture.calls,
    );
    expect(calls.some((call) => call.command === "start_task")).toBe(false);
    await page.reload();
    await expect(work.locator(".place")).toHaveText(["Project", "Reference"]);
  });
}

test("sidebar edge resizes, collapses completely, reopens at the saved width and cancels a resize", async ({
  page,
}) => {
  await nativeFixture(page);
  const sidebar = page.getByRole("complementary", {
    name: "位置侧栏",
    exact: true,
  });
  const divider = page.getByRole("separator", {
    name: "调整侧栏宽度",
    exact: true,
  });
  const retained = page.getByRole("option", { name: /retained.txt/ });
  await retained.click();
  async function resize(x: number) {
    const bounds = (await divider.boundingBox())!;
    await page.mouse.move(bounds.x + 0.5, bounds.y + 180);
    await page.mouse.down();
    await page.mouse.move(x, bounds.y + 180, { steps: 12 });
    await page.mouse.up();
  }
  await resize(300);
  await expect(divider).toHaveAttribute("aria-valuenow", "300");
  expect(Math.round((await sidebar.boundingBox())!.width)).toBe(300);
  await expect(retained).toHaveAttribute("aria-selected", "true");
  await resize(1);
  await expect(sidebar).toHaveCount(0);
  await expect(divider).toHaveAttribute("aria-valuenow", "0");
  await expect(retained).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "切换侧边栏", exact: true }).click();
  await expect(divider).toHaveAttribute("aria-valuenow", "300");
  await resize(1);
  await resize(240);
  await expect(sidebar).toBeVisible();
  await expect(divider).toHaveAttribute("aria-valuenow", "240");
  const bounds = (await divider.boundingBox())!;
  await page.mouse.move(bounds.x + 0.5, bounds.y + 180);
  await page.mouse.down();
  await page.mouse.move(340, bounds.y + 180, { steps: 6 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(divider).toHaveAttribute("aria-valuenow", "240");
  await expect(retained).toHaveAttribute("aria-selected", "true");
  await divider.press("Home");
  await page.reload();
  await expect(sidebar).toHaveCount(0);
  await page.getByRole("button", { name: "切换侧边栏", exact: true }).click();
  await expect(divider).toHaveAttribute("aria-valuenow", "240");
  expect(Math.round((await sidebar.boundingBox())!.width)).toBe(240);
  await page.setViewportSize({ width: 800, height: 650 });
  await expect(divider).toHaveAttribute("aria-valuemax", "380");
  await divider.press("End");
  await expect
    .poll(async () => (await sidebar.boundingBox())!.width)
    .toBeLessThanOrEqual(380);
  await expect(
    page.getByRole("button", { name: "回收站", exact: true }),
  ).toBeInViewport({ ratio: 1 });
});
