import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { preview } from "vite";

// Build first. Pass a second dist directory to alternate releases on the same machine.
const usage = "node scripts/benchmark-workspace.mjs [dist] [other-dist]";
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    usage,
    "\nFILEPACE_BENCH_TRIALS defaults to 20, after one warm-up.",
  );
  process.exit(0);
}
if (args.length > 2) throw new Error(usage);
const repeats = Number(process.env.FILEPACE_BENCH_TRIALS ?? 20);
if (!Number.isSafeInteger(repeats) || repeats < 1)
  throw new Error("Expected a positive trial count.");
const builds = (args.length ? args : ["dist"]).map((directory) => ({
  directory: resolve(directory),
  samples: [],
}));
const fixture = { size: 10_000, placesDelayMs: 400 };
const jumps = 24;

function installFixture({ size, placesDelayMs }) {
  const stats = {
    directoryReads: 0,
    sidebarReads: 0,
    keyListeners: 0,
    ready: null,
  };
  window.workspaceBenchmark = stats;
  const read = Storage.prototype.getItem;
  Storage.prototype.getItem = function (key) {
    if (key === "filepace-location-groups-v1") stats.sidebarReads++;
    return read.call(this, key);
  };
  const listen = window.addEventListener.bind(window);
  window.addEventListener = (name, ...args) => {
    if (name === "keydown") stats.keyListeners++;
    return listen(name, ...args);
  };
  localStorage.setItem(
    "filepace-preferences",
    JSON.stringify({ defaultView: "list", autoUpdate: false }),
  );
  const path = "/fixture";
  const tab = (id, path) => ({
    id,
    path,
    history: [path],
    index: 0,
    query: "",
    selected: [],
    scroll: 0,
    view: "list",
    sort: "name",
    descending: false,
  });
  let nextId = 0;
  window.isTauri = true;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
    transformCallback: () => ++nextId,
    async invoke(command) {
      if (command === "plugin:event|listen") return ++nextId;
      if (command === "places") {
        await new Promise((done) => setTimeout(done, placesDelayMs));
        return [{ path: "/home", name: "个人目录", kind: "favorite" }];
      }
      if (command === "load_session")
        return {
          tabs: [
            tab("a", path),
            tab("idle1", "/idle1"),
            tab("idle2", "/idle2"),
          ],
          active: "a",
          right: {
            tabs: [tab("b", path), tab("idle3", "/idle3")],
            active: "b",
          },
        };
      if (command === "list_directory") {
        stats.directoryReads++;
        const entries = Array.from({ length: size }, (_, index) => {
          const name = `item-${String(index).padStart(5, "0")}.txt`;
          return {
            name,
            path: path + "/" + name,
            isDir: false,
            isLink: false,
            hidden: false,
            size: 32,
            modified: 1710000000,
          };
        });
        return { path, parent: "/", entries };
      }
      if (command === "tasks") return { tasks: [], revision: 0, undo: null };
      if (command === "update_status")
        return { current: "fixture", phase: "idle" };
      return null;
    },
  };
  const observe = () => {
    let pressing = false;
    const observer = new MutationObserver(() => {
      const list = document.querySelector(
        '[aria-label="文件列表"][data-pane="left"]',
      );
      if (!list?.querySelector('[role="option"]')) return;
      if (list.querySelector('[role="option"][aria-selected="true"]')) {
        stats.ready = performance.now();
        observer.disconnect();
      } else if (!pressing) {
        pressing = true;
        const select = () => {
          if (stats.ready !== null) return;
          list.focus();
          list.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
          );
          requestAnimationFrame(select);
        };
        requestAnimationFrame(select);
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
    });
  };
  if (document.documentElement) observe();
  else window.addEventListener("DOMContentLoaded", observe, { once: true });
}

async function scrollList(jumps) {
  const list = document.querySelector(
    '[aria-label="文件列表"][data-pane="left"]',
  );
  const stats = window.workspaceBenchmark;
  const { sidebarReads, keyListeners } = stats;
  const height = list
    .querySelector('[role="option"]')
    .getBoundingClientRect().height;
  const scrollMs = [];
  for (let jump = 1; jump <= jumps; jump++) {
    const index = jump * 320;
    const elapsed = await new Promise((done, fail) => {
      const start = performance.now();
      const observer = new MutationObserver(() => {
        if (!list.querySelector(`[aria-posinset="${index + 1}"]`)) return;
        observer.disconnect();
        clearTimeout(timeout);
        requestAnimationFrame(() => done(performance.now() - start));
      });
      const timeout = setTimeout(() => {
        observer.disconnect();
        fail(new Error(`Row ${index + 1} did not appear`));
      }, 3000);
      observer.observe(list, {
        subtree: true,
        childList: true,
        attributes: true,
      });
      list.scrollTop = index * height;
    });
    scrollMs.push(elapsed);
  }
  return {
    ready: stats.ready,
    scrollMs,
    directoryReads: stats.directoryReads,
    sidebarReads: stats.sidebarReads - sidebarReads,
    keyListeners: stats.keyListeners - keyListeners,
  };
}

const percentile = (values, fraction) =>
  values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const milliseconds = (values, fraction) =>
  Number(percentile(values, fraction).toFixed(1));
let browser;
try {
  for (const build of builds) {
    await access(resolve(build.directory, "index.html"));
    build.server = await preview({
      configFile: false,
      logLevel: "error",
      build: { outDir: build.directory },
      preview: { host: "127.0.0.1", port: 0 },
    });
  }
  browser = await chromium.launch(process.env.CI ? {} : { channel: "chrome" });
  console.log({ browser: await browser.version(), repeats, jumps, ...fixture });
  for (let round = 0; round <= repeats; round++) {
    for (const build of round % 2 ? builds : [...builds].reverse()) {
      const page = await browser.newPage({
        viewport: { width: 1180, height: 780 },
      });
      const deadline = setTimeout(
        () => void page.close().catch(() => {}),
        30_000,
      );
      try {
        page.setDefaultTimeout(10_000);
        await page.addInitScript(installFixture, fixture);
        await page.goto(build.server.resolvedUrls.local[0]);
        await page.waitForFunction(
          () => window.workspaceBenchmark.ready !== null,
        );
        await page
          .getByRole("button", { name: "个人目录", exact: true })
          .waitFor();
        const sample = await page.evaluate(scrollList, jumps);
        if (round > 0) build.samples.push(sample);
      } finally {
        clearTimeout(deadline);
        await page.close();
      }
    }
  }
  for (const { directory, samples } of builds) {
    const ready = samples.map((sample) => sample.ready);
    const scroll = samples.flatMap((sample) => sample.scrollMs);
    console.log({
      directory,
      readyMedianMs: milliseconds(ready, 0.5),
      readyP95Ms: milliseconds(ready, 0.95),
      scrollMedianMs: milliseconds(scroll, 0.5),
      scrollP95Ms: milliseconds(scroll, 0.95),
      directoryReads: [
        ...new Set(samples.map((sample) => sample.directoryReads)),
      ],
      medianSidebarReadsPerTrial: percentile(
        samples.map((sample) => sample.sidebarReads),
        0.5,
      ),
      medianKeyListenersAddedPerTrial: percentile(
        samples.map((sample) => sample.keyListeners),
        0.5,
      ),
    });
  }
} finally {
  await browser?.close();
  await Promise.all(builds.map((build) => build.server?.close()));
}
