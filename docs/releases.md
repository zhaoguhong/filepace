# Source and installer releases

## Release titles and notes

Use `Filepace vVERSION` as the release title, including pre-releases. Keep preview labels in the release status and body.

Write release notes for users: describe changes, provide downloads and installation requirements, and explain known limitations. Chinese and English content may both be included. Keep signing and notarization status, system prompts, WebView2 requirements, upgrade instructions, checksums, and license links visible. Retain unverified scenarios when they affect installation or normal use, using the coverage known for that version.

Record test counts, CI runs, installer checks, and other verification details in [the platform notes](scope.md) and CI records. Release notes should omit a separate verification section and descriptions of internal testing or build procedures.

## Before opening the source repository

- Review the tracked file list for credentials, local paths, test output, and installer bundles.
- Check that the README, contribution instructions, project license, and both dependency lockfiles are included.
- Enable GitHub Actions and check the macOS and Windows jobs on the default branch after the first push.

A source preview can be published as a GitHub pre-release after the source checks pass. Point the release tag at the checked commit and describe how to build it from source.

## Installer previews

1. Dispatch **Desktop checks and installers** on the release candidate with **Upload installer artifacts** enabled. Confirm that both jobs passed, including the Windows installer smoke test, and point the release tag at that commit.
2. Check the downloaded installers for the expected version and architecture. For an unsigned macOS preview, ad-hoc sign the app bundle before making the disk image. Mount the final image, launch the copied app, and run the [macOS drag-and-drop checks](#macos-drag-and-drop-checks). Record installer coverage in [the platform notes](scope.md).
3. Include SHA-256 checksums, the Filepace license, dependency notices, and source download information for any bundled MPL-covered components alongside the installers. Review the exact versions in both lockfiles and use the standard-library notices from the Rust toolchain that built the installers. [Mozilla MPL 2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
4. Publish the assets on the tagged GitHub pre-release. List the supported platforms and tell users about Gatekeeper and SmartScreen prompts when distributing installers without publisher signatures. Record verification coverage in [the platform notes](scope.md).

## Before publishing a signed release

1. Build installers from the release commit on macOS and Windows and run the checks in the [README](../README.md).
2. Run the [Windows standard-user matrix](windows-installation.md) and exercise native file dragging on Windows. Run the [macOS drag-and-drop checks](#macos-drag-and-drop-checks). Exercise clipboard interoperability and window closing on both systems.
3. Sign the Windows installer and sign and notarize the macOS distribution. Validate both downloads on clean machines before publishing. [Tauri distribution guide](https://v2.tauri.app/distribute/)

## Regular releases

Use the same build and asset checks as an installer preview. Verify the final installers on both platforms, including an unelevated Windows installation and a first installation without WebView2. Record the observed coverage in [the platform notes](scope.md) and publish the checked tag as a regular GitHub release. Describe the current signing and notarization status on the download page.

## macOS drag-and-drop checks

Run this matrix with the installed candidate when verifying an installer or a change to native drag handling. Record the app build and macOS version. Create the fixture in Terminal. The three test folders share a volume so Finder's default behavior for a local transfer is move.

```sh
drag_root=$(mktemp -d "${TMPDIR:-/tmp}/filepace-drag.XXXXXX")
mkdir "$drag_root/left" "$drag_root/right" "$drag_root/finder" "$drag_root/reference"

for file in window-move window-copy window-press-option window-release-option \
  to-finder-move to-finder-copy from-finder-move from-finder-copy
do
  printf 'Filepace drag fixture %s\n' "$file" > "$drag_root/reference/$file.txt"
  case $file in
    from-finder-*) cp "$drag_root/reference/$file.txt" "$drag_root/finder/" ;;
    *) cp "$drag_root/reference/$file.txt" "$drag_root/left/" ;;
  esac
done

printf '%s\n' "$drag_root"
```

Open `left` and `right` in separate Filepace windows using Command+N and the path bar. Open `finder` in Finder. Arrange the source and destination so both remain visible. Drop onto the destination file area, wait for the Filepace task to finish or for the Finder transfer to settle, then check the bytes and source state for each file.

| File stem | Source | Destination | Gesture | Expected |
| --- | --- | --- | --- | --- |
| `window-move` | `left` | `right` | Drag without Option | Move |
| `window-copy` | `left` | `right` | Hold Option from mouse-down through drop | Copy |
| `window-press-option` | `left` | `right` | Start without Option, cross the window boundary, then press Option while dragging and hold it through drop | Copy |
| `window-release-option` | `left` | `right` | Start with Option held, cross the window boundary, then release Option while dragging before drop | Move |
| `to-finder-move` | `left` | `finder` | Drag without Option | Move |
| `to-finder-copy` | `left` | `finder` | Hold Option through drop | Copy |
| `from-finder-move` | `finder` | `right` | Drag without Option | Move |
| `from-finder-copy` | `finder` | `right` | Hold Option through drop | Copy |

In the same Terminal session, load this check and run it with each row's file stem, source, destination, and expected operation in lowercase. A copy requires both files to match the reference. A move requires matching destination bytes and an absent source.

```sh
check_drag() {
  cmp "$drag_root/reference/$1.txt" "$drag_root/$3/$1.txt" || return 1
  case $4 in
    copy) cmp "$drag_root/reference/$1.txt" "$drag_root/$2/$1.txt" ;;
    move) test ! -e "$drag_root/$2/$1.txt" ;;
    *) return 2 ;;
  esac
}

check_drag window-press-option left right copy && printf 'PASS\n'
```

Record each result in [the platform notes](scope.md), including any case that could not be run. Remove the temporary fixture after verification.

## In-app updates

The release build signs the Windows NSIS installer and the macOS app archive with the repository's `FILEPACE_UPDATE_SIGNING_KEY` secret. Keep the matching private key backed up outside version control. The app verifies the artifact signature and the signed version against its embedded public key.

In-app updates use quiet NSIS installation under the current Windows user. The installer language selector is available when users run the installer manually.

Copy both signed artifacts and their `.sig` files into the directory containing the release assets. Run `node scripts/update-manifest.mjs VERSION ASSET_DIRECTORY` to produce `latest.json`. Upload the manifest, Mac app archive, and both signatures alongside the DMG and NSIS installer before publishing the latest release. [Tauri updater](https://v2.tauri.app/plugin/updater/)
