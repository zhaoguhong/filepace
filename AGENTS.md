# Filepace repository instructions

- Write all Git commit messages in English.
- `src/App.tsx` contains the React window shell. `src/browsePane.ts` loads each pane's current directory. `src/fileDrag.ts` handles pointer gestures and routes native drops. `src-tauri/src/main.rs` owns filesystem commands, tasks, and window sessions.
- Keep pane navigation and selection independent. Preserve compatibility with saved sessions that contain only the original single-pane `tabs` and `active` fields.
- Prefer macOS and Windows filesystem, search, archive, and shell capabilities and reuse existing file-manager behavior. Add Filepace implementations where the native interface cannot provide the required behavior or safety.
- Route file mutations through the Rust commands and existing task engine. Validate destinations on the backend, preserve source data until a move commits, and send deletions to the system trash. Keep the browser preview read-only.
- Keep macOS and Windows behavior explicit. Between directory columns, panes, or Filepace windows, drag defaults to move and the copy modifier is Option on macOS or Ctrl on Windows. Keep Windows NSIS installation in current-user mode.
- Run `npm test`, `npm run build`, `npm run test:e2e`, and `cargo test --locked --manifest-path src-tauri/Cargo.toml` for changes to desktop behavior. Use temporary directories for native file tests and check the source and destination contents after a transfer.
- Keep generated bundles, dependency directories, test output, credentials, local session data, and unfinished QA notes outside version control. Follow the [contributor guide](CONTRIBUTING.md) and record verified scenarios in [docs/scope.md](docs/scope.md).
