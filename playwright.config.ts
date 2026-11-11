import { defineConfig } from "@playwright/test";
const port = Number(process.env.FILEPACE_TEST_PORT ?? 1420);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./tests",
  use: {
    baseURL,
    browserName: "chromium",
    launchOptions: process.env.CI ? {} : { channel: "chrome" },
    viewport: { width: 1180, height: 780 },
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: true,
  },
  reporter: "list",
});
