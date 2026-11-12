import { test, expect } from "@playwright/test";

test("keeps pane focus independent while resizing through the narrow divider", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "左右分栏", exact: true }).click();
  const left = page.getByRole("region", { name: "左栏", exact: true });
  const right = page.getByRole("region", { name: "右栏", exact: true });
  const divider = page.getByRole("separator", { name: "调整左右栏宽度" });
  await left.getByRole("option", { name: /产品需求\.md/ }).click();
  await right.getByRole("option", { name: /项目/ }).dblclick();
  await expect(right.getByText("这个文件夹还是空的")).toBeVisible();
  await expect(
    left.getByRole("option", { name: /产品需求\.md/, selected: true }),
  ).toBeVisible();
  const bounds = (await divider.boundingBox())!;
  // The line remains one pixel wide, with a larger invisible drag target.
  await page.mouse.move(bounds.x - 3, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 90, bounds.y + bounds.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await divider.getAttribute("aria-valuenow")))
    .toBeGreaterThan(55);
  await expect(right).toHaveClass(/focused/);
  await expect(left).not.toHaveClass(/focused/);
  await expect(page.locator(".pane-focus-badge")).toHaveCount(0);
  await expect(
    left.getByRole("option", { name: /产品需求\.md/, selected: true }),
  ).toBeVisible();
  await divider.focus();
  await page.keyboard.press("Home");
  await expect(divider).toHaveAttribute("aria-valuenow", "50");
  await page.keyboard.press("ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", "45");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({
      path: `test-results/filepace-split-${colorScheme}.png`,
    });
  }
});
