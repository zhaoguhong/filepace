import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";

assert.equal(process.platform, "win32");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Run only on a disposable Windows runner");
const root = await mkdtemp(join(process.env.RUNNER_TEMP, "filepace-smoke-"));
const source = join(root, "整理前");
const destination = join(root, "整理后");
const nested = join(source, "图片");
await mkdir(nested, { recursive: true });
await mkdir(destination);
const moving = "move.docx";
const copying = "copy.txt";
const bytes = Buffer.from("Filepace installer fixture\n");
await writeFile(join(source, moving), bytes);
await writeFile(join(source, copying), bytes);
await writeFile(join(nested, "large.PNG"), Buffer.alloc(4096));

const config = join(process.env.APPDATA, "app.filepace.desktop");
const appDirectory = join(process.env.LOCALAPPDATA, "Filepace");
const executable = join(appDirectory, "filepace.exe");
const uninstall = join(appDirectory, "uninstall.exe");
await assert.rejects(stat(executable), { code: "ENOENT" });
const bundle = join("src-tauri", "target", "release", "bundle", "nsis");
const installers = (await readdir(bundle)).filter((name) => name.endsWith("-setup.exe"));
assert.equal(installers.length, 1);
const pane = (id, path) => ({
  active: id,
  tabs: [{ id, path, history: [path], index: 0, query: "", view: "list",
    sort: "name", descending: false, selected: [], scroll: 0 }],
});
await mkdir(config, { recursive: true });
await writeFile(join(config, "sessions.json"), JSON.stringify({
  main: { ...pane("source", source), right: pane("destination", destination), focused: "left" },
}), { flag: "wx" });

function closeNativeDialog(kind) {
  const condition = kind === "properties"
    ? '$window.Current.Name -like "*copy.txt*Properties*"'
    : '$window.Current.Name -match "Open With|Select an app" -or $processName -eq "OpenWith"';
  execFileSync("powershell.exe", ["-NoProfile", "-Command", `
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $deadline = (Get-Date).AddSeconds(15)
    do {
      $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($window in $windows) {
        $processName = (Get-Process -Id $window.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName
        if (${condition}) {
          Write-Output "Observed native window: $($window.Current.Name) ($processName)"
          $pattern = $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
          $pattern.Close()
          exit 0
        }
      }
      Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    $windows | ForEach-Object { Write-Output "Window: $($_.Current.Name)" }
    exit 1
  `], { stdio: "inherit", timeout: 25000, windowsHide: true });
}

let browser;
let app;
try {
  execFileSync(join(bundle, installers[0]), ["/S"], { timeout: 120000, windowsHide: true });
  await stat(executable);
  const endpoint = "http://127.0.0.1:9222";
  app = spawn(executable, [], {
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: join(root, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1" },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${endpoint}/json/version`)).ok) break;
    } catch {
      // The WebView2 debugging endpoint starts after the app window.
    }
    assert.equal(app.exitCode, null, "Filepace exited before its WebView2 was ready");
    await setTimeout(300);
  }
  browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
  const page = browser.contexts()[0].pages()[0];
  assert.ok(page, "The installed app opened a WebView2 page");
  await page.getByRole("button", { name: "存储概览", exact: true }).click();
  await expect(page.getByRole("meter").first()).toBeVisible();
  await page.getByRole("button", { name: "开始扫描" }).click();
  await expect(page.getByRole("heading", { name: "文件分类" })).toBeVisible();
  await page.getByRole("button", { name: /图片.*1 个/ }).click();
  await expect(page.getByRole("button", { name: /large\.PNG/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /move\.docx/ })).toHaveCount(0);
  await page.getByRole("button", { name: "返回文件" }).click();
  const left = page.getByRole("region", { name: "左栏" });
  const right = page.getByRole("region", { name: "右栏" });
  const target = await right.getByLabel("文件列表").boundingBox();
  assert.ok(target);
  for (const [file, copy] of [[moving, false], [copying, true]]) {
    const row = left.getByRole("option", { name: new RegExp(file) });
    const start = await row.boundingBox();
    assert.ok(start);
    await page.mouse.move(start.x + 24, start.y + 15);
    await page.mouse.down();
    if (copy) await page.keyboard.down("Control");
    await page.mouse.move(target.x + 40, target.y + target.height - 30, { steps: 14 });
    await expect(page.locator(".drag-preview")).toContainText(copy ? "复制" : "移动");
    await page.mouse.up();
    if (copy) await page.keyboard.up("Control");
    await expect.poll(async () => {
      try { return (await readFile(join(destination, file))).toString(); }
      catch { return ""; }
    }).toBe(bytes.toString());
  }
  await assert.rejects(stat(join(source, moving)), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(source, copying)), bytes);

  const file = left.getByRole("option", { name: /copy\.txt/ });
  await file.click({ button: "right" });
  await page.getByRole("button", { name: "属性", exact: true }).click();
  closeNativeDialog("properties");
  await file.click({ button: "right" });
  await page.getByRole("button", { name: "打开方式", exact: true }).click();
  closeNativeDialog("open-with");
  console.log("Verified installed volume scan, file grouping, move/copy, and native Windows dialogs.");
} finally {
  await browser?.close().catch(() => {});
  if (app?.exitCode === null) app.kill();
  try {
    await stat(uninstall);
    execFileSync(uninstall, ["/S"], { timeout: 120000, windowsHide: true });
    await expect.poll(async () => stat(executable).then(() => true, () => false)).toBe(false);
    console.log("Uninstalled the current-user package.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
