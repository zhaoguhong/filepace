# Filepace

[简体中文](README.md)

Filepace is a local file manager for macOS and Windows. Browse in tabs or side by side, drag files to organize them, and open a location in Finder, File Explorer, or a command line. Filepace uses Tauri, Rust, React, and TypeScript.

## Download and install

Download the v0.2.0 installer for your system from the [GitHub Release](https://github.com/zhaoguhong/filepace/releases/tag/v0.2.0).

| System | Installer | How to install |
| --- | --- | --- |
| macOS (Apple Silicon) | [Download .dmg][mac-download] | Open the disk image and drag Filepace to Applications. |
| Windows (x64) | [Download .exe][windows-download] | Run the installer for the current user. If WebView2 is missing, the installer needs an internet connection to download it. |

The installers are a preview. The macOS app is ad-hoc signed and has no notarization, so Gatekeeper may show a prompt. Windows may show a SmartScreen warning because the installer has no publisher signature. [Apple support](https://support.apple.com/en-us/102445) · [Microsoft SmartScreen documentation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

## Work with two folders

- **New Window (新建窗口)** opens a separate desktop window at the current location. A tab's context menu can also move it to a new window.
- **Split View (左右分栏)** opens a right pane in the current window. Each pane has its own tabs, selection, and navigation history. Sidebar navigation and keyboard shortcuts apply to the active pane.
- Drag a file or folder to the other pane or another Filepace window to move it. Hold **Option** on macOS or **Ctrl** on Windows when you release the pointer to copy. Drop on a folder to put items inside it, or on blank space to use the pane's current directory.
- **Merge Panes (合并分栏)** returns to a single pane and keeps the tabs from both sides.

Right-click a file, folder, or blank space in the file list to copy its full path, show it in Finder or File Explorer, or open a command line. Filepace opens Terminal on macOS and PowerShell on Windows. When you right-click a file, the command line starts in its containing folder.

## Storage overview

- Open **Storage Overview (存储概览)** in the window toolbar to see mounted volumes, their capacity, available space, and usage. Use a volume card to browse it or choose it as the scan scope.
- Choose the current directory, a favorite, or a volume and start a scan. The report shows logical file sizes and counts by category, the largest files, and the largest subfolders. You can stop a scan or select a category to filter the largest files.
- Click a result to locate it in Filepace or set a subfolder as the next scan scope. Scanning reads file metadata locally and skips links and inaccessible entries.

## Views and system actions

List and icon views distinguish Word, Excel, PowerPoint, PDF, images, and other common file types. The toolbar offers list view and four icon sizes. The drag preview shows the item icon, name, and selection count.

Use **Open With (打开方式)** to choose from the apps provided by the system. Use **Properties (属性)**, **Command+I** on macOS, or **Alt+Enter** on Windows to open the system info window for the selection. Filepace shows basic metadata if the system window is unavailable. Use **Copy Name (复制名称)** to copy selected names and the storage overview to open Disk Utility or Windows Storage Settings.

## File operations

File tasks show progress and ask how to handle name conflicts. A move completes the destination copy before removing the source. Deletions and replaced items go to the system trash. If a task is running when you close the last window, Filepace asks whether to continue the task or cancel it and close the window.

Filepace saves tabs and pane locations for each window and uses the signed-in user's filesystem permissions. You can browse symbolic links. File transfers involving symbolic links are currently unsupported. [Platform verification and known gaps](docs/scope.md)

## Run from source

Install Node.js 24 or later, stable Rust, and the build tools for your operating system. [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/)

```sh
npm ci
npm run tauri dev
```

`npm run dev` opens a read-only browser preview with sample files. Use the desktop app to test real file operations on disposable folders.

## Test and build

```sh
npm test
npm run build
npm run test:e2e
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

The browser tests use a local Google Chrome installation. In CI, the workflow installs Playwright's Chromium.

```sh
# macOS
npm run tauri -- build --bundles app,dmg

# Windows
npm run tauri -- build --bundles nsis
```

Bundles appear under `src-tauri/target/release/bundle/`. GitHub Actions checks both platforms. Use the manual workflow to upload installer artifacts. [Windows installation](docs/windows-installation.md) · [Release checks](docs/releases.md)

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for repository guidelines. Filepace is available under the [MIT License](LICENSE). Dependencies retain their own licenses.

[mac-download]: https://github.com/zhaoguhong/filepace/releases/download/v0.2.0/Filepace_0.2.0_aarch64.dmg
[windows-download]: https://github.com/zhaoguhong/filepace/releases/download/v0.2.0/Filepace_0.2.0_x64-setup.exe
