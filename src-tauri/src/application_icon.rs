use std::path::Path;

use crate::fs_safety::{entry_path, is_link};

#[cfg(any(target_os = "macos", windows))]
const ICON_SIZE: i32 = 256;

pub(crate) fn load(path: &Path) -> Result<Vec<u8>, String> {
    let path = entry_path(path)?;
    let metadata = path.symlink_metadata().map_err(|error| error.to_string())?;
    let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    let mac_app =
        cfg!(target_os = "macos") && metadata.is_dir() && extension.eq_ignore_ascii_case("app");
    let windows_app = cfg!(windows) && metadata.is_file() && extension.eq_ignore_ascii_case("exe");
    if is_link(&metadata) || !(mac_app || windows_app) {
        return Err("此项目不支持系统应用图标".into());
    }
    platform_icon(&path).ok_or_else(|| "系统应用图标不可用".into())
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
                    CLSID_WICImagingFactory, GUID_WICPixelFormat32bppRGBA, IWICImagingFactory,
                    WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom,
                    WICBitmapUsePremultipliedAlpha,
                },
            },
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_ICONONLY},
        },
    };

    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) {
            // This guard is constructed only after CoInitializeEx succeeds.
            unsafe { CoUninitialize() };
        }
    }

    let name: Vec<_> = path.as_os_str().encode_wide().chain([0]).collect();
    // All COM objects and the owned bitmap stay on this worker thread.
    unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            return None;
        }
        let _apartment = ComApartment;
        let item: IShellItemImageFactory =
            SHCreateItemFromParsingName(PCWSTR(name.as_ptr()), None).ok()?;
        let size = SIZE {
            cx: ICON_SIZE,
            cy: ICON_SIZE,
        };
        let bitmap = Owned::new(item.GetImage(size, SIIGBF_ICONONLY).ok()?);
        let wic: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
        let source = wic
            .CreateBitmapFromHBITMAP(*bitmap, HPALETTE::default(), WICBitmapUsePremultipliedAlpha)
            .ok()?;
        let converter = wic.CreateFormatConverter().ok()?;
        converter
            .Initialize(
                &source,
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

#[cfg(not(any(target_os = "macos", windows)))]
fn platform_icon(_: &Path) -> Option<Vec<u8>> {
    None
}
