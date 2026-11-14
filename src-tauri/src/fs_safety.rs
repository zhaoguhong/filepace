use std::{
    collections::HashMap,
    fs::{File, Metadata},
    io::{self, ErrorKind},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

fn protected_paths() -> &'static Mutex<HashMap<PathBuf, usize>> {
    static PATHS: OnceLock<Mutex<HashMap<PathBuf, usize>>> = OnceLock::new();
    PATHS.get_or_init(Mutex::default)
}

fn protected_path_key(path: &Path) -> PathBuf {
    // Windows and most macOS volumes resolve names without case sensitivity.
    // Conservatively protect case aliases even on case-sensitive volumes.
    #[cfg(any(windows, target_os = "macos"))]
    return PathBuf::from(path.to_string_lossy().to_lowercase());
    #[cfg(not(any(windows, target_os = "macos")))]
    path.to_path_buf()
}

/// Keep a transfer's private staging area out of other user mutations while
/// its task releases the mutation lock. Internal transfer commits do not use
/// this user-entry-point check.
pub(crate) struct ProtectedPath(PathBuf);

pub(crate) fn protect_mutation_path(path: &Path) -> ProtectedPath {
    let path = protected_path_key(path);
    *protected_paths()
        .lock()
        .unwrap()
        .entry(path.clone())
        .or_default() += 1;
    ProtectedPath(path)
}

impl Drop for ProtectedPath {
    fn drop(&mut self) {
        let mut paths = protected_paths().lock().unwrap();
        if let Some(count) = paths.get_mut(&self.0) {
            *count -= 1;
            if *count == 0 {
                paths.remove(&self.0);
            }
        }
    }
}

pub(crate) fn ensure_not_internal_path(path: &Path) -> Result<(), String> {
    if path.components().any(|part| {
        let name = part.as_os_str().to_string_lossy().to_ascii_lowercase();
        name.starts_with(".filepace-stage-") || name.starts_with(".filepace-replaced-")
    }) {
        return Err("这是 Filepace 的传输暂存或恢复位置，请先完成文件任务".into());
    }
    Ok(())
}

/// Check the concrete item being created, removed or replaced. Destination
/// folders may enclose a staging area, so callers should check the final child
/// target, rather than disallowing all writes to that containing folder.
pub(crate) fn ensure_mutation_path(path: &Path) -> Result<(), String> {
    ensure_not_internal_path(path)?;
    let path = protected_path_key(path);
    if protected_paths()
        .lock()
        .unwrap()
        .keys()
        .any(|protected| path.starts_with(protected) || protected.starts_with(&path))
    {
        return Err("此位置包含正在传输的暂存文件，请先完成文件任务".into());
    }
    Ok(())
}

#[cfg(test)]
mod mutation_path_tests {
    use super::*;

    #[test]
    fn reserves_private_stage_and_backup_components() {
        let root = tempfile::tempdir().unwrap();
        for name in [
            ".filepace-stage-active",
            ".filepace-replaced-old",
            ".FILEPACE-STAGE-CASE",
        ] {
            let private = root.path().join(name);
            assert!(ensure_mutation_path(&private).is_err());
            assert!(ensure_mutation_path(&private.join("item")).is_err());
        }
        assert!(ensure_mutation_path(&root.path().join("filepace-stage-not-private")).is_ok());
    }

    #[test]
    fn protects_active_stage_ancestors_but_allows_unrelated_destination_children() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let source = root.join("source.txt");
        let destination = root.join("destination");
        std::fs::write(&source, b"source bytes").unwrap();
        std::fs::create_dir(&destination).unwrap();
        let stage = destination.join("private-transfer");
        std::fs::create_dir(&stage).unwrap();
        let payload = stage.join("item");
        std::fs::write(&payload, b"staged bytes").unwrap();
        let protection = protect_mutation_path(&stage);
        assert!(ensure_mutation_path(&stage).is_err());
        assert!(ensure_mutation_path(&payload).is_err());
        assert!(ensure_mutation_path(&destination).is_err());
        assert!(ensure_mutation_path(&root).is_err());
        assert!(ensure_mutation_path(&source).is_ok());
        assert!(ensure_mutation_path(&destination.join("other.txt")).is_ok());
        assert_eq!(std::fs::read(&source).unwrap(), b"source bytes");
        assert_eq!(std::fs::read(&payload).unwrap(), b"staged bytes");
        drop(protection);
        assert!(ensure_mutation_path(&destination).is_ok());
    }

    #[test]
    fn protection_lasts_until_the_last_guard_is_dropped() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let first = protect_mutation_path(&root);
        let second = protect_mutation_path(&root);
        drop(first);
        assert!(ensure_mutation_path(&root).is_err());
        drop(second);
        assert!(ensure_mutation_path(&root).is_ok());
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn protects_case_aliases_of_active_staging_ancestors() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let destination = root.join("MixedDestination");
        let stage = destination.join("private-transfer");
        let _protection = protect_mutation_path(&stage);
        assert!(ensure_mutation_path(&root.join("MIXEDDESTINATION")).is_err());
        assert!(
            ensure_mutation_path(&root.join("mixeddestination/private-transfer/item")).is_err()
        );
        assert!(ensure_mutation_path(&root.join("MixedDestination/other.txt")).is_ok());
    }
}

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

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Identity {
    volume: u64,
    file: u64,
    created: Option<SystemTime>,
}

impl Identity {
    pub(crate) fn same_file_after_rename(&self, current: &Self) -> bool {
        self.volume == current.volume
            && self.file == current.file
            // NTFS can restore a name's cached creation time during a rename.
            && (cfg!(windows) || self.created == current.created)
    }

    pub(crate) fn at(path: &Path) -> io::Result<Self> {
        let metadata = path.symlink_metadata()?;
        Self::from_path(path, &metadata)
    }

    fn from_path(_path: &Path, metadata: &Metadata) -> io::Result<Self> {
        if !(metadata.is_file() || metadata.is_dir() || is_link(metadata)) {
            return Err(io::Error::other("特殊文件不支持撤销"));
        }
        #[cfg(unix)]
        return Ok(Self::from_metadata(metadata));
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            };
            let file = std::fs::OpenOptions::new()
                .access_mode(0)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(_path)?;
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub(crate) identity: Identity,
    size: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    changed: (i64, i64),
}

impl Snapshot {
    pub(crate) fn at(path: &Path, metadata: &Metadata) -> io::Result<Self> {
        Ok(Self::new(Identity::from_path(path, metadata)?, metadata))
    }

    pub(crate) fn from_file(file: &File, metadata: &Metadata) -> io::Result<Self> {
        Ok(Self::new(Identity::from_file(file)?, metadata))
    }

    fn new(identity: Identity, metadata: &Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            identity,
            size: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            changed: (metadata.ctime(), metadata.ctime_nsec()),
        }
    }

    pub(crate) fn matches(&self, path: &Path) -> bool {
        path.symlink_metadata()
            .and_then(|metadata| Self::at(path, &metadata))
            .as_ref()
            .ok()
            == Some(self)
    }

    pub(crate) fn matches_after_rename(&self, path: &Path) -> bool {
        path.symlink_metadata()
            .and_then(|metadata| Self::at(path, &metadata))
            .is_ok_and(|current| {
                current.identity == self.identity
                    && current.size == self.size
                    && current.modified == self.modified
            })
    }
}

pub(crate) struct Directory {
    pub(crate) path: PathBuf,
    identity: Identity,
}

impl Directory {
    pub(crate) fn at(path: &Path) -> io::Result<Self> {
        let metadata = path.symlink_metadata()?;
        if !metadata.is_dir() || is_link(&metadata) {
            return Err(io::Error::other("上级路径不是普通文件夹"));
        }
        Ok(Self {
            path: path.to_owned(),
            identity: Identity::from_path(path, &metadata)?,
        })
    }

    pub(crate) fn parent(path: &Path) -> io::Result<Self> {
        Self::at(path.parent().ok_or(ErrorKind::InvalidInput)?)
    }

    pub(crate) fn check(&self) -> Result<(), String> {
        if Identity::at(&self.path).as_ref().ok() == Some(&self.identity) {
            Ok(())
        } else {
            Err(format!("上级文件夹已变更：{}", self.path.display()))
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
pub(crate) fn wide_path(path: &Path) -> io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;
    // Canonicalize the parents to get extended-length paths without following
    // a link at the entry itself.
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
}

#[cfg(windows)]
pub(crate) fn rename_exclusive(from: &Path, to: &Path) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let from = wide_path(from)?;
    let to = wide_path(to)?;
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
