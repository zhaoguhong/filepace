import { test, expect, type Page } from "@playwright/test";
import packageInfo from "../package.json" with { type: "json" };
import type { Task } from "../src/model";
test("browse, filter, tabs, restore, preview and grid", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("filepace-preferences", JSON.stringify({ defaultView: "list" })));
  await page.goto("/");
  await expect(page.locator(".file-area").getByRole("option")).toHaveCount(11);
  await page.getByLabel("筛选当前文件夹").fill("需求");
  await expect(page.locator(".file-area").getByRole("option")).toHaveCount(1);
  await page.getByLabel("清除筛选").click();
  await page.getByLabel("新建标签", { exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.locator(".file-area").getByRole("option").filter({ hasText: "项目" }).dblclick();
  await expect(page.getByText("这个文件夹还是空的")).toBeVisible();
  await page.getByRole("tab").first().click();
  await expect(page.locator(".file-area").getByRole("option")).toHaveCount(11);
  await page.locator(".file-area").getByRole("option").filter({ hasText: "产品需求.md" }).click();
  await page.keyboard.press("Space");
  await expect(page.getByLabel("关闭预览")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("图标视图", { exact: true }).click();
  await expect(page.locator(".file-area")).toHaveClass(/grid/);
  await page.getByRole("button", { name: "显示选项", exact: true }).click();
  await page.getByRole("button", { name: "显示隐藏文件", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".file-area").getByRole("option")).toHaveCount(12);
  await page.getByRole("tab").first().click({ button: "right" });
  await page.getByRole("button", { name: "关闭标签", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await page.keyboard.press("Control+Shift+T");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.screenshot({ path: "test-results/filepace-main.png" });
});

test("distinguishes document icons and saves the chosen size per tab", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "列表视图" }).click();
  const files = page.getByLabel("文件列表");
  const word = files.getByRole("option", { name: /会议纪要\.docx/ });
  const excel = files.getByRole("option", { name: /预算表\.xlsx/ });
  const slides = files.getByRole("option", { name: /季度汇报\.pptx/ });
  await expect(word.locator('[data-file-kind="word"] img')).toBeVisible();
  await expect(excel.locator('[data-file-kind="excel"] img')).toBeVisible();
  await expect(slides.locator('[data-file-kind="powerpoint"] img')).toBeVisible();
  await expect(word).toContainText("Word 文档");

  const sizeMenu = page.getByRole("group", { name: "选择图标大小" });
  let previousWidth = 0;
  for (const label of ["小图标", "中图标", "大图标", "超大图标"]) {
    await page.getByRole("button", { name: "显示选项", exact: true }).click();
    await sizeMenu.getByRole("button", { name: label, exact: true }).click();
    await page.keyboard.press("Escape");
    const icon = await word.locator(".entry-icon").boundingBox();
    expect(icon?.width).toBeGreaterThan(previousWidth);
    previousWidth = icon!.width;
  }
  await page.getByRole("button", { name: "列表视图", exact: true }).click();
  await page.getByRole("button", { name: "图标视图", exact: true }).click();
  await expect(files).toHaveAttribute("data-grid-size", "extra-large");

  await page.getByRole("button", { name: "新建标签", exact: true }).click();
  await page.getByRole("button", { name: "图标视图", exact: true }).click();
  await expect(files).toHaveAttribute("data-grid-size", "medium");
  await page.getByRole("tab").first().click();
  await expect(files).toHaveAttribute("data-grid-size", "extra-large");
});

test("shows storage volumes, filters scan results, and locates a file", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "存储概览", exact: true }).click();
  await expect(page.getByRole("heading", { name: "存储概览" })).toBeVisible();
  await expect(page.getByRole("meter", { name: "系统磁盘已用比例" })).toBeVisible();
  await expect(page.getByRole("meter", { name: "外接磁盘已用比例" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "文件分类" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "开始扫描" })).toBeHidden();
  await page.getByRole("button", { name: /^目录分析 查看文件分布/ }).click();
  await expect(page.getByRole("heading", { name: "目录分析", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "开始扫描" }).click();
  await expect(page.getByRole("heading", { name: "文件分类" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "占用最多的子目录" })).toBeVisible();
  await page.getByRole("button", { name: /压缩包.*个/ }).click();
  await expect(page.getByRole("heading", { name: "最大的文件 · 压缩包" })).toBeVisible();
  const rankings = page.getByRole("listbox", { name: "最大的文件 · 压缩包", exact: true });
  await expect(rankings.getByRole("button", { name: /数据备份\.zip/ })).toBeVisible();
  await expect(rankings.getByRole("button", { name: /季度汇报\.pptx/ })).toHaveCount(0);
  await rankings.locator(".result-row").filter({ hasText: "数据备份.zip" }).getByRole("button", { name: "打开所在目录并选中" }).click();
  await expect(page.getByRole("heading", { name: "存储概览" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: /数据备份\.zip/, selected: true })).toBeVisible();
  await page.getByRole("button", { name: "目录分析", exact: true }).click();
  await page.getByRole("button", { name: /^项目 0 个文件/ }).dblclick();
  await expect(page.getByText("这个文件夹还是空的")).toBeVisible();
  await page.getByRole("button", { name: "目录分析", exact: true }).click();
  await expect(page.getByLabel("扫描范围", { exact: true })).toHaveValue("/Users/demo");
  await expect(page.getByRole("heading", { name: "最大的文件 · 压缩包" })).toBeVisible();
});

test("keeps smart diagnosis read-only in the browser preview", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "目录分析", exact: true }).click();
  await page.getByRole("tab", { name: "智能诊断", exact: true }).click();
  await expect(page.getByRole("heading", { name: "智能诊断", exact: true })).toBeVisible();
  const agent = page.getByLabel("AI 工具", { exact: true });
  await expect(agent.locator("option")).toHaveText(["Codex", "Claude Code", "OpenCode", "DeepSeek Harness"]);
  await expect(page.getByRole("button", { name: "开始诊断", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "占用分析", exact: true }).click();
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await page.getByRole("tab", { name: "智能诊断", exact: true }).click();
  await expect(page.getByRole("button", { name: "开始诊断", exact: true })).toBeDisabled();
  await expect(page.getByText("浏览器仅预览界面，请在桌面应用中使用智能诊断。")).toBeVisible();
  await expect(page.getByRole("region", { name: "AI 工具提示" })).toHaveCount(0);
});

test("searches by file name and type and reveals the result", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "搜索子文件夹" }).click();
  await page.getByRole("textbox", { name: "文件名关键词" }).fill("会议");
  await page.getByRole("combobox", { name: "文件类型" }).selectOption("images");
  await page.getByRole("button", { name: "开始搜索" }).click();
  await expect(page.getByText("这个范围没有匹配的项目。")).toBeVisible();
  await page.getByRole("combobox", { name: "文件类型" }).selectOption("documents");
  await page.getByRole("textbox", { name: "文件名关键词" }).press("Enter");
  await page.locator(".result-row").filter({ hasText: "会议纪要.docx" }).getByRole("button", { name: "打开所在目录并选中" }).click();
  await expect(page.getByRole("option", { name: /会议纪要\.docx/, selected: true })).toBeVisible();
});

test("follows system light and dark mode and keeps an explicit theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-mode", "light");
  for (const surface of ["html", ".titlebar", ".sidebar", ".tabs", ".column-head", ".statusbar"]) {
    await expect(page.locator(surface)).toHaveCSS("background-color", "rgb(255, 255, 255)");
  }
  const file = page.getByRole("option", { name: /会议纪要\.docx/ });
  await file.hover();
  await expect(file).toHaveCSS("background-color", "rgb(241, 242, 244)");
  await file.click();
  await expect(file).toHaveCSS("background-color", "rgb(234, 241, 255)");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "外观", exact: true }).click();
  const theme = page.getByRole("combobox", { name: "主题" });
  const mode = page.getByRole("combobox", { name: "显示模式" });
  await expect(mode).toHaveValue("system");
  await expect(theme).toHaveValue("default");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-mode", "dark");
  await theme.selectOption("mist");
  await expect(root).toHaveCSS("background-color", "rgb(28, 43, 64)");
  await theme.selectOption("sand");
  await expect(root).toHaveCSS("background-color", "rgb(48, 40, 32)");
  await theme.selectOption("lilac");
  await expect(root).toHaveCSS("background-color", "rgb(44, 37, 56)");
  await mode.selectOption("light");
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "lilac");
  await expect(root).toHaveAttribute("data-mode", "light");
  await expect(root).toHaveCSS("background-color", "rgb(252, 249, 255)");
});

test("follows column branches and applies a changed default only to new tabs", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "列视图", exact: true }).click();
  const current = page.getByLabel("文件列表", { exact: true });
  await expect(current).toBeVisible();
  const strip = await page.locator(".column-browser").boundingBox();
  const area = await current.boundingBox();
  expect(area!.x + area!.width).toBeCloseTo(strip!.x + strip!.width - 1, 0);
  await current.getByRole("option", { name: /项目/ }).click();
  const ancestor = page.getByLabel("文件夹 · demo", { exact: true });
  await expect(ancestor.getByRole("option", { name: /项目/ })).toHaveAttribute("aria-selected", "true");
  const project = page.getByRole("region", { name: "当前目录列 · 项目" });
  await expect(project).toBeVisible();
  expect((await current.boundingBox())!.y).toBeCloseTo((await project.boundingBox())!.y, 0);
  await expect(page.getByRole("region", { name: "目录列 · demo", exact: true }).getByRole("button", { name: "demo", exact: true })).toHaveCount(0);
  await ancestor.getByRole("option", { name: /设计素材/ }).click();
  await expect(page.getByRole("region", { name: "当前目录列 · 设计素材" })).toBeVisible();
  await ancestor.getByRole("option", { name: /产品需求\.md/ }).click();
  await expect(page.getByRole("region", { name: "文件预览" })).toContainText("产品需求.md");
  await current.getByRole("option", { name: "项目" }).click();
  await page.locator(".address").getByRole("button", { name: "demo", exact: true }).click();
  await expect(page.getByRole("region", { name: "当前目录列 · demo" })).toBeVisible();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const view = page.getByRole("combobox", { name: "默认视图" });
  await expect(view).toHaveValue("list");
  await view.selectOption("grid");
  await page.getByRole("button", { name: "返回文件" }).click();
  await page.getByRole("button", { name: "新建标签", exact: true }).click();
  await expect(current).toHaveClass(/^file-area grid/);
  await page.getByRole("tab").first().click();
  await expect(current).toHaveClass(/column-list/);
});
test("new folder errors are visible and navigation can be typed", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("编辑路径").click();
  await page.getByLabel("完整路径").fill("/Users/demo/Downloads");
  await page.getByLabel("完整路径").press("Enter");
  await expect(page.getByText("这个文件夹还是空的")).toBeVisible();
  await page.getByLabel("文件列表", { exact: true }).click({ button: "right", position: { x: 25, y: 200 } });
  await page.locator(".context-menu").getByRole("button", { name: "新建文件夹", exact: true }).click();
  await expect(page.getByLabel("文件夹名称")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
});

test('reorders tabs with pointer gestures independently of native file drag', async ({page})=>{
 await page.addInitScript(() => localStorage.setItem("filepace-preferences", JSON.stringify({ defaultView: "list" })));
 await page.goto('/');await page.getByLabel('新建标签',{exact:true}).click();await page.locator('.file-area').getByRole('option').filter({hasText:'项目'}).dblclick();
 const from=await page.getByRole('tab').last().boundingBox();const to=await page.getByRole('tab').first().boundingBox();
 await page.mouse.move(from!.x+30,from!.y+15);await page.mouse.down();await page.mouse.move(to!.x+30,to!.y+15,{steps:8});await page.mouse.up();
 await expect(page.getByRole('tab').first()).toContainText('项目');
});

test("shows path and system actions for a file, a folder and an empty list", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("filepace-preferences", JSON.stringify({ defaultView: "list" })));
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
  await menu.getByRole("button", { name: "属性", exact: true }).click();
  const properties = page.getByRole("dialog", { name: "属性" });
  await expect(properties).toContainText("/Users/demo/产品需求.md");
  await expect(properties).toContainText("Markdown 文档");
  await page.keyboard.press("Escape");
  await expect(properties).toHaveCount(0);

  await folder.click({ button: "right" });
  await expect(copyPath).toBeVisible();
  await expect(reveal).toBeVisible();
  await expect(terminal).toBeVisible();
  await menu.getByRole("button", { name: "属性", exact: true }).click();
  await expect(properties).toContainText("/Users/demo/项目");
  await expect(properties).toContainText("文件夹");
  await page.keyboard.press("Escape");

  await folder.dblclick();
  await files.getByText("这个文件夹还是空的").click({ button: "right" });
  await expect(copyPath).toBeVisible();
  await expect(reveal).toBeVisible();
  await expect(terminal).toBeVisible();
});

const home = "/Users/demo";

type DiagnosisFixture = {
  mode: "success" | "pending" | "late" | "error";
  scanMode: "success" | "pending" | "late" | "error" | "empty";
  missingAgents?: string[];
  configurationError?: string;
  configurationErrors?: Record<string, string>;
  calls: { command: string; args: Record<string, unknown> }[];
  complete: () => void;
  completeScans: () => void;
};

async function mockStorageDiagnosis(page: Page, mode: DiagnosisFixture["mode"] = "success", missingAgents: string[] = [], configurationErrors: Record<string, string> = {}) {
  await mockDesktop(page, "list");
  await page.goto("/");
  await page.evaluate(({ home, mode, missingAgents, configurationErrors }) => {
    type Native = { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
    const native = (window as unknown as { __TAURI_INTERNALS__: Native }).__TAURI_INTERNALS__;
    const original = native.invoke;
    const calls: DiagnosisFixture["calls"] = [];
    const snapshots = new Map<string, { path: string }>();
    const pending = new Map<string, { resolve: (value: unknown) => void; result: unknown }>();
    const pendingScans = new Map<string, { resolve: (value: unknown) => void; result: unknown }>();
    const fixture: DiagnosisFixture = {
      mode, scanMode: "success", calls, missingAgents, configurationErrors,
      complete: () => {
        for (const [id, item] of pending) { item.resolve(item.result); pending.delete(id); }
      },
      completeScans: () => {
        for (const [id, item] of pendingScans) { item.resolve(item.result); pendingScans.delete(id); }
      },
    };
    Object.assign(window, { filepaceDiagnosisFixture: fixture });
    native.invoke = async (command, args = {}) => {
      if (["scan_storage", "cancel_storage_scan", "diagnosis_agents", "diagnose_storage", "cancel_storage_diagnosis"].includes(command)) calls.push({ command, args });
      if (command === "storage_volumes") return [{ name: "测试卷", path: "/Volumes/fixture", total: 100000, available: 50000 }];
      if (command === "scan_storage") {
        if (fixture.scanMode === "error") throw "无法读取扫描目录";
        const path = String(args.path);
        const result = fixture.scanMode === "empty"
          ? { path, counts: { files: 0, folders: 0, bytes: 0, skipped: 0 }, folders: [], categories: {} }
          : { path, counts: { files: 1, folders: 0, bytes: 2048, skipped: 0 }, folders: [],
          categories: { documents: { files: 1, bytes: 2048,
            largest: [{ name: "左栏文件.txt", path: `${path}/左栏文件.txt`, parent: path, size: 2048, files: 1 }] } } };
        if (fixture.scanMode === "pending" || fixture.scanMode === "late") {
          return new Promise((resolve) => pendingScans.set(String(args.id), { result, resolve: (value) => {
            if (value) snapshots.set(String(args.id), { path });
            resolve(value);
          } }));
        }
        snapshots.set(String(args.id), { path });
        return result;
      }
      if (command === "cancel_storage_scan") {
        const id = String(args.id);
        if (fixture.scanMode !== "late") { pendingScans.get(id)?.resolve(null); pendingScans.delete(id); }
        return null;
      }
      if (command === "diagnosis_agents") {
        const paths = args.paths as Record<string, string>;
        return ["codex", "claude", "opencode", "deepseek"].map((id) => {
          const path = fixture.missingAgents?.includes(id) ? null : paths[id] || (id === "opencode" ? null : `/usr/local/bin/${id}`);
          return { id, name: id === "claude" ? "Claude Code" : id === "codex" ? "Codex" : "OpenCode", path,
            error: path ? null : "未找到 OpenCode，请安装后重新检测，或指定命令路径",
            configurationError: fixture.configurationError || fixture.configurationErrors?.[id] || null,
            configuration: { model: "my-model", provider: "my-provider", source: "/Users/demo/.config/ai", profiles: ["work", "web"], profile: (args.profiles as Record<string, string>)?.[id] || null, note: "沿用已有连接配置；开始诊断时验证登录与连通性。" } };
        });
      }
      if (command === "diagnose_storage") {
        if (fixture.mode === "error") throw "Claude Code：请先在终端运行 claude auth login 完成登录";
        const path = snapshots.get(String(args.scanId))?.path ?? home;
        const result = { agent: args.agent, scanId: args.scanId, goal: args.goal ?? "overview", instructions: args.instructions ?? "", createdAt: 1794380000,
          summary: `由 ${args.agent} 生成的诊断：本次扫描的主要占用来自文档。`,
          findings: [{ title: "核查大文件的保留需求", kind: "review", reason: "该文档出现在本次占用排行中。",
            suggestion: "先打开核对用途，再决定是否归档。", items: [{ id: "item-1", name: "左栏文件.txt",
              path: `${path}/左栏文件.txt`, parent: path, size: 2048, files: 1, isDir: false }] }],
          limitations: ["没有读取内容，也没有校验重复。"] };
        if (fixture.mode === "pending" || fixture.mode === "late") return new Promise((resolve) => pending.set(String(args.id), { resolve, result }));
        return result;
      }
      if (command === "cancel_storage_diagnosis") {
        const id = String(args.id);
        if (fixture.mode !== "late") { pending.get(id)?.resolve(null); pending.delete(id); }
        return null;
      }
      return original(command, args);
    };
  }, { home, mode, missingAgents, configurationErrors });
  await page.getByRole("button", { name: "目录分析", exact: true }).click();
  await page.getByRole("tab", { name: "智能诊断", exact: true }).click();
}

test("diagnoses with all four agents, configures a missing command, and retains the report while locating files", async ({ page }) => {
  await mockStorageDiagnosis(page);
  const start = page.getByRole("button", { name: "开始诊断", exact: true });
  await expect(start).toBeEnabled();
  await expect(page.getByText("开始诊断后，将自动收集当前范围的目录信息。")).toBeVisible();
  await start.click();
  const report = page.getByLabel("智能诊断报告", { exact: true });
  await expect(report).toContainText("由 codex 生成的诊断");
  await report.getByRole("button", { name: "打开所在目录并选中" }).click();
  await expect(page.getByRole("option", { name: /左栏文件\.txt/, selected: true })).toBeVisible();
  await page.getByRole("button", { name: "目录分析", exact: true }).click();
  await expect(report).toContainText("由 codex 生成的诊断");
  await page.getByLabel("AI 工具", { exact: true }).selectOption("claude");
  await start.click();
  await expect(report).toContainText("由 claude 生成的诊断");
  await page.getByLabel("AI 工具", { exact: true }).selectOption("opencode");
  await expect(start).toBeDisabled();
  await expect(page.getByText("未找到 OpenCode，请安装后重新检测，或指定命令路径")).toBeVisible();
  await page.getByText("指定命令路径", { exact: true }).click();
  await page.getByLabel("OpenCode 可执行文件", { exact: true }).fill("/tmp/AI Tools/opencode");
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(start).toBeEnabled();
  await start.click();
  await expect(report).toContainText("由 opencode 生成的诊断");
  await page.getByLabel("AI 工具", { exact: true }).selectOption("deepseek");
  await expect(page.getByLabel("AI 连接配置")).toContainText("my-provider");
  await page.getByText("连接配置", { exact: true }).click();
  await page.getByLabel("配置方案", { exact: true }).selectOption("web");
  await start.click();
  await expect(report).toContainText("由 deepseek 生成的诊断");
  const calls = await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls);
  expect(calls.filter((call) => call.command === "diagnose_storage").map((call) => call.args.agent)).toEqual(["codex", "claude", "opencode", "deepseek"]);
  expect(calls.filter((call) => call.command === "diagnose_storage" && call.args.agent === "opencode").at(-1)?.args.executablePath).toBe("/tmp/AI Tools/opencode");
  expect(calls.filter((call) => call.command === "scan_storage")).toHaveLength(1);
  expect(calls.filter((call) => call.command === "diagnose_storage").at(-1)?.args.configurationProfile).toBe("web");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.getByRole("heading", { name: "智能诊断", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/filepace-diagnosis-${colorScheme}.png` });
  }
});

test("stops diagnosis, reports an agent error, and allows retry", async ({ page }) => {
  await mockStorageDiagnosis(page, "pending");
  await page.getByRole("tab", { name: "占用分析", exact: true }).click();
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await page.getByRole("tab", { name: "智能诊断", exact: true }).click();
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect(page.getByLabel("AI 工具", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "停止诊断", exact: true }).click();
  await expect(page.getByText("诊断已停止。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始诊断", exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.mode = "error"; });
  await page.getByLabel("AI 工具", { exact: true }).selectOption("claude");
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("claude auth login");
  await page.evaluate(() => { (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.mode = "success"; });
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect(page.getByLabel("智能诊断报告", { exact: true })).toContainText("由 claude 生成的诊断");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("keeps diagnosis tied to its original scope while browsing another analysis range", async ({ page }) => {
  await mockStorageDiagnosis(page, "late");
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止诊断", exact: true })).toBeVisible();
  await page.getByLabel("扫描范围", { exact: true }).selectOption("/Volumes/fixture");
  await expect(page.getByText(/正在后台诊断：/)).toContainText(home);
  await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.complete());
  await expect(page.getByRole("button", { name: "开始诊断", exact: true })).toBeEnabled();
  await expect(page.getByLabel("智能诊断报告", { exact: true })).toHaveCount(0);
  await page.getByLabel("扫描范围", { exact: true }).selectOption("");
  await expect(page.getByLabel("智能诊断报告", { exact: true }).getByRole("button", { name: /左栏文件\.txt/ })).toHaveAttribute("title", `${home}/左栏文件.txt`);
  const calls = await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls);
  expect(calls.filter((call) => call.command === "cancel_storage_diagnosis")).toHaveLength(0);
});

test("keeps diagnosis running while rescanning and closing directory analysis", async ({ page }) => {
  await mockStorageDiagnosis(page, "pending");
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止诊断", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "占用分析", exact: true }).click();
  await page.getByRole("button", { name: "重新扫描", exact: true }).click();
  await page.getByRole("tab", { name: "智能诊断", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止诊断", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回文件", exact: true }).click();
  await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.complete());
  await page.getByRole("button", { name: "目录分析", exact: true }).click();
  await expect(page.getByLabel("智能诊断报告", { exact: true })).toBeVisible();
  const calls = await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls);
  expect(calls.filter((call) => call.command === "cancel_storage_diagnosis")).toHaveLength(0);
  expect(calls.filter((call) => call.command === "scan_storage")).toHaveLength(2);
  expect(calls.find((call) => call.command === "diagnose_storage")?.args.scanId).toBe(calls.find((call) => call.command === "scan_storage")?.args.id);
});

test("sends preset directions and supplemental requirements and reuses the scan", async ({ page }) => {
  await mockStorageDiagnosis(page);
  const run = page.getByRole("button", { name: /^(开始|重新)诊断$/ });
  const requirements = page.getByLabel("补充要求（可选）", { exact: true });
  for (const [label, goal, instructions] of [
    ["清理空间", "cleanup", "保留照片和源码"],
    ["整理归档", "organize", "沿用现有项目目录"],
    ["了解目录", "understand", "只介绍构成，不建议改动"],
  ]) {
    await page.getByRole("radio", { name: new RegExp(`^${label}`) }).check();
    await requirements.fill(instructions);
    await run.click();
    await expect(page.getByLabel("智能诊断报告", { exact: true })).toContainText(`本次要求：${instructions}`);
    const last = await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls.filter((call) => call.command === "diagnose_storage").at(-1));
    expect(last?.args.goal).toBe(goal);
    expect(last?.args.instructions).toBe(instructions);
  }
  await page.getByRole("radio", { name: /^自定义/ }).check();
  const custom = page.getByLabel("自定义诊断方向", { exact: true });
  await custom.fill("  ");
  await expect(run).toBeDisabled();
  await custom.fill("  按客户梳理归档方向，保留原件与照片📷。  ");
  await run.click();
  await expect(page.getByLabel("智能诊断报告", { exact: true })).toContainText("本次要求：按客户梳理归档方向，保留原件与照片📷。");
  const calls = await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls);
  expect(calls.filter((call) => call.command === "scan_storage")).toHaveLength(1);
  expect(calls.filter((call) => call.command === "diagnose_storage").at(-1)?.args).toMatchObject({ goal: "custom", instructions: "按客户梳理归档方向，保留原件与照片📷。" });
});

test("waits for automatic scan completion and supports an explicit fresh scan", async ({ page }) => {
  await mockStorageDiagnosis(page);
  await page.evaluate(() => { (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.scanMode = "pending"; });
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止诊断", exact: true })).toBeVisible();
  await expect(page.getByText(/正在收集目录信息：/)).toBeVisible();
  let calls = await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls);
  expect(calls.filter((call) => call.command === "diagnose_storage")).toHaveLength(0);
  await page.evaluate(() => {
    const fixture = (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture;
    fixture.scanMode = "success";
    fixture.completeScans();
  });
  await expect(page.getByLabel("智能诊断报告", { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "重新扫描后诊断", exact: true }).check();
  await page.getByRole("button", { name: "重新诊断", exact: true }).click();
  await expect(page.getByLabel("智能诊断报告", { exact: true })).toBeVisible();
  calls = await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls);
  const scans = calls.filter((call) => call.command === "scan_storage");
  const diagnoses = calls.filter((call) => call.command === "diagnose_storage");
  expect(scans).toHaveLength(2);
  expect(diagnoses).toHaveLength(2);
  expect(diagnoses[0].args.scanId).toBe(scans[0].args.id);
  expect(diagnoses[1].args.scanId).toBe(scans[1].args.id);
  expect(diagnoses[0].args.scanId).not.toBe(diagnoses[1].args.scanId);
  expect(calls.filter((call) => call.command === "cancel_storage_diagnosis")).toHaveLength(0);
});

test("never calls an agent after stopping preparation, even if the scan completes late", async ({ page }) => {
  await mockStorageDiagnosis(page);
  await page.evaluate(() => { (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.scanMode = "late"; });
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await page.getByRole("button", { name: "停止诊断", exact: true }).click();
  await expect.poll(async () => page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls.filter((call) => call.command === "cancel_storage_scan").length)).toBe(1);
  await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.completeScans());
  await expect(page.getByText("诊断已停止。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始诊断", exact: true })).toBeEnabled();
  const calls = await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls);
  expect(calls.filter((call) => call.command === "diagnose_storage")).toHaveLength(0);
});

test("continues preparation after closing the panel and starts the agent on its original snapshot", async ({ page }) => {
  await mockStorageDiagnosis(page);
  await page.evaluate(() => { (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.scanMode = "late"; });
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止诊断", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回文件", exact: true }).click();
  await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.completeScans());
  await page.getByRole("button", { name: "目录分析", exact: true }).click();
  await expect(page.getByLabel("智能诊断报告", { exact: true })).toBeVisible();
  const calls = await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls);
  expect(calls.filter((call) => call.command === "cancel_storage_scan")).toHaveLength(0);
  expect(calls.filter((call) => call.command === "diagnose_storage")).toHaveLength(1);
  expect(calls.find((call) => call.command === "diagnose_storage")?.args.scanId).toBe(calls.find((call) => call.command === "scan_storage")?.args.id);
});

test("handles failed and empty automatic scans without spending agent usage", async ({ page }) => {
  await mockStorageDiagnosis(page);
  await page.evaluate(() => { (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.scanMode = "error"; });
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("无法读取扫描目录");
  await page.evaluate(() => { (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.scanMode = "empty"; });
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect(page.getByText("这个范围没有可分析的文件。", { exact: true })).toBeVisible();
  let calls = await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls);
  expect(calls.filter((call) => call.command === "diagnose_storage")).toHaveLength(0);
  await page.evaluate(() => { (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.scanMode = "success"; });
  await page.getByRole("checkbox", { name: "重新扫描后诊断", exact: true }).check();
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect(page.getByLabel("智能诊断报告", { exact: true })).toBeVisible();
  calls = await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls);
  expect(calls.filter((call) => call.command === "diagnose_storage")).toHaveLength(1);
});

async function mockDesktop(page: Page, defaultView: "list" | "columns", root = home, count = 0, files?: [string, boolean, boolean?][], persistSession = false) {
  await page.addInitScript(({ home, defaultView, count, version, files, persistSession }) => {
    localStorage.setItem("filepace-preferences", JSON.stringify({ defaultView }));
    const writes: { command: string; args: Record<string, unknown> }[] = [];
    const reads: string[] = [];
    const icons: Record<string, unknown>[] = [];
    const separator = home.includes("\\") ? "\\" : "/";
    const listings: Record<string, [string, boolean, boolean?][]> = {
      [home]: [["项目", true], ["左栏文件.txt", false], ["补充文档.DOCX", false]],
      [`${home}${separator}项目`]: [["归档", true], ["右栏文件.txt", false]],
    };
    let branch = [home, "项目", "归档"].join(separator);
    for (const folder of ["第三级", "第四级", "第五级", "第六级"]) {
      listings[branch] = [[folder, true]];
      branch += separator + folder;
    }
    listings[branch] = [["深层文件.txt", false]];
    if (count) listings[home] = Array.from({ length: count }, (_, i) => [`文件 ${(i * 7919) % count}.txt`, false]);
    if (files) listings[home] = files;
    let callback = 0;
    let revision = 0;
    let tasks: Task[] = [];
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { name: string; callback: number }>();
    const emit = (name: string, payload: unknown) => {
      for (const [id, listener] of listeners)
        if (listener.name === name) callbacks.get(listener.callback)?.({ event: name, id, payload });
    };
    Object.defineProperty(window, "filepaceTasks", {
      get: () => tasks,
      set: (next: Task[]) => {
        const removed = tasks.filter((old) => !next.some((task) => task.id === old.id)).map((task) => task.id);
        tasks = next;
        emit("task-activity", { revision: ++revision, updates: tasks, removed, undo: null });
      },
    });
    Object.assign(window, {
      isTauri: true,
      filepaceWrites: writes,
      filepaceReads: reads,
      filepaceIcons: icons,
      filepaceListings: listings,
      filepaceEmit: emit,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        transformCallback: (handler: (value: unknown) => void) => {
          callbacks.set(++callback, handler);
          return callback;
        },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (persistSession && command === "load_session") return JSON.parse(sessionStorage.getItem("filepace-fixture-session") ?? "null");
          if (persistSession && command === "save_session") sessionStorage.setItem("filepace-fixture-session", JSON.stringify(args.value));
          if (command === "places") return [{ name: "个人目录", path: home, kind: "favorite" }];
          if (command === "tasks") return { tasks, revision, undo: null };
          if (command === "error_log") return (window as Window & { filepaceErrors?: unknown[] }).filepaceErrors ?? [];
          if (command === "update_status") return { current: version, phase: "current" };
          if (command === "list_directory") {
            const requested = String(args.path);
            const path = separator === "\\" && requested.length > 3 && requested.endsWith(separator)
              ? requested.slice(0, -1)
              : requested;
            reads.push(path);
            return {
              path,
              parent: path.slice(0, path.lastIndexOf(separator)),
              entries: (listings[path] ?? []).map(([name, isDir, isLink = false]) => ({
                name, isDir, path: `${path}${separator}${name}`, isLink, size: 10, modified: 0, hidden: name.startsWith("."),
              })),
            };
          }
          if (command === "thumbnail") {
            icons.push(args);
            if (String(args.path).includes("Unavailable")) throw "系统文件图标不可用";
            if (String(args.path).includes("Corrupt")) return new Uint8Array([1, 2, 3]).buffer;
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 16;
            const context = canvas.getContext("2d")!;
            context.fillStyle = String(args.path).includes("Second") ? "#328361" : "#3178c6";
            context.fillRect(0, 0, 16, 16);
            return Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (c) => c.charCodeAt(0)).buffer;
          }
          if (command === "make_text_file") {
            writes.push({ command, args });
            const parent = String(args.parent);
            const name = String(args.name);
            const fileName = name.toLowerCase().endsWith(".txt") ? name : name + ".txt";
            const entries = listings[parent] ?? [];
            if (entries.some(([entry]) => entry === fileName)) throw "同名项目已存在，请换个名称";
            listings[parent] = [...entries, [fileName, false]];
            return null;
          }
          if (["start_task", "new_window", "start_file_drag", "clipboard_set", "task_action"].includes(command)) writes.push({ command, args });
          if (command === "start_task") return `task-${writes.length}`;
          if (command === "preview_batch_rename" || command === "batch_rename") {
            writes.push({ command, args });
            return command === "preview_batch_rename" ? "rename-preview" : "rename-task";
          }
          if (command === "plugin:event|listen") {
            listeners.set(++callback, { name: String(args.event), callback: Number(args.handler) });
            return callback;
          }
          if (command === "plugin:event|unlisten") listeners.delete(Number(args.eventId));
          return null;
        },
      },
    });
  }, { home: root, defaultView, count, version: packageInfo.version, files, persistSession });
}

test("starts in list view and keeps navigation and file actions in their existing menus", async ({ page }) => {
  await page.goto("/");
  const files = page.getByLabel("文件列表", { exact: true });
  await expect(files).toHaveClass(/^file-area list/);
  await expect(page.locator(".view-switch button").first()).toHaveAccessibleName("列表视图");
  for (const name of ["新建文件夹", "复制", "剪切", "粘贴", "移到回收站"]) {
    await expect(page.locator(".toolbar").getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  await expect(page.locator(".location-footer")).toHaveCount(0);
  const footer = page.locator(".statusbar");
  await expect(footer).toContainText("11 个项目");
  const file = files.getByRole("option", { name: /产品需求\.md/ });
  await file.click({ button: "right" });
  const menu = page.locator(".context-menu");
  for (const name of ["复制", "剪切", "移到回收站"]) {
    await expect(menu.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await file.click();
  await expect(footer).toContainText("已选择 1 项");
  await page.keyboard.press("ControlOrMeta+l");
  await expect(page.getByLabel("完整路径")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "新建标签", exact: true }).click();
  await expect(files).toHaveClass(/^file-area list/);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const view = page.getByRole("combobox", { name: "默认视图" });
  await expect(view).toHaveValue("list");
  await expect(view.locator("option")).toHaveText(["列表", "列视图", "图标"]);
});

test("distinguishes language icons and loads Windows shortcut icons with safe fallbacks in every view", async ({ page }) => {
  const root = "C:\\Icon Fixtures";
  await mockDesktop(page, "list", root, 0, [
    ["main.PY", false], ["Main.java", false], ["app.js", false], ["app.ts", false],
    ["App.tsx", false], ["run.ps1", false], ["run.cmd", false], ["Dockerfile", false],
    [".env.local", false], [".gitignore", false], ["First.lnk", false], ["Second.LNK", false],
    ["Unavailable.lnk", false], ["Corrupt.lnk", false], ["Site.url", false], ["Setup.msi", false],
    ["Folder.lnk", true], ["Folder link", true, true], ["unknown.xyz", false],
  ]);
  await page.goto("/");
  await page.getByRole("button", { name: "显示选项", exact: true }).click();
  await page.getByRole("button", { name: "显示隐藏文件", exact: true }).click();
  await page.keyboard.press("Escape");
  const files = page.getByLabel("文件列表", { exact: true });
  const kinds = { "main.PY": "python", "Main.java": "java", "app.js": "javascript", "app.ts": "typescript", "App.tsx": "tsx", "run.ps1": "powershell", "run.cmd": "batch", "Dockerfile": "docker", ".env.local": "env", ".gitignore": "git", "Folder.lnk": "folder", "unknown.xyz": "generic" };
  const sources = new Set<string>();
  for (const [name, kind] of Object.entries(kinds)) {
    const icon = files.getByRole("option").filter({ has: page.locator(".file-name", { hasText: name }) }).locator(`.entry-icon[data-file-kind="${kind}"] img`);
    await expect(icon).toBeVisible();
    sources.add((await icon.getAttribute("src"))!);
  }
  expect(sources.size).toBe(Object.keys(kinds).length);
  for (const label of ["图标视图", "列视图", "列表视图"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    for (const name of ["First.lnk", "Second.LNK", "Site.url", "Setup.msi"]) {
      const row = files.getByRole("option").filter({ has: page.locator(".file-name", { hasText: name }) });
      await row.scrollIntoViewIfNeeded();
      await expect(row.locator(".thumbnail img")).toHaveAttribute("src", /^blob:/);
      if (name !== "Setup.msi") await expect(row.locator(".shortcut-overlay")).toBeVisible();
    }
    for (const name of ["Unavailable.lnk", "Corrupt.lnk"]) {
      const row = files.getByRole("option").filter({ has: page.locator(".file-name", { hasText: name }) });
      await row.scrollIntoViewIfNeeded();
      await expect(row.locator(".entry-icon img")).toHaveAttribute("src", /^data:image\/svg\+xml,/);
      await expect(row.locator(".shortcut-overlay")).toBeVisible();
    }
    await files.evaluate((element) => { element.scrollTop = 0; });
    await expect(files.getByRole("option").filter({ hasText: "Folder link" }).locator(".shortcut-overlay")).toBeVisible();
  }
  const requests = await page.evaluate(() => (window as Window & { filepaceIcons: { path: string; nativeIcon: boolean }[] }).filepaceIcons);
  expect(requests.map((request) => request.path).sort()).toEqual(["First.lnk", "Second.LNK", "Unavailable.lnk", "Corrupt.lnk", "Site.url", "Setup.msi"].map((name) => `${root}\\${name}`).sort());
  expect(requests.every((request) => request.nativeIcon)).toBe(true);
  await page.getByRole("button", { name: "图标视图", exact: true }).click();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: `test-results/filepace-file-icons-${colorScheme}.png` });
  }
});

test("offers copy and move to the other pane in the file context menu", async ({ page }) => {
  await mockDesktop(page, "list");
  await page.goto("/");
  await page.getByRole("button", { name: "左右分栏", exact: true }).click();
  const left = page.getByRole("region", { name: "左栏", exact: true });
  const right = page.getByRole("region", { name: "右栏", exact: true });
  await right.getByRole("option", { name: /项目/ }).dblclick();
  const file = left.getByRole("option", { name: /左栏文件\.txt/ });
  const menu = page.locator(".context-menu");
  for (const [label, kind] of [["复制到另一栏", "copy"], ["移动到另一栏", "move"]]) {
    await file.click({ button: "right" });
    await menu.getByRole("button", { name: label, exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as Window & { filepaceWrites: { command: string; args: Record<string, unknown> }[] }).filepaceWrites.at(-1))).toEqual({
      command: "start_task", args: { kind, sources: [`${home}/左栏文件.txt`], destination: `${home}/项目` },
    });
  }
});

test("dismisses one interaction at a time while preserving the file selection", async ({ page }) => {
  await mockDesktop(page, "list");
  await page.goto("/");
  const files = page.getByLabel("文件列表", { exact: true });
  const file = files.getByRole("option", { name: /左栏文件\.txt/ });
  await file.click({ button: "right" });
  const buttons = page.locator(".context-menu").getByRole("button");
  await expect(buttons.nth(0)).toHaveAccessibleName("打开");
  await expect(buttons.nth(1)).toHaveAccessibleName("复制");
  await expect(buttons.nth(2)).toHaveAccessibleName("剪切");
  await page.keyboard.press("ArrowDown");
  await expect(buttons.nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(file).toHaveAttribute("aria-selected", "true");
  await expect(files).toBeFocused();
  await page.keyboard.press("F2");
  await expect(page.getByLabel("新文件名")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("新文件名")).toHaveCount(0);
  await expect(file).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ControlOrMeta+l");
  await expect(page.getByLabel("完整路径")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(file).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Space");
  await expect(page.getByLabel("关闭预览")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(file).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ControlOrMeta+Shift+n");
  await expect(page.getByRole("dialog", { name: "新建文件夹" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(file).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(files.getByRole("option", { selected: true })).toHaveCount(0);
});

test("explains filter counts, hidden-only folders and empty-folder actions", async ({ page }) => {
  await mockDesktop(page, "list", home, 0, [["visible.py", false], ["notes.txt", false], [".secret.py", false]]);
  await page.goto("/");
  const filter = page.getByLabel("筛选当前文件夹");
  const footer = page.locator(".statusbar");
  await expect(footer).toContainText("2 个项目");
  await expect(footer).toContainText("隐藏 1 项");
  await filter.fill("py");
  await expect(footer).toContainText("匹配 1 项，共 2 项");
  await expect(page.locator(".filter")).toHaveClass(/active/);
  await filter.press("Escape");
  await expect(filter).toHaveValue("");
  await filter.fill("secret");
  await expect(page.getByText("另有 1 个匹配项被隐藏，可以显示隐藏文件。")).toBeVisible();
  await page.getByLabel("文件列表", { exact: true }).getByRole("button", { name: "显示隐藏文件" }).click();
  await expect(footer).toContainText("匹配 1 项，共 3 项");
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await page.getByRole("button", { name: "显示选项", exact: true }).click();
  await page.getByRole("button", { name: "显示隐藏文件", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.evaluate((root) => {
    const app = window as Window & { filepaceListings: Record<string, [string, boolean][]>; filepaceEmit: (name: string, payload: unknown) => void };
    app.filepaceListings[root] = [[".only-hidden", false]];
    app.filepaceEmit("directory-changed", [root]);
  }, home);
  await expect(page.getByRole("heading", { name: "这个文件夹只有隐藏项目" })).toBeVisible();
  await page.getByRole("button", { name: "显示隐藏文件", exact: true }).click();
  await expect(page.getByRole("option", { name: /only-hidden/ })).toBeVisible();
  await page.getByRole("button", { name: "编辑路径", exact: true }).click();
  await page.getByLabel("完整路径").fill(home + "/empty");
  await page.getByLabel("完整路径").press("Enter");
  await expect(page.getByRole("heading", { name: "这个文件夹还是空的" })).toBeVisible();
  await page.getByLabel("文件列表", { exact: true }).getByRole("button", { name: "新建文件夹", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "新建文件夹" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("resizes aligned list columns and restores each tab's saved widths", async ({ page }) => {
  const longName = "A long Python file name that remains readable while browsing and renaming.py";
  await mockDesktop(page, "list", home, 0, [["项目", true], [longName, false], ["short.txt", false]], true);
  await page.goto("/");
  const name = page.getByRole("option", { name: new RegExp(longName.replaceAll(".", "\\.")) }).locator(".file-name");
  await expect(name.locator(".file-label")).toHaveAttribute("title", longName);
  await name.click();
  const original = (await name.boundingBox())!.width;
  const separator = page.getByRole("separator", { name: "调整名称列宽", exact: true });
  const bounds = (await separator.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 60, bounds.y + bounds.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await name.boundingBox())!.width).toBeGreaterThan(original + 50);
  const dateHeader = (await page.locator(".list-heading").nth(1).boundingBox())!;
  const date = (await name.locator("..").locator(".file-date").boundingBox())!;
  expect(date.x).toBeCloseTo(dateHeader.x, 0);
  const resized = (await name.boundingBox())!.width;
  const cancelBounds = (await separator.boundingBox())!;
  await page.mouse.move(cancelBounds.x + cancelBounds.width / 2, cancelBounds.y + cancelBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(cancelBounds.x + 20, cancelBounds.y + cancelBounds.height / 2);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await name.boundingBox())!.width - resized)).toBeLessThan(2);
  await expect(name.locator("..")).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "新建标签", exact: true }).click();
  await expect.poll(async () => (await name.boundingBox())!.width).toBeLessThan(original + 3);
  await page.getByRole("tab").first().click();
  await expect.poll(async () => (await name.boundingBox())!.width).toBeGreaterThan(resized - 3);
  await page.getByRole("option", { name: /项目/ }).dblclick();
  await expect(page.getByRole("option", { name: /右栏文件/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("filepace-fixture-session") ?? "{}").tabs?.[0]?.columnWidths?.length)).toBe(4);
  await page.reload();
  await expect(page.getByRole("option", { name: /右栏文件/ })).toBeVisible();
  await expect(page.locator(".file-pane")).toHaveAttribute("style", /--list-column-0/);
  await page.getByRole("button", { name: "显示选项", exact: true }).click();
  await page.getByRole("button", { name: "恢复默认列宽", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".file-pane")).not.toHaveAttribute("style", /--list-column-0/);
});

test("keeps compact controls, pane focus and display options usable in narrow windows", async ({ page }) => {
  await mockDesktop(page, "list");
  await page.goto("/");
  expect((await page.locator(".pane-controls").boundingBox())!.height).toBeLessThan(65);
  await page.getByRole("button", { name: "左右分栏", exact: true }).click();
  const left = page.getByRole("region", { name: "左栏", exact: true });
  const right = page.getByRole("region", { name: "右栏", exact: true });
  const first = left.getByRole("option", { name: /左栏文件/ });
  await first.click();
  await right.getByRole("option", { name: /补充文档/ }).click();
  await expect(left).not.toHaveClass(/focused/);
  await expect(right).toHaveClass(/focused/);
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".status-pane")).toContainText("右栏");
  await page.setViewportSize({ width: 800, height: 640 });
  for (const pane of [left, right]) {
    expect(await pane.locator(".pane-controls").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThan(2);
  }
  await right.getByRole("button", { name: "显示选项", exact: true }).click();
  const menu = page.getByRole("group", { name: "显示选项", exact: true });
  const menuBounds = (await menu.boundingBox())!;
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(800);
  expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(640);
  await menu.getByRole("group", { name: "排序依据" }).getByRole("button", { name: "大小", exact: true }).click();
  await menu.getByRole("combobox", { name: "列表分组" }).selectOption("kind");
  await page.keyboard.press("Escape");
  await expect(first).toHaveAttribute("aria-selected", "true");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: `test-results/filepace-compact-panes-${colorScheme}.png` });
  }
  await page.getByRole("button", { name: "合并分栏", exact: true }).click();
  await page.getByRole("button", { name: "编辑路径", exact: true }).click();
  await page.getByLabel("完整路径").fill("/Users/demo/a-very-long-parent-folder/another-long-parent/current-folder");
  await page.getByLabel("完整路径").press("Enter");
  await page.getByRole("button", { name: "上级目录", exact: true }).click();
  await page.getByRole("group", { name: "选择上级目录", exact: true }).getByRole("button", { name: "demo", exact: true }).click();
  await expect(page.getByRole("option", { name: /左栏文件/ })).toBeVisible();
});

test("keeps the ten-thousand-item grid bounded and reveals its last row", async ({ page }) => {
  await mockDesktop(page, "list", home, 10_000);
  await page.goto("/");
  const list = page.getByRole("listbox", { name: "文件列表" });
  await expect(list.getByRole("option", { name: /文件 0\.txt/ })).toBeVisible();
  await page.getByRole("button", { name: "图标视图", exact: true }).click();
  await expect(list).toHaveClass(/grid/);
  expect(await list.getByRole("option").count()).toBeLessThan(300);
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const last = list.getByRole("option", { name: "文件 9999.txt", exact: true });
  await expect(last).toBeVisible();
  await last.click();
  await page.keyboard.press("ArrowLeft");
  await expect(list.getByRole("option", { name: "文件 9998.txt", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("shares a directory snapshot and refreshes only the changed pane", async ({ page }) => {
  await mockDesktop(page, "list");
  await page.goto("/");
  await page.getByRole("button", { name: "左右分栏" }).click();
  const right = page.getByRole("region", { name: "右栏" });
  await expect(right.getByRole("option", { name: /项目/ })).toBeVisible();
  await right.getByRole("option", { name: /项目/ }).dblclick();
  await expect(right.getByRole("option", { name: /右栏文件/ })).toBeVisible();
  await page.evaluate((home) => {
    (window as Window & { filepaceEmit: (name: string, payload: unknown) => void }).filepaceEmit(
      "directory-changed", [home + "/项目/外部修改.txt"],
    );
  }, home);
  await expect.poll(() => page.evaluate(() => (window as Window & { filepaceReads: string[] }).filepaceReads)).toEqual(
    [home, home + "/项目", home + "/项目"],
  );
});

test("previews a batch rename and submits the validated token", async ({ page }) => {
  await mockDesktop(page, "list");
  await page.goto("/");
  const list = page.getByRole("listbox", { name: "文件列表" });
  await list.getByRole("option", { name: /左栏文件\.txt/ }).click();
  await list.getByRole("option", { name: /补充文档\.DOCX/ }).click({ modifiers: ["Shift"] });
  await page.keyboard.press("F2");
  const dialog = page.getByRole("dialog", { name: "批量重命名" });
  await dialog.getByLabel("规则").selectOption("affix");
  await dialog.getByRole("textbox", { name: "前缀", exact: true }).fill("整理-");
  await expect(dialog.getByRole("region", { name: "改名预览" })).toContainText("整理-左栏文件.txt");
  await dialog.getByRole("button", { name: "应用改名" }).click();
  await expect(dialog).toBeHidden();
  const writes = await page.evaluate(() => (window as Window & { filepaceWrites: unknown[] }).filepaceWrites);
  expect(writes).toContainEqual({ command: "batch_rename", args: { token: "rename-preview" } });
});

test("creates a text document in the directory whose blank area was right-clicked", async ({ page }) => {
  await mockDesktop(page, "columns");
  await page.goto("/");
  const files = page.getByLabel("文件列表", { exact: true });
  await files.getByRole("option", { name: "项目", exact: true }).click();
  await files.getByRole("option", { name: "归档", exact: true }).click();
  const parent = page.getByLabel("文件夹 · 项目", { exact: true });
  await parent.click({ button: "right", position: { x: 40, y: 200 } });
  const menu = page.locator(".context-menu");
  await expect(menu.getByRole("button", { name: "新建文件夹", exact: true })).toBeVisible();
  await menu.getByRole("button", { name: "新建文本文档", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "新建文本文档" });
  await expect(dialog).toContainText("创建于 项目");
  const name = dialog.getByRole("textbox", { name: "文档名称" });
  await expect(name).toHaveValue("新建文本文档.txt");
  await name.fill("右栏文件");
  await name.press("Enter");
  await expect(dialog.getByRole("alert")).toHaveText("同名项目已存在，请换个名称");
  await name.fill("整理记录");
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(files.getByRole("option", { name: "整理记录.txt", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "文件任务" })).toBeHidden();
  const writes = await page.evaluate(() => (window as Window & { filepaceWrites: unknown[] }).filepaceWrites);
  expect(writes).toEqual([
    { command: "make_text_file", args: { parent: `${home}/项目`, name: "右栏文件" } },
    { command: "make_text_file", args: { parent: `${home}/项目`, name: "整理记录" } },
  ]);
});

test("keeps routine file tasks quiet and shows failures without opening the panel", async ({ page }) => {
  await mockDesktop(page, "list");
  await page.goto("/");
  const panel = page.getByRole("region", { name: "文件任务" });
  const taskButton = page.getByRole("button", { name: "文件任务", exact: true });
  const source = `${home}/左栏文件.txt`;
  const task: Task = {
    id: "task-1", kind: "trash", sources: [source], destination: home,
    status: "running", current: source, completed: 0, bytes: 0, errors: [], conflict: null,
  };
  async function showTask(status: Task["status"], errors: string[] = []) {
    await page.evaluate((value) => {
      (window as Window & { filepaceTasks: Task[] }).filepaceTasks = [value];
    }, { ...task, status, errors, completed: status === "done" ? 1 : 0 });
  }
  async function trashFile() {
    await page.getByRole("option").filter({ hasText: "左栏文件.txt" }).click({ button: "right" });
    await page.locator(".context-menu").getByRole("button", { name: "移到回收站", exact: true }).click();
  }

  await trashFile();
  await showTask("running");
  await expect(page.getByRole("button", { name: "1 个文件任务" })).toBeVisible();
  await expect(panel).toBeHidden();
  await showTask("done");
  await expect(taskButton).toBeVisible();
  await expect(panel).toBeHidden();
  await expect(page.locator(".toast")).toBeHidden();
  await taskButton.click();
  await expect(panel.getByText("已完成", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "关闭任务面板" }).click();

  task.id = "task-2";
  await trashFile();
  await showTask("error", ["无法将此项目移到回收站"]);
  await expect(page.getByText("文件任务遇到问题，可在「文件任务」查看详情。")).toBeVisible();
  await expect(panel).toBeHidden();
  await taskButton.click();
  await panel.getByText("1 个问题").click();
  await expect(panel.getByText("无法将此项目移到回收站")).toBeVisible();
});

test("shows recent local errors and refreshes Windows error details in settings", async ({ page }) => {
  await mockDesktop(page, "list");
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "错误日志", exact: true }).click();
  await expect(page.getByText("还没有错误记录。")).toBeVisible();

  const path = String.raw`C:\Filepace Fixture\NUL`;
  await page.evaluate((record) => {
    (window as Window & { filepaceErrors: unknown[] }).filepaceErrors = [record];
  }, {
    time: 1_800_000_000, operation: "打开文件夹", step: "读取项目属性",
    path, osCode: 1, message: "函数不正确。",
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  const log = page.locator(".error-log");
  await expect(log).toContainText("打开文件夹 · 读取项目属性");
  await expect(log).toContainText(path);
  await expect(log).toContainText("OS Error 1");
  await expect(log).toContainText("函数不正确。");
});

test("keeps earlier columns when using Windows breadcrumbs", async ({ page }) => {
  await mockDesktop(page, "columns", "C:\\Filepace Fixture");
  await page.goto("/");
  const current = page.getByLabel("文件列表", { exact: true });
  await current.getByRole("option", { name: "项目", exact: true }).click();
  await current.getByRole("option", { name: "归档", exact: true }).click();
  await page.locator(".address").getByRole("button", { name: "项目", exact: true }).click();
  await expect(page.getByRole("region", { name: "当前目录列 · 项目", exact: true })).toBeVisible();
  const earlier = page.getByRole("region", { name: "目录列 · Filepace Fixture", exact: true });
  await expect(earlier.getByRole("option", { name: "项目", exact: true, selected: true })).toBeVisible();
});

test("compares conflict metadata and scopes apply-all to the current file task", async ({ page }) => {
  await mockDesktop(page, "list");
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "目标位置已有同名项目" });
  const sourceTime = 1_700_000_000;
  const targetTime = 1_800_000_000;
  async function showConflict(id: string) {
    const path = `${home}/项目/${id}.txt`;
    const source = `${home}/${id}.txt`;
    await page.evaluate((task) => {
      (window as Window & { filepaceTasks: Task[] }).filepaceTasks = [task];
    }, {
      id, kind: "copy", sources: [source], destination: `${home}/项目`, status: "conflict",
      current: source, completed: 0, bytes: 0, errors: [],
      conflict: {
        id: `conflict-${id}`,
        source: { path: source, isDir: false, size: 12, modified: sourceTime },
        destination: { path, isDir: false, size: 1024, modified: targetTime },
      },
    });
    await expect(dialog.getByText(path, { exact: true })).toBeVisible();
  }

  await showConflict("first");
  const source = dialog.getByRole("region", { name: "源项目" });
  const target = dialog.getByRole("region", { name: "目标项目" });
  const dates = await page.evaluate((times) => times.map((time) => new Date(time * 1000).toLocaleString("zh-CN")), [sourceTime, targetTime]);
  await expect(source.getByText(`${home}/first.txt`, { exact: true })).toBeVisible();
  await expect(source).toContainText("12 B");
  await expect(source).toContainText(dates[0]);
  await expect(target).toContainText("1.0 KB");
  await expect(target).toContainText(dates[1]);
  const apply = dialog.getByRole("checkbox", { name: "应用到本次任务的后续冲突" });
  const skip = dialog.getByRole("button", { name: "跳过", exact: true });
  await apply.check();
  await skip.click();
  await showConflict("second");
  await expect(apply).not.toBeChecked();
  await skip.click();
  const writes = await page.evaluate(() => (window as Window & { filepaceWrites: unknown[] }).filepaceWrites);
  expect(writes).toEqual([
    { command: "task_action", args: { id: "first", conflictId: "conflict-first", decision: "skip", applyAll: true } },
    { command: "task_action", args: { id: "second", conflictId: "conflict-second", decision: "skip", applyAll: false } },
  ]);
});

test("scrolls to hidden columns while dragging and drops on the visible destination", async ({ page }) => {
  await mockDesktop(page, "columns");
  await page.goto("/");
  const current = page.getByLabel("文件列表", { exact: true });
  const folders = ["项目", "归档", "第三级", "第四级", "第五级", "第六级"];
  for (const folder of folders) {
    await current.getByRole("option", { name: folder, exact: true }).click();
  }
  const strip = page.getByLabel("列视图目录", { exact: true });
  const view = (await strip.boundingBox())!;
  const deep = current.getByRole("option", { name: "深层文件.txt" });
  await expect(deep).toBeInViewport();
  const from = (await deep.boundingBox())!;
  expect(await strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(200);
  await page.mouse.move(from.x + 25, from.y + 14);
  await page.mouse.down();
  await page.mouse.move(view.x + 8, view.y + 150, { steps: 10 });
  await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBe(0);
  await expect(page.getByRole("status").filter({ hasText: "移动到 demo" })).toBeVisible();
  await page.mouse.up();

  const rootFile = page.getByRole("region", { name: "目录列 · demo", exact: true })
    .getByRole("option", { name: "左栏文件.txt" });
  const root = (await rootFile.boundingBox())!;
  await page.mouse.move(root.x + 25, root.y + 14);
  await page.mouse.down();
  await page.mouse.move(view.x + view.width - 8, view.y + 150, { steps: 10 });
  await expect.poll(() => strip.evaluate((el) => el.scrollWidth - el.clientWidth - el.scrollLeft)).toBeLessThan(2);
  const copyKey = await page.evaluate(() => navigator.platform.includes("Mac")) ? "Alt" : "Control";
  await page.keyboard.down(copyKey);
  await expect(page.getByRole("status").filter({ hasText: "复制到 第六级" })).toBeVisible();
  await page.mouse.up();
  await page.keyboard.up(copyKey);

  const deepPath = [home, ...folders].join("/");
  expect(await page.evaluate(() => (window as Window & { filepaceWrites: unknown[] }).filepaceWrites)).toEqual([
    { command: "start_task", args: { kind: "move", sources: [`${deepPath}/深层文件.txt`], destination: home } },
    { command: "start_task", args: { kind: "copy", sources: [`${home}/左栏文件.txt`], destination: deepPath } },
  ]);
});

test("moves and copies files between panes and keeps both tabs when merging", async ({ page }) => {
  await mockDesktop(page, "list");
  await page.goto("/");
  const nativeRow = page.getByRole("option", { name: /补充文档/ });
  await expect(nativeRow.locator('[data-file-kind="word"]')).toBeVisible();
  const nativeSource = (await nativeRow.boundingBox())!;
  await page.mouse.move(nativeSource.x + 26, nativeSource.y + 17);
  await page.mouse.down();
  await page.mouse.move(-12, nativeSource.y + 17, { steps: 12 });
  await page.mouse.up();
  const native = await page.evaluate(() => {
    const { command, args } = (window as Window & {
      filepaceWrites: { command: string; args: { paths: string[]; previewImage: number[] } }[];
    }).filepaceWrites.shift()!;
    return { command, paths: args.paths, header: args.previewImage?.slice(0, 8) };
  });
  expect(native).toEqual({
    command: "start_file_drag",
    paths: [`${home}/补充文档.DOCX`],
    header: [137, 80, 78, 71, 13, 10, 26, 10],
  });

  await page.getByRole("button", { name: "左右分栏" }).click();
  const left = page.getByRole("region", { name: "左栏" });
  const right = page.getByRole("region", { name: "右栏" });
  await right.getByRole("option", { name: /项目/ }).dblclick();
  await expect(left.getByRole("option", { name: /左栏文件/ })).toBeVisible();
  await expect(right.getByRole("option", { name: /右栏文件/ })).toBeVisible();
  await expect(right).toHaveClass(/focused/);
  await expect(left.locator(".pane-focus-badge")).toHaveCount(0);
  await expect(right.locator(".pane-focus-badge")).toHaveCount(0);
  await left.getByRole("button", { name: "显示选项" }).click();
  await page.getByRole("button", { name: "小图标", exact: true }).click();
  await page.keyboard.press("Escape");
  await right.getByRole("button", { name: "显示选项" }).click();
  await page.getByRole("button", { name: "大图标", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(left.getByLabel("文件列表")).toHaveAttribute("data-grid-size", "small");
  await expect(right.getByLabel("文件列表")).toHaveAttribute("data-grid-size", "large");

  const leftRow = left.getByRole("option", { name: /左栏文件/ });
  await leftRow.click();
  await left.getByRole("option", { name: /补充文档/ }).click({ modifiers: ["ControlOrMeta"] });
  const leftFile = (await leftRow.boundingBox())!;
  const archive = (await right.getByRole("option", { name: /归档/ }).boundingBox())!;
  const dragPreview = page.locator(".drag-preview");
  await page.mouse.move(leftFile.x + 25, leftFile.y + 18);
  await page.mouse.down();
  await expect(dragPreview).toHaveCount(0);
  await page.mouse.move(leftFile.x + 42, leftFile.y + 20);
  await expect(dragPreview).toContainText("左栏文件.txt");
  await expect(dragPreview).toContainText("2 项");
  await expect(leftRow).toHaveClass(/drag-source/);
  const start = (await dragPreview.boundingBox())!;
  await page.mouse.move(archive.x + 25, archive.y + 18, { steps: 12 });
  await expect(right.getByRole("status")).toContainText("移动到 归档");
  await expect(dragPreview).toContainText("移动");
  expect((await dragPreview.boundingBox())!.x).toBeGreaterThan(start.x);
  await page.mouse.up();
  await expect(dragPreview).toHaveCount(0);
  await expect(leftRow).not.toHaveClass(/drag-source/);

  const rightFile = (await right.getByRole("option", { name: /右栏文件/ }).boundingBox())!;
  const leftList = (await left.getByLabel("文件列表").boundingBox())!;
  const copyKey = (await page.evaluate(() => navigator.platform.includes("Mac"))) ? "Alt" : "Control";
  await page.mouse.move(rightFile.x + 25, rightFile.y + 18);
  await page.mouse.down();
  await page.mouse.move(leftList.x + 45, leftList.y + leftList.height - 35, { steps: 12 });
  await expect(left.getByRole("status")).toContainText("移动到 demo");
  await page.keyboard.down(copyKey);
  await expect(left.getByRole("status")).toContainText("复制到 demo");
  await expect(dragPreview).toContainText("复制");
  await page.mouse.up();
  await page.keyboard.up(copyKey);

  await page.mouse.move(rightFile.x + 25, rightFile.y + 18);
  await page.mouse.down();
  await page.mouse.move(leftList.x + 45, leftList.y + leftList.height - 35, { steps: 12 });
  await expect(dragPreview).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dragPreview).toHaveCount(0);
  await page.mouse.up();

  const writes = await page.evaluate(() => (window as Window & { filepaceWrites: unknown[] }).filepaceWrites);
  expect(writes).toEqual([
    { command: "start_task", args: { kind: "move", sources: [`${home}/左栏文件.txt`, `${home}/补充文档.DOCX`], destination: `${home}/项目/归档` } },
    { command: "start_task", args: { kind: "copy", sources: [`${home}/项目/右栏文件.txt`], destination: home } },
  ]);

  await page.getByRole("button", { name: "合并分栏" }).click();
  await expect(page.getByRole("region", { name: "右栏" })).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "新建窗口", exact: true })).toHaveCount(0);
  await page.keyboard.press("Control+n");
  await expect.poll(() => page.evaluate(() => (
    window as Window & { filepaceWrites: { command: string }[] }
  ).filepaceWrites.at(-1)?.command)).toBe("new_window");
});

test("moves between columns of one pane and copies a marquee selection", async ({ page }) => {
  await mockDesktop(page, "columns");
  await page.goto("/");
  await expect(page.locator(".titlebar")).not.toContainText("Filepace");
  await page.getByRole("option", { name: "项目" }).click();
  const ancestor = page.getByLabel("文件夹 · demo", { exact: true });
  const current = page.getByLabel("文件列表", { exact: true });
  const source = ancestor.getByRole("option", { name: "左栏文件.txt" });
  const copySource = current.getByRole("option", { name: "右栏文件.txt" });
  await expect(copySource).toBeVisible();
  const from = (await source.boundingBox())!;
  const other = (await ancestor.getByRole("option", { name: "补充文档.DOCX" }).boundingBox())!;
  const to = (await current.boundingBox())!;
  const earlier = (await ancestor.boundingBox())!;
  const second = (await copySource.boundingBox())!;
  const copyKey = await page.evaluate(() => navigator.platform.includes("Mac")) ? "Alt" : "Control";

  await page.mouse.move(from.x + 25, from.y + 16);
  await page.mouse.down();
  await page.mouse.move(to.x + 40, to.y + 105, { steps: 12 });
  await expect(page.getByRole("status").filter({ hasText: "移动到 项目" })).toBeVisible();
  await page.mouse.up();

  await page.mouse.move(second.x + 25, second.y + 16);
  await page.mouse.down();
  await page.mouse.move(earlier.x + 40, earlier.y + 130, { steps: 12 });
  await page.keyboard.down(copyKey);
  await expect(page.getByRole("status").filter({ hasText: "复制到 demo" })).toBeVisible();
  await page.mouse.up();
  await page.keyboard.up(copyKey);

  await page.mouse.move(earlier.x + earlier.width - 5, earlier.y + 114);
  await page.mouse.down();
  await page.mouse.move(from.x + 16, Math.min(from.y, other.y) + 3, { steps: 12 });
  await expect(page.locator(".selection-marquee")).toBeVisible();
  await expect(ancestor.getByRole("option", { selected: true })).toHaveCount(2);
  await page.mouse.up();
  await expect(page.locator(".selection-marquee")).toHaveCount(0);
  await expect(current.getByRole("option", { selected: true })).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+c");
  expect(await page.evaluate(() => (window as Window & { filepaceWrites: unknown[] }).filepaceWrites)).toEqual([
    { command: "start_task", args: { kind: "move", sources: [`${home}/左栏文件.txt`], destination: `${home}/项目` } },
    { command: "start_task", args: { kind: "copy", sources: [`${home}/项目/右栏文件.txt`], destination: home } },
    { command: "clipboard_set", args: { paths: [`${home}/补充文档.DOCX`, `${home}/左栏文件.txt`], cut: false } },
  ]);
});

test("marquee selects folders and supports keyboard ranges and cancellation", async ({ page }) => {
  await page.goto("/");
  const files = page.getByLabel("文件列表", { exact: true });
  await page.getByRole("button", { name: "列表视图", exact: true }).click();
  const rows = files.getByRole("option");
  const selected = files.getByRole("option", { selected: true });
  await rows.nth(2).click();
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(selected).toHaveCount(3);
  await page.keyboard.press("Shift+ArrowDown");
  await expect(selected).toHaveCount(2);
  await page.keyboard.press("Escape");

  const list = (await files.boundingBox())!;
  const first = (await rows.first().boundingBox())!;
  const third = (await rows.nth(2).boundingBox())!;
  await page.mouse.move(list.x + await files.evaluate((element) => element.clientWidth) - 5, first.y + 2);
  await page.mouse.down();
  await page.mouse.move(first.x + 20, third.y + 10, { steps: 12 });
  await expect(selected).toHaveCount(3);
  await page.mouse.up();
  await expect(selected).toHaveCount(3);

  await page.getByRole("button", { name: "图标视图", exact: true }).click();
  await page.keyboard.press("Escape");
  const grid = (await files.boundingBox())!;
  const tile = (await rows.nth(2).boundingBox())!;
  await page.mouse.move(grid.x + 5, grid.y + 5);
  await page.mouse.down();
  await page.mouse.move(tile.x + 10, tile.y + 45, { steps: 12 });
  await expect(selected).toHaveCount(3);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(selected).toHaveCount(0);
  await page.mouse.move(grid.x + 5, grid.y + 5);
  await page.mouse.down();
  await page.mouse.move(tile.x + 10, tile.y + 45, { steps: 12 });
  await page.mouse.up();
  await expect(selected).toHaveCount(3);
  await page.keyboard.press("ArrowRight");
  await expect(rows.nth(3)).toHaveAttribute("aria-selected", "true");
  await expect(selected).toHaveCount(1);
});

test("remembers sidebar groups and edits common locations while retaining saved favorites", async ({ page, context }) => {
  await page.addInitScript(() => {
    localStorage.setItem("filepace-favorites", JSON.stringify(["/Users/demo/设计素材"]));
  });
  await page.goto("/");
  const common = page.getByRole("region", { name: "常用位置" });
  const favorites = page.getByRole("region", { name: "收藏目录" });
  const menu = page.locator(".context-menu");
  const commonToggle = common.getByRole("button", { name: "常用位置", exact: true });
  const favoritesToggle = favorites.getByRole("button", { name: "收藏目录", exact: true });
  await expect(favorites.getByRole("button", { name: "设计素材" })).toBeVisible();
  await page.getByRole("option", { name: "项目" }).click({ button: "right" });
  await menu.getByRole("button", { name: "添加到常用位置", exact: true }).click();
  const project = common.getByRole("button", { name: "项目" });
  await expect(common.locator(".place").last()).toHaveText("项目");
  await project.click({ button: "right" });
  await menu.getByRole("button", { name: "上移", exact: true }).click();
  await expect(common.locator(".place").last()).toHaveText("图片");
  await common.getByRole("button", { name: "下载", exact: true }).click({ button: "right" });
  await menu.getByRole("button", { name: "从常用位置移除" }).click();
  await expect(common.getByRole("button", { name: "下载", exact: true })).toHaveCount(0);
  await commonToggle.press("Enter");
  await favoritesToggle.press("Space");
  await expect(commonToggle).toHaveAttribute("aria-expanded", "false");
  await expect(favoritesToggle).toHaveAttribute("aria-expanded", "false");
  await expect(project).toBeHidden();
  await page.reload();
  await expect(commonToggle).toHaveAttribute("aria-expanded", "false");
  await expect(favoritesToggle).toHaveAttribute("aria-expanded", "false");

  const secondWindow = await context.newPage();
  await secondWindow.goto("/");
  await secondWindow.getByRole("button", { name: "常用位置", exact: true }).click();
  await expect(commonToggle).toHaveAttribute("aria-expanded", "true");
  await expect(common.locator(".place").nth(3)).toHaveText("项目");
  await expect(common.getByRole("button", { name: "下载", exact: true })).toHaveCount(0);
  await favoritesToggle.click();
  await expect(favorites.getByRole("button", { name: "设计素材" })).toBeVisible();
  await secondWindow.evaluate(() => {
    localStorage.setItem("filepace-favorites", JSON.stringify(
      Array.from({ length: 30 }, (_, index) => `/Users/demo/目录 ${index + 1}`),
    ));
  });
  await expect(favorites.getByRole("button", { name: "目录 30", exact: true })).toHaveCount(1);
  const settings = page.getByRole("complementary", { name: "位置侧栏" }).getByRole("button", { name: "设置", exact: true });
  await expect(settings).toBeInViewport({ ratio: 1 });
  await settings.click();
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await secondWindow.close();
});

test("opens directory analysis from volumes and folder menus without changing pane selection", async ({ page }) => {
  await page.goto("/");
  const project = page.getByRole("option", { name: /^项目/ });
  await project.click({ button: "right" });
  await page.getByRole("button", { name: "分析此目录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "目录分析", exact: true })).toBeVisible();
  await expect(page.getByLabel("扫描范围", { exact: true })).toHaveValue("/Users/demo/项目");
  await expect(page.getByRole("tab", { name: "占用分析" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(project).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "存储概览", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toHaveCount(0);
  await page.getByRole("button", { name: "分析此磁盘", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "目录分析", exact: true })).toBeVisible();
  await expect(page.getByLabel("扫描范围", { exact: true })).toHaveValue("/");
});

test("keeps diagnosis running across analysis tabs and volume overview", async ({ page }) => {
  await mockStorageDiagnosis(page, "pending");
  await page.getByRole("button", { name: "开始诊断", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止诊断", exact: true })).toBeVisible();
  const usage = page.getByRole("tab", { name: "占用分析", exact: true });
  await usage.click();
  await expect(page.getByRole("heading", { name: "文件分类", exact: true })).toBeVisible();
  await usage.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "智能诊断", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "停止诊断", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls.filter((call) => call.command === "cancel_storage_diagnosis"))).toHaveLength(0);
  await page.getByRole("button", { name: "存储概览", exact: true }).click();
  await page.getByRole("button", { name: "目录分析", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止诊断", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls.filter((call) => call.command === "cancel_storage_diagnosis"))).toHaveLength(0);
});

test("lays out directory analysis in light, dark and narrow windows", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "目录分析", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "test-results/directory-analysis-empty.png" });
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await expect(page.getByRole("img", { name: /文件分类占用/ })).toBeVisible();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: `test-results/directory-analysis-${colorScheme}.png` });
  }
  await page.setViewportSize({ width: 800, height: 780 });
  const analysis = page.getByRole("region", { name: "目录分析", exact: true });
  expect(await analysis.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/directory-analysis-narrow.png" });
  await page.getByRole("tab", { name: "智能诊断", exact: true }).click();
  expect(await analysis.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "开始诊断", exact: true })).toBeDisabled();
  await page.screenshot({ path: "test-results/directory-diagnosis-narrow.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator(".app")).toHaveCount(1);
  await page.screenshot({ path: "test-results/directory-diagnosis-light.png" });
});

test("cancels the previous manual scan when entering analysis for another volume", async ({ page }) => {
  await mockStorageDiagnosis(page);
  await page.evaluate(() => { (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.scanMode = "late"; });
  await page.getByRole("tab", { name: "占用分析", exact: true }).click();
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止扫描", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "存储概览", exact: true }).click();
  await page.getByRole("button", { name: "分析此磁盘", exact: true }).click();
  await expect(page.getByLabel("扫描范围", { exact: true })).toHaveValue("/Volumes/fixture");
  await expect.poll(() => page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls.filter((call) => call.command === "cancel_storage_scan").length)).toBe(1);
  await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.completeScans());
  await expect(page.getByRole("button", { name: "开始扫描", exact: true })).toBeEnabled();
  await expect(page.getByRole("img", { name: /文件分类占用/ })).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.scanMode = "success"; });
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await expect(page.getByRole("img", { name: /文件分类占用/ })).toBeVisible();
  const scans = await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls.filter((call) => call.command === "scan_storage"));
  expect(scans.map((scan) => scan.args.path)).toEqual([home, "/Volumes/fixture"]);
});


test("keeps rescan secondary and inside Usage, with a visible diagnosis next step", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "目录分析", exact: true }).click();
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新扫描", exact: true })).toHaveClass("storage-secondary");
  await expect(page.getByText(/^扫描于 /)).toBeVisible();
  await page.getByRole("button", { name: "智能诊断", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新扫描", exact: true })).toBeHidden();
  await expect(page.getByLabel("扫描范围", { exact: true })).toBeVisible();
});

test("blocks invalid connection settings without sending the scan to an agent", async ({ page }) => {
  await mockStorageDiagnosis(page);
  await page.evaluate(() => { (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.configurationError = "配置格式有误，请修复后重新检测"; });
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("配置格式有误");
  await expect(page.getByRole("region", { name: "AI 工具提示" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "开始诊断", exact: true })).toBeDisabled();
  const calls = await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls);
  expect(calls.filter((call) => call.command === "diagnose_storage")).toHaveLength(0);
});


test("selects an installed tool when the initial default is missing", async ({ page }) => {
  await mockStorageDiagnosis(page, "success", ["codex"]);
  await expect(page.getByLabel("AI 工具", { exact: true }).locator("option")).toHaveText([
    "Claude Code", "DeepSeek Harness", "Codex · 未找到", "OpenCode · 未找到",
  ]);
  await expect(page.getByLabel("AI 工具", { exact: true })).toHaveValue("claude");
  await expect(page.getByText("已自动选择本机检测到的 Claude Code。尚未验证登录与连接。")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始诊断", exact: true })).toBeEnabled();
  await page.getByLabel("AI 工具", { exact: true }).selectOption("deepseek");
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(page.getByLabel("AI 工具", { exact: true })).toHaveValue("deepseek");
});

test("ranks tools with valid configuration before tools that need setup", async ({ page }) => {
  await mockStorageDiagnosis(page, "success", [], { codex: "配置格式无效" });
  const agent = page.getByLabel("AI 工具", { exact: true });
  await expect(agent).toHaveValue("claude");
  await expect(agent.locator("option")).toHaveText([
    "Claude Code", "DeepSeek Harness", "Codex · 配置需要处理", "OpenCode · 未找到",
  ]);
  await agent.selectOption("codex");
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(agent).toBeEnabled();
  await expect(agent).toHaveValue("codex");
  await expect(page.getByRole("alert")).toContainText("配置格式无效");
  await expect(page.getByRole("button", { name: "开始诊断", exact: true })).toBeDisabled();
});

test("retains a saved installed tool instead of choosing the first option", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("filepace-diagnosis", JSON.stringify({ agent: "deepseek", paths: {}, profiles: {} }));
  });
  await mockStorageDiagnosis(page, "success", ["codex"]);
  const agent = page.getByLabel("AI 工具", { exact: true });
  await expect(agent).toBeEnabled();
  await expect(agent).toHaveValue("deepseek");
  await expect(agent.locator("option").first()).toHaveText("Claude Code");
  await expect(page.getByRole("button", { name: "开始诊断", exact: true })).toBeEnabled();
});

test("keeps missing tools configurable and blocks diagnosis when none are installed", async ({ page }) => {
  await mockStorageDiagnosis(page, "success", ["codex", "claude", "opencode", "deepseek"]);
  const agent = page.getByLabel("AI 工具", { exact: true });
  await expect(agent.locator("option")).toHaveText([
    "Codex · 未找到", "Claude Code · 未找到", "OpenCode · 未找到", "DeepSeek Harness · 未找到",
  ]);
  await agent.selectOption("claude");
  await expect(page.getByRole("button", { name: "开始诊断", exact: true })).toBeDisabled();
  await page.getByText("指定命令路径", { exact: true }).click();
  await expect(page.getByLabel("Claude Code 可执行文件", { exact: true })).toBeEnabled();
  const notice = page.getByRole("region", { name: "AI 工具提示" });
  await expect(notice).toContainText("未检测到 AI 工具");
  await expect(notice).toContainText("占用分析不依赖 AI 工具，可正常使用。");
  await page.setViewportSize({ width: 800, height: 780 });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(notice).toBeVisible();
    await page.screenshot({ path: `test-results/filepace-no-ai-${colorScheme}.png` });
  }
  await notice.getByRole("button", { name: "查看占用分析" }).click();
  const usage = page.getByRole("tab", { name: "占用分析", exact: true });
  await expect(usage).toHaveAttribute("aria-selected", "true");
  await expect(usage).toBeFocused();
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await expect(page.getByRole("img", { name: /文件分类占用/ })).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "占用分析", exact: true }).getByText("左栏文件.txt", { exact: true })).toBeVisible();
  const calls = await page.evaluate(() => (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.calls);
  expect(calls.filter((call) => call.command === "scan_storage")).toHaveLength(1);
  expect(calls.filter((call) => call.command === "diagnose_storage")).toHaveLength(0);
  await page.getByRole("tab", { name: "智能诊断", exact: true }).click();
  await expect(notice).toBeVisible();
  await page.evaluate(() => { (window as unknown as { filepaceDiagnosisFixture: DiagnosisFixture }).filepaceDiagnosisFixture.missingAgents = ["codex", "opencode", "deepseek"]; });
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(page.getByRole("button", { name: "开始诊断", exact: true })).toBeEnabled();
  await expect(notice).toHaveCount(0);
});


test("shows interrupted transfer locations once without retrying or deleting files", async ({ page }) => {
  await mockDesktop(page, "list");
  await page.goto("/");
  await page.evaluate((home) => {
    (window as Window & { filepaceTasks: Task[] }).filepaceTasks = [{
      id: "recovery-fixture", kind: "move", sources: [`${home}/source.txt`], destination: home,
      status: "error", current: `${home}/target.txt`, phase: "中断后待核对", completed: 0,
      bytes: 0, errors: ["上次文件操作中断", `源位置：${home}/source.txt`, `目标位置：${home}/target.txt`], conflict: null,
    }];
  }, home);
  const panel = page.getByRole("region", { name: "文件任务" });
  await expect(panel).toBeVisible();
  await panel.getByText("3 个问题").click();
  await expect(panel.getByText(`源位置：${home}/source.txt`, { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "重试失败项目" })).toHaveCount(0);
  await panel.getByRole("button", { name: "关闭任务面板" }).click();
  await page.getByRole("button", { name: "文件任务", exact: true }).click();
  await panel.getByRole("button", { name: "打开目标位置" }).click();
  await expect(panel).toBeHidden();
  const writes = await page.evaluate(() => (window as Window & { filepaceWrites: { command: string }[] }).filepaceWrites);
  expect(writes.filter((write) => ["retry_task", "start_task", "task_action"].includes(write.command))).toEqual([]);
});
