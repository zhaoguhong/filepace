import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "filepace-preferences",
      JSON.stringify({ defaultView: "list", autoUpdate: false }),
    );
    let sequence = 0;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const root = "/Users/fixture";
    const snapshots = new Map<string, string>();
    const emit = (event: string, payload: unknown) => {
      for (const [id, listener] of listeners) {
        if (listener.event === event)
          callbacks.get(listener.handler)?.({ event, id, payload });
      }
    };
    Object.assign(window, {
      isTauri: true,
      analysisFixture: { calls, emit },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main", windowLabel: "main" },
        },
        transformCallback: (handler: (value: unknown) => void) => {
          callbacks.set(++sequence, handler);
          return sequence;
        },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args });
          if (command === "places")
            return [
              { name: "个人目录", path: root, kind: "favorite" },
              { name: "文档", path: root + "/Documents", kind: "favorite" },
            ];
          if (command === "tasks")
            return { tasks: [], revision: 0, undo: null };
          if (command === "list_directory")
            return { path: args.path, parent: "/Users", entries: [] };
          if (command === "storage_volumes") return [];
          if (command === "update_status")
            return { current: "fixture", phase: "current" };
          if (command === "diagnosis_agents")
            return [
              {
                id: "codex",
                name: "Codex",
                path: "/bin/codex",
                configurationError: null,
              },
            ];
          if (command === "scan_storage") {
            const path = String(args.path);
            snapshots.set(String(args.id), path);
            return {
              path,
              counts: { files: 1, folders: 0, bytes: 1024, skipped: 0 },
              folders: [],
              categories: {
                documents: {
                  files: 1,
                  bytes: 1024,
                  largest: [
                    {
                      path: path + "/sample.txt",
                      parent: path,
                      name: path.endsWith("Documents")
                        ? "文档快照.txt"
                        : "个人目录快照.txt",
                      size: 1024,
                      files: 1,
                    },
                  ],
                },
              },
            };
          }
          if (command === "diagnose_storage") {
            if (!snapshots.has(String(args.scanId)))
              throw new Error("Snapshot expired");
            return {
              agent: args.agent,
              scanId: args.scanId,
              goal: args.goal,
              instructions: args.instructions,
              createdAt: 1794380000,
              summary: "使用所选目录的扫描快照。",
              findings: [],
              limitations: [],
            };
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
  });
  await page.goto("/");
  await page.getByRole("button", { name: "目录分析", exact: true }).click();
}

type Fixture = {
  calls: { command: string; args: Record<string, unknown> }[];
  emit: (event: string, payload: unknown) => void;
};
async function scans(page: Page) {
  return page.evaluate(() =>
    (
      window as unknown as { analysisFixture: Fixture }
    ).analysisFixture.calls.filter((call) => call.command === "scan_storage"),
  );
}

test("reuses recent scopes for browsing and diagnosis and shows the largest files in the first screen", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  const first = (await scans(page))[0];
  const file = page.getByRole("button", { name: /个人目录快照.txt/ });
  await expect(file).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "查看诊断选项", exact: true }),
  ).toHaveCount(0);
  const scope = page.getByLabel("扫描范围", { exact: true });
  await scope.selectOption("/Users/fixture/Documents");
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /文档快照.txt/ }),
  ).toBeVisible();
  await scope.selectOption("");
  await expect(file).toBeVisible();
  expect(await scans(page)).toHaveLength(2);
  await page.getByRole("tab", { name: "智能诊断", exact: true }).click();
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect(
    page.getByText("使用所选目录的扫描快照。", { exact: true }),
  ).toBeVisible();
  const diagnosis = await page.evaluate(() =>
    (
      window as unknown as { analysisFixture: Fixture }
    ).analysisFixture.calls.find((call) => call.command === "diagnose_storage"),
  );
  expect(diagnosis?.args.scanId).toBe(first.args.id);
  expect(await scans(page)).toHaveLength(2);
});

test("refreshes a changed directory before sending metadata to an agent", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  const initial = (await scans(page))[0];
  await page.evaluate(() =>
    (window as unknown as { analysisFixture: Fixture }).analysisFixture.emit(
      "directory-changed",
      ["/Users/fixture/Documents/new.txt"],
    ),
  );
  await expect(
    page.getByRole("status").filter({ hasText: "目录已有变化" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "智能诊断", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "重新扫描后诊断", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect(
    page.getByText("使用所选目录的扫描快照。", { exact: true }),
  ).toBeVisible();
  const refreshed = await scans(page);
  expect(refreshed).toHaveLength(2);
  expect(refreshed[1].args.id).not.toBe(initial.args.id);
  const diagnosis = await page.evaluate(() =>
    (
      window as unknown as { analysisFixture: Fixture }
    ).analysisFixture.calls.find((call) => call.command === "diagnose_storage"),
  );
  expect(diagnosis?.args.scanId).toBe(refreshed[1].args.id);
});
