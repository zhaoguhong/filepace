import { describe, expect, it } from "vitest";
import { makeTab } from "./model";
import { cleanPane, restoreSession } from "./session";

describe("window sessions", () => {
  it("restores legacy single-pane sessions and retains their view and history", () => {
    const tab = {
      ...makeTab("/work", "columns"),
      history: ["/", "/work"],
      index: 1,
    };
    const result = restoreSession(
      { tabs: [tab], active: "missing", focused: "right" },
      "/fallback",
      "grid",
    );
    expect(result).toMatchObject({
      tabs: [tab],
      active: tab.id,
      focused: "left",
      right: undefined,
    });
  });

  it("keeps split-pane histories independent and rejects invalid divider positions", () => {
    const left = makeTab("/left");
    const right = makeTab("/right", "grid");
    const result = restoreSession(
      {
        tabs: [left],
        active: left.id,
        right: { tabs: [right], active: "gone" },
        focused: "right",
        splitRatio: 3,
      },
      "/",
      "list",
    );
    expect(result.right).toEqual({ tabs: [right], active: right.id });
    expect(result.focused).toBe("right");
    expect(result.splitRatio).toBeUndefined();
    expect(result.tabs[0].history).toEqual(["/left"]);
  });

  it("removes transient selections from saved history without changing live selections", () => {
    const tab = {
      ...makeTab("/work"),
      selected: ["/work/a"],
      locationState: { 0: { query: "a", selected: ["/work/a"], scroll: 200 } },
    };
    const saved = cleanPane({ tabs: [tab], active: tab.id });
    expect(saved.tabs[0].selected).toEqual([]);
    expect(saved.tabs[0].locationState?.[0]).toEqual({
      query: "a",
      selected: [],
      scroll: 200,
    });
    expect(tab.selected).toEqual(["/work/a"]);
    expect(tab.locationState[0].selected).toEqual(["/work/a"]);
  });
});
