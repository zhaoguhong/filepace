import { test, expect, type Page } from "@playwright/test";
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
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "外观", exact: true }).click();
  const theme = page.getByRole("combobox", { name: "主题" });
  const mode = page.getByRole("combobox", { name: "显示模式" });
  await expect(mode).toHaveValue("system");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await theme.selectOption("mist");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "mist");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await theme.selectOption("sand");
  await mode.selectOption("light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sand");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
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
  await expect(page.getByRole("region", { name: "当前目录列 · 项目" })).toBeVisible();
  await ancestor.getByRole("option", { name: /设计素材/ }).click();
  await expect(page.getByRole("region", { name: "当前目录列 · 设计素材" })).toBeVisible();
  await ancestor.getByRole("option", { name: /产品需求\.md/ }).click();
  await expect(page.getByRole("region", { name: "文件预览" })).toContainText("产品需求.md");

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

async function mockDesktop(page: Page, defaultView: "list" | "columns") {
  await page.addInitScript(({ home, defaultView }) => {
    localStorage.setItem("filepace-preferences", JSON.stringify({ defaultView }));
    const writes: { command: string; args: Record<string, unknown> }[] = [];
    const listings: Record<string, [string, boolean][]> = {
      [home]: [["项目", true], ["左栏文件.txt", false], ["补充文档.DOCX", false]],
      [`${home}/项目`]: [["归档", true], ["右栏文件.txt", false]],
    };
    let callback = 0;
    Object.assign(window, {
      isTauri: true,
      filepaceWrites: writes,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        transformCallback: () => ++callback,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === "places") return [{ name: "个人目录", path: home, kind: "favorite" }];
          if (command === "tasks") return { tasks: [], undo: null };
          if (command === "update_status") return { current: "0.4.1", phase: "current" };
          if (command === "list_directory") {
            const path = String(args.path);
            return {
              path,
              parent: path.slice(0, path.lastIndexOf("/")),
              entries: (listings[path] ?? []).map(([name, isDir]) => ({
                name, isDir, path: `${path}/${name}`, isLink: false, size: 10, modified: 0, hidden: false,
              })),
            };
          }
          if (["start_task", "new_window", "start_file_drag", "clipboard_set"].includes(command)) writes.push({ command, args });
          if (command === "plugin:event|listen") return ++callback;
          return null;
        },
      },
    });
  }, { home, defaultView });
}

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
  await secondWindow.close();
});
