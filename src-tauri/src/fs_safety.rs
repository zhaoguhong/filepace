use std::{
    fs::{File, Metadata},
    io::{self, ErrorKind},
    path::{Path, PathBuf},
    time::SystemTime,
};

pub(crate) fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

pub(crate) fn entry_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("请选择绝对文件路径".into());
    }
    let parent = path.parent().ok_or("请选择文件或文件夹")?;
    let name = path.file_name().ok_or("请选择文件或文件夹")?;
    Ok(crate::canonical(&crate::strpath(parent))?.join(name))
}

pub(crate) fn missing(path: &Path) -> io::Result<bool> {
    match path.symlink_metadata() {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error),
    }
}

pub(crate) fn check_ancestors(path: &Path) -> io::Result<()> {
    for parent in path.ancestors().skip(1) {
        match parent.symlink_metadata() {
            Ok(metadata) if metadata.is_dir() && !is_link(&metadata) => {}
            Ok(_) => return Err(io::Error::other("上级路径已变更或包含链接")),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Identity {
    volume: u64,
    file: u64,
    created: Option<SystemTime>,
}

impl Identity {
    pub(crate) fn at(path: &Path) -> io::Result<Self> {
        let metadata = path.symlink_metadata()?;
        if !(metadata.is_file() || metadata.is_dir() || is_link(&metadata)) {
            return Err(io::Error::other("特殊文件不支持撤销"));
        }
        #[cfg(unix)]
        return Ok(Self::from_metadata(&metadata));
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            };
            let file = std::fs::OpenOptions::new()
                .access_mode(0)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)?;
            Self::from_file(&file)
        }
    }

    #[cfg(unix)]
    fn from_metadata(metadata: &Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            volume: metadata.dev(),
            file: metadata.ino(),
            created: metadata.created().ok(),
        }
    }

    pub(crate) fn from_file(file: &File) -> io::Result<Self> {
        let metadata = file.metadata()?;
        #[cfg(unix)]
        return Ok(Self::from_metadata(&metadata));
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{
                GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            };
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self {
                volume: u64::from(info.dwVolumeSerialNumber),
                file: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
                created: metadata.created().ok(),
            })
        }
    }
}

#[cfg(unix)]
pub(crate) fn rename_exclusive(from: &Path, to: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub(crate) fn rename_exclusive(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    // Canonicalize the parents to get extended-length paths without following
    // a link at the entry itself.
    let wide_path = |path: &Path| -> io::Result<Vec<u16>> {
        let parent = path
            .parent()
            .ok_or(ErrorKind::InvalidInput)?
            .canonicalize()?;
        let full = parent.join(path.file_name().ok_or(ErrorKind::InvalidInput)?);
        let wide: Vec<_> = full.as_os_str().encode_wide().collect();
        if wide.contains(&0) {
            return Err(ErrorKind::InvalidInput.into());
        }
        Ok(wide.into_iter().chain([0]).collect())
    };
    let from = wide_path(from)?;
    let to = wide_path(to)?;
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
