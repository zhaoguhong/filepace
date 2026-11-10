import { test, expect } from "@playwright/test";
test("browse, filter, tabs, restore, preview and grid", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-area").getByRole("option")).toHaveCount(8);
  await page.getByLabel("筛选当前文件夹").fill("需求");
  await expect(page.locator(".file-area").getByRole("option")).toHaveCount(1);
  await page.getByLabel("清除筛选").click();
  await page.getByLabel("新建标签", { exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.locator(".file-area").getByRole("option").filter({ hasText: "项目" }).dblclick();
  await expect(page.getByText("这个文件夹还是空的")).toBeVisible();
  await page.getByRole("tab").first().click();
  await expect(page.locator(".file-area").getByRole("option")).toHaveCount(8);
  await page.locator(".file-area").getByRole("option").filter({ hasText: "产品需求.md" }).click();
  await page.keyboard.press("Space");
  await expect(page.getByLabel("关闭预览")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("图标视图", { exact: true }).click();
  await expect(page.locator(".file-area")).toHaveClass(/grid/);
  await page.getByLabel("显示隐藏文件").click();
  await expect(page.locator(".file-area").getByRole("option")).toHaveCount(9);
  await page.getByRole("tab").first().click({ button: "right" });
  await page.getByRole("button", { name: "关闭标签", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await page.keyboard.press("Control+Shift+T");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.screenshot({ path: "test-results/filepace-main.png" });
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
 await page.goto('/');await page.getByLabel('新建标签',{exact:true}).click();await page.locator('.file-area').getByRole('option').filter({hasText:'项目'}).dblclick();
 const from=await page.getByRole('tab').last().boundingBox();const to=await page.getByRole('tab').first().boundingBox();
 await page.mouse.move(from!.x+30,from!.y+15);await page.mouse.down();await page.mouse.move(to!.x+30,to!.y+15,{steps:8});await page.mouse.up();
 await expect(page.getByRole('tab').first()).toContainText('项目');
});

test("shows path and system actions for a file, a folder and an empty list", async ({
  page,
}) => {
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
  await page.keyboard.press("Escape");

  await folder.click({ button: "right" });
  await expect(copyPath).toBeVisible();
  await expect(reveal).toBeVisible();
  await expect(terminal).toBeVisible();
  await page.keyboard.press("Escape");

  await folder.dblclick();
  await files.getByText("这个文件夹还是空的").click({ button: "right" });
  await expect(copyPath).toBeVisible();
  await expect(reveal).toBeVisible();
  await expect(terminal).toBeVisible();
});

test("moves and copies files between panes and keeps both tabs when merging", async ({ page }) => {
  const home = "/Users/demo";
  await page.addInitScript((home) => {
    const writes: { command: string; args: Record<string, unknown> }[] = [];
    const listings: Record<string, [string, boolean][]> = {
      [home]: [["项目", true], ["左栏文件.txt", false]],
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
          if (command === "tasks") return [];
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
          if (command === "start_task" || command === "new_window") writes.push({ command, args });
          if (command === "plugin:event|listen") return ++callback;
          return null;
        },
      },
    });
  }, home);
  await page.goto("/");
  await page.getByRole("button", { name: "左右分栏" }).click();
  const left = page.getByRole("region", { name: "左栏" });
  const right = page.getByRole("region", { name: "右栏" });
  await right.getByRole("option", { name: /项目/ }).dblclick();
  await expect(left.getByRole("option", { name: /左栏文件/ })).toBeVisible();
  await expect(right.getByRole("option", { name: /右栏文件/ })).toBeVisible();

  const leftFile = (await left.getByRole("option", { name: /左栏文件/ }).boundingBox())!;
  const archive = (await right.getByRole("option", { name: /归档/ }).boundingBox())!;
  await page.mouse.move(leftFile.x + 25, leftFile.y + 18);
  await page.mouse.down();
  await page.mouse.move(archive.x + 25, archive.y + 18, { steps: 12 });
  await expect(right.getByRole("status")).toContainText("移动到 归档");
  await page.mouse.up();

  const rightFile = (await right.getByRole("option", { name: /右栏文件/ }).boundingBox())!;
  const leftList = (await left.getByLabel("文件列表").boundingBox())!;
  const copyKey = (await page.evaluate(() => navigator.platform.includes("Mac"))) ? "Alt" : "Control";
  await page.mouse.move(rightFile.x + 25, rightFile.y + 18);
  await page.mouse.down();
  await page.mouse.move(leftList.x + 45, leftList.y + leftList.height - 35, { steps: 12 });
  await expect(left.getByRole("status")).toContainText("移动到 demo");
  await page.keyboard.down(copyKey);
  await expect(left.getByRole("status")).toContainText("复制到 demo");
  await page.mouse.up();
  await page.keyboard.up(copyKey);

  await page.mouse.move(rightFile.x + 25, rightFile.y + 18);
  await page.mouse.down();
  await page.mouse.move(leftList.x + 45, leftList.y + leftList.height - 35, { steps: 12 });
  await page.keyboard.press("Escape");
  await page.mouse.up();

  const writes = await page.evaluate(() => (window as Window & { filepaceWrites: unknown[] }).filepaceWrites);
  expect(writes).toEqual([
    { command: "start_task", args: { kind: "move", sources: [`${home}/左栏文件.txt`], destination: `${home}/项目/归档` } },
    { command: "start_task", args: { kind: "copy", sources: [`${home}/项目/右栏文件.txt`], destination: home } },
  ]);

  await page.getByRole("button", { name: "合并分栏" }).click();
  await expect(page.getByRole("region", { name: "右栏" })).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "新建窗口" })).toBeVisible();
});
