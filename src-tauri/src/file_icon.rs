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
            UI::{
                Controls::{IImageList, ILD_TRANSPARENT},
                Shell::{
                    IShellItemImageFactory, SHCreateItemFromParsingName, SHGetFileInfoW,
                    SHGetImageList, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_SYSICONINDEX,
                    SHIL_EXTRALARGE, SHIL_JUMBO, SIIGBF_ICONONLY,
                },
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
            let mut bitmap = image::RgbaImage::from_raw(width, height, rgba)?;
            let (mut left, mut top, mut right, mut bottom) = (width, height, 0, 0);
            for (x, y, pixel) in bitmap.enumerate_pixels() {
                if pixel[3] == 0 {
                    continue;
                }
                left = left.min(x);
                top = top.min(y);
                right = right.max(x);
                bottom = bottom.max(y);
            }
            // A jumbo image list may pad an old 16/32-pixel icon onto a 256-pixel
            // canvas. Remove that excess canvas so small icons remain visible.
            if width >= 128
                && height >= 128
                && right - left + 1 <= width / 4
                && bottom - top + 1 <= height / 4
            {
                bitmap = image::imageops::crop_imm(
                    &bitmap,
                    left,
                    top,
                    right - left + 1,
                    bottom - top + 1,
                )
                .to_image();
            }
            let mut png = Vec::new();
            image::codecs::png::PngEncoder::new(&mut png)
                .write_image(
                    bitmap.as_raw(),
                    bitmap.width(),
                    bitmap.height(),
                    image::ExtendedColorType::Rgba8,
                )
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
        // Explorer's per-item image index honors shortcut IconLocation. The
        // image factory can successfully return only the generic .lnk class icon.
        let from_shell = (|| {
            let mut info = SHFILEINFOW::default();
            if SHGetFileInfoW(
                PCWSTR(name.as_ptr()),
                FILE_FLAGS_AND_ATTRIBUTES(0),
                Some(&mut info),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_SYSICONINDEX | SHGFI_ICON | SHGFI_LARGEICON,
            ) == 0
            {
                return None;
            }
            let legacy_icon = Owned::new(info.hIcon);
            for size in [SHIL_JUMBO, SHIL_EXTRALARGE] {
                let Ok(list) = SHGetImageList::<IImageList>(size as i32) else {
                    continue;
                };
                let Ok(icon) = list.GetIcon(info.iIcon, ILD_TRANSPARENT.0) else {
                    continue;
                };
                let icon = Owned::new(icon);
                let Ok(source) = wic.CreateBitmapFromHICON(*icon) else {
                    continue;
                };
                if let Some(png) = encode(&wic, &source) {
                    return Some(png);
                }
            }
            // Old handlers may only provide a mask-based 32-pixel icon.
            if legacy_icon.is_invalid() {
                return None;
            }
            let source = wic.CreateBitmapFromHICON(*legacy_icon).ok()?;
            encode(&wic, &source)
        })();
        if from_shell.is_some() {
            return from_shell;
        }
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
        high_resolution
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
        fn write_icon(path: &Path, color: [u8; 4]) {
            // A 32x32 uncompressed ICO with an opaque BGRA bitmap and AND mask.
            let mut bytes = vec![0, 0, 1, 0, 1, 0, 32, 32, 0, 0];
            bytes.extend_from_slice(&1_u16.to_le_bytes());
            bytes.extend_from_slice(&32_u16.to_le_bytes());
            bytes.extend_from_slice(&(40_u32 + 32 * 32 * 4 + 32 * 4).to_le_bytes());
            bytes.extend_from_slice(&22_u32.to_le_bytes());
            bytes.extend_from_slice(&40_u32.to_le_bytes());
            bytes.extend_from_slice(&32_i32.to_le_bytes());
            bytes.extend_from_slice(&64_i32.to_le_bytes());
            bytes.extend_from_slice(&1_u16.to_le_bytes());
            bytes.extend_from_slice(&32_u16.to_le_bytes());
            bytes.extend_from_slice(&[0; 24]);
            for _ in 0..32 * 32 {
                bytes.extend_from_slice(&color)
            }
            bytes.extend_from_slice(&[0; 32 * 4]);
            fs::write(path, bytes).unwrap();
        }
        let red = fixture.path().join("red.ico");
        let green = fixture.path().join("green.ico");
        write_icon(&red, [0, 0, 240, 255]);
        write_icon(&green, [0, 220, 0, 255]);
        // Generate fixtures through Unicode Shell interfaces, avoiding external
        // script encoding and argument parsing.
        fn create_link(path: &Path, target: &Path, icon: &Path) {
            use std::os::windows::ffi::OsStrExt;
            use windows::{
                core::{Interface, PCWSTR},
                Win32::{
                    System::Com::{
                        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile,
                        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
                    },
                    UI::Shell::{IShellLinkW, ShellLink},
                },
            };
            struct Apartment;
            impl Drop for Apartment {
                fn drop(&mut self) {
                    unsafe { CoUninitialize() };
                }
            }
            let wide = |path: &Path| {
                path.as_os_str()
                    .encode_wide()
                    .chain([0])
                    .collect::<Vec<_>>()
            };
            unsafe {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
                let _apartment = Apartment;
                let link: IShellLinkW =
                    CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
                link.SetPath(PCWSTR(wide(target).as_ptr())).unwrap();
                link.SetIconLocation(PCWSTR(wide(icon).as_ptr()), 0)
                    .unwrap();
                let file: IPersistFile = link.cast().unwrap();
                file.Save(PCWSTR(wide(path).as_ptr()), true).unwrap();
            }
        }
        create_link(&first, &target, &red);
        create_link(&second, &target, &green);
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
        let first_image = image::load_from_memory(&first_png).unwrap().to_rgba8();
        let second_image = image::load_from_memory(&second_png).unwrap().to_rgba8();
        assert!(first_image
            .pixels()
            .any(|pixel| pixel[0] > 180 && pixel[1] < 60 && pixel[3] > 200));
        assert!(second_image
            .pixels()
            .any(|pixel| pixel[1] > 180 && pixel[0] < 60 && pixel[3] > 200));
        for bitmap in [&first_image, &second_image] {
            let occupied = bitmap.pixels().filter(|pixel| pixel[3] > 200).count();
            assert!(
                occupied * 4 >= (bitmap.width() * bitmap.height()) as usize,
                "small shortcut icons must remain visible in a jumbo image list"
            );
        }
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
