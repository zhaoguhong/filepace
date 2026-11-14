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
            const number =
              Number(localStorage.getItem("fixture-storage-scan") ?? 0) + 1;
            localStorage.setItem("fixture-storage-scan", String(number));
            const size = number === 1 ? 100 : 150;
            const folder = {
              path: path + "/work",
              parent: path,
              name: "work",
              size,
              files: 1,
              isDir: true,
              modified: 0,
            };
            const file = {
              path: path + "/work/sample.txt",
              parent: folder.path,
              name: "sample.txt",
              size,
              files: 1,
              isDir: false,
              modified: 0,
            };
            const extra = {
              path: path + "/root.bin",
              parent: path,
              name: "root.bin",
              size: 20,
              files: 1,
              isDir: false,
              modified: 0,
            };
            return {
              path,
              counts: { files: 2, folders: 1, bytes: size + 20, skipped: 0 },
              folders: [folder],
              categories: {
                documents: {
                  files: 2,
                  bytes: size + 20,
                  largest: [file, extra],
                },
              },
              tree: [folder, file, extra],
              treeComplete: true,
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

test("treemap drills down with keyboard and links files to existing result actions", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  const map = page.getByRole("region", { name: "目录矩形树图" });
  const folder = map.getByRole("button", { name: /展开目录 work/ });
  await folder.focus();
  await page.keyboard.press("Enter");
  await expect(
    map.getByRole("group", {
      name: "目录占用图 /Users/fixture/work",
      exact: true,
    }),
  ).toBeVisible();
  await map.getByRole("button", { name: /查看文件 sample.txt/ }).click();
  const results = map.getByLabel("图中项目", { exact: true });
  await expect(
    results.getByRole("button", { name: /sample.txt/ }),
  ).toBeVisible();
  await map.getByRole("button", { name: "显示全部项目", exact: true }).click();
  await map.getByRole("button", { name: "扫描根目录", exact: true }).click();
  await expect(
    map.getByRole("button", { name: /查看文件 root.bin/ }),
  ).toBeVisible();
});

test("baseline survives reload, compares rescans and clears", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  const comparison = page.getByRole("region", { name: "扫描前后对比" });
  await comparison.getByRole("button", { name: "保存为对比基线" }).click();
  await expect(
    comparison.getByText("基线已保存，重新扫描后可查看变化。", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "目录分析", exact: true }).click();
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await expect(comparison.getByText(/文件大小变化 \+50 B/)).toBeVisible();
  await expect(comparison.getByText("目录变化", { exact: true })).toBeVisible();
  await comparison.getByRole("button", { name: "替换对比基线" }).click();
  await expect(
    comparison.getByText("基线已保存，重新扫描后可查看变化。", { exact: true }),
  ).toBeVisible();
  await comparison.getByRole("button", { name: "清除基线" }).click();
  await expect(
    comparison.getByRole("button", { name: "保存为对比基线" }),
  ).toBeVisible();
});
