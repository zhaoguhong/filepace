import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page, platform?: string) {
  await page.addInitScript((platform: string | null) => {
    if (platform)
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        get: () => platform,
      });
    localStorage.setItem(
      "filepace-preferences",
      JSON.stringify({ defaultView: "list", autoUpdate: false }),
    );
    const root = "/Users/results";
    const entries = Array.from({ length: 45 }, (_, index) => ({
      path: `${root}/file-${String(index + 1).padStart(2, "0")}.txt`,
      name: `file-${String(index + 1).padStart(2, "0")}.txt`,
      size: 101 + index,
      modified: 1_794_490_000,
      isDir: false,
      isLink: false,
      hidden: false,
    }));
    entries.push({
      ...entries[0],
      name: "file-other.txt",
      path: root + "/nested/file-other.txt",
      size: 333,
    });
    let sequence = 0;
    let clipboard: [string[], boolean] = [[], false];
    const tasks: Record<string, unknown>[] = [];
    let revision = 0;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const emit = (event: string, payload: unknown) => {
      for (const [id, listener] of listeners) {
        if (listener.event === event)
          callbacks.get(listener.handler)?.({ event, id, payload });
      }
    };
    Object.assign(window, {
      isTauri: true,
      resultsFixture: { calls, entries, emit },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
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
          calls.push({ command, args });
          if (command === "places")
            return [{ name: "个人目录", path: root, kind: "favorite" }];
          if (command === "load_session") return null;
          if (command === "list_directory")
            return {
              path: args.path,
              parent: "/Users",
              entries: entries.filter(
                (entry) =>
                  entry.path.slice(0, entry.path.lastIndexOf("/")) ===
                  args.path,
              ),
            };
          if (command === "tasks")
            return { tasks: [...tasks], undo: null, revision };
          if (command === "update_status")
            return { current: "fixture", phase: "current" };
          if (command === "search_files")
            return {
              hits: entries
                .filter((entry) => entry.name.includes(String(args.query)))
                .map((entry) => ({
                  entry: { ...entry },
                  parent: entry.path.slice(0, entry.path.lastIndexOf("/")),
                })),
              indexed: false,
              limited: false,
              skipped: 0,
            };
          if (command === "read_preview")
            return "# Results preview\n\nA local test file.";
          if (command === "storage_volumes") return [];
          if (command === "scan_storage")
            return {
              path: args.path,
              counts: {
                files: entries.length,
                folders: 1,
                bytes: 5000,
                skipped: 0,
              },
              folders: [
                {
                  path: root + "/nested",
                  parent: root,
                  name: "nested",
                  size: 333,
                  files: 1,
                },
              ],
              categories: {
                documents: {
                  files: entries.length,
                  bytes: 5000,
                  largest: entries.slice(0, 10).map((entry) => ({
                    ...entry,
                    parent: entry.path.slice(0, entry.path.lastIndexOf("/")),
                    files: 1,
                  })),
                },
              },
            };
          if (command === "diagnosis_agents")
            return [
              {
                id: "codex",
                name: "Codex",
                path: "/bin/codex",
                error: null,
                configurationError: null,
              },
            ];
          if (command === "diagnose_storage")
            return {
              scanId: args.scanId,
              agent: args.agent,
              goal: args.goal,
              instructions: args.instructions,
              createdAt: 1794490000,
              summary: "测试目录中的文件可逐项处理。",
              limitations: [],
              findings: [
                {
                  title: "检查文档",
                  kind: "review",
                  reason: "文件名和大小",
                  suggestion: "核对后整理",
                  items: entries.slice(0, 3).map((entry, index) => ({
                    ...entry,
                    id: String(index),
                    parent: entry.path.slice(0, entry.path.lastIndexOf("/")),
                    files: 1,
                  })),
                },
              ],
            };
          if (command === "clipboard_set") {
            clipboard = [args.paths as string[], Boolean(args.cut)];
            return null;
          }
          if (command === "clipboard_get") return clipboard;
          if (command === "rename_entry") {
            const entry = entries.find((entry) => entry.path === args.path);
            if (!entry) throw new Error("文件已不存在");
            entry.path =
              entry.path.slice(0, entry.path.lastIndexOf("/") + 1) + args.name;
            entry.name = String(args.name);
            emit("files-mutated", [
              { from: args.path, to: entry.path, kind: "rename" },
            ]);
            return null;
          }
          if (command === "preview_batch_rename") {
            const edits = args.edits as { path: string; name: string }[];
            if (
              new Set(
                edits.map((edit) =>
                  edit.path.slice(0, edit.path.lastIndexOf("/")),
                ),
              ).size > 1
            )
              throw new Error("批量重命名仅支持同一文件夹中的项目");
            return "preview-token";
          }
          if (command === "start_task") {
            const sources = args.sources as string[];
            const id = "result-task-" + (tasks.length + 1);
            const task = {
              id,
              sequence: tasks.length + 1,
              kind: args.kind,
              sources,
              destination: args.destination,
              status: "done",
              current: sources.at(-1) ?? "",
              completed: sources.length,
              bytes: 0,
              errors: [],
              conflict: null,
              fileChanges:
                args.kind === "trash"
                  ? sources.map((from) => ({ from, kind: "trash" }))
                  : [],
            };
            tasks.push(task);
            revision++;
            emit("task-activity", {
              revision,
              updates: [task],
              removed: [],
              undo: null,
            });
            emit("files-mutated", task.fileChanges);
            return id;
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
  }, platform ?? null);
  await page.goto("/");
  await page.getByRole("button", { name: "搜索子文件夹", exact: true }).click();
  await page.getByLabel("文件名关键词", { exact: true }).fill("file");
  await page.getByRole("button", { name: "开始搜索", exact: true }).click();
  await expect(page.locator(".search-results .result-row")).toHaveCount(46);
}

type Fixture = {
  calls: { command: string; args: Record<string, unknown> }[];
  entries: { name: string; path: string; size: number }[];
  emit: (event: string, payload: unknown) => void;
};

test("keeps search conditions, selection and scroll after locating a result", async ({
  page,
}) => {
  await setup(page);
  const panel = page.getByRole("region", { name: "搜索子文件夹", exact: true });
  const row = panel.locator(".result-row").filter({ hasText: "file-35.txt" });
  await row.locator(".result-main").click();
  await expect(row).toHaveAttribute("aria-selected", "true");
  const scroll = await panel.evaluate((element) => element.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await row
    .getByRole("button", { name: "打开所在目录并选中", exact: true })
    .click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "返回搜索结果", exact: true }).click();
  await expect(page.getByLabel("文件名关键词", { exact: true })).toHaveValue(
    "file",
  );
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() => panel.evaluate((element) => element.scrollTop))
    .toBe(scroll);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { resultsFixture: Fixture }
        ).resultsFixture.calls.filter((call) => call.command === "search_files")
          .length,
    ),
  ).toBe(1);
});

test("copies a range from results and asks for an explicit paste destination", async ({
  page,
}) => {
  await setup(page);
  const rows = page.locator(".search-results .result-row");
  await rows.nth(0).locator(".result-main").click();
  await rows
    .nth(2)
    .locator(".result-main")
    .click({ modifiers: ["Shift"] });
  await expect(page.getByText("已选择 3 项", { exact: true })).toBeVisible();
  await rows.nth(1).locator(".result-main").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "结果文件操作", exact: true });
  await menu.getByRole("menuitem", { name: "复制", exact: true }).click();
  const copied = await page.evaluate(() =>
    (window as unknown as { resultsFixture: Fixture }).resultsFixture.calls
      .filter((call) => call.command === "clipboard_set")
      .at(-1),
  );
  expect(copied?.args.paths).toHaveLength(3);
  await page.getByRole("button", { name: "选择粘贴位置", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "复制到文件夹",
    exact: true,
  });
  await expect(
    dialog.getByLabel("目标文件夹完整路径", { exact: true }),
  ).toHaveValue("/Users/results");
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { resultsFixture: Fixture }
        ).resultsFixture.calls.filter((call) => call.command === "start_task")
          .length,
    ),
  ).toBe(0);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(".search-results .result-row")).toHaveCount(46);
});

test("previews and advances within search results without losing the selection", async ({
  page,
}) => {
  await setup(page);
  const first = page.locator(".search-results .result-row").first();
  await first.locator(".result-main").click();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("dialog", { name: "预览 file-01.txt", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("dialog", { name: "预览 file-02.txt", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "关闭预览", exact: true }),
  ).toHaveCount(0);
  await expect(first).toHaveAttribute("aria-selected", "true");
});

test("renames one search result without leaving search and reports mixed-folder batch limitations", async ({
  page,
}) => {
  await setup(page);
  const row = page
    .locator(".search-results .result-row")
    .filter({ hasText: "file-01.txt" });
  await row.locator(".result-main").click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名…", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "重命名", exact: true });
  await rename.getByLabel("新名称", { exact: true }).fill("file-new.txt");
  await rename.getByRole("button", { name: "应用改名", exact: true }).click();
  const renamed = page
    .locator(".search-results .result-row")
    .filter({ hasText: "file-new.txt" });
  await expect(renamed).toContainText("已改名");
  await expect(page.getByLabel("文件名关键词", { exact: true })).toHaveValue(
    "file",
  );
  await renamed.getByRole("checkbox").check();
  await page
    .locator(".search-results .result-row")
    .filter({ hasText: "file-other.txt" })
    .getByRole("checkbox")
    .check();
  await renamed.locator(".result-main").click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "批量重命名…", exact: true })
    .click();
  await expect(
    page.getByText("批量改名需要选择同一个文件夹内的项目，请分组处理。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "批量重命名", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { resultsFixture: Fixture }
        ).resultsFixture.calls.filter(
          (call) => call.command === "preview_batch_rename",
        ).length,
    ),
  ).toBe(0);
});

test("applies simultaneous rename cycles to old results once and starts fresh searches from current paths", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const fixture = (window as unknown as { resultsFixture: Fixture })
      .resultsFixture;
    const first = fixture.entries[0],
      second = fixture.entries[1];
    [first.path, second.path] = [second.path, first.path];
    [first.name, second.name] = [second.name, first.name];
    fixture.emit("files-mutated", [
      {
        from: "/Users/results/file-01.txt",
        to: "/Users/results/file-02.txt",
        kind: "rename",
      },
      {
        from: "/Users/results/file-02.txt",
        to: "/Users/results/file-01.txt",
        kind: "rename",
      },
    ]);
  });
  const firstRow = page.locator(".search-results .result-row").first();
  await expect(firstRow).toContainText("file-02.txt");
  await expect(firstRow).toContainText("101 B");
  await expect(firstRow).toContainText("已改名");
  await page.getByRole("button", { name: "开始搜索", exact: true }).click();
  await expect(firstRow).toContainText("file-02.txt");
  await expect(firstRow).toContainText("101 B");
  await expect(firstRow).not.toContainText("已改名");
});

test("names, pins, updates and deletes saved search conditions", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "保存条件", exact: true }).click();
  await page.getByLabel("搜索名称", { exact: true }).fill("工作文档");
  await page.getByRole("button", { name: "保存搜索", exact: true }).click();
  await page.getByText("管理已保存搜索 · 1", { exact: true }).click();
  await page
    .getByRole("button", { name: "固定到侧栏 工作文档", exact: true })
    .click();
  await expect(
    page
      .getByRole("complementary", { name: "位置侧栏" })
      .getByRole("button", { name: "工作文档", exact: true }),
  ).toBeVisible();
  await page.getByLabel("文件名关键词", { exact: true }).fill("file-02");
  await page
    .getByRole("button", { name: "更新 工作文档", exact: true })
    .click();
  await page.getByRole("button", { name: "保存搜索", exact: true }).click();
  await page.getByLabel("文件名关键词", { exact: true }).fill("unused");
  await page
    .getByRole("complementary", { name: "位置侧栏" })
    .getByRole("button", { name: "工作文档", exact: true })
    .click();
  await expect(page.getByLabel("文件名关键词", { exact: true })).toHaveValue(
    "file-02",
  );
  await page
    .getByRole("button", { name: "删除搜索 工作文档", exact: true })
    .click();
  await expect(
    page
      .getByRole("complementary", { name: "位置侧栏" })
      .getByRole("button", { name: "工作文档", exact: true }),
  ).toHaveCount(0);
});

test("uses the same file actions in usage rankings and AI references and keeps their snapshots", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "目录分析", exact: true }).click();
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  const ranking = page.getByRole("listbox", {
    name: "最大的文件",
    exact: true,
  });
  await ranking
    .getByRole("checkbox", { name: "选择 file-10.txt", exact: true })
    .check();
  await ranking
    .getByRole("checkbox", { name: "选择 file-09.txt", exact: true })
    .check();
  await ranking
    .locator(".result-main")
    .filter({ hasText: "file-10.txt" })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制", exact: true }).click();
  const copied = await page.evaluate(() =>
    (window as unknown as { resultsFixture: Fixture }).resultsFixture.calls
      .filter((call) => call.command === "clipboard_set")
      .at(-1),
  );
  expect(copied?.args.paths).toHaveLength(2);
  await page.getByRole("tab", { name: "智能诊断", exact: true }).click();
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  const report = page.getByLabel("智能诊断报告", { exact: true });
  await report
    .getByRole("checkbox", { name: "选择 file-01.txt", exact: true })
    .check();
  await report
    .getByRole("checkbox", { name: "选择 file-02.txt", exact: true })
    .check();
  await page.screenshot({ path: "test-results/result-actions-report.png" });
  await report
    .getByRole("button", { name: "将所选文件移到回收站", exact: true })
    .click();
  await expect(report).toContainText("测试目录中的文件可逐项处理。");
  await expect(
    report.locator(".result-status").filter({ hasText: "已移到回收站" }),
  ).toHaveCount(2);
  await page.getByRole("tab", { name: "占用分析", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "目录已有变化" }),
  ).toBeVisible();
  await expect(
    ranking.locator(".result-status").filter({ hasText: "已移到回收站" }),
  ).toHaveCount(2);
  await expect(
    ranking.getByRole("checkbox", { name: "选择 file-01.txt", exact: true }),
  ).toBeDisabled();
  await expect(
    ranking.getByRole("checkbox", { name: "选择 file-10.txt", exact: true }),
  ).toBeChecked();
});

test("activates result toolbar and context-menu buttons from the keyboard", async ({
  page,
}) => {
  await setup(page);
  const panel = page.getByRole("region", { name: "搜索子文件夹", exact: true });
  const first = panel.locator(".result-row").first();
  await first.locator(".result-main").click();
  await page.keyboard.press("Shift+F10");
  const copy = page.getByRole("menuitem", { name: "复制", exact: true });
  await copy.focus();
  await copy.press("Enter");
  await expect(
    page.getByRole("menu", { name: "结果文件操作", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { resultsFixture: Fixture }
        ).resultsFixture.calls.filter(
          (call) => call.command === "clipboard_set",
        ).length,
    ),
  ).toBe(1);
  const paste = panel.getByRole("button", {
    name: "选择粘贴位置",
    exact: true,
  });
  await paste.focus();
  await paste.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "复制到文件夹",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await first.locator(".result-main").focus();
  await page.keyboard.press("Escape");
  await expect(first).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("tracks a file through a parent move, a child rename and both undo steps", async ({
  page,
}) => {
  await setup(page);
  const first = page.locator(".search-results .result-row").first();
  await page.evaluate(() =>
    (window as unknown as { resultsFixture: Fixture }).resultsFixture.emit(
      "files-mutated",
      [{ from: "/Users/results", to: "/Users/moved", kind: "move" }],
    ),
  );
  await expect(first).toHaveAttribute("data-path", "/Users/moved/file-01.txt");
  await page.evaluate(() =>
    (window as unknown as { resultsFixture: Fixture }).resultsFixture.emit(
      "files-mutated",
      [
        {
          from: "/Users/moved/file-01.txt",
          to: "/Users/moved/renamed.txt",
          kind: "rename",
        },
      ],
    ),
  );
  await expect(first).toHaveAttribute("data-path", "/Users/moved/renamed.txt");
  await page.evaluate(() =>
    (window as unknown as { resultsFixture: Fixture }).resultsFixture.emit(
      "files-mutated",
      [
        {
          from: "/Users/moved/renamed.txt",
          to: "/Users/moved/file-01.txt",
          kind: "rename",
        },
      ],
    ),
  );
  await expect(first).toHaveAttribute("data-path", "/Users/moved/file-01.txt");
  await page.evaluate(() =>
    (window as unknown as { resultsFixture: Fixture }).resultsFixture.emit(
      "files-mutated",
      [{ from: "/Users/moved", to: "/Users/results", kind: "move" }],
    ),
  );
  await expect(first).toHaveAttribute(
    "data-path",
    "/Users/results/file-01.txt",
  );
  await expect(first.locator(".result-status")).toHaveCount(0);
});

for (const [platform, modifier] of [
  ["MacIntel", "Meta"],
  ["Win32", "Control"],
] as const) {
  test(`keeps ${platform} result shortcuts consistent with file browsing`, async ({
    page,
  }) => {
    await setup(page, platform);
    const first = page
      .locator(".search-results .result-row")
      .first()
      .locator(".result-main");
    await first.click();
    await page.keyboard.press(`${modifier}+Shift+C`);
    await expect(
      page.getByText("请先打开左右分栏并选择目标目录。", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press(`${modifier}+Shift+M`);
    const calls = () =>
      page.evaluate(
        () =>
          (window as unknown as { resultsFixture: Fixture }).resultsFixture
            .calls,
      );
    expect(
      (await calls()).filter((call) => call.command === "clipboard_set"),
    ).toHaveLength(0);
    expect(
      (await calls()).filter((call) => call.command === "start_task"),
    ).toHaveLength(0);
    await page.keyboard.press(platform === "MacIntel" ? "Meta+I" : "Alt+Enter");
    await expect
      .poll(
        async () =>
          (await calls()).filter((call) => call.command === "open_properties")
            .length,
      )
      .toBe(1);
    await page.keyboard.press(platform === "MacIntel" ? "Enter" : "F2");
    const rename = page.getByRole("dialog", { name: "重命名", exact: true });
    await expect(rename).toBeVisible();
    await rename.getByRole("button", { name: "取消", exact: true }).click();
    await first.focus();
    await page.keyboard.press(
      platform === "MacIntel" ? "Meta+ArrowDown" : "Enter",
    );
    await expect
      .poll(
        async () =>
          (await calls()).filter((call) => call.command === "open_entry")
            .length,
      )
      .toBe(1);
    expect(
      (await calls()).filter((call) => call.command === "open_entry").at(-1)
        ?.args.path,
    ).toBe("/Users/results/file-01.txt");
  });
}

test("focuses selected result rows and restores focus after menu actions without browser pointer focus", async ({
  page,
}) => {
  await setup(page, "MacIntel");
  const rows = page.locator(".search-results .result-row");
  const first = rows.nth(0).locator(".result-main");
  const second = rows.nth(1).locator(".result-main");
  await page.getByLabel("文件名关键词", { exact: true }).focus();
  // Synthetic pointer events have no native focus behavior, matching WebKit's
  // macOS button clicks. The result controller must move focus explicitly.
  await first.dispatchEvent("click");
  await expect(first).toBeFocused();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("dialog", { name: "预览 file-01.txt", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await rows.nth(1).getByRole("checkbox").dispatchEvent("click");
  await expect(second).toBeFocused();
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+C");
  const copied = await page.evaluate(() =>
    (window as unknown as { resultsFixture: Fixture }).resultsFixture.calls
      .filter((call) => call.command === "clipboard_set")
      .at(-1),
  );
  expect(copied?.args.paths).toEqual([
    "/Users/results/file-01.txt",
    "/Users/results/file-02.txt",
  ]);
  await second.evaluate((element) =>
    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 100,
        clientY: 350,
      }),
    ),
  );
  await page
    .getByRole("menuitem", { name: "复制", exact: true })
    .dispatchEvent("click");
  await expect(second).toBeFocused();
});
