use std::path::Path;

use crate::fs_safety::{entry_path, is_link};

#[cfg(any(target_os = "macos", windows))]
const ICON_SIZE: i32 = 256;

pub(crate) fn load(path: &Path) -> Result<Vec<u8>, String> {
    let path = entry_path(path)?;
    let metadata = path.symlink_metadata().map_err(|error| error.to_string())?;
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mac_icon = cfg!(target_os = "macos")
        && ((metadata.is_dir()
            && matches!(
                extension.as_str(),
                "app" | "pkg" | "mpkg" | "framework" | "sparsebundle"
            ))
            || (metadata.is_file()
                && matches!(
                    extension.as_str(),
                    "pkg" | "mpkg" | "dmg" | "icns" | "webloc"
                )));
    let windows_icon = cfg!(windows)
        && metadata.is_file()
        && matches!(
            extension.as_str(),
            "exe"
                | "com"
                | "scr"
                | "cpl"
                | "lnk"
                | "url"
                | "website"
                | "appref-ms"
                | "msi"
                | "msix"
                | "msixbundle"
                | "appx"
                | "appxbundle"
                | "ico"
        );
    if is_link(&metadata) || !(mac_icon || windows_icon) {
        return Err("此项目不支持系统文件图标".into());
    }
    // Ask the OS about the shortcut itself so custom IconLocation, installer and
    // URL icons are preserved. Never resolve or launch a shortcut's target here.
    platform_icon(&path).ok_or_else(|| "系统文件图标不可用".into())
}

#[cfg(target_os = "macos")]
fn platform_icon(path: &Path) -> Option<Vec<u8>> {
    use objc2::{rc::autoreleasepool, AnyThread};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

    autoreleasepool(|_| {
        let icon = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(path.to_str()?));
        let size = f64::from(ICON_SIZE);
        let mut rect = NSRect::new(NSPoint::new(0., 0.), NSSize::new(size, size));
        // The proposed rectangle is valid for the call. AppKit chooses the image representation.
        let image = unsafe { icon.CGImageForProposedRect_context_hints(&mut rect, None, None)? };
        let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &image);
        if !(1..=1024).contains(&bitmap.pixelsWide()) || !(1..=1024).contains(&bitmap.pixelsHigh())
        {
            return None;
        }
        let properties = NSDictionary::new();
        let png = unsafe {
            bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)?
        };
        (png.len() <= 2 * 1024 * 1024).then(|| png.to_vec())
    })
}

#[cfg(windows)]
fn platform_icon(path: &Path) -> Option<Vec<u8>> {
    use image::ImageEncoder;
    use std::{os::windows::ffi::OsStrExt, ptr::null};
    use windows::{
        core::{Owned, PCWSTR},
        Win32::{
            Foundation::SIZE,
            Graphics::{
                Gdi::HPALETTE,
                Imaging::{
                    CLSID_WICImagingFactory, GUID_WICPixelFormat32bppRGBA, IWICBitmap,
                    IWICImagingFactory, WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom,
                    WICBitmapUsePremultipliedAlpha,
                },
            },
            Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES,
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            UI::Shell::{
                IShellItemImageFactory, SHCreateItemFromParsingName, SHGetFileInfoW, SHFILEINFOW,
                SHGFI_ICON, SHGFI_LARGEICON, SIIGBF_ICONONLY,
            },
        },
    };

    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) {
            // This guard is constructed only after CoInitializeEx succeeds.
            unsafe { CoUninitialize() };
        }
    }

    fn encode(wic: &IWICImagingFactory, source: &IWICBitmap) -> Option<Vec<u8>> {
        // The bitmap and converter are used only while their COM apartment is alive.
        unsafe {
            let converter = wic.CreateFormatConverter().ok()?;
            converter
                .Initialize(
                    source,
                    &GUID_WICPixelFormat32bppRGBA,
                    WICBitmapDitherTypeNone,
                    None,
                    0.,
                    WICBitmapPaletteTypeCustom,
                )
                .ok()?;
            let (mut width, mut height) = (0, 0);
            converter.GetSize(&mut width, &mut height).ok()?;
            if !(1..=512).contains(&width) || !(1..=512).contains(&height) {
                return None;
            }
            let stride = width * 4;
            let mut rgba = vec![0; (stride * height) as usize];
            converter.CopyPixels(null(), stride, &mut rgba).ok()?;
            if rgba.chunks_exact(4).all(|pixel| pixel[3] == 0) {
                return None;
            }
            let mut png = Vec::new();
            image::codecs::png::PngEncoder::new(&mut png)
                .write_image(&rgba, width, height, image::ExtendedColorType::Rgba8)
                .ok()?;
            Some(png)
        }
    }

    let name: Vec<_> = path.as_os_str().encode_wide().chain([0]).collect();
    // All COM objects and owned Shell handles stay on this worker thread.
    unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            return None;
        }
        let _apartment = ComApartment;
        let wic: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
        let high_resolution = (|| {
            let item: IShellItemImageFactory =
                SHCreateItemFromParsingName(PCWSTR(name.as_ptr()), None).ok()?;
            let size = SIZE {
                cx: ICON_SIZE,
                cy: ICON_SIZE,
            };
            let bitmap = Owned::new(item.GetImage(size, SIIGBF_ICONONLY).ok()?);
            let source = wic
                .CreateBitmapFromHBITMAP(
                    *bitmap,
                    HPALETTE::default(),
                    WICBitmapUsePremultipliedAlpha,
                )
                .ok()?;
            encode(&wic, &source)
        })();
        if high_resolution.is_some() {
            return high_resolution;
        }

        // Legacy handlers and mask-based icons may not provide a usable ARGB bitmap.
        // WIC converts the Shell HICON, including its transparency mask, for the fallback.
        let mut info = SHFILEINFOW::default();
        if SHGetFileInfoW(
            PCWSTR(name.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        ) == 0
            || info.hIcon.is_invalid()
        {
            return None;
        }
        let icon = Owned::new(info.hIcon);
        let source = wic.CreateBitmapFromHICON(*icon).ok()?;
        encode(&wic, &source)
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn platform_icon(_: &Path) -> Option<Vec<u8>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_unsupported_files_and_shortcut_named_directories() {
        let fixture = tempfile::tempdir().unwrap();
        let text = fixture.path().join("script.py");
        fs::write(&text, b"print('unchanged')").unwrap();
        assert!(load(&text).is_err());
        assert_eq!(fs::read(&text).unwrap(), b"print('unchanged')");
        let directory = fixture.path().join("folder.lnk");
        fs::create_dir(&directory).unwrap();
        assert!(load(&directory).is_err());
        assert!(load(Path::new("relative.lnk")).is_err());
        assert!(load(&fixture.path().join("missing.lnk")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symbolic_links_without_following_the_target() {
        let fixture = tempfile::tempdir().unwrap();
        let target = fixture.path().join("target.app");
        fs::create_dir(&target).unwrap();
        let link = fixture.path().join("linked.app");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(load(&link).is_err());
        fs::remove_dir(target).unwrap();
        assert!(load(&link).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn loads_native_package_and_web_shortcut_icons() {
        let fixture = tempfile::tempdir().unwrap();
        let app = fixture.path().join("Example.APP");
        fs::create_dir(&app).unwrap();
        let installer = fixture.path().join("Example.pkg");
        fs::write(&installer, b"installer fixture").unwrap();
        let shortcut = fixture.path().join("Example.webloc");
        let contents = b"<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>URL</key><string>https://example.com/</string></dict></plist>";
        fs::write(&shortcut, contents).unwrap();
        for path in [&app, &installer, &shortcut] {
            let png = load(path).unwrap();
            assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
            assert!(image::load_from_memory(&png).is_ok());
        }
        assert_eq!(fs::read(shortcut).unwrap(), contents);
        assert_eq!(fs::read(installer).unwrap(), b"installer fixture");
    }

    #[cfg(windows)]
    #[test]
    fn loads_each_windows_shortcuts_custom_icon_without_changing_files() {
        let fixture = tempfile::tempdir().unwrap();
        let target = fixture.path().join("target.txt");
        fs::write(&target, b"shortcut target stays untouched").unwrap();
        let first = fixture.path().join("First 快捷方式.LNK");
        let second = fixture.path().join("Second 快捷方式.lnk");
        // Use the native Shell link writer; no hand-built .lnk parser or target launch.
        let result = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference = 'Stop'; $shell = New-Object -ComObject WScript.Shell; foreach ($pair in @(@($env:FILEPACE_FIRST_ICON, 3), @($env:FILEPACE_SECOND_ICON, 4))) { $link = $shell.CreateShortcut($pair[0]); $link.TargetPath = $env:FILEPACE_ICON_TARGET; $link.IconLocation = \"$env:WINDIR\\System32\\shell32.dll,$($pair[1])\"; $link.Save() }",
            ])
            .env("FILEPACE_FIRST_ICON", &first)
            .env("FILEPACE_SECOND_ICON", &second)
            .env("FILEPACE_ICON_TARGET", &target)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let first_contents = fs::read(&first).unwrap();
        let second_contents = fs::read(&second).unwrap();
        let first_png = load(&first).unwrap();
        let second_png = load(&second).unwrap();
        for png in [&first_png, &second_png] {
            assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
            assert!(image::load_from_memory(png).is_ok());
        }
        assert_ne!(
            first_png, second_png,
            "custom shortcut icons must not collapse to the .lnk type icon"
        );
        assert_eq!(fs::read(first).unwrap(), first_contents);
        assert_eq!(fs::read(second).unwrap(), second_contents);
        let url = fixture.path().join("Website.URL");
        let url_contents = format!(
            "[InternetShortcut]\r\nURL=https://example.com/\r\nIconFile={}\\System32\\shell32.dll\r\nIconIndex=3\r\n",
            std::env::var("WINDIR").unwrap()
        );
        fs::write(&url, &url_contents).unwrap();
        assert!(image::load_from_memory(&load(&url).unwrap()).is_ok());
        assert_eq!(fs::read_to_string(url).unwrap(), url_contents);
        assert_eq!(
            fs::read(target).unwrap(),
            b"shortcut target stays untouched"
        );
    }
}
