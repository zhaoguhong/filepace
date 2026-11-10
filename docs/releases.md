# Source and installer releases

## Before opening the source repository

- Review the tracked file list for credentials, local paths, test output, and installer bundles.
- Check that the README, contribution instructions, project license, and both dependency lockfiles are included.
- Enable GitHub Actions and check the macOS and Windows jobs on the default branch after the first push.

A source preview can be published as a GitHub pre-release after the source checks pass. Point the release tag at the checked commit and describe how to build it from source.

## Installer previews

1. Dispatch **Desktop checks and installers** on the release candidate with **Upload installer artifacts** enabled. Confirm that both jobs passed, including the Windows installer smoke test, and point the release tag at that commit.
2. Check the downloaded installers for the expected version and architecture. For an unsigned macOS preview, ad-hoc sign the app bundle before making the disk image. Mount the final image and launch the copied app. Record which Windows installation scenarios have been verified in [the platform notes](scope.md).
3. Include SHA-256 checksums, the Filepace license, dependency notices, and source download information for any bundled MPL-covered components alongside the installers. Review the exact versions in both lockfiles. [Mozilla MPL 2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
4. Publish the assets on the tagged GitHub pre-release. List the tested platforms and tell users about Gatekeeper and SmartScreen prompts when distributing installers without publisher signatures.

## Before publishing a signed release

1. Build installers from the release commit on macOS and Windows and run the checks in the [README](../README.md).
2. Run the [Windows standard-user matrix](windows-installation.md) and exercise native file dragging, clipboard interoperability, and window closing on both systems.
3. Sign the Windows installer and sign and notarize the macOS distribution. Validate both downloads on clean machines before publishing. [Tauri distribution guide](https://v2.tauri.app/distribute/)

## Regular releases

Use the same build and asset checks as an installer preview. Verify the final installers on both platforms, including separate-window move and modifier-copy on macOS, an unelevated Windows installation, and a first installation without WebView2. Describe the observed coverage in the release notes and publish the checked tag as a regular GitHub release. Describe the current signing and notarization status on the download page.
