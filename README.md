# Filepace

Filepace is a local desktop file manager for macOS and Windows. Browse folders in tabs or side by side, move and copy files with visible task progress, and open a location in Finder, File Explorer, or a command line. Filepace uses Tauri, Rust, React, and TypeScript.

## Work with two folders

- **New Window (新建窗口)** opens a separate desktop window at the current location. You can also move a tab into a new window from its context menu.
- **Split View (左右分栏)** opens a right pane inside the current window. Each pane has its own folders, tabs, selection, and navigation history. The highlighted pane receives sidebar navigation and keyboard shortcuts.
- Drag a file or folder to the other pane or another Filepace window to move it. Hold **Option** on macOS or **Ctrl** on Windows when you release the pointer to copy. Drop on a folder to put the items inside it, or on blank space to use the pane's current directory.
- **Merge Panes (合并分栏)** returns to a single pane and keeps the tabs from both sides.

Right-click a file, folder, or the file list background to copy its full path, show it in the system file manager, or open a command line at that location. For a file, the command line starts in its containing folder. Filepace opens Terminal on macOS and PowerShell on Windows.

## Run from source

Install Node.js 24 or later, stable Rust, and the build tools for your operating system. [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/)

```sh
npm ci
npm run tauri dev
```

Use `npm run dev` for the read-only browser preview with sample files. Use the desktop app for real filesystem operations.

## Test and build

```sh
npm test
npm run build
npm run test:e2e
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

The browser tests use a local Google Chrome installation. In CI, the workflow installs Playwright's Chromium. Test real file operations on disposable folders in the desktop app. [Verification notes](docs/scope.md)

```sh
# Run on macOS
npm run tauri -- build --bundles app,dmg

# Run on Windows
npm run tauri -- build --bundles nsis
```

Bundles appear under `src-tauri/target/release/bundle/`. The Windows NSIS installer uses the current-user install mode. GitHub Actions builds and checks both platforms. Installer artifact upload is available through a manual workflow run. [Windows installation](docs/windows-installation.md) · [Release checks](docs/releases.md)

## File operations and preview status

- File tasks show progress, support cancellation, and prompt for same-name conflicts. A move publishes the destination before removing the source. Deletion and replacement use the system trash.
- Tabs and pane locations are saved for each window. If a file task is active, Filepace keeps the last window open and offers to continue or cancel the task.
- The app runs with the permissions of the signed-in user. Browser previews use sample data, and the desktop app loads its packaged interface.
- This is a development preview. The project still needs Windows installer and Explorer testing, native cross-window drag coverage, signed public installers, and more filesystem edge-case testing. Symbolic links can be browsed. The file transfer engine currently reports them as unsupported. [Verification notes](docs/scope.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for reporting issues and submitting changes, and [AGENTS.md](AGENTS.md) for repository rules.

## License

Filepace is available under the [MIT License](LICENSE). Dependencies retain their respective licenses. [Dependency and release notes](docs/releases.md)
