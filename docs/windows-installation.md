# Windows standard-user installation

Filepace must install and run without membership in the Administrators group.

- Build NSIS only: `npm run tauri -- build --bundles nsis`.
- `bundle.windows.nsis.installMode` is explicitly `currentUser`. Never change to `both` or `perMachine`: the former also requires elevation.
- The NSIS installer installs under the current user's profile and registers per-user shortcuts/uninstall data. No services, drivers, machine PATH changes or privileged startup tasks.
- `downloadBootstrapper` installs WebView2 when absent. The bootstrapper must run unelevated; Microsoft supports per-user installation in this case. Initial runtime installation needs network access. Managed devices may restrict installation through organizational policy.
- Preferences and session state are stored in Tauri's per-user app configuration directory. WebView data uses the framework's per-user location. Never write settings beside the executable.
- Installation does not confer permission to access protected files: filesystem access errors appear in the UI without requesting elevation.

## Release gate (requires a Windows machine or VM)

The current implementation was developed on macOS. Windows compilation is configured in CI; the following scenarios are not yet verified on a real Windows system.

1. Sign in with a standard local user; start installer normally (not Run as administrator). No UAC or administrator credentials.
2. Repeat on Windows 10/11 with and without WebView2; absent runtime should install per-user. Check offline failure messaging, then retry online.
3. Launch, create/copy/rename/recycle files within the user's profile; protected locations must fail without elevation.
4. Test Explorer file copy/paste in both directions, multiple files, Unicode paths, UNC paths and removable drives.
5. Install a newer version over the old one and uninstall as the same standard user; preserve user-created files.
6. Validate signed distribution and SmartScreen handling separately from UAC. Signing credentials are not configured in this repository.

References:

- https://v2.tauri.app/distribute/windows-installer/
- https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution
