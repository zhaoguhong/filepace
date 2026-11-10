import { it, expect } from "vitest";
import config from "../src-tauri/tauri.conf.json";
it("Windows installs for current user without selecting an elevated mode", () => {
  expect(config.bundle.windows.nsis.installMode).toBe("currentUser");
  expect(config.bundle.targets).toContain("nsis");
  expect(config.bundle.targets).not.toContain("msi");
  expect(config.bundle.windows.webviewInstallMode.type).toBe(
    "downloadBootstrapper",
  );
});
