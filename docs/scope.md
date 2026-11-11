# First-version scope and verification

## Agreed product rules

- macOS + Windows; Tauri + Rust + React.
- Single-pane and left/right split layouts inside each window. Each pane has independent tabs and navigation.
- Tabs reorder within a window and can be moved to a new window. Cross-window tab drag is deferred.
- New tabs and windows start at the current location. Closing the last tab of one split pane returns to a single pane. Closing the last tab of a single pane closes its window.
- List View is the default for new tabs and windows unless changed in Settings. View controls are ordered List, Column, Icon. Restored tabs retain their saved views.
- File operations belong to the application, not the originating tab.
- Default delete means system trash, with no fallback to permanent deletion.
- Windows installation must work as a standard user without administrator credentials.
- Sidebar → tabs → path/filter bar → toolbar → files → status/tasks.

## Verified locally

- Frontend TypeScript and production asset build.
- Rust compile and filesystem unit tests cover copying and moving actual files, cancellation preserving the source, conflict handling, invalid names, preview size limits, and refusal to read or transfer named pipes.
- Browser interaction tests cover browsing, tab recovery, right-click actions and the properties fallback, file type icons, four icon sizes, and independent pane settings. Drag tests check the moving preview, selection count, move and modifier-copy gestures, cancellation, and the PNG handed off to the native drag command.
- Browser fixtures checked 27 icon categories in light and dark mode, the blue and gold folder designs, and the fallback after an icon request fails. The installed macOS app displayed the native icons for Filepace and system apps. The Windows Shell icon path passed the Windows GNU target compilation check.
- Shared file-type tests cover language-specific icons, uppercase extensions, exact names such as Dockerfile and `.gitignore`, and `.env` variants. Native search and storage tests verify the same filename classification, including keeping an extensionless `.pdf` as an unknown file.
- Browser fixtures verify language badges, per-path Windows shortcut icon requests, failed requests, corrupt image responses, and shortcut arrows on files and directory links in all three views. Light and dark screenshots were visually checked. Native macOS fixture tests load application, installer, and web shortcut icons without changing their contents. Windows Shell code and Windows-specific custom `.lnk` and `.url` fixture tests passed the Windows GNU compilation check; actual Windows icon extraction still needs runtime verification.
- Browser tests verify List View as the fresh default and first choice, preserve an existing tab's view when the default changes, and keep file creation and file actions accessible through context menus and shortcuts after removing their toolbar buttons. Two-pane context-menu copy and move target the other pane. The duplicate bottom path and shortcut hint are removed; file counts, selection sizes, task controls, and drag destination feedback remain available.
- Browser tests verify pure white surfaces in the default light theme, distinct file hover and selection states, and theme persistence across reloads. All eight themes were rendered in light and dark mode in Chrome on macOS. The checked text and background pairs, including selected file text, had at least 4.5:1 contrast. The updated macOS app launched from the user's Applications folder, restored four saved tabs, and listed all eight themes in Appearance.
- A browser test checks that creating a text document from a column's background menu targets that directory. A macOS desktop test created an empty `.txt` file in the right pane and verified that a duplicate name preserved the existing file contents.
- Column-view tests confirm that file lists start at the top of their columns and that returning through the path bar keeps earlier columns with Windows paths.
- Browser tests keep the Settings button visible while a long sidebar list scrolls and verify that the apply-all choice in a conflict dialog applies to the current file task only.
- Browser tests confirm that sending a file to the trash leaves the task panel closed, completed tasks are visible when opened from the status bar, and failed tasks show a notice.
- Rust and browser tests check that the local error log retains the 100 most recent records, keeps the original system error code, and can be refreshed from Settings.
- A macOS desktop test used temporary files to verify context-menu, Return, and F2 renaming, including a folder in column view. Renaming and undo preserved the fixture contents, and opening a missing directory produced a log entry with the path and system error code.
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

## v0.4.0 column browsing and updates

- Browser tests cover opening a folder in the next column, switching branches, previewing a file, setting a default view for new tabs, and choosing the display mode and theme separately.
- The installed macOS app rejected an update whose announced version differed from its signature. It installed the verified v0.4.0 archive, relaunched, and previewed the fixture file from the restored directory. [macOS update verification](https://github.com/zhaoguhong/filepace/actions/runs/42767485790/job/129667272922)
- The Windows installer passed current-user installation with and without a preinstalled WebView2 runtime. The installed app moved and Ctrl-copied files between separate windows with the destination in column view. [Installer checks](https://github.com/zhaoguhong/filepace/actions/runs/42767422205)
- On Windows, the updater rejected a mismatched signed version, installed the verified v0.4.0 package, and relaunched with the saved directory and fixture file intact. [Windows update verification](https://github.com/zhaoguhong/filepace/actions/runs/42769047016)

## v0.4.1 selection and sidebar shortcuts

- Browser tests cover marquee selection in columns, lists, and icon views, cancelling a selection with Escape, repeated Shift-arrow selection, and arrow-key navigation in icon view.
- Browser tests cover keeping older favorites, adding, removing and reordering common locations, and syncing group expansion between windows after reopening.
- The installed macOS and Windows apps moved a real file between columns in one pane and copied another with Option or Ctrl. Marquee selection followed by system clipboard copy and paste preserved the bytes of the selected files and a folder's contents in both locations. [Installed desktop verification](https://github.com/zhaoguhong/filepace/actions/runs/42773449596)

## v0.4.2 column scrolling and conflict details

- Browser tests check scrolling toward hidden columns on both edges during a file drag and verify the destination and transfer mode at drop time.
- On macOS and Windows, the installed app scrolled to a hidden ancestor and displayed the source and target file sizes and modification times. Choosing Keep Both preserved the existing target and moved the source bytes under a new name. [Installed desktop verification](https://github.com/zhaoguhong/filepace/actions/runs/42777121944)

## v0.5.0 desktop verification

- Rust fixture tests verify that an item replaced during a conflict is never moved, a same-volume directory move preserves mode, modification time and hard links, and a failed staging operation leaves the original target in place. They also verify a reversible rename cycle and relative paths in a folder comparison.
- Browser tests verify bounded rendering and keyboard selection at the end of a 10,000-item grid, shared listings for two panes on the same path, targeted refresh after a path changes, and submission of a validated batch rename.
- With 10,000 simulated text files and 20 trials in headless Chrome on macOS, the production frontend's p95 time to display the list was 36 ms. Selection took 37 ms and switching to the grid took 33 ms. The grid mounted 119 tiles at 1180 × 780. This measurement isolates frontend work.
- An isolated macOS release build copied and moved temporary files between panes, copied a nested folder from comparison results, renamed and undid three items as a batch, and extracted a ZIP into a chosen folder. Source and destination bytes were checked, including the original and replacement files after a refused conflict. It also saved and ran a type-only search, restored its split session, and displayed both pages of a test PDF.
- The locally signed macOS 0.4.2 build launched from the user's Applications folder and restored all four tabs and the active location from the previous installation.

## v0.6.0 browsing and icon verification

- Browser tests cover compact controls at full width and in an 800-pixel split window, distinct active-pane markers and selection preservation, sortable headers, per-tab column resizing and session restoration, long filename titles, and ancestor navigation from collapsed breadcrumbs.
- Browser tests cover keyboard navigation in context menus, common actions ordered before system actions, Escape dismissing only the current menu, preview, rename field or path editor, and the new-folder shortcut. Filtering reports match counts, and hidden-only and empty directories offer the appropriate next action.
- An isolated macOS 0.6.0 release build created a real folder from the empty-directory action and copied and moved temporary files through the two-pane context menu. Source and destination bytes were checked. Native UI checks covered Escape preserving selection, filter counts, hidden-only directories, language and system web shortcut icons, independent pane widths, and restoring the resized list columns after quitting and reopening.
- macOS Rust tests and a Windows GNU test compilation check cover batch rename undo recording committed file identities and refusing to undo replaced files. Windows fixtures assign distinct creation times so the rename cycle exercises NTFS creation-time tunneling. Windows runtime coverage is recorded after the release build checks complete.

## Remaining release work

- Complete the Windows standard-user installation matrix in [windows-installation.md](windows-installation.md).
- Verify separate-window drags on macOS, including the Option copy modifier. A macOS UI automation attempt at a separate-window drop did not transfer the test file. Test Explorer/Finder drag interoperability and cut clipboard feedback with external applications.
- Exercise geometry and history restoration on multiple monitors and with the Windows desktop build.
- Harden races and failure recovery, filesystem metadata fidelity, special files, symlinks, restricted folders and unavailable network/removable volumes.
- Add stable platform-native menus, right-click recycle-bin entry, installer signing and macOS notarization.

The preview deliberately reports unsupported operations rather than silently claiming success. The README distinguishes implemented code from manually verified integrations.
