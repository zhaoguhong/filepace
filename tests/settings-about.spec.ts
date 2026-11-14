import { expect, test, type Page } from "@playwright/test";
import packageInfo from "../package.json" with { type: "json" };

const projectUrl = "https://github.com/zhaoguhong/filepace";

async function openAbout(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "关于", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "关于 Filepace" }),
  ).toBeVisible();
}

test("about settings expose the project source and version in browser preview", async ({
  page,
}) => {
  await openAbout(page);
  const link = page.getByRole("link", { name: "GitHub · zhaoguhong/filepace" });
  await expect(link).toHaveAttribute("href", projectUrl);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.getByText(projectUrl, { exact: true })).toHaveCount(0);
  await expect(
    page.getByText(`v${packageInfo.version} · MIT 许可证`),
  ).toBeVisible();
  await link.focus();
  await expect(link).toBeFocused();
});

test("desktop project link invokes the system browser and reports failures without leaving settings", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let next = 0;
    const callbacks = new Map<number, (value: unknown) => void>();
    const fixture = { opened: [] as string[], fail: true };
    Object.assign(window, {
      isTauri: true,
      aboutFixture: fixture,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main", windowLabel: "main" },
        },
        transformCallback: (handler: (value: unknown) => void) => {
          callbacks.set(++next, handler);
          return next;
        },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === "plugin:event|listen") return ++next;
          if (command === "places")
            return [
              { name: "个人目录", path: "/Users/about", kind: "favorite" },
            ];
          if (command === "list_directory")
            return { path: args.path, parent: "/Users", entries: [] };
          if (command === "tasks")
            return { tasks: [], undo: null, revision: 0 };
          if (command === "plugin:opener|open_url") {
            fixture.opened.push(String(args.url));
            if (fixture.fail) throw new Error("No browser available");
          }
          return null;
        },
      },
    });
  });
  await openAbout(page);
  const link = page.getByRole("link", { name: "GitHub · zhaoguhong/filepace" });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(
    "无法打开浏览器，请复制项目地址后打开。",
  );
  await expect(page.getByText(projectUrl, { exact: true })).toBeVisible();
  const readFixture = () =>
    page.evaluate(
      () =>
        (window as unknown as { aboutFixture: { opened: string[] } })
          .aboutFixture.opened,
    );
  expect(await readFixture()).toEqual([projectUrl]);
  await page.evaluate(() => {
    (
      window as unknown as { aboutFixture: { fail: boolean } }
    ).aboutFixture.fail = false;
  });
  await link.click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText(projectUrl, { exact: true })).toHaveCount(0);
  expect(await readFixture()).toEqual([projectUrl, projectUrl]);
  await expect(
    page.getByRole("heading", { name: "关于 Filepace" }),
  ).toBeVisible();
});
