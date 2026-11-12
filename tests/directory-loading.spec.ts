import { test, expect, type Page } from "@playwright/test";

async function installListingFixture(page: Page, selected = false, scroll = 0) {
  await page.addInitScript(
    ({ selected, scroll }) => {
      const root = "/fixture";
      type Entry = {
        name: string;
        path: string;
        isDir: boolean;
        isLink: boolean;
        hidden: boolean;
        size: number;
        modified: number;
      };
      const entry = (name: string, isDir = false, path = root): Entry => ({
        name,
        path: `${path}/${name}`,
        isDir,
        isLink: false,
        hidden: false,
        size: 10,
        modified: 0,
      });
      const rows = [entry("Destination", true), entry("keep.txt")];
      let callbackId = 0;
      const listeners = new Map<number, { event: string; handler: number }>();
      const callbacks = new Map<number, (data: unknown) => void>();
      const requests: {
        path: string;
        id: string;
        onBatch: { onmessage: (batch: unknown) => void };
        finish: (listing: unknown) => void;
      }[] = [];
      const cancelled: string[] = [];
      Object.assign(window, {
        isTauri: true,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
        filepaceListingFixture: {
          requests,
          cancelled,
          batch(index: number, count = 2) {
            const request = requests[index];
            const entries =
              count === 2
                ? rows
                : Array.from({ length: count }, (_, index) =>
                    entry(
                      `file-${String(index).padStart(5, "0")}.txt`,
                      false,
                      request.path,
                    ),
                  );
            request.onBatch.onmessage({
              path: request.path,
              parent: "/",
              entries,
            });
          },
          finish(index: number, count = 2, target = "destination-only.txt") {
            const request = requests[index];
            const entries =
              request.path === root
                ? rows
                : [entry(target, false, request.path)];
            request.finish({
              path: request.path,
              parent: request.path === root ? "/" : root,
              entries:
                count > 2
                  ? [
                      ...entries,
                      ...Array.from(
                        { length: count - entries.length },
                        (_, index) =>
                          entry(
                            `file-${String(index).padStart(5, "0")}.txt`,
                            false,
                            request.path,
                          ),
                      ),
                    ]
                  : entries,
            });
          },
          emitChange(path: string) {
            for (const [id, listener] of listeners)
              if (listener.event === "directory-changed")
                callbacks.get(listener.handler)?.({
                  event: listener.event,
                  id,
                  payload: [path],
                });
          },
        },
        __TAURI_INTERNALS__: {
          metadata: {
            currentWindow: { label: "main" },
            currentWebview: { label: "main", windowLabel: "main" },
          },
          transformCallback(handler: (data: unknown) => void) {
            callbacks.set(++callbackId, handler);
            return callbackId;
          },
          invoke(command: string, args: Record<string, unknown> = {}) {
            if (command === "places")
              return Promise.resolve([
                { name: "个人目录", path: root, kind: "favorite" },
              ]);
            if (command === "load_session")
              return Promise.resolve({
                tabs: [
                  {
                    id: "initial",
                    path: root,
                    history: [root],
                    index: 0,
                    selected: selected ? [`${root}/keep.txt`] : [],
                    query: "",
                    view: "list",
                    scroll,
                    sort: "name",
                    gridSize: "medium",
                  },
                ],
                active: "initial",
              });
            if (command === "search_files")
              return Promise.resolve({
                hits: [
                  {
                    entry: entry("zz-final.txt", false, `${root}/Destination`),
                    parent: `${root}/Destination`,
                  },
                ],
                indexed: false,
                limited: false,
                skipped: 0,
              });
            if (command === "tasks")
              return Promise.resolve({ tasks: [], revision: 0, undo: null });
            if (command === "update_status")
              return Promise.resolve({ current: "0.7.0", phase: "current" });
            if (command === "list_directory")
              return new Promise((finish) =>
                requests.push({ ...args, finish } as (typeof requests)[number]),
              );
            if (command === "cancel_directory_listing")
              cancelled.push(String(args.id));
            if (command === "plugin:event|listen") {
              listeners.set(++callbackId, {
                event: String(args.event),
                handler: Number(args.handler),
              });
              return Promise.resolve(callbackId);
            }
            if (command === "plugin:event|unlisten")
              listeners.delete(Number(args.eventId));
            return Promise.resolve(null);
          },
        },
      });
    },
    { selected, scroll },
  );
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).filepaceListingFixture.requests.length,
      ),
    )
    .toBe(1);
}

// UI fixtures control the IPC boundary: batches and completion deliberately arrive
// separately, so a final-only implementation cannot accidentally pass these checks.
test("shows partial rows, preserves a not-yet-enumerated selection and virtualizes the final snapshot", async ({
  page,
}) => {
  await installListingFixture(page, true);
  await page.evaluate(() =>
    (window as any).filepaceListingFixture.batch(0, 300),
  );
  await expect(
    page.getByRole("option", { name: /file-00000.txt/ }),
  ).toBeVisible();
  await expect(page.getByRole("contentinfo")).toContainText("已选择 1");
  await page.evaluate(() =>
    (window as any).filepaceListingFixture.finish(0, 10000),
  );
  await expect.poll(() => page.getByRole("option").count()).toBeLessThan(80);
  await expect(page.getByRole("contentinfo")).toContainText("10000");
  await page.getByLabel("文件列表").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    page.getByRole("option", { name: /keep.txt/, selected: true }),
  ).toBeVisible();
});

test("shares reads between panes, cancels after the last subscriber leaves and ignores late batches and completion", async ({
  page,
}) => {
  await installListingFixture(page);
  await page.evaluate(() => (window as any).filepaceListingFixture.batch(0));
  await page.getByRole("button", { name: "左右分栏", exact: true }).click();
  const left = page.getByRole("region", { name: "左栏", exact: true });
  const right = page.getByRole("region", { name: "右栏", exact: true });
  await expect(
    right.getByRole("option", { name: /Destination/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).filepaceListingFixture.requests.length,
    ),
  ).toBe(1);
  await right.getByRole("option", { name: /Destination/ }).dblclick();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).filepaceListingFixture.requests.length,
      ),
    )
    .toBe(2);
  expect(
    await page.evaluate(() => (window as any).filepaceListingFixture.cancelled),
  ).toEqual([]);
  await left.getByRole("option", { name: /Destination/ }).dblclick();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).filepaceListingFixture.cancelled.length,
      ),
    )
    .toBe(1);
  await page.evaluate(() => {
    const fixture = (window as any).filepaceListingFixture;
    fixture.batch(0, 300);
    fixture.finish(0);
    fixture.finish(1);
  });
  await expect(
    left.getByRole("option", { name: /destination-only.txt/ }),
  ).toBeVisible();
  await expect(
    right.getByRole("option", { name: /destination-only.txt/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: /keep.txt|file-00000.txt/ }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as any).filepaceListingFixture.requests.length,
    ),
  ).toBe(2);
});

test("keeps the complete snapshot and selection during refresh until the final result arrives", async ({
  page,
}) => {
  await installListingFixture(page, true);
  await page.evaluate(() => (window as any).filepaceListingFixture.finish(0));
  const selected = page.getByRole("option", {
    name: /keep.txt/,
    selected: true,
  });
  await expect(selected).toBeVisible();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).filepaceListingFixture.requests.length,
      ),
    )
    .toBe(2);
  await page.evaluate(() =>
    (window as any).filepaceListingFixture.batch(1, 300),
  );
  await expect(selected).toBeVisible();
  await page.evaluate(() => (window as any).filepaceListingFixture.finish(1));
  await expect(selected).toBeVisible();
});

test("restores a saved scroll position only after partial content can accommodate it", async ({
  page,
}) => {
  await installListingFixture(page, false, 50_000);
  await page.evaluate(() =>
    (window as any).filepaceListingFixture.batch(0, 300),
  );
  const files = page.getByLabel("文件列表");
  await expect(page.locator(".pane-read-status")).toContainText("300");
  // Force a real scroll event while the partial list is too short. It must not
  // replace the saved viewport with a clamped position.
  await files.evaluate((element) => {
    element.scrollTop = 100;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.evaluate(() =>
    (window as any).filepaceListingFixture.finish(0, 10_000),
  );
  await expect
    .poll(() => files.evaluate((element) => element.scrollTop))
    .toBe(50_000);
});

test("reveals a search result that arrives only in the final directory batch", async ({
  page,
}) => {
  await installListingFixture(page);
  await page.evaluate(() => (window as any).filepaceListingFixture.finish(0));
  await page.getByRole("button", { name: "搜索子文件夹", exact: true }).click();
  await page.getByLabel("文件名关键词").fill("zz-final");
  await page.getByRole("button", { name: "开始搜索", exact: true }).click();
  await page.locator(".result-row").filter({ hasText: "zz-final.txt" }).getByRole("button", { name: "打开所在目录并选中" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).filepaceListingFixture.requests.length,
      ),
    )
    .toBe(2);
  await page.evaluate(() =>
    (window as any).filepaceListingFixture.batch(1, 300),
  );
  await expect(
    page.getByRole("option", { name: /file-00000.txt/ }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as any).filepaceListingFixture.finish(1, 10_000, "zz-final.txt"),
  );
  await expect(
    page.getByRole("option", { name: /zz-final.txt/, selected: true }),
  ).toBeVisible();
});
