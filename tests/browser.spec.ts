import { test, expect, type Page } from "@playwright/test";
import packageInfo from "../package.json" with { type: "json" };
import type { Task } from "../src/model";
test("browse, filter, tabs, restore, preview and grid", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("filepace-preferences", JSON.stringify({ defaultView: "list" })));
  await page.goto("/");
  await expect(page.locator(".file-area").getByRole("option")).toHaveCount(11);
  await page.getByLabel("筛选当前文件夹").fill("需求");
  await expect(page.locator(".file-area").getByRole("option")).toHaveCount(1);
  await page.getByLabel("清除筛选").click();
  await page.getByLabel("新建标签", { exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.locator(".file-area").getByRole("option").filter({ hasText: "项目" }).dblclick();
  await expect(page.getByText("这个文件夹还是空的")).toBeVisible();
  await page.getByRole("tab").first().click();
  await expect(page.locator(".file-area").getByRole("option")).toHaveCount(11);
  await page.locator(".file-area").getByRole("option").filter({ hasText: "产品需求.md" }).click();
  await page.keyboard.press("Space");
  await expect(page.getByLabel("关闭预览")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("图标视图", { exact: true }).click();
  await expect(page.locator(".file-area")).toHaveClass(/grid/);
  await page.getByLabel("显示隐藏文件").click();
  await expect(page.locator(".file-area").getByRole("option")).toHaveCount(12);
  await page.getByRole("tab").first().click({ button: "right" });
  await page.getByRole("button", { name: "关闭标签", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await page.keyboard.press("Control+Shift+T");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.screenshot({ path: "test-results/filepace-main.png" });
});

test("distinguishes document icons and saves the chosen size per tab", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "列表视图" }).click();
  const files = page.getByLabel("文件列表");
  const word = files.getByRole("option", { name: /会议纪要\.docx/ });
  const excel = files.getByRole("option", { name: /预算表\.xlsx/ });
  const slides = files.getByRole("option", { name: /季度汇报\.pptx/ });
  await expect(word.locator('[data-file-kind="word"] img')).toBeVisible();
  await expect(excel.locator('[data-file-kind="excel"] img')).toBeVisible();
  await expect(slides.locator('[data-file-kind="powerpoint"] img')).toBeVisible();
  await expect(word).toContainText("Word 文档");

  const sizeMenu = page.getByRole("group", { name: "选择图标大小" });
  let previousWidth = 0;
  for (const label of ["小图标", "中图标", "大图标", "超大图标"]) {
    await page.getByRole("button", { name: "图标大小", exact: true }).click();
    await sizeMenu.getByRole("button", { name: label, exact: true }).click();
    const icon = await word.locator(".entry-icon").boundingBox();
    expect(icon?.width).toBeGreaterThan(previousWidth);
    previousWidth = icon!.width;
  }
  await page.getByRole("button", { name: "列表视图", exact: true }).click();
  await page.getByRole("button", { name: "图标视图", exact: true }).click();
  await expect(files).toHaveAttribute("data-grid-size", "extra-large");

  await page.getByRole("button", { name: "新建标签", exact: true }).click();
  await page.getByRole("button", { name: "图标视图", exact: true }).click();
  await expect(files).toHaveAttribute("data-grid-size", "medium");
  await page.getByRole("tab").first().click();
  await expect(files).toHaveAttribute("data-grid-size", "extra-large");
});

test("shows storage volumes, filters scan results, and locates a file", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "存储概览", exact: true }).click();
  await expect(page.getByRole("heading", { name: "存储概览" })).toBeVisible();
  await expect(page.getByRole("meter", { name: "系统磁盘已用比例" })).toBeVisible();
  await expect(page.getByRole("meter", { name: "外接磁盘已用比例" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "文件分类" })).toHaveCount(0);
  await page.getByRole("button", { name: "开始扫描" }).click();
  await expect(page.getByRole("heading", { name: "文件分类" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "占用最多的子目录" })).toBeVisible();
  await page.getByRole("button", { name: /压缩包.*个/ }).click();
  await expect(page.getByRole("heading", { name: "最大的文件 · 压缩包" })).toBeVisible();
  await expect(page.getByRole("button", { name: /数据备份\.zip/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /季度汇报\.pptx/ })).toHaveCount(0);
  await page.getByRole("button", { name: /数据备份\.zip/ }).click();
  await expect(page.getByRole("heading", { name: "存储概览" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: /数据备份\.zip/, selected: true })).toBeVisible();
  await page.getByRole("button", { name: "存储概览", exact: true }).click();
  await page.getByRole("button", { name: /^项目 0 个文件/ }).click();
  await expect(page.getByText("这个文件夹还是空的")).toBeVisible();
  await page.getByRole("button", { name: "存储概览", exact: true }).click();
  await expect(page.getByLabel("扫描范围", { exact: true })).toHaveValue("/Users/demo");
  await expect(page.getByRole("heading", { name: "最大的文件 · 压缩包" })).toBeVisible();
});

test("searches by file name and type and reveals the result", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "跨目录搜索" }).click();
  await page.getByRole("textbox", { name: "文件名关键词" }).fill("会议");
  await page.getByRole("combobox", { name: "文件类型" }).selectOption("images");
  await page.getByRole("button", { name: "开始搜索" }).click();
  await expect(page.getByText("这个范围没有匹配的项目。")).toBeVisible();
  await page.getByRole("combobox", { name: "文件类型" }).selectOption("documents");
  await page.getByRole("textbox", { name: "文件名关键词" }).press("Enter");
  await page.getByRole("button", { name: /会议纪要\.docx/ }).click();
  await expect(page.getByRole("option", { name: /会议纪要\.docx/, selected: true })).toBeVisible();
});

test("follows system light and dark mode and keeps an explicit theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-mode", "light");
  for (const surface of ["html", ".titlebar", ".sidebar", ".tabs", ".active-column", ".statusbar"]) {
    await expect(page.locator(surface)).toHaveCSS("background-color", "rgb(255, 255, 255)");
  }
  const file = page.getByRole("option", { name: /会议纪要\.docx/ });
  await file.hover();
  await expect(file).toHaveCSS("background-color", "rgb(241, 242, 244)");
  await file.click();
  await expect(file).toHaveCSS("background-color", "rgb(234, 241, 255)");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "外观", exact: true }).click();
  const theme = page.getByRole("combobox", { name: "主题" });
  const mode = page.getByRole("combobox", { name: "显示模式" });
  await expect(mode).toHaveValue("system");
  await expect(theme).toHaveValue("default");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-mode", "dark");
  await theme.selectOption("mist");
  await expect(root).toHaveCSS("background-color", "rgb(28, 43, 64)");
  await theme.selectOption("sand");
  await expect(root).toHaveCSS("background-color", "rgb(48, 40, 32)");
  await theme.selectOption("lilac");
  await expect(root).toHaveCSS("background-color", "rgb(44, 37, 56)");
  await mode.selectOption("light");
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "lilac");
  await expect(root).toHaveAttribute("data-mode", "light");
  await expect(root).toHaveCSS("background-color", "rgb(252, 249, 255)");
});

test("opens new tabs in columns and follows a branch until the file preview", async ({ page }) => {
  await page.goto("/");
  const current = page.getByLabel("文件列表", { exact: true });
  await expect(current).toBeVisible();
  const strip = await page.locator(".column-browser").boundingBox();
  const area = await current.boundingBox();
  expect(area!.x + area!.width).toBeCloseTo(strip!.x + strip!.width - 1, 0);
  await current.getByRole("option", { name: /项目/ }).click();
  const ancestor = page.getByLabel("文件夹 · demo", { exact: true });
  await expect(ancestor.getByRole("option", { name: /项目/ })).toHaveAttribute("aria-selected", "true");
  const project = page.getByRole("region", { name: "当前目录列 · 项目" });
  await expect(project).toBeVisible();
  expect((await current.boundingBox())!.y).toBeCloseTo((await project.boundingBox())!.y, 0);
  await expect(page.getByRole("region", { name: "目录列 · demo", exact: true }).getByRole("button", { name: "demo", exact: true })).toHaveCount(0);
  await ancestor.getByRole("option", { name: /设计素材/ }).click();
  await expect(page.getByRole("region", { name: "当前目录列 · 设计素材" })).toBeVisible();
  await ancestor.getByRole("option", { name: /产品需求\.md/ }).click();
  await expect(page.getByRole("region", { name: "文件预览" })).toContainText("产品需求.md");
  await current.getByRole("option", { name: "项目" }).click();
  await page.locator(".address").getByRole("button", { name: "demo", exact: true }).click();
  await expect(page.getByRole("region", { name: "当前目录列 · demo" })).toBeVisible();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const view = page.getByRole("combobox", { name: "默认视图" });
  await expect(view).toHaveValue("columns");
  await view.selectOption("list");
  await page.getByRole("button", { name: "返回文件" }).click();
  await page.getByRole("button", { name: "新建标签", exact: true }).click();
  await expect(current).toHaveClass(/^file-area list/);
  await page.getByRole("tab").first().click();
  await expect(current).toHaveClass(/column-list/);
});
test("new folder errors are visible and navigation can be typed", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("编辑路径").click();
  await page.getByLabel("完整路径").fill("/Users/demo/Downloads");
  await page.getByLabel("完整路径").press("Enter");
  await expect(page.getByText("这个文件夹还是空的")).toBeVisible();
  await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
  await expect(page.getByLabel("文件夹名称")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
});

test('reorders tabs with pointer gestures independently of native file drag', async ({page})=>{
 await page.addInitScript(() => localStorage.setItem("filepace-preferences", JSON.stringify({ defaultView: "list" })));
 await page.goto('/');await page.getByLabel('新建标签',{exact:true}).click();await page.locator('.file-area').getByRole('option').filter({hasText:'项目'}).dblclick();
 const from=await page.getByRole('tab').last().boundingBox();const to=await page.getByRole('tab').first().boundingBox();
 await page.mouse.move(from!.x+30,from!.y+15);await page.mouse.down();await page.mouse.move(to!.x+30,to!.y+15,{steps:8});await page.mouse.up();
 await expect(page.getByRole('tab').first()).toContainText('项目');
});

test("shows path and system actions for a file, a folder and an empty list", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("filepace-preferences", JSON.stringify({ defaultView: "list" })));
  await page.goto("/");
  const files = page.getByLabel("文件列表");
  const file = files.getByRole("option").filter({ hasText: "产品需求.md" });
  const folder = files.getByRole("option").filter({ hasText: "项目" });
  const menu = page.locator(".context-menu");
  const copyPath = menu.getByRole("button", { name: "复制路径", exact: true });
  const reveal = menu.getByRole("button", { name: /在 Finder 中显示|在资源管理器中显示/ });
  const terminal = menu.getByRole("button", { name: "在命令行中打开" });

  await file.click({ button: "right" });
  await expect(copyPath).toBeVisible();
  await expect(reveal).toBeVisible();
  await expect(terminal).toBeVisible();
  await menu.getByRole("button", { name: "属性", exact: true }).click();
  const properties = page.getByRole("dialog", { name: "属性" });
  await expect(properties).toContainText("/Users/demo/产品需求.md");
  await expect(properties).toContainText("Markdown 文档");
  await page.keyboard.press("Escape");
  await expect(properties).toHaveCount(0);

  await folder.click({ button: "right" });
  await expect(copyPath).toBeVisible();
  await expect(reveal).toBeVisible();
  await expect(terminal).toBeVisible();
  await menu.getByRole("button", { name: "属性", exact: true }).click();
  await expect(properties).toContainText("/Users/demo/项目");
  await expect(properties).toContainText("文件夹");
  await page.keyboard.press("Escape");

  await folder.dblclick();
  await files.getByText("这个文件夹还是空的").click({ button: "right" });
  await expect(copyPath).toBeVisible();
  await expect(reveal).toBeVisible();
  await expect(terminal).toBeVisible();
});

const home = "/Users/demo";

async function mockDesktop(page: Page, defaultView: "list" | "columns", root = home, count = 0) {
  await page.addInitScript(({ home, defaultView, count, version }) => {
    localStorage.setItem("filepace-preferences", JSON.stringify({ defaultView }));
    const writes: { command: string; args: Record<string, unknown> }[] = [];
    const reads: string[] = [];
    const separator = home.includes("\\") ? "\\" : "/";
    const listings: Record<string, [string, boolean][]> = {
      [home]: [["项目", true], ["左栏文件.txt", false], ["补充文档.DOCX", false]],
      [`${home}${separator}项目`]: [["归档", true], ["右栏文件.txt", false]],
    };
    let branch = [home, "项目", "归档"].join(separator);
    for (const folder of ["第三级", "第四级", "第五级", "第六级"]) {
      listings[branch] = [[folder, true]];
      branch += separator + folder;
    }
    listings[branch] = [["深层文件.txt", false]];
    if (count) listings[home] = Array.from({ length: count }, (_, i) => [`文件 ${(i * 7919) % count}.txt`, false]);
    let callback = 0;
    let revision = 0;
    let tasks: Task[] = [];
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { name: string; callback: number }>();
    const emit = (name: string, payload: unknown) => {
      for (const [id, listener] of listeners)
        if (listener.name === name) callbacks.get(listener.callback)?.({ event: name, id, payload });
    };
    Object.defineProperty(window, "filepaceTasks", {
      get: () => tasks,
      set: (next: Task[]) => {
        const removed = tasks.filter((old) => !next.some((task) => task.id === old.id)).map((task) => task.id);
        tasks = next;
        emit("task-activity", { revision: ++revision, updates: tasks, removed, undo: null });
      },
    });
    Object.assign(window, {
      isTauri: true,
      filepaceWrites: writes,
      filepaceReads: reads,
      filepaceEmit: emit,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        transformCallback: (handler: (value: unknown) => void) => {
          callbacks.set(++callback, handler);
          return callback;
        },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === "places") return [{ name: "个人目录", path: home, kind: "favorite" }];
          if (command === "tasks") return { tasks, revision, undo: null };
          if (command === "error_log") return (window as Window & { filepaceErrors?: unknown[] }).filepaceErrors ?? [];
          if (command === "update_status") return { current: version, phase: "current" };
          if (command === "list_directory") {
            const requested = String(args.path);
            const path = separator === "\\" && requested.length > 3 && requested.endsWith(separator)
              ? requested.slice(0, -1)
              : requested;
            reads.push(path);
            return {
              path,
              parent: path.slice(0, path.lastIndexOf(separator)),
              entries: (listings[path] ?? []).map(([name, isDir]) => ({
                name, isDir, path: `${path}${separator}${name}`, isLink: false, size: 10, modified: 0, hidden: false,
              })),
            };
          }
          if (command === "make_text_file") {
            writes.push({ command, args });
            const parent = String(args.parent);
            const name = String(args.name);
            const fileName = name.toLowerCase().endsWith(".txt") ? name : name + ".txt";
            const entries = listings[parent] ?? [];
            if (entries.some(([entry]) => entry === fileName)) throw "同名项目已存在，请换个名称";
            listings[parent] = [...entries, [fileName, false]];
            return null;
          }
          if (["start_task", "new_window", "start_file_drag", "clipboard_set", "task_action"].includes(command)) writes.push({ command, args });
          if (command === "start_task") return `task-${writes.length}`;
          if (command === "preview_batch_rename" || command === "batch_rename") {
            writes.push({ command, args });
            return command === "preview_batch_rename" ? "rename-preview" : "rename-task";
          }
          if (command === "plugin:event|listen") {
            listeners.set(++callback, { name: String(args.event), callback: Number(args.handler) });
            return callback;
          }
          if (command === "plugin:event|unlisten") listeners.delete(Number(args.eventId));
          return null;
        },
      },
    });
  }, { home: root, defaultView, count, version: packageInfo.version });
}

test("keeps the ten-thousand-item grid bounded and reveals its last row", async ({ page }) => {
  await mockDesktop(page, "list", home, 10_000);
  await page.goto("/");
  const list = page.getByRole("listbox", { name: "文件列表" });
  await expect(list.getByRole("option", { name: /文件 0\.txt/ })).toBeVisible();
  await page.getByRole("button", { name: "图标视图", exact: true }).click();
  await expect(list).toHaveClass(/grid/);
  expect(await list.getByRole("option").count()).toBeLessThan(300);
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const last = list.getByRole("option", { name: "文件 9999.txt", exact: true });
  await expect(last).toBeVisible();
  await last.click();
  await page.keyboard.press("ArrowLeft");
  await expect(list.getByRole("option", { name: "文件 9998.txt", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("shares a directory snapshot and refreshes only the changed pane", async ({ page }) => {
  await mockDesktop(page, "list");
  await page.goto("/");
  await page.getByRole("button", { name: "左右分栏" }).click();
  const right = page.getByRole("region", { name: "右栏" });
  await expect(right.getByRole("option", { name: /项目/ })).toBeVisible();
  await right.getByRole("option", { name: /项目/ }).dblclick();
  await expect(right.getByRole("option", { name: /右栏文件/ })).toBeVisible();
  await page.evaluate((home) => {
    (window as Window & { filepaceEmit: (name: string, payload: unknown) => void }).filepaceEmit(
      "directory-changed", [home + "/项目/外部修改.txt"],
    );
  }, home);
  await expect.poll(() => page.evaluate(() => (window as Window & { filepaceReads: string[] }).filepaceReads)).toEqual(
    [home, home + "/项目", home + "/项目"],
  );
});

test("previews a batch rename and submits the validated token", async ({ page }) => {
  await mockDesktop(page, "list");
  await page.goto("/");
  const list = page.getByRole("listbox", { name: "文件列表" });
  await list.getByRole("option", { name: /左栏文件\.txt/ }).click();
  await list.getByRole("option", { name: /补充文档\.DOCX/ }).click({ modifiers: ["Shift"] });
  await page.keyboard.press("F2");
  const dialog = page.getByRole("dialog", { name: "批量重命名" });
  await dialog.getByLabel("规则").selectOption("affix");
  await dialog.getByRole("textbox", { name: "前缀", exact: true }).fill("整理-");
  await expect(dialog.getByRole("region", { name: "改名预览" })).toContainText("整理-左栏文件.txt");
  await dialog.getByRole("button", { name: "应用改名" }).click();
  await expect(dialog).toBeHidden();
  const writes = await page.evaluate(() => (window as Window & { filepaceWrites: unknown[] }).filepaceWrites);
  expect(writes).toContainEqual({ command: "batch_rename", args: { token: "rename-preview" } });
});

test("creates a text document in the directory whose blank area was right-clicked", async ({ page }) => {
  await mockDesktop(page, "columns");
  await page.goto("/");
  const files = page.getByLabel("文件列表", { exact: true });
  await files.getByRole("option", { name: "项目", exact: true }).click();
  await files.getByRole("option", { name: "归档", exact: true }).click();
  const parent = page.getByLabel("文件夹 · 项目", { exact: true });
  await parent.click({ button: "right", position: { x: 40, y: 200 } });
  const menu = page.locator(".context-menu");
  await expect(menu.getByRole("button", { name: "新建文件夹", exact: true })).toBeVisible();
  await menu.getByRole("button", { name: "新建文本文档", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "新建文本文档" });
  await expect(dialog).toContainText("创建于 项目");
  const name = dialog.getByRole("textbox", { name: "文档名称" });
  await expect(name).toHaveValue("新建文本文档.txt");
  await name.fill("右栏文件");
  await name.press("Enter");
  await expect(dialog.getByRole("alert")).toHaveText("同名项目已存在，请换个名称");
  await name.fill("整理记录");
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(files.getByRole("option", { name: "整理记录.txt", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "文件任务" })).toBeHidden();
  const writes = await page.evaluate(() => (window as Window & { filepaceWrites: unknown[] }).filepaceWrites);
  expect(writes).toEqual([
    { command: "make_text_file", args: { parent: `${home}/项目`, name: "右栏文件" } },
    { command: "make_text_file", args: { parent: `${home}/项目`, name: "整理记录" } },
  ]);
});

test("keeps routine file tasks quiet and shows failures without opening the panel", async ({ page }) => {
  await mockDesktop(page, "list");
  await page.goto("/");
  const panel = page.getByRole("region", { name: "文件任务" });
  const taskButton = page.getByRole("button", { name: "文件任务", exact: true });
  const source = `${home}/左栏文件.txt`;
  const task: Task = {
    id: "task-1", kind: "trash", sources: [source], destination: home,
    status: "running", current: source, completed: 0, bytes: 0, errors: [], conflict: null,
  };
  async function showTask(status: Task["status"], errors: string[] = []) {
    await page.evaluate((value) => {
      (window as Window & { filepaceTasks: Task[] }).filepaceTasks = [value];
    }, { ...task, status, errors, completed: status === "done" ? 1 : 0 });
  }
  async function trashFile() {
    await page.getByRole("option").filter({ hasText: "左栏文件.txt" }).click({ button: "right" });
    await page.locator(".context-menu").getByRole("button", { name: "移到回收站", exact: true }).click();
  }

  await trashFile();
  await showTask("running");
  await expect(page.getByRole("button", { name: "1 个文件任务" })).toBeVisible();
  await expect(panel).toBeHidden();
  await showTask("done");
  await expect(taskButton).toBeVisible();
  await expect(panel).toBeHidden();
  await expect(page.locator(".toast")).toBeHidden();
  await taskButton.click();
  await expect(panel.getByText("已完成", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "关闭任务面板" }).click();

  task.id = "task-2";
  await trashFile();
  await showTask("error", ["无法将此项目移到回收站"]);
  await expect(page.getByText("文件任务遇到问题，可在「文件任务」查看详情。")).toBeVisible();
  await expect(panel).toBeHidden();
  await taskButton.click();
  await panel.getByText("1 个问题").click();
  await expect(panel.getByText("无法将此项目移到回收站")).toBeVisible();
});

test("shows recent local errors and refreshes Windows error details in settings", async ({ page }) => {
  await mockDesktop(page, "list");
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "错误日志", exact: true }).click();
  await expect(page.getByText("还没有错误记录。")).toBeVisible();

  const path = String.raw`C:\Filepace Fixture\NUL`;
  await page.evaluate((record) => {
    (window as Window & { filepaceErrors: unknown[] }).filepaceErrors = [record];
  }, {
    time: 1_800_000_000, operation: "打开文件夹", step: "读取项目属性",
    path, osCode: 1, message: "函数不正确。",
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  const log = page.locator(".error-log");
  await expect(log).toContainText("打开文件夹 · 读取项目属性");
  await expect(log).toContainText(path);
  await expect(log).toContainText("OS Error 1");
  await expect(log).toContainText("函数不正确。");
});

test("keeps earlier columns when using Windows breadcrumbs", async ({ page }) => {
  await mockDesktop(page, "columns", "C:\\Filepace Fixture");
  await page.goto("/");
  const current = page.getByLabel("文件列表", { exact: true });
  await current.getByRole("option", { name: "项目", exact: true }).click();
  await current.getByRole("option", { name: "归档", exact: true }).click();
  await page.locator(".address").getByRole("button", { name: "项目", exact: true }).click();
  await expect(page.getByRole("region", { name: "当前目录列 · 项目", exact: true })).toBeVisible();
  const earlier = page.getByRole("region", { name: "目录列 · Filepace Fixture", exact: true });
  await expect(earlier.getByRole("option", { name: "项目", exact: true, selected: true })).toBeVisible();
});

test("compares conflict metadata and scopes apply-all to the current file task", async ({ page }) => {
  await mockDesktop(page, "list");
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "目标位置已有同名项目" });
  const sourceTime = 1_700_000_000;
  const targetTime = 1_800_000_000;
  async function showConflict(id: string) {
    const path = `${home}/项目/${id}.txt`;
    const source = `${home}/${id}.txt`;
    await page.evaluate((task) => {
      (window as Window & { filepaceTasks: Task[] }).filepaceTasks = [task];
    }, {
      id, kind: "copy", sources: [source], destination: `${home}/项目`, status: "conflict",
      current: source, completed: 0, bytes: 0, errors: [],
      conflict: {
        id: `conflict-${id}`,
        source: { path: source, isDir: false, size: 12, modified: sourceTime },
        destination: { path, isDir: false, size: 1024, modified: targetTime },
      },
    });
    await expect(dialog.getByText(path, { exact: true })).toBeVisible();
  }

  await showConflict("first");
  const source = dialog.getByRole("region", { name: "源项目" });
  const target = dialog.getByRole("region", { name: "目标项目" });
  const dates = await page.evaluate((times) => times.map((time) => new Date(time * 1000).toLocaleString("zh-CN")), [sourceTime, targetTime]);
  await expect(source.getByText(`${home}/first.txt`, { exact: true })).toBeVisible();
  await expect(source).toContainText("12 B");
  await expect(source).toContainText(dates[0]);
  await expect(target).toContainText("1.0 KB");
  await expect(target).toContainText(dates[1]);
  const apply = dialog.getByRole("checkbox", { name: "应用到本次任务的后续冲突" });
  const skip = dialog.getByRole("button", { name: "跳过", exact: true });
  await apply.check();
  await skip.click();
  await showConflict("second");
  await expect(apply).not.toBeChecked();
  await skip.click();
  const writes = await page.evaluate(() => (window as Window & { filepaceWrites: unknown[] }).filepaceWrites);
  expect(writes).toEqual([
    { command: "task_action", args: { id: "first", conflictId: "conflict-first", decision: "skip", applyAll: true } },
    { command: "task_action", args: { id: "second", conflictId: "conflict-second", decision: "skip", applyAll: false } },
  ]);
});

test("scrolls to hidden columns while dragging and drops on the visible destination", async ({ page }) => {
  await mockDesktop(page, "columns");
  await page.goto("/");
  const current = page.getByLabel("文件列表", { exact: true });
  const folders = ["项目", "归档", "第三级", "第四级", "第五级", "第六级"];
  for (const folder of folders) {
    await current.getByRole("option", { name: folder, exact: true }).click();
  }
  const strip = page.getByLabel("列视图目录", { exact: true });
  const view = (await strip.boundingBox())!;
  const deep = current.getByRole("option", { name: "深层文件.txt" });
  await expect(deep).toBeInViewport();
  const from = (await deep.boundingBox())!;
  expect(await strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(200);
  await page.mouse.move(from.x + 25, from.y + 14);
  await page.mouse.down();
  await page.mouse.move(view.x + 8, view.y + 150, { steps: 10 });
  await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBe(0);
  await expect(page.getByRole("status").filter({ hasText: "移动到 demo" })).toBeVisible();
  await page.mouse.up();

  const rootFile = page.getByRole("region", { name: "目录列 · demo", exact: true })
    .getByRole("option", { name: "左栏文件.txt" });
  const root = (await rootFile.boundingBox())!;
  await page.mouse.move(root.x + 25, root.y + 14);
  await page.mouse.down();
  await page.mouse.move(view.x + view.width - 8, view.y + 150, { steps: 10 });
  await expect.poll(() => strip.evaluate((el) => el.scrollWidth - el.clientWidth - el.scrollLeft)).toBeLessThan(2);
  const copyKey = await page.evaluate(() => navigator.platform.includes("Mac")) ? "Alt" : "Control";
  await page.keyboard.down(copyKey);
  await expect(page.getByRole("status").filter({ hasText: "复制到 第六级" })).toBeVisible();
  await page.mouse.up();
  await page.keyboard.up(copyKey);

  const deepPath = [home, ...folders].join("/");
  expect(await page.evaluate(() => (window as Window & { filepaceWrites: unknown[] }).filepaceWrites)).toEqual([
    { command: "start_task", args: { kind: "move", sources: [`${deepPath}/深层文件.txt`], destination: home } },
    { command: "start_task", args: { kind: "copy", sources: [`${home}/左栏文件.txt`], destination: deepPath } },
  ]);
});

test("moves and copies files between panes and keeps both tabs when merging", async ({ page }) => {
  await mockDesktop(page, "list");
  await page.goto("/");
  const nativeRow = page.getByRole("option", { name: /补充文档/ });
  await expect(nativeRow.locator('[data-file-kind="word"]')).toBeVisible();
  const nativeSource = (await nativeRow.boundingBox())!;
  await page.mouse.move(nativeSource.x + 26, nativeSource.y + 17);
  await page.mouse.down();
  await page.mouse.move(-12, nativeSource.y + 17, { steps: 12 });
  await page.mouse.up();
  const native = await page.evaluate(() => {
    const { command, args } = (window as Window & {
      filepaceWrites: { command: string; args: { paths: string[]; previewImage: number[] } }[];
    }).filepaceWrites.shift()!;
    return { command, paths: args.paths, header: args.previewImage?.slice(0, 8) };
  });
  expect(native).toEqual({
    command: "start_file_drag",
    paths: [`${home}/补充文档.DOCX`],
    header: [137, 80, 78, 71, 13, 10, 26, 10],
  });

  await page.getByRole("button", { name: "左右分栏" }).click();
  const left = page.getByRole("region", { name: "左栏" });
  const right = page.getByRole("region", { name: "右栏" });
  await right.getByRole("option", { name: /项目/ }).dblclick();
  await expect(left.getByRole("option", { name: /左栏文件/ })).toBeVisible();
  await expect(right.getByRole("option", { name: /右栏文件/ })).toBeVisible();
  await expect(page.getByText("左栏", { exact: true })).toHaveCount(0);
  await expect(page.getByText("右栏", { exact: true })).toHaveCount(0);
  await left.getByRole("button", { name: "图标大小" }).click();
  await page.getByRole("button", { name: "小图标", exact: true }).click();
  await right.getByRole("button", { name: "图标大小" }).click();
  await page.getByRole("button", { name: "大图标", exact: true }).click();
  await expect(left.getByLabel("文件列表")).toHaveAttribute("data-grid-size", "small");
  await expect(right.getByLabel("文件列表")).toHaveAttribute("data-grid-size", "large");

  const leftRow = left.getByRole("option", { name: /左栏文件/ });
  await leftRow.click();
  await left.getByRole("option", { name: /补充文档/ }).click({ modifiers: ["ControlOrMeta"] });
  const leftFile = (await leftRow.boundingBox())!;
  const archive = (await right.getByRole("option", { name: /归档/ }).boundingBox())!;
  const dragPreview = page.locator(".drag-preview");
  await page.mouse.move(leftFile.x + 25, leftFile.y + 18);
  await page.mouse.down();
  await expect(dragPreview).toHaveCount(0);
  await page.mouse.move(leftFile.x + 42, leftFile.y + 20);
  await expect(dragPreview).toContainText("左栏文件.txt");
  await expect(dragPreview).toContainText("2 项");
  await expect(leftRow).toHaveClass(/drag-source/);
  const start = (await dragPreview.boundingBox())!;
  await page.mouse.move(archive.x + 25, archive.y + 18, { steps: 12 });
  await expect(right.getByRole("status")).toContainText("移动到 归档");
  await expect(dragPreview).toContainText("移动");
  expect((await dragPreview.boundingBox())!.x).toBeGreaterThan(start.x);
  await page.mouse.up();
  await expect(dragPreview).toHaveCount(0);
  await expect(leftRow).not.toHaveClass(/drag-source/);

  const rightFile = (await right.getByRole("option", { name: /右栏文件/ }).boundingBox())!;
  const leftList = (await left.getByLabel("文件列表").boundingBox())!;
  const copyKey = (await page.evaluate(() => navigator.platform.includes("Mac"))) ? "Alt" : "Control";
  await page.mouse.move(rightFile.x + 25, rightFile.y + 18);
  await page.mouse.down();
  await page.mouse.move(leftList.x + 45, leftList.y + leftList.height - 35, { steps: 12 });
  await expect(left.getByRole("status")).toContainText("移动到 demo");
  await page.keyboard.down(copyKey);
  await expect(left.getByRole("status")).toContainText("复制到 demo");
  await expect(dragPreview).toContainText("复制");
  await page.mouse.up();
  await page.keyboard.up(copyKey);

  await page.mouse.move(rightFile.x + 25, rightFile.y + 18);
  await page.mouse.down();
  await page.mouse.move(leftList.x + 45, leftList.y + leftList.height - 35, { steps: 12 });
  await expect(dragPreview).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dragPreview).toHaveCount(0);
  await page.mouse.up();

  const writes = await page.evaluate(() => (window as Window & { filepaceWrites: unknown[] }).filepaceWrites);
  expect(writes).toEqual([
    { command: "start_task", args: { kind: "move", sources: [`${home}/左栏文件.txt`, `${home}/补充文档.DOCX`], destination: `${home}/项目/归档` } },
    { command: "start_task", args: { kind: "copy", sources: [`${home}/项目/右栏文件.txt`], destination: home } },
  ]);

  await page.getByRole("button", { name: "合并分栏" }).click();
  await expect(page.getByRole("region", { name: "右栏" })).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "新建窗口", exact: true })).toHaveCount(0);
  await page.keyboard.press("Control+n");
  await expect.poll(() => page.evaluate(() => (
    window as Window & { filepaceWrites: { command: string }[] }
  ).filepaceWrites.at(-1)?.command)).toBe("new_window");
});

test("moves between columns of one pane and copies a marquee selection", async ({ page }) => {
  await mockDesktop(page, "columns");
  await page.goto("/");
  await expect(page.locator(".titlebar")).not.toContainText("Filepace");
  await page.getByRole("option", { name: "项目" }).click();
  const ancestor = page.getByLabel("文件夹 · demo", { exact: true });
  const current = page.getByLabel("文件列表", { exact: true });
  const source = ancestor.getByRole("option", { name: "左栏文件.txt" });
  const copySource = current.getByRole("option", { name: "右栏文件.txt" });
  await expect(copySource).toBeVisible();
  const from = (await source.boundingBox())!;
  const other = (await ancestor.getByRole("option", { name: "补充文档.DOCX" }).boundingBox())!;
  const to = (await current.boundingBox())!;
  const earlier = (await ancestor.boundingBox())!;
  const second = (await copySource.boundingBox())!;
  const copyKey = await page.evaluate(() => navigator.platform.includes("Mac")) ? "Alt" : "Control";

  await page.mouse.move(from.x + 25, from.y + 16);
  await page.mouse.down();
  await page.mouse.move(to.x + 40, to.y + 105, { steps: 12 });
  await expect(page.getByRole("status").filter({ hasText: "移动到 项目" })).toBeVisible();
  await page.mouse.up();

  await page.mouse.move(second.x + 25, second.y + 16);
  await page.mouse.down();
  await page.mouse.move(earlier.x + 40, earlier.y + 130, { steps: 12 });
  await page.keyboard.down(copyKey);
  await expect(page.getByRole("status").filter({ hasText: "复制到 demo" })).toBeVisible();
  await page.mouse.up();
  await page.keyboard.up(copyKey);

  await page.mouse.move(earlier.x + earlier.width - 5, earlier.y + 114);
  await page.mouse.down();
  await page.mouse.move(from.x + 16, Math.min(from.y, other.y) + 3, { steps: 12 });
  await expect(page.locator(".selection-marquee")).toBeVisible();
  await expect(ancestor.getByRole("option", { selected: true })).toHaveCount(2);
  await page.mouse.up();
  await expect(page.locator(".selection-marquee")).toHaveCount(0);
  await expect(current.getByRole("option", { selected: true })).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+c");
  expect(await page.evaluate(() => (window as Window & { filepaceWrites: unknown[] }).filepaceWrites)).toEqual([
    { command: "start_task", args: { kind: "move", sources: [`${home}/左栏文件.txt`], destination: `${home}/项目` } },
    { command: "start_task", args: { kind: "copy", sources: [`${home}/项目/右栏文件.txt`], destination: home } },
    { command: "clipboard_set", args: { paths: [`${home}/补充文档.DOCX`, `${home}/左栏文件.txt`], cut: false } },
  ]);
});

test("marquee selects folders and supports keyboard ranges and cancellation", async ({ page }) => {
  await page.goto("/");
  const files = page.getByLabel("文件列表", { exact: true });
  await page.getByRole("button", { name: "列表视图", exact: true }).click();
  const rows = files.getByRole("option");
  const selected = files.getByRole("option", { selected: true });
  await rows.nth(2).click();
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(selected).toHaveCount(3);
  await page.keyboard.press("Shift+ArrowDown");
  await expect(selected).toHaveCount(2);
  await page.keyboard.press("Escape");

  const list = (await files.boundingBox())!;
  const first = (await rows.first().boundingBox())!;
  const third = (await rows.nth(2).boundingBox())!;
  await page.mouse.move(list.x + await files.evaluate((element) => element.clientWidth) - 5, first.y + 2);
  await page.mouse.down();
  await page.mouse.move(first.x + 20, third.y + 10, { steps: 12 });
  await expect(selected).toHaveCount(3);
  await page.mouse.up();
  await expect(selected).toHaveCount(3);

  await page.getByRole("button", { name: "图标视图", exact: true }).click();
  await page.keyboard.press("Escape");
  const grid = (await files.boundingBox())!;
  const tile = (await rows.nth(2).boundingBox())!;
  await page.mouse.move(grid.x + 5, grid.y + 5);
  await page.mouse.down();
  await page.mouse.move(tile.x + 10, tile.y + 45, { steps: 12 });
  await expect(selected).toHaveCount(3);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(selected).toHaveCount(0);
  await page.mouse.move(grid.x + 5, grid.y + 5);
  await page.mouse.down();
  await page.mouse.move(tile.x + 10, tile.y + 45, { steps: 12 });
  await page.mouse.up();
  await expect(selected).toHaveCount(3);
  await page.keyboard.press("ArrowRight");
  await expect(rows.nth(3)).toHaveAttribute("aria-selected", "true");
  await expect(selected).toHaveCount(1);
});

test("remembers sidebar groups and edits common locations while retaining saved favorites", async ({ page, context }) => {
  await page.addInitScript(() => {
    localStorage.setItem("filepace-favorites", JSON.stringify(["/Users/demo/设计素材"]));
  });
  await page.goto("/");
  const common = page.getByRole("region", { name: "常用位置" });
  const favorites = page.getByRole("region", { name: "收藏目录" });
  const menu = page.locator(".context-menu");
  const commonToggle = common.getByRole("button", { name: "常用位置", exact: true });
  const favoritesToggle = favorites.getByRole("button", { name: "收藏目录", exact: true });
  await expect(favorites.getByRole("button", { name: "设计素材" })).toBeVisible();
  await page.getByRole("option", { name: "项目" }).click({ button: "right" });
  await menu.getByRole("button", { name: "添加到常用位置", exact: true }).click();
  const project = common.getByRole("button", { name: "项目" });
  await expect(common.locator(".place").last()).toHaveText("项目");
  await project.click({ button: "right" });
  await menu.getByRole("button", { name: "上移", exact: true }).click();
  await expect(common.locator(".place").last()).toHaveText("图片");
  await common.getByRole("button", { name: "下载", exact: true }).click({ button: "right" });
  await menu.getByRole("button", { name: "从常用位置移除" }).click();
  await expect(common.getByRole("button", { name: "下载", exact: true })).toHaveCount(0);
  await commonToggle.press("Enter");
  await favoritesToggle.press("Space");
  await expect(commonToggle).toHaveAttribute("aria-expanded", "false");
  await expect(favoritesToggle).toHaveAttribute("aria-expanded", "false");
  await expect(project).toBeHidden();
  await page.reload();
  await expect(commonToggle).toHaveAttribute("aria-expanded", "false");
  await expect(favoritesToggle).toHaveAttribute("aria-expanded", "false");

  const secondWindow = await context.newPage();
  await secondWindow.goto("/");
  await secondWindow.getByRole("button", { name: "常用位置", exact: true }).click();
  await expect(commonToggle).toHaveAttribute("aria-expanded", "true");
  await expect(common.locator(".place").nth(3)).toHaveText("项目");
  await expect(common.getByRole("button", { name: "下载", exact: true })).toHaveCount(0);
  await favoritesToggle.click();
  await expect(favorites.getByRole("button", { name: "设计素材" })).toBeVisible();
  await secondWindow.evaluate(() => {
    localStorage.setItem("filepace-favorites", JSON.stringify(
      Array.from({ length: 30 }, (_, index) => `/Users/demo/目录 ${index + 1}`),
    ));
  });
  await expect(favorites.getByRole("button", { name: "目录 30", exact: true })).toHaveCount(1);
  const settings = page.getByRole("complementary", { name: "位置侧栏" }).getByRole("button", { name: "设置", exact: true });
  await expect(settings).toBeInViewport({ ratio: 1 });
  await settings.click();
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await secondWindow.close();
});
