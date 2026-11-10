# First-version scope and verification

## Agreed product rules

- macOS + Windows; Tauri + Rust + React.
- Single-pane and left/right split layouts inside each window. Each pane has independent tabs and navigation.
- Tabs reorder within a window and can be moved to a new window. Cross-window tab drag is deferred.
- New tabs and windows start at the current location. Closing the last tab of one split pane returns to a single pane. Closing the last tab of a single pane closes its window.
- File operations belong to the application, not the originating tab.
- Default delete means system trash, with no fallback to permanent deletion.
- Windows installation must work as a standard user without administrator credentials.
- Sidebar → tabs → path/filter bar → toolbar → files → status/tasks.

## Verified locally

- Frontend TypeScript and production asset build.
- Rust compile and filesystem unit tests cover copying and moving actual files, cancellation preserving the source, conflict handling, invalid names, preview size limits, and refusal to read or transfer named pipes.
- Browser interaction tests cover browsing, tab recovery, right-click actions and the properties fallback, file type icons, four icon sizes, and independent pane settings. Drag tests check the moving preview, selection count, move and modifier-copy gestures, cancellation, and the PNG handed off to the native drag command.
- Installed macOS app testing covered real file moves in both directions between panes, including a drop into a subfolder. The red close button closed an extra window and the final idle window. A pending conflict blocked closing the last window until the test task was cancelled.
- The current macOS build showed the Finder Get Info window for both a file and a folder. A move from the extra-large icon view into a folder in the other pane and a copy into a folder in a single pane preserved the test file contents.
- The Windows GNU target passed a Rust compilation check, including the Shell properties command.

## Storage overview

- Capacity comes from mounted-volume information on macOS and Windows. APFS volumes may share free space. Network drive capacity on Windows is left blank so opening the overview does not wait for a remote drive.
- Scans run on request and report logical sizes per file path. They skip symbolic links, Windows reparse points, and unreadable items. Traversal stays on the selected file system. The overview ranks the largest items in each category and direct subfolders.
- Rust tests check volume capacities, category totals, ranking, cancellation, and symlink handling. Browser tests cover scan controls, classification filters, and navigating from results.
- The macOS app reported both the system disk and a mounted test image. A disposable directory scan matched the expected counts, bytes, category filter, and link exclusion. The macOS shortcuts and system actions opened Finder Get Info, an associated app selected from the Open With list, and Disk Utility.
- On Windows Server 2025 in GitHub Actions, the installed app displayed live volume data, scanned a temporary directory, and filtered a category. Moves and Ctrl-copies between split panes and separate windows were checked against the source and destination bytes. Properties, Open With, and Windows Storage Settings opened, and Copy Name put the file name on the system clipboard. [Installer verification](https://github.com/zhaoguhong/filepace/actions/runs/42755129589)

## v0.1.0 installer preview

- GitHub Actions ran the desktop test suite and built macOS (Apple Silicon) and Windows (x64) installers from the v0.1.0 tag. [Build run](https://github.com/zhaoguhong/filepace/actions/runs/42744647320)
- The macOS preview disk image mounted successfully. The app copied from the image passed ad-hoc signature verification and launched on an Apple Silicon Mac.
- The Windows x64 package installed into the runner account's profile, launched, and uninstalled on a Windows GitHub Actions runner. A standard-user session and installation on a machine without WebView2 still need testing. [Installer smoke test](https://github.com/zhaoguhong/filepace/actions/runs/42746015565)
- The macOS preview has no Developer ID signature or notarization. The Windows preview has no publisher signature.

## File organization

- Undo keeps up to 20 move and rename records in the current session. It checks item identities and original locations before restoring files. A merged move records the items it actually moved and preserves the destination folder's unrelated items. Earlier replacement items remain in the system trash.
- Search tries the platform index for the selected directory. It can scan the directory when the index is unavailable or misses items, and can stop between entries. Results are limited to 300 matches.
- Compression uses system tar when its output matches the selection and uses the ZIP library as a fallback. Extraction accepts regular files and folders, validates entry paths, and stages the result before committing it. A ZIP can contain up to 250,000 entries.
- Tests cover undo conflicts and retry, replaced identities, nested search, ZIP round trips, and path traversal rejection. Browser tests cover search result navigation, system light and dark mode, and saved themes.

## Remaining release work

- Complete the Windows standard-user installation matrix in [windows-installation.md](windows-installation.md).
- Verify separate-window drags on macOS, including the Option copy modifier. A macOS UI automation attempt at a separate-window drop did not transfer the test file. Test Explorer/Finder drag interoperability and cut clipboard feedback with external applications.
- Complete session geometry, per-history scroll/selection restoration, tab overflow menu, name disambiguation and focus restoration.
- Enrich conflicts with both source and destination metadata; add task completion notifications, clear task history and open-location actions.
- Harden races and failure recovery, filesystem metadata fidelity, special files, symlinks, restricted folders and unavailable network/removable volumes.
- Add stable platform-native menus, right-click recycle-bin entry, installer signing and macOS notarization.

The preview deliberately reports unsupported operations rather than silently claiming success. The README distinguishes implemented code from manually verified integrations.
