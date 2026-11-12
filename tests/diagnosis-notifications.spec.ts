import { expect, test, type Page } from "@playwright/test";
import packageInfo from "../package.json" with { type: "json" };

type NotificationFixture = {
  calls: string[];
  notifications: {
    title: string;
    body: string;
    extra: Record<string, unknown>;
  }[];
  focused: boolean;
  permissionRequests: number;
  activeListeners: number;
  diagnosisStarted: boolean;
  complete: (error?: string) => void;
  click: (extra: Record<string, unknown>) => void;
};

async function mockNotifications(
  page: Page,
  focused: boolean,
  permission: "granted" | "denied" = "granted",
) {
  await page.addInitScript(
    ({ focused, permission, version }) => {
      const home = "/Users/notification-fixture";
      localStorage.setItem(
        "filepace-preferences",
        JSON.stringify({ autoUpdate: false }),
      );
      let next = 0;
      const callbacks = new Map<number, (value: unknown) => void>();
      const events = new Map<number, { event: string; handler: number }>();
      const notificationListeners = new Map<
        number,
        { onmessage: (value: unknown) => void }
      >();
      const scans = new Map<string, string>();
      let completion:
        | {
            resolve: (value: unknown) => void;
            reject: (reason: string) => void;
            result: unknown;
          }
        | undefined;
      const fixture: NotificationFixture = {
        calls: [],
        notifications: [],
        focused,
        permissionRequests: 0,
        activeListeners: 0,
        diagnosisStarted: false,
        complete: (error) => {
          if (error) completion?.reject(error);
          else completion?.resolve(completion.result);
          completion = undefined;
        },
        click: (extra) => {
          for (const listener of notificationListeners.values())
            listener.onmessage({ actionId: "tap", notification: { extra } });
        },
      };
      class TestNotification {
        static permission = "default";
        static async requestPermission() {
          fixture.permissionRequests++;
          TestNotification.permission = permission;
          return permission;
        }
        constructor(title: string, options: Record<string, unknown>) {
          fixture.notifications.push({
            title,
            body: String(options.body),
            extra: options.extra as Record<string, unknown>,
          });
        }
      }
      Object.defineProperty(window, "Notification", {
        value: TestNotification,
        configurable: true,
      });
      Object.assign(window, {
        isTauri: true,
        filepaceNotificationFixture: fixture,
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
          unregisterCallback: (id: number) => callbacks.delete(id),
          invoke: async (
            command: string,
            args: Record<string, unknown> = {},
          ) => {
            fixture.calls.push(command);
            if (command === "plugin:event|listen") {
              events.set(++next, {
                event: String(args.event),
                handler: Number(args.handler),
              });
              return next;
            }
            if (command === "plugin:event|unlisten")
              events.delete(Number(args.eventId));
            if (command === "plugin:notification|register_listener") {
              const handler = args.handler as {
                id: number;
                onmessage: (value: unknown) => void;
              };
              notificationListeners.set(handler.id, handler);
              fixture.activeListeners = notificationListeners.size;
            }
            if (command === "plugin:notification|remove_listener") {
              notificationListeners.delete(Number(args.channelId));
              fixture.activeListeners = notificationListeners.size;
            }
            if (command === "plugin:notification|is_permission_granted")
              return false;
            if (command === "plugin:window|is_focused") return fixture.focused;
            if (command === "places")
              return [{ name: "个人目录", path: home, kind: "favorite" }];
            if (command === "tasks")
              return { tasks: [], revision: 0, undo: null };
            if (command === "update_status")
              return { current: version, phase: "current" };
            if (command === "list_directory")
              return {
                path: args.path,
                parent: "/Users",
                entries: [
                  {
                    name: "文档.txt",
                    path: `${args.path}/文档.txt`,
                    isDir: false,
                    size: 2048,
                    modified: 0,
                    hidden: false,
                    isLink: false,
                  },
                ],
              };
            if (command === "storage_volumes") return [];
            if (command === "diagnosis_agents")
              return [
                {
                  id: "codex",
                  name: "Codex",
                  path: "/usr/local/bin/codex",
                  error: null,
                },
              ];
            if (command === "scan_storage") {
              scans.set(String(args.id), String(args.path));
              return {
                path: args.path,
                counts: { files: 1, folders: 0, bytes: 2048, skipped: 0 },
                categories: {},
                folders: [],
              };
            }
            if (command === "diagnose_storage") {
              fixture.diagnosisStarted = true;
              const scope = scans.get(String(args.scanId));
              const result = {
                agent: args.agent,
                scanId: args.scanId,
                goal: args.goal,
                instructions: args.instructions,
                createdAt: 1794380000,
                summary: `原目录 ${scope} 的诊断报告`,
                findings: [],
                limitations: [],
              };
              return new Promise((resolve, reject) => {
                completion = { resolve, reject, result };
              });
            }
            return null;
          },
        },
      });
    },
    { focused, permission, version: packageInfo.version },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "目录分析", exact: true }).click();
  await page.getByRole("tab", { name: "智能诊断", exact: true }).click();
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              filepaceNotificationFixture: NotificationFixture;
            }
          ).filepaceNotificationFixture.diagnosisStarted,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              filepaceNotificationFixture: NotificationFixture;
            }
          ).filepaceNotificationFixture.permissionRequests,
      ),
    )
    .toBe(1);
}

async function complete(page: Page, error?: string) {
  await page.evaluate(
    (error) =>
      (
        window as unknown as {
          filepaceNotificationFixture: NotificationFixture;
        }
      ).filepaceNotificationFixture.complete(error),
    error,
  );
  await expect(page.locator(".diagnosis-completion")).toBeVisible();
}

test("notifies in the background and routes notification clicks only to their original window and report", async ({
  page,
}) => {
  await mockNotifications(page, false);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              filepaceNotificationFixture: NotificationFixture;
            }
          ).filepaceNotificationFixture.activeListeners,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            filepaceNotificationFixture: NotificationFixture;
          }
        ).filepaceNotificationFixture.calls.filter(
          (call) => call === "plugin:notification|remove_listener",
        ).length,
    ),
  ).toBeGreaterThan(0);
  await page.getByRole("button", { name: "返回文件", exact: true }).click();
  await page.getByRole("button", { name: "编辑路径", exact: true }).click();
  await page
    .getByRole("combobox", { name: "完整路径", exact: true })
    .fill("/Users/other-work");
  await page
    .getByRole("combobox", { name: "完整路径", exact: true })
    .press("Enter");
  await complete(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              filepaceNotificationFixture: NotificationFixture;
            }
          ).filepaceNotificationFixture.notifications.length,
      ),
    )
    .toBe(1);
  const notification = await page.evaluate(
    () =>
      (
        window as unknown as {
          filepaceNotificationFixture: NotificationFixture;
        }
      ).filepaceNotificationFixture.notifications[0],
  );
  expect(notification.title).toBe("目录诊断完成");
  expect(notification.extra).toMatchObject({
    filepaceWindow: "main",
    scope: "/Users/notification-fixture",
  });
  await page.evaluate(
    (extra) =>
      (
        window as unknown as {
          filepaceNotificationFixture: NotificationFixture;
        }
      ).filepaceNotificationFixture.click({
        ...extra,
        filepaceWindow: "different-window",
      }),
    notification.extra,
  );
  await expect(
    page.getByRole("heading", { name: "目录分析", exact: true }),
  ).toBeHidden();
  await expect(page.locator(".file-area")).toBeVisible();
  await page.evaluate(
    (extra) =>
      (
        window as unknown as {
          filepaceNotificationFixture: NotificationFixture;
        }
      ).filepaceNotificationFixture.click(extra),
    notification.extra,
  );
  await expect(
    page.getByRole("heading", { name: "目录分析", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("智能诊断报告", { exact: true })).toContainText(
    "原目录 /Users/notification-fixture 的诊断报告",
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            filepaceNotificationFixture: NotificationFixture;
          }
        ).filepaceNotificationFixture.calls.includes("plugin:window|set_focus"),
      ),
    )
    .toBe(true);
});

test("keeps completion inside the focused app without sending a duplicate system notification", async ({
  page,
}) => {
  await mockNotifications(page, true);
  await complete(page);
  await expect(page.locator(".diagnosis-completion")).toContainText(
    "诊断已完成",
  );
  await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            filepaceNotificationFixture: NotificationFixture;
          }
        ).filepaceNotificationFixture.notifications,
    ),
  ).toHaveLength(0);
});

test("preserves failure details and the in-app entry when system notification permission is denied", async ({
  page,
}) => {
  await mockNotifications(page, false, "denied");
  await page.getByRole("button", { name: "返回文件", exact: true }).click();
  await complete(page, "连接已断开，请稍后重试");
  await expect(page.locator(".diagnosis-completion")).toContainText(
    "连接已断开，请稍后重试",
  );
  await page
    .locator(".diagnosis-completion")
    .getByRole("button", { name: "关闭诊断提示", exact: true })
    .click();
  const entry = page.locator(".sidebar-bottom").getByRole("button", {
    name: "诊断未完成：notification-fixture",
    exact: true,
  });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.getByRole("alert")).toContainText("连接已断开，请稍后重试");
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            filepaceNotificationFixture: NotificationFixture;
          }
        ).filepaceNotificationFixture.notifications,
    ),
  ).toHaveLength(0);
});
