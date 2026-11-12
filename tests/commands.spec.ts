import { expect, test, type Page } from "@playwright/test";

async function command(page: Page, query: string) {
  await page.getByRole("button", { name: /命令面板（/ }).click();
  await page.getByRole("combobox", { name: "搜索操作" }).fill(query);
  await page.getByRole("combobox", { name: "搜索操作" }).press("Enter");
}

test("command palette filters actions, preserves layouts, and changes real list geometry", async ({
  page,
}) => {
  await page.goto("/");
  const firstRow = page.locator(".file-area.list .file-row").first();
  await expect(firstRow).toHaveCSS("height", "44px");
  await command(page, "紧凑列表");
  await expect(firstRow).toHaveCSS("height", "34px");
  await page.getByRole("button", { name: "左右分栏", exact: true }).click();
  await page
    .getByRole("button", { name: "新建标签", exact: true })
    .first()
    .click();
  await command(page, "工作布局");
  const layouts = page.getByRole("dialog", { name: "工作布局", exact: true });
  await layouts.getByRole("textbox", { name: "布局名称" }).fill("项目整理");
  await layouts
    .getByRole("button", { name: "保存当前布局", exact: true })
    .click();
  await expect(layouts).toContainText("3 个标签 · 左右分栏");
  await layouts.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "合并分栏", exact: true }).click();
  await command(page, "工作布局");
  await layouts.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "右栏", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(3);
  await command(page, "工作布局");
  await layouts.getByRole("button", { name: "删除布局 项目整理" }).click();
  await expect(layouts).toContainText("还没有保存的布局");
  await page.keyboard.press("Escape");
  await expect(layouts).toBeHidden();
});

test("palette keyboard and empty results work in narrow dark windows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 680 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /命令面板（/ })).toBeVisible();
  await page.keyboard.press("Control+Shift+P");
  const input = page.getByRole("combobox", { name: "搜索操作" });
  await input.fill("不存在的操作");
  await expect(page.getByText("没有匹配的操作", { exact: true })).toBeVisible();
  await input.fill("搜索子文件夹");
  await input.press("Enter");
  await expect(
    page.getByRole("heading", { name: "搜索子文件夹", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "命令面板", exact: true }),
  ).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
