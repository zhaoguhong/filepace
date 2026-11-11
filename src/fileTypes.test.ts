import { describe, expect, it } from "vitest";
import { describeFile, type FileKind } from "./fileTypes";
import fileKinds from "./fileKinds.json";
import type { Entry } from "./model";

function entry(name: string, options: Partial<Entry> = {}): Entry {
  return {
    name,
    path: `/fixtures/${name}`,
    isDir: false,
    isLink: false,
    hidden: false,
    size: 10,
    modified: 0,
    ...options,
  };
}

describe("file type icons", () => {
  it("classifies every declared extension and exact file name without collisions", () => {
    const seen = new Set<string>();
    for (const [kind, [, keys, category]] of Object.entries(fileKinds)) {
      for (const key of keys.split(" ").filter(Boolean)) {
        expect(seen.has(key), `duplicate file type key ${key}`).toBe(false);
        seen.add(key);
        const name = key.startsWith("@")
          ? key.slice(1)
          : `Example.${key.toUpperCase()}`;
        expect(describeFile(entry(name))).toMatchObject({ kind, category });
      }
    }
  });

  it.each<[string, FileKind]>([
    ["main.PY", "python"],
    ["Main.java", "java"],
    ["app.js", "javascript"],
    ["app.mjs", "javascript"],
    ["module.cts", "typescript"],
    ["index.d.ts", "typescript"],
    ["camera.mts", "video"],
    ["App.jsx", "jsx"],
    ["App.tsx", "tsx"],
    ["script.ps1", "powershell"],
    ["run.cmd", "batch"],
    [".zshrc", "shell"],
    [".env.local", "env"],
    [".ENV.PRODUCTION", "env"],
    ["Dockerfile.dev", "docker"],
    ["Containerfile.prod", "docker"],
    ["Makefile", "make"],
    [".gitignore", "git"],
    ["README", "document"],
    [".pdf", "generic"],
    ["unknown.xyz", "generic"],
    ["no extension", "generic"],
  ])("recognizes %s", (name, kind) => {
    expect(describeFile(entry(name)).kind).toBe(kind);
  });

  it.each([
    "App.exe",
    "App.COM",
    "App.lnk",
    "App.LNK",
    "Site.url",
    "Site.website",
    "App.appref-ms",
    "Setup.msi",
    "Setup.msix",
    "Logo.ico",
  ])("requests the Windows Shell icon for %s", (name) => {
    expect(
      describeFile(entry(name, { path: `C:\\fixtures\\${name}` })).nativeIcon,
    ).toBe(true);
    expect(describeFile(entry(name)).nativeIcon).toBe(false);
    expect(
      describeFile(entry(name, { path: `C:\\fixtures\\${name}`, isDir: true }))
        .nativeIcon,
    ).toBe(false);
  });

  it("handles UNC shortcuts and macOS packages explicitly", () => {
    expect(
      describeFile(entry("App.lnk", { path: "\\\\server\\share\\App.lnk" })),
    ).toMatchObject({ nativeIcon: true, shortcut: true });
    expect(describeFile(entry("Editor.APP", { isDir: true }))).toMatchObject({
      kind: "application",
      nativeIcon: true,
    });
    expect(describeFile(entry("Installer.pkg", { isDir: true }))).toMatchObject(
      { kind: "installer", nativeIcon: true },
    );
    expect(describeFile(entry("Site.webloc"))).toMatchObject({
      nativeIcon: true,
      shortcut: true,
    });
  });

  it("marks directory and broken file links without requesting native icons or thumbnails", () => {
    expect(
      describeFile(entry("App.app", { isDir: true, isLink: true })),
    ).toMatchObject({
      kind: "folder",
      shortcut: true,
      nativeIcon: false,
      thumbnail: false,
    });
    expect(describeFile(entry("Missing.png", { isLink: true }))).toMatchObject({
      kind: "shortcut",
      shortcut: true,
      nativeIcon: false,
      thumbnail: false,
    });
    expect(describeFile(entry("folder.py", { isDir: true }))).toMatchObject({
      kind: "folder",
      shortcut: false,
      nativeIcon: false,
    });
  });
});
