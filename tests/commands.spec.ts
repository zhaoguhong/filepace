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

test("palette contains focus, restores its opener and ignores IME confirmation", async ({
  page,
}) => {
  await page.goto("/");
  const row = page.locator(".file-row").filter({ hasText: "产品需求.md" });
  await row.click();
  const opener = page.getByRole("button", { name: /命令面板（/ });
  await opener.click();
  const input = page.getByRole("combobox", { name: "搜索操作" });
  for (const key of ["Tab", "Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    await expect(input).toBeFocused();
  }
  await input.fill("工作布局");
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
  });
  await expect(
    page.getByRole("dialog", { name: "命令面板", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  await expect(row).toHaveAttribute("aria-selected", "true");
  await opener.click();
  await input.fill("工作布局");
  await input.press("Enter");
  const layouts = page.getByRole("dialog", { name: "工作布局" });
  const layoutName = layouts.getByRole("textbox", { name: "布局名称" });
  const close = layouts.getByRole("button", { name: "关闭", exact: true });
  await expect(layoutName).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(layoutName).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(layouts).toBeHidden();
  await expect(opener).toBeFocused();
});

test("palette finds familiar aliases and explains unavailable actions", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /命令面板（/ }).click();
  const input = page.getByRole("combobox", { name: "搜索操作" });
  for (const [query, label] of [
    ["去重", "检查重复文件"],
    ["  WORKSPACE  ", "保存或恢复工作布局"],
    ["双栏", "左右分栏"],
    ["search demo", "搜索子文件夹"],
  ]) {
    await input.fill(query);
    await expect(
      page.getByRole("listbox", { name: "可用操作" }).getByRole("option"),
    ).toHaveCount(1);
    await expect(
      page.getByRole("listbox", { name: "可用操作" }).getByRole("option"),
    ).toContainText(label);
  }
  await input.fill("去重");
  await expect(
    page.getByRole("listbox", { name: "可用操作" }).getByRole("option"),
  ).toHaveAttribute("aria-disabled", "true");
  await expect(
    page.getByRole("listbox", { name: "可用操作" }).getByRole("option"),
  ).toContainText("请在桌面应用中使用");
  await input.press("Enter");
  await expect(input).toBeVisible();
  await input.fill("双栏");
  await input.press("Enter");
  await expect(
    page.getByRole("region", { name: "右栏", exact: true }),
  ).toBeVisible();
});

test("editing layouts preserves the saved session unless explicitly updated", async ({
  page,
}) => {
  await page.goto("/");
  await command(page, "工作布局");
  const dialog = page.getByRole("dialog", { name: "工作布局", exact: true });
  const name = dialog.getByRole("textbox", { name: "布局名称" });
  await name.fill("旧布局");
  await dialog
    .getByRole("button", { name: "保存当前布局", exact: true })
    .click();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "左右分栏", exact: true }).click();
  await command(page, "工作布局");
  await dialog.getByRole("button", { name: "编辑布局 旧布局" }).click();
  await name.fill("常用布局");
  await dialog.getByRole("button", { name: "保存修改" }).click();
  await expect(dialog).toContainText("1 个标签 · 单栏");
  await dialog.getByRole("button", { name: "编辑布局 常用布局" }).click();
  await name.fill("取消的名称");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "编辑布局 常用布局" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "编辑布局 常用布局" }).click();
  await dialog
    .getByRole("checkbox", { name: "同时更新为当前标签页与分栏" })
    .check();
  await dialog.getByRole("button", { name: "保存修改" }).click();
  await expect(dialog).toContainText("2 个标签 · 左右分栏");
  await page.reload();
  await command(page, "工作布局");
  await dialog.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "右栏", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(2);
});

test("a full layout library can be renamed and preserves concurrent additions", async ({
  page,
}) => {
  await page.goto("/");
  await command(page, "工作布局");
  const dialog = page.getByRole("dialog", { name: "工作布局", exact: true });
  const input = dialog.getByRole("textbox", { name: "布局名称" });
  await input.fill("模板");
  await dialog
    .getByRole("button", { name: "保存当前布局", exact: true })
    .click();
  await dialog.getByRole("button", { name: "编辑布局 模板" }).click();
  await page.evaluate(() => {
    const original = JSON.parse(
      localStorage.getItem("filepace-work-layouts")!,
    )[0];
    localStorage.setItem(
      "filepace-work-layouts",
      JSON.stringify([
        original,
        ...Array.from({ length: 11 }, (_, i) => ({
          ...original,
          id: `extra-${i}`,
          name: `其他布局${i}`,
        })),
      ]),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: "filepace-work-layouts" }),
    );
  });
  await input.fill("改名后");
  await dialog.getByRole("button", { name: "保存修改" }).click();
  await expect(dialog.getByRole("button", { name: /^编辑布局 / })).toHaveCount(
    12,
  );
  await expect(
    dialog.getByRole("button", { name: "编辑布局 改名后" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "保存当前布局", exact: true }),
  ).toBeDisabled();
});
