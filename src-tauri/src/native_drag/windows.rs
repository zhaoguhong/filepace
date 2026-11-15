use std::{os::windows::ffi::OsStrExt, path::PathBuf};

use windows::{
    core::{Error, PCWSTR},
    Win32::{
        Foundation::{GlobalFree, E_FAIL},
        System::{
            Com::{
                IDataObject, DVASPECT_CONTENT, FORMATETC, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL,
            },
            DataExchange::RegisterClipboardFormatW,
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
            Ole::{IDropSource, DROPEFFECT_COPY, DROPEFFECT_MOVE},
        },
        UI::Shell::{
            BHID_DataObject, ILCreateFromPathW, ILFree, SHCreateShellItemArrayFromIDLists,
            SHDoDragDrop, CFSTR_PREFERREDDROPEFFECT,
        },
    },
};

pub(super) fn start(
    window: &tauri::Window,
    paths: Vec<PathBuf>,
    _image: drag::Image,
    finished: impl Fn(),
) -> Result<(), String> {
    let result = (|| -> windows::core::Result<()> {
        let mut ids = Vec::new();
        for path in paths {
            let wide: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let id = unsafe { ILCreateFromPathW(PCWSTR(wide.as_ptr())) };
            if id.is_null() {
                for id in ids {
                    unsafe { ILFree(Some(id)) };
                }
                return Err(Error::from_hresult(E_FAIL));
            }
            ids.push(id.cast_const());
        }
        let array = unsafe { SHCreateShellItemArrayFromIDLists(&ids) };
        for id in ids {
            unsafe { ILFree(Some(id)) };
        }
        let data: IDataObject = unsafe { array?.BindToHandler(None, &BHID_DataObject) }?;
        prefer_move(&data)?;
        // The Shell supplies the drag source and image, tracks Ctrl throughout
        // the gesture, and lets Explorer execute the transfer. Never delete any
        // source merely because the drag loop reports a successful drop.
        unsafe {
            SHDoDragDrop(
                Some(window.hwnd().map_err(|_| Error::from_hresult(E_FAIL))?),
                &data,
                None::<&IDropSource>,
                DROPEFFECT_MOVE | DROPEFFECT_COPY,
            )
        }?;
        Ok(())
    })();
    finished();
    result.map_err(|error| error.to_string())
}

fn prefer_move(data: &IDataObject) -> windows::core::Result<()> {
    unsafe {
        let format = RegisterClipboardFormatW(CFSTR_PREFERREDDROPEFFECT);
        if format == 0 {
            return Err(Error::from_thread());
        }
        let memory = GlobalAlloc(GMEM_MOVEABLE, size_of::<u32>())?;
        let pointer = GlobalLock(memory);
        if pointer.is_null() {
            let _ = GlobalFree(Some(memory));
            return Err(Error::from_thread());
        }
        pointer.cast::<u32>().write(DROPEFFECT_MOVE.0);
        let _ = GlobalUnlock(memory);
        let format = FORMATETC {
            cfFormat: format as u16,
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
            ..Default::default()
        };
        let medium = STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: memory },
            pUnkForRelease: std::mem::ManuallyDrop::new(None),
        };
        let result = data.SetData(&format, &medium, true);
        if result.is_err() {
            let _ = GlobalFree(Some(memory));
        }
        result
    }
}
