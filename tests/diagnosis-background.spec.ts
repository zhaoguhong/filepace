import { expect, test, type Page } from "@playwright/test";

const first = "/Users/diagnosis";
const second = "/Volumes/other";
type Fixture = {
  calls: { command: string; args: Record<string, unknown> }[];
  scanPending: boolean;
  empty: boolean;
  finishScan: () => void;
  finish: (outcome?: "success" | "error" | "mismatch") => void;
};

async function setup(page: Page, scanPending = false) {
  await page.addInitScript(
    ({ first, second, scanPending }) => {
      localStorage.setItem(
        "filepace-preferences",
        JSON.stringify({ defaultView: "list", autoUpdate: false }),
      );
      let sequence = 0;
      const callbacks = new Map<number, (value: unknown) => void>();
      const listeners = new Map<number, { event: string; handler: number }>();
      const snapshots = new Map<string, string>();
      const scans = new Map<string, () => void>();
      const runs = new Map<
        string,
        {
          args: Record<string, unknown>;
          resolve: (value: unknown) => void;
          reject: (error: unknown) => void;
        }
      >();
      const file = (path: string) => ({
        path: `${path}/report.txt`,
        name: "report.txt",
        size: 2048,
        modified: 1794490000,
        isDir: false,
        isLink: false,
        hidden: false,
      });
      const fixture: Fixture = {
        calls: [],
        scanPending,
        empty: false,
        finishScan: () => {
          for (const finish of scans.values()) finish();
          scans.clear();
        },
        finish: (outcome = "success") => {
          for (const run of runs.values()) {
            const path = snapshots.get(String(run.args.scanId))!;
            if (outcome === "error") {
              run.reject("测试连接失败，请检查账号登录。");
              continue;
            }
            run.resolve({
              scanId: outcome === "mismatch" ? "another-scan" : run.args.scanId,
              agent: run.args.agent,
              goal: run.args.goal,
              instructions: run.args.instructions,
              createdAt: 1794490000,
              summary: `${path} 的独立诊断结果`,
              limitations: [],
              findings: [
                {
                  title: "核查报告",
                  kind: "review",
                  reason: "该文件在本次快照中。",
                  suggestion: "确认用途后整理。",
                  items: [
                    { ...file(path), id: "report", parent: path, files: 1 },
                  ],
                },
              ],
            });
          }
          runs.clear();
        },
      };
      Object.assign(window, {
        isTauri: true,
        diagnosisBackgroundFixture: fixture,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
        __TAURI_INTERNALS__: {
          metadata: {
            currentWindow: { label: "main" },
            currentWebview: { label: "main", windowLabel: "main" },
          },
          transformCallback: (callback: (value: unknown) => void) => {
            callbacks.set(++sequence, callback);
            return sequence;
          },
          invoke: async (
            command: string,
            args: Record<string, unknown> = {},
          ) => {
            fixture.calls.push({ command, args });
            if (command === "places")
              return [{ name: "个人目录", path: first, kind: "favorite" }];
            if (command === "list_directory")
              return {
                path: args.path,
                parent: "/",
                entries: [file(String(args.path))],
              };
            if (command === "tasks")
              return { tasks: [], undo: null, revision: 0 };
            if (command === "update_status")
              return { current: "fixture", phase: "current" };
            if (command === "storage_volumes")
              return [
                {
                  name: "其他目录",
                  path: second,
                  total: 10000,
                  available: 5000,
                },
              ];
            if (command === "diagnosis_agents")
              return [
                { id: "codex", name: "Codex", path: "/bin/codex", error: null },
              ];
            if (command === "scan_storage") {
              const path = String(args.path);
              const id = String(args.id);
              const empty = fixture.empty;
              const result = {
                path,
                counts: {
                  files: empty ? 0 : 1,
                  folders: 0,
                  bytes: empty ? 0 : 2048,
                  skipped: 0,
                },
                folders: [],
                categories: empty
                  ? {}
                  : {
                      documents: {
                        files: 1,
                        bytes: 2048,
                        largest: [{ ...file(path), parent: path, files: 1 }],
                      },
                    },
              };
              if (fixture.scanPending)
                return new Promise((resolve) =>
                  scans.set(id, () => {
                    snapshots.set(id, path);
                    resolve(result);
                  }),
                );
              snapshots.set(id, path);
              return result;
            }
            if (command === "diagnose_storage")
              return new Promise((resolve, reject) =>
                runs.set(String(args.id), { args, resolve, reject }),
              );
            // Deliberately leave stopped runs pending to exercise late native output.
            if (command === "plugin:event|listen") {
              listeners.set(++sequence, {
                event: String(args.event),
                handler: Number(args.handler),
              });
              return sequence;
            }
            if (command === "plugin:event|unlisten")
              listeners.delete(Number(args.eventId));
            if (command === "plugin:window|is_focused") return true;
            if (command === "plugin:notification|is_permission_granted")
              return true;
            return null;
          },
        },
      });
    },
    { first, second, scanPending },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "目录分析", exact: true }).click();
  await page.getByRole("tab", { name: "智能诊断", exact: true }).click();
}

async function calls(page: Page, command: string) {
  return page.evaluate(
    (command) =>
      (
        window as unknown as { diagnosisBackgroundFixture: Fixture }
      ).diagnosisBackgroundFixture.calls.filter(
        (call) => call.command === command,
      ),
    command,
  );
}
async function finish(
  page: Page,
  outcome: "success" | "error" | "mismatch" = "success",
) {
  await page.evaluate(
    (outcome) =>
      (
        window as unknown as { diagnosisBackgroundFixture: Fixture }
      ).diagnosisBackgroundFixture.finish(outcome),
    outcome,
  );
}

test("prepares and diagnoses in the background while browsing another directory, then opens the original report", async ({
  page,
}) => {
  await setup(page, true);
  await page.setViewportSize({ width: 1180, height: 560 });
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect(page.locator(".diagnosis-activity")).toContainText(
    "正在收集目录信息",
  );
  await page.getByRole("button", { name: "返回文件", exact: true }).click();
  await page.getByRole("button", { name: "编辑路径", exact: true }).click();
  await page.getByLabel("完整路径").fill(second);
  await page.getByLabel("完整路径").press("Enter");
  await page.evaluate(() =>
    (
      window as unknown as { diagnosisBackgroundFixture: Fixture }
    ).diagnosisBackgroundFixture.finishScan(),
  );
  await expect.poll(() => calls(page, "diagnose_storage")).toHaveLength(1);
  const scan = (await calls(page, "scan_storage"))[0];
  expect(scan.args.path).toBe(first);
  expect((await calls(page, "diagnose_storage"))[0].args.scanId).toBe(
    scan.args.id,
  );
  await finish(page);
  await expect(page.locator(".diagnosis-completion")).toContainText(
    "诊断已完成",
  );
  await expect(
    page
      .getByLabel("文件列表", { exact: true })
      .getByRole("option", { name: /report\.txt/ }),
  ).toHaveAttribute("data-path", `${second}/report.txt`);
  await page
    .locator(".diagnosis-completion")
    .getByRole("button", { name: "查看报告", exact: true })
    .click();
  await expect(page.getByLabel("扫描范围", { exact: true })).toHaveValue(first);
  await expect(
    page.getByRole("tab", { name: "智能诊断", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const report = page.getByLabel("智能诊断报告", { exact: true });
  await expect(report).toContainText(`${first} 的独立诊断结果`);
  const summary = report.getByText(`${first} 的独立诊断结果`, { exact: true });
  await expect(summary).toBeInViewport({ ratio: 1 });
  await page.locator(".directory-analysis").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(summary).not.toBeInViewport();
  await page.getByRole("tab", { name: "占用分析", exact: true }).click();
  await page.locator(".diagnosis-activity").click();
  await expect(summary).toBeInViewport({ ratio: 1 });
  await report
    .getByRole("checkbox", { name: "选择 report.txt", exact: true })
    .check();
  await report
    .getByRole("button", { name: "复制所选文件", exact: true })
    .click();
  expect((await calls(page, "clipboard_set"))[0].args.paths).toEqual([
    `${first}/report.txt`,
  ]);
  expect(await calls(page, "cancel_storage_scan")).toHaveLength(0);
  expect(await calls(page, "cancel_storage_diagnosis")).toHaveLength(0);
});

test("keeps reports isolated and recoverable after changing scope and rescanning", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect.poll(() => calls(page, "diagnose_storage")).toHaveLength(1);
  await page.getByLabel("扫描范围", { exact: true }).selectOption(second);
  await expect(page.getByText(/正在后台诊断：/)).toContainText(first);
  await page.getByRole("tab", { name: "占用分析", exact: true }).click();
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await page.getByRole("tab", { name: "智能诊断", exact: true }).click();
  await finish(page);
  await expect(
    page.getByRole("button", { name: "开始诊断", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("智能诊断报告", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect.poll(() => calls(page, "diagnose_storage")).toHaveLength(2);
  await finish(page);
  await expect(page.getByLabel("智能诊断报告", { exact: true })).toContainText(
    `${second} 的独立诊断结果`,
  );
  await page.getByLabel("扫描范围", { exact: true }).selectOption("");
  await expect(page.getByLabel("智能诊断报告", { exact: true })).toContainText(
    `${first} 的独立诊断结果`,
  );
  await page.getByRole("tab", { name: "占用分析", exact: true }).click();
  await page.getByRole("button", { name: "重新扫描", exact: true }).click();
  await page.getByRole("tab", { name: "智能诊断", exact: true }).click();
  await expect(page.getByLabel("智能诊断报告", { exact: true })).toContainText(
    `${first} 的独立诊断结果`,
  );
  expect(await calls(page, "cancel_storage_diagnosis")).toHaveLength(0);
});

test("restores background failures and rejects mismatched results before allowing retry", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect.poll(() => calls(page, "diagnose_storage")).toHaveLength(1);
  await page.getByRole("button", { name: "返回文件", exact: true }).click();
  await page.locator(".diagnosis-activity").click();
  await expect(
    page.getByRole("button", { name: "停止诊断", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await page.getByRole("button", { name: "返回文件", exact: true }).click();
  await finish(page, "error");
  await page
    .locator(".diagnosis-completion")
    .getByRole("button", { name: "查看诊断", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("测试连接失败");
  await expect(page.getByRole("alert")).toBeInViewport({ ratio: 1 });
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect.poll(() => calls(page, "diagnose_storage")).toHaveLength(2);
  await finish(page, "mismatch");
  await expect(page.getByRole("alert")).toContainText(
    "诊断结果与当前请求不一致",
  );
  await expect(page.getByLabel("智能诊断报告", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect.poll(() => calls(page, "diagnose_storage")).toHaveLength(3);
  await finish(page);
  await expect(page.getByLabel("智能诊断报告", { exact: true })).toContainText(
    `${first} 的独立诊断结果`,
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("ignores late output after an explicit stop and does not call an agent for an empty scan", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect.poll(() => calls(page, "diagnose_storage")).toHaveLength(1);
  await page.getByRole("button", { name: "停止诊断", exact: true }).click();
  await expect
    .poll(() => calls(page, "cancel_storage_diagnosis"))
    .toHaveLength(1);
  await finish(page);
  await expect(page.getByText("诊断已停止。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("智能诊断报告", { exact: true })).toHaveCount(0);
  await expect(page.locator(".diagnosis-completion")).toHaveCount(0);
  await page.getByLabel("扫描范围", { exact: true }).selectOption(second);
  await page.evaluate(() => {
    (
      window as unknown as { diagnosisBackgroundFixture: Fixture }
    ).diagnosisBackgroundFixture.empty = true;
  });
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect(
    page.getByText("这个范围没有可分析的文件。", { exact: true }),
  ).toBeVisible();
  expect(await calls(page, "diagnose_storage")).toHaveLength(1);
});
