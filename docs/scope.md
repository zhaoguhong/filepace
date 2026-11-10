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
- Browser interaction tests cover browsing, tab recovery, right-click actions, independent pane navigation, move and modifier-copy gestures, drag cancellation, and merging panes.
- Installed macOS app testing covered real file moves in both directions between panes, including a drop into a subfolder. The red close button closed an extra window and the final idle window. A pending conflict blocked closing the last window until the test task was cancelled.
- The Windows GNU target passed a Rust compilation check. Native Windows installation and interaction tests remain part of the release matrix.

## Remaining release work

- Run native Windows builds and the standard-user installation matrix in [windows-installation.md](windows-installation.md).
- Test native drags across separate windows, Option and Ctrl during real desktop drags, and Explorer/Finder interoperability. Test cut clipboard feedback with external applications.
- Complete session geometry, per-history scroll/selection restoration, tab overflow menu, name disambiguation and focus restoration.
- Enrich conflicts with both source and destination metadata; add task completion notifications, clear task history and open-location actions.
- Harden races and failure recovery, filesystem metadata fidelity, special files, symlinks, restricted folders and unavailable network/removable volumes.
- Add stable platform-native menus, right-click recycle-bin entry, installer signing and macOS notarization.

The preview deliberately reports unsupported operations rather than silently claiming success. The README distinguishes implemented code from manually verified integrations.
