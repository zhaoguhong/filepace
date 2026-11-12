import { expect, test, type Page } from "@playwright/test";
import packageInfo from "../package.json" with { type: "json" };
import type { UpdateStatus } from "../src/updates";

type UpdateFixture = {
  calls: string[];
  snapshotRequested: boolean;
  emit: (status: UpdateStatus) => void;
  releaseSnapshot: () => void;
};

async function mockUpdates(
  page: Page,
  status: UpdateStatus,
  delayedSnapshot = false,
) {
  await page.addInitScript(
    ({ status, delayedSnapshot }) => {
      localStorage.setItem(
        "filepace-preferences",
        JSON.stringify({ autoUpdate: false }),
      );
      let next = 0;
      const callbacks = new Map<number, (value: unknown) => void>();
      const listeners = new Map<number, { event: string; handler: number }>();
      let release: (() => void) | undefined;
      const fixture = {
        calls: [] as string[],
        snapshotRequested: false,
        emit: (payload: UpdateStatus) => {
          for (const [id, listener] of listeners) {
            if (listener.event === "filepace-update")
              callbacks.get(listener.handler)?.({
                event: listener.event,
                id,
                payload,
              });
          }
        },
        releaseSnapshot: () => release?.(),
      };
      Object.assign(window, {
        isTauri: true,
        filepaceUpdateFixture: fixture,
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
          invoke: async (
            command: string,
            args: Record<string, unknown> = {},
          ) => {
            fixture.calls.push(command);
            if (command === "plugin:event|listen") {
              listeners.set(++next, {
                event: String(args.event),
                handler: Number(args.handler),
              });
              return next;
            }
            if (command === "plugin:event|unlisten")
              listeners.delete(Number(args.eventId));
            if (command === "places")
              return [
                {
                  name: "个人目录",
                  path: "/Users/update-fixture",
                  kind: "favorite",
                },
              ];
            if (command === "list_directory")
              return { path: args.path, parent: "/Users", entries: [] };
            if (command === "tasks")
              return { tasks: [], revision: 0, undo: null };
            if (command === "update_status") {
              fixture.snapshotRequested = true;
              if (delayedSnapshot)
                await new Promise<void>((resolve) => {
                  release = resolve;
                });
              return status;
            }
            if (command === "install_update") {
              fixture.emit({ ...status, phase: "installing" });
            }
            return null;
          },
        },
      });
    },
    { status, delayedSnapshot },
  );
}

const ready: UpdateStatus = {
  current: packageInfo.version,
  phase: "ready",
  version: "9.9.9",
};

test("shows a versioned update card beside settings as soon as downloading starts", async ({
  page,
}) => {
  await mockUpdates(page, { ...ready, phase: "downloading" });
  await page.goto("/");
  const card = page
    .locator(".sidebar-bottom")
    .getByRole("button", { name: "发现新版本 v9.9.9", exact: true });
  await expect(card).toBeVisible();
  await expect(card).toContainText("正在后台下载…");
  await expect(card.locator("strong")).toHaveCSS("font-size", "12px");
  const geometry = await card.boundingBox();
  expect(geometry!.height).toBeGreaterThanOrEqual(64);
  expect(geometry!.y).toBeGreaterThan(500);
  await card.click();
  await expect(
    page.getByRole("heading", { name: "更新", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("正在下载 v9.9.9…", { exact: true }),
  ).toBeVisible();
  await page.evaluate(
    (status) =>
      (
        window as unknown as { filepaceUpdateFixture: UpdateFixture }
      ).filepaceUpdateFixture.emit(status),
    ready,
  );
  await expect(
    page
      .locator(".sidebar-bottom")
      .getByRole("button", { name: "可重启更新 v9.9.9", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "重启更新", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { filepaceUpdateFixture: UpdateFixture }
        ).filepaceUpdateFixture.calls.filter(
          (call) => call === "install_update",
        ).length,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "重启更新", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { filepaceUpdateFixture: UpdateFixture }
          ).filepaceUpdateFixture.calls.filter(
            (call) => call === "install_update",
          ).length,
      ),
    )
    .toBe(1);
});

test("keeps an accessible versioned update entry when the sidebar is hidden in a narrow dark window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 680 });
  await page.emulateMedia({ colorScheme: "dark" });
  await mockUpdates(page, ready);
  await page.goto("/");
  await page.getByRole("button", { name: "切换侧边栏", exact: true }).click();
  const card = page
    .locator(".statusbar")
    .getByRole("button", { name: "可重启更新 v9.9.9", exact: true });
  await expect(card).toBeVisible();
  await expect(card.locator("strong")).toHaveCSS("font-size", "12px");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await card.click();
  await expect(
    page.getByRole("heading", { name: "更新", exact: true }),
  ).toBeVisible();
  await page.evaluate(
    (status) =>
      (
        window as unknown as { filepaceUpdateFixture: UpdateFixture }
      ).filepaceUpdateFixture.emit(status),
    { ...ready, phase: "error", message: "下载连接已断开" },
  );
  await expect(
    page
      .locator(".statusbar")
      .getByRole("button", { name: "新版本下载失败 v9.9.9", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("下载连接已断开", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { filepaceUpdateFixture: UpdateFixture }
          ).filepaceUpdateFixture.calls.filter(
            (call) => call === "check_update",
          ).length,
      ),
    )
    .toBe(1);
});

test("does not let a delayed startup snapshot hide a newer update event", async ({
  page,
}) => {
  await mockUpdates(
    page,
    { current: packageInfo.version, phase: "current" },
    true,
  );
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { filepaceUpdateFixture: UpdateFixture })
            .filepaceUpdateFixture.snapshotRequested,
      ),
    )
    .toBe(true);
  await page.evaluate(
    (status) =>
      (
        window as unknown as { filepaceUpdateFixture: UpdateFixture }
      ).filepaceUpdateFixture.emit(status),
    ready,
  );
  const card = page.getByRole("button", {
    name: "可重启更新 v9.9.9",
    exact: true,
  });
  await expect(card).toBeVisible();
  await page.evaluate(async () => {
    (
      window as unknown as { filepaceUpdateFixture: UpdateFixture }
    ).filepaceUpdateFixture.releaseSnapshot();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(card).toBeVisible();
});
