import { chromium } from "@playwright/test";
import { build } from "vite";

// Run from the repository root. All fixtures and the production bundle stay in memory.
const [bundle] = await build({
  configFile: false,
  logLevel: "warn",
  build: {
    write: false,
    minify: true,
    lib: { entry: "src/model.ts", formats: ["iife"], name: "FilepaceModel" },
  },
});
const browser = await chromium.launch(
  process.env.CI ? {} : { channel: "chrome" },
);
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: bundle.output[0].code });
  console.log(`Headless Chromium ${await browser.version()}`);
  for (const size of [10_000, 100_000]) {
    console.log(await page.evaluate(measure, size));
  }
} finally {
  await browser.close();
}

function measure(size) {
  const { appendListing, reuseUnchangedListing, sortedListing, sortEntries } =
    window.FilepaceModel;
  const data = Array.from({ length: size }, (_, i) => ({
    name: `${i % 7 ? "文件" : "img-"}${(i * 6271) % size}.txt`,
    path: `/fixture/${i}`,
    isDir: i % 19 === 0,
    hidden: i % 23 === 0,
    size: i % 11,
    modified: i,
    isLink: false,
  }));
  const snapshot = (entries) => ({ path: "/fixture", parent: "/", entries });
  const previous = snapshot(data);
  const expected = sortedListing(previous, "name", false, false);
  const serialized = JSON.stringify(data);

  function run(delivery, optimized) {
    let listing = snapshot([]);
    let total = 0,
      longest = 0,
      publishes = 0;
    let rows;
    for (let offset = 0; offset < data.length;) {
      // Model 256-entry native batches with one immediate publish and 16
      // batches coalesced per subsequent publish. This isolates derivation.
      const width = delivery !== "batches" ? size : offset === 0 ? 256 : 4096;
      // The IPC decoder has already produced fresh entry objects when the
      // frontend decides whether to reuse the previous complete snapshot.
      const batch =
        delivery === "refresh"
          ? JSON.parse(serialized)
          : data.slice(offset, offset + width);
      offset += batch.length;
      const start = performance.now();
      if (delivery === "batches") {
        listing = optimized
          ? appendListing(listing, batch)
          : snapshot(listing.entries.concat(batch));
      } else {
        listing = snapshot(batch);
        if (delivery === "refresh" && optimized)
          listing = reuseUnchangedListing(previous, listing);
      }
      const sort =
        delivery === "snapshot" && !optimized
          ? () => sortEntries(listing.entries, "name", false, false)
          : () => sortedListing(listing, "name", false, false);
      const first = sort();
      rows = sort();
      const elapsed = performance.now() - start;
      if (first.length !== rows.length) throw new Error("Pane sizes differ");
      total += elapsed;
      longest = Math.max(longest, elapsed);
      publishes++;
    }
    if (
      rows.length !== expected.length ||
      rows.some((row, i) => row.path !== expected[i].path)
    ) {
      throw new Error("Unexpected final ordering");
    }
    return { total, longest, publishes };
  }

  const results = [];
  for (const delivery of ["snapshot", "batches", "refresh"]) {
    const samples = [[], []];
    const repeats = delivery === "snapshot" ? 11 : 7;
    for (let round = -1; round < repeats; round++) {
      for (let trial = 0; trial < 2; trial++) {
        const mode = (round + trial + 2) % 2;
        const sample = run(delivery, Boolean(mode));
        if (round >= 0) samples[mode].push(sample);
      }
    }
    const median = (values) =>
      values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    for (const [mode, runs] of samples.entries()) {
      results.push({
        size,
        delivery,
        optimized: Boolean(mode),
        repeats,
        publishes: runs[0].publishes,
        medianTotalMs: median(runs.map((sample) => sample.total)),
        medianWorstPublishMs: median(runs.map((sample) => sample.longest)),
      });
    }
  }
  return results;
}
