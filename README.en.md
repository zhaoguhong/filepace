# Filepace

[简体中文](README.md)

Filepace is a local file manager for macOS and Windows. Browse in tabs or side by side, drag files to organize them, and open a location in Finder, File Explorer, or a command line. Filepace uses Tauri, Rust, React, and TypeScript.

## Download and install

Download the v0.5.0 installer for your system from the [GitHub Release](https://github.com/zhaoguhong/filepace/releases/tag/v0.5.0).

| System | Installer | How to install |
| --- | --- | --- |
| macOS (Apple Silicon) | [Download .dmg][mac-download] | Open the disk image and drag Filepace to Applications. |
| Windows (x64) | [Download .exe][windows-download] | Run the installer for the current user. If WebView2 is missing, the installer needs an internet connection to download it. |

The macOS app is ad-hoc signed and has no notarization, so Gatekeeper may show a prompt. Windows may show a SmartScreen warning because the installer has no publisher signature. [Apple support](https://support.apple.com/en-us/102445) · [Microsoft SmartScreen documentation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

## Work with two folders

- Press **Command+N** on macOS or **Ctrl+N** on Windows to open a separate window at the current location. Use the tab context menu to move a tab to a new window.
- **Split View (左右分栏)** opens a right pane in the current window. Each pane has its own tabs, selection, and navigation history. Sidebar navigation and keyboard shortcuts apply to the active pane.
- Drag a file or folder to another directory column, pane, or Filepace window to move it. Hold **Option** on macOS or **Ctrl** on Windows when you release the pointer to copy. Drop on a folder to put items inside it, or on blank space to use the directory displayed there.
- Hold a dragged file near the left or right edge of Column View to scroll to other columns.
- **Merge Panes (合并分栏)** returns to a single pane and keeps the tabs from both sides.
- Drag the divider to resize the panes. Use the toolbar to copy or move the selection to the other pane. The shortcuts are **Command+Shift+C** or **Ctrl+Shift+C** to copy and **Command+Shift+M** or **Ctrl+Shift+M** to move.
- **Compare Folders (对比目录)** shows items that exist on one side or differ. Compare sizes and modification times or check file contents, then select items to copy to the other pane.

Right-click a file, folder, or blank space in the file list to copy its full path, show it in Finder or File Explorer, or open a command line. Filepace opens Terminal on macOS and PowerShell on Windows. When you right-click a file, the command line starts in its containing folder.

## Storage overview

- Open **Storage Overview (存储概览)** in the window toolbar to see mounted volumes, their capacity, available space, and usage. Use a volume card to browse it or choose it as the scan scope.
- Choose the current directory, a favorite, or a volume and start a scan. The report shows logical file sizes and counts by category, the largest files, and the largest subfolders. You can stop a scan or select a category to filter the largest files.
- Click a result to locate it in Filepace or set a subfolder as the next scan scope. Scanning reads file metadata locally and skips links and inaccessible entries.

## Views and system actions

Column, list, and icon views use colors and shapes to distinguish documents, media, archives, installers, design files, fonts, databases, and other types. macOS `.app` bundles and Windows `.exe` files use their system icons when available. The toolbar offers four icon sizes. The drag preview shows the item icon, name, and selection count.

New tabs use Column View by default. Click a folder to open its contents in the next column. Select a file to see its preview or details. The toolbar switches each tab between Column, List, and Icon views. List View can group files by type or modification date. Open folders refresh when local files change.

Drag from blank space in any view to draw a selection rectangle around files and folders. Hold **Shift** to select a range, or use **Command** on macOS and **Ctrl** on Windows to toggle individual items.

Click the sidebar's **Common Locations (常用位置)** or **Favorites (收藏目录)** heading to collapse or expand it. Use the plus button beside Common Locations to add the current folder. Right-click a shortcut to reorder or remove it. The sidebar remembers your changes.

Open **Settings (设置)** at the bottom of the sidebar to set the default view. Under **Appearance (外观)**, choose the display mode and theme separately. Display mode follows the system by default. The default theme uses a pure white background in light mode. Mist Blue, Warm Sand, Sage, Sea Salt Teal, Lilac, Rose, and Slate each support light and dark modes.

Use **Open With (打开方式)** to choose from the apps provided by the system. Use **Properties (属性)**, **Command+I** on macOS, or **Alt+Enter** on Windows to open the system info window for the selection. Filepace shows basic metadata if the system window is unavailable. Use **Copy Name (复制名称)** to copy selected names and the storage overview to open Disk Utility or Windows Storage Settings.

## App updates

Starting with v0.4.0, Filepace checks, downloads, and verifies stable updates from GitHub in the background. Use **Settings → Updates** to check manually or turn off automatic updates. Finish active file tasks before restarting to install an update. Upgrade from v0.3.0 or earlier by downloading the new installer once.

## Search subfolders

Use **Search (搜索)**, **Command+F** on macOS, or **Ctrl+F** on Windows to look for file and folder names in the current directory and its subfolders. Choose a file type to narrow the search. Filepace queries Spotlight or Windows Search first and can scan the directory when the index is unavailable or incomplete. Click a result to locate it.

Search by type, modification date, or minimum file size with or without a name. Save search criteria for the current folder. The path bar suggests recent folders, favorites, and matching subfolders.

## File operations

Open **File Tasks (文件任务)** in the status bar to see progress and results. When names conflict, compare the source and destination paths, file sizes, and modification times before choosing to skip, replace, or keep both. Moves on the same volume rename the original when the destination is vacant. Moves across volumes commit the staged destination before removing the source. Deletions and successfully replaced items go to the system trash. If a task is running when you close the last window, Filepace asks whether to continue it or cancel it and close the window. View recent local errors under **Settings → Error Log (错误日志)**.

- Use **Undo (撤销)** in the status bar or press **Command+Z** / **Ctrl+Z** to undo the most recent move or rename in the current session. Filepace stops if the original location is occupied or the item has been replaced. Replaced items can be recovered through the system trash.
- Select multiple items and press **F2** to preview a batch rename. Find and replace text, add a prefix or suffix, or number the items. Undo can reverse the batch.
- Press **Space** on a PDF to preview it and switch pages. Use **Browse Archive (浏览压缩包)** in a ZIP file's context menu to inspect entries and choose where to extract. Extraction validates entry paths and prepares the contents in a temporary folder before committing the result.
- Use **Compress to ZIP (压缩为 ZIP)** in the context menu to archive selected items with the system tool where available.

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

[mac-download]: https://github.com/zhaoguhong/filepace/releases/download/v0.5.0/Filepace_0.5.0_aarch64.dmg
[windows-download]: https://github.com/zhaoguhong/filepace/releases/download/v0.5.0/Filepace_0.5.0_x64-setup.exe
