import { test, expect, type Page } from "@playwright/test";

async function installListingFixture(
  page: Page,
  selected = false,
  scroll = 0,
  startup?: "saved" | "new",
) {
  await page.addInitScript(
    ({ selected, scroll, startup }) => {
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
      let savedSession: unknown;
      let releasePlaces!: () => void;
      const pendingPlaces = new Promise<void>((resolve) => {
        releasePlaces = resolve;
      });
      let placesRequested = false;
      Object.assign(window, {
        isTauri: true,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
        filepaceListingFixture: {
          requests,
          cancelled,
          get savedSession() {
            return savedSession;
          },
          releasePlaces,
          get placesRequested() {
            return placesRequested;
          },
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
            if (command === "places") {
              placesRequested = true;
              const places = [
                {
                  name: "个人目录",
                  path: startup ? "/home-test" : root,
                  kind: "favorite",
                },
              ];
              return startup
                ? pendingPlaces.then(() => places)
                : Promise.resolve(places);
            }
            if (command === "load_session" && startup === "new")
              return Promise.resolve(null);
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
            if (command === "save_session") {
              savedSession = args.value;
              return Promise.resolve(null);
            }
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
    { selected, scroll, startup },
  );
  await page.goto("/");
  if (startup === "new") {
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).filepaceListingFixture.placesRequested,
        ),
      )
      .toBe(true);
    return;
  }
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).filepaceListingFixture.requests.length,
      ),
    )
    .toBe(1);
}

test("restores the active directory and accepts keyboard input before sidebar places arrive", async ({
  page,
}) => {
  await installListingFixture(page, false, 0, "saved");
  await page.evaluate(() => (window as any).filepaceListingFixture.finish(0));
  const list = page.getByRole("listbox", { name: "文件列表" });
  await list.press("ArrowDown");
  await expect(
    list.getByRole("option", { name: /Destination/, selected: true }),
  ).toBeVisible();
  await list
    .getByRole("option", { name: /Destination/ })
    .click({ button: "right" });
  await page
    .getByRole("button", { name: "添加到常用位置", exact: true })
    .click();
  await page.evaluate(() =>
    (window as any).filepaceListingFixture.releasePlaces(),
  );
  await expect(
    page.getByRole("button", { name: "个人目录", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Destination", exact: true }),
  ).toBeVisible();
  await expect(
    list.getByRole("option", { name: /Destination/, selected: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).filepaceListingFixture.requests.map(
        (r: { path: string }) => r.path,
      ),
    ),
  ).toEqual(["/fixture"]);
});

test("opens the real default location once when there is no saved session", async ({
  page,
}) => {
  await installListingFixture(page, false, 0, "new");
  expect(
    await page.evaluate(
      () => (window as any).filepaceListingFixture.requests.length,
    ),
  ).toBe(0);
  await page.evaluate(() =>
    (window as any).filepaceListingFixture.releasePlaces(),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).filepaceListingFixture.requests.map(
          (r: { path: string }) => r.path,
        ),
      ),
    )
    .toEqual(["/home-test"]);
});

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
    fixture.requests[0].onBatch.onmessage({
      path: fixture.requests[0].path,
      parent: "/",
      entries: [],
      total: 302,
    });
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

test("discards an incomplete stream and retries the directory", async ({
  page,
}) => {
  await installListingFixture(page);
  await page.evaluate(() => {
    const fixture = (window as any).filepaceListingFixture;
    fixture.batch(0);
    const request = fixture.requests[0];
    request.onBatch.onmessage({
      path: request.path,
      parent: "/",
      entries: [],
      total: 3,
    });
    request.finish({ streamed: true });
  });
  await expect(page.getByText("目录读取不完整，请刷新重试")).toBeVisible();
  await page.getByRole("button", { name: "重新尝试" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).filepaceListingFixture.requests.length,
      ),
    )
    .toBe(2);
  await page.evaluate(() => (window as any).filepaceListingFixture.finish(1));
  await expect(page.getByRole("option", { name: /keep.txt/ })).toBeVisible();
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
  expect(
    await page.evaluate(() =>
      (window as any).filepaceListingFixture.requests.map(
        (request: { delivery: string }) => request.delivery,
      ),
    ),
  ).toEqual(["stream", "snapshot"]);
  await page.evaluate(() =>
    (window as any).filepaceListingFixture.batch(1, 300),
  );
  await expect(selected).toBeVisible();
  await page.evaluate(() => (window as any).filepaceListingFixture.finish(1));
  await expect(selected).toBeVisible();
});

for (const ackFirst of [true, false]) {
  test(`uses the final ordered directory batch when the acknowledgement arrives ${ackFirst ? "first" : "last"}`, async ({
    page,
  }) => {
    await installListingFixture(page, true);
    await page.evaluate((early) => {
      const fixture = (window as any).filepaceListingFixture;
      fixture.batch(0, 256);
      if (early) fixture.requests[0].finish({ streamed: true });
    }, ackFirst);
    await expect(page.locator(".pane-read-status")).toContainText("256");
    await page.evaluate(() => {
      const request = (window as any).filepaceListingFixture.requests[0];
      request.onBatch.onmessage({
        path: request.path,
        parent: "/",
        total: 257,
        entries: [
          {
            path: request.path + "/keep.txt",
            name: "keep.txt",
            hidden: false,
            isLink: false,
            isDir: false,
            size: 10,
            modified: 0,
          },
        ],
      });
    });
    await expect(page.locator(".pane-read-status")).toHaveCount(0);
    if (!ackFirst) {
      await page.evaluate(() =>
        (window as any).filepaceListingFixture.requests[0].finish({
          streamed: true,
        }),
      );
    }
    await expect(page.getByRole("contentinfo")).toContainText("257");
    await page.getByLabel("文件列表").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(
      page.getByRole("option", { name: /keep.txt/, selected: true }),
    ).toBeVisible();
  });
}

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

test("keeps live pixel offsets independent across panes, history, tab reopening and session saves", async ({
  page,
}) => {
  await installListingFixture(page);
  await page.evaluate(() =>
    (window as any).filepaceListingFixture.finish(0, 10_000),
  );
  await page.getByRole("button", { name: "左右分栏", exact: true }).click();
  const left = page.getByRole("region", { name: "左栏", exact: true });
  const right = page.getByRole("region", { name: "右栏", exact: true });
  const files = left.getByLabel("文件列表");
  await files.getByRole("option", { name: /Destination/ }).click();
  await expect(files).toHaveAttribute("aria-activedescendant", /Destination/);
  await files.evaluate((element) => {
    element.scrollTop = 44_007;
  });
  await expect(left.locator('[aria-posinset="1001"]')).toBeVisible();
  await expect(files).not.toHaveAttribute("aria-activedescendant", /.+/);
  await right.getByLabel("文件列表").evaluate((element) => {
    element.scrollTop = 8_809;
  });
  await expect(right.locator('[aria-posinset="201"]')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const saved = (window as any).filepaceListingFixture.savedSession;
        return [saved?.tabs[0]?.scroll, saved?.right?.tabs[0]?.scroll];
      }),
    )
    .toEqual([44_007, 8_809]);
  await left.getByLabel("编辑路径").click();
  await left.getByLabel("完整路径").fill("/fixture/Destination");
  await left.getByLabel("完整路径").press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).filepaceListingFixture.requests.length,
      ),
    )
    .toBe(2);
  await page.evaluate(() => (window as any).filepaceListingFixture.finish(1));
  await left.getByLabel("后退", { exact: true }).click();
  await expect
    .poll(() => files.evaluate((element) => element.scrollTop))
    .toBe(44_007);
  // Switch before the native scroll event for this final movement is delivered.
  await left.evaluate((element) => {
    element.querySelector<HTMLElement>('[aria-label="文件列表"]')!.scrollTop =
      44_021;
    element
      .querySelector<HTMLButtonElement>('[aria-label="新建标签"]')!
      .click();
  });
  await expect
    .poll(() => files.evaluate((element) => element.scrollTop))
    .toBe(0);
  await left.getByRole("tab").first().click();
  await expect
    .poll(() => files.evaluate((element) => element.scrollTop))
    .toBe(44_021);
  await page.keyboard.press("ControlOrMeta+w");
  await page.keyboard.press("ControlOrMeta+Shift+t");
  await expect
    .poll(() => files.evaluate((element) => element.scrollTop))
    .toBe(44_021);
  expect(
    await right.getByLabel("文件列表").evaluate((element) => element.scrollTop),
  ).toBe(8_809);
});

test("reveals a search result that arrives only in the final directory batch", async ({
  page,
}) => {
  await installListingFixture(page);
  await page.evaluate(() => (window as any).filepaceListingFixture.finish(0));
  await page.getByRole("button", { name: "搜索子文件夹", exact: true }).click();
  await page.getByLabel("文件名关键词").fill("zz-final");
  await page.getByRole("button", { name: "开始搜索", exact: true }).click();
  await page
    .locator(".result-row")
    .filter({ hasText: "zz-final.txt" })
    .getByRole("button", { name: "打开所在目录并选中" })
    .click();
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
