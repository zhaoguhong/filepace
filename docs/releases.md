# Source and installer releases

## Before opening the source repository

- Review the tracked file list for credentials, local paths, test output, and installer bundles.
- Check that the README, contribution instructions, project license, and both dependency lockfiles are included.
- Enable GitHub Actions and check the macOS and Windows jobs on the default branch after the first push.

A source preview can be published as a GitHub pre-release after the source checks pass. Point the release tag at the checked commit and describe how to build it from source.

## Before distributing installers

1. Build installers from the release commit on macOS and Windows and run the checks in the [README](../README.md).
2. Run the [Windows standard-user matrix](windows-installation.md) and exercise native file dragging, clipboard interoperability, and window closing on both systems.
3. Review the licenses for the exact dependencies in `package-lock.json` and `src-tauri/Cargo.lock`. Include the Filepace license, the notices required by the bundled dependencies, and source availability information for any bundled MPL-covered components. [Mozilla MPL 2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
4. Sign the Windows installer and sign and notarize the macOS distribution. Validate both downloads on clean machines before making a public release. [Tauri distribution guide](https://v2.tauri.app/distribute/)

The desktop workflow builds installers on pushes and pull requests. To upload artifacts for a test run, select **Upload installer artifacts** when dispatching the workflow manually.
