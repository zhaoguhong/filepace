use std::{
    collections::{BTreeMap, HashMap},
    fs::Metadata,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{Emitter, EventTarget, State, Window};
use walkdir::WalkDir;

use crate::{strpath, Place};

const TOP_ITEMS: usize = 12;
const PROGRESS_EVENT: &str = "filepace-storage-progress";

#[derive(Serialize)]
pub struct Volume {
    name: String,
    path: String,
    total: Option<u64>,
    available: Option<u64>,
}

impl Volume {
    fn new(name: String, path: String, capacity: Option<(u64, u64)>) -> Self {
        Self {
            name,
            path,
            total: capacity.map(|(total, _)| total),
            available: capacity.map(|(total, available)| available.min(total)),
        }
    }
}

pub(crate) fn disk_places() -> Vec<Place> {
    volumes(false)
        .into_iter()
        .map(|volume| Place {
            name: volume.name,
            path: volume.path,
            kind: "disk".into(),
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn volumes(read_capacity: bool) -> Vec<Volume> {
    use std::{ffi::CStr, mem, ptr};

    // MNT_NOWAIT uses cached mount information without waking network or removable volumes.
    let count = unsafe { libc::getfsstat(ptr::null_mut(), 0, libc::MNT_NOWAIT) };
    if count <= 0 {
        return vec![Volume::new("系统磁盘".into(), "/".into(), None)];
    }
    let mut mounts = vec![unsafe { mem::zeroed::<libc::statfs>() }; count as usize + 8];
    let bytes = (mounts.len() * mem::size_of::<libc::statfs>()) as libc::c_int;
    let read = unsafe { libc::getfsstat(mounts.as_mut_ptr(), bytes, libc::MNT_NOWAIT) };
    let mut volumes: Vec<_> = mounts
        .into_iter()
        .take(read.max(0) as usize)
        .filter_map(|mount| {
            let mount_path = unsafe { CStr::from_ptr(mount.f_mntonname.as_ptr()) };
            let path = mount_path.to_string_lossy();
            let name = if path == "/" {
                "系统磁盘".into()
            } else {
                let name = path.strip_prefix("/Volumes/")?;
                if name.is_empty() || name.starts_with('.') {
                    return None;
                }
                name.into()
            };
            let mut stats = mount;
            if read_capacity && mount.f_flags & libc::MNT_LOCAL as u32 != 0 {
                let _ = unsafe { libc::statfs(mount_path.as_ptr(), &mut stats) };
            }
            let block = u64::from(stats.f_bsize);
            let total = stats.f_blocks.saturating_mul(block);
            let available = stats.f_bavail.saturating_mul(block);
            Some(Volume::new(
                name,
                path.into_owned(),
                (total > 0).then_some((total, available)),
            ))
        })
        .collect();
    if !volumes.iter().any(|volume| volume.path == "/") {
        volumes.push(Volume::new("系统磁盘".into(), "/".into(), None));
    }
    volumes.sort_by(|a, b| a.path.cmp(&b.path));
    volumes
}

#[cfg(windows)]
fn volumes(read_capacity: bool) -> Vec<Volume> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
    };
    // Win32 GetDriveTypeW returns DRIVE_REMOTE (4) for a network drive.
    const DRIVE_REMOTE: u32 = 4;
    let mask = unsafe { GetLogicalDrives() };
    (0..26)
        .filter(|index| mask & (1 << index) != 0)
        .map(|index| {
            let letter = (b'A' + index) as char;
            let path = format!("{letter}:\\");
            let wide: Vec<u16> = path.encode_utf16().chain([0]).collect();
            let remote = unsafe { GetDriveTypeW(wide.as_ptr()) } == DRIVE_REMOTE;
            let mut name = format!("{} ({letter}:)", if remote { "网络驱动器" } else { "磁盘" });
            let mut capacity = None;
            if read_capacity && !remote {
                let (mut total, mut available) = (0, 0);
                if unsafe {
                    GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, null_mut())
                } != 0
                    && total > 0
                {
                    capacity = Some((total, available));
                    let mut label = [0u16; 261];
                    if unsafe {
                        GetVolumeInformationW(
                            wide.as_ptr(),
                            label.as_mut_ptr(),
                            label.len() as u32,
                            null_mut(),
                            null_mut(),
                            null_mut(),
                            null_mut(),
                            0,
                        )
                    } != 0
                    {
                        let end = label.iter().position(|&ch| ch == 0).unwrap_or(label.len());
                        if end > 0 {
                            name =
                                format!("{} ({letter}:)", String::from_utf16_lossy(&label[..end]));
                        }
                    }
                }
            }
            Volume::new(name, path, capacity)
        })
        .collect()
}

#[cfg(not(any(target_os = "macos", windows)))]
fn volumes(_read_capacity: bool) -> Vec<Volume> {
    vec![Volume::new("系统磁盘".into(), "/".into(), None)]
}

#[tauri::command]
pub async fn storage_volumes() -> Result<Vec<Volume>, String> {
    tauri::async_runtime::spawn_blocking(|| volumes(true))
        .await
        .map_err(|error| error.to_string())
}

#[derive(Clone, Default, Serialize)]
pub struct ScanCounts {
    files: u64,
    folders: u64,
    bytes: u64,
    skipped: u64,
}

#[derive(Serialize)]
struct RankedItem {
    path: String,
    name: String,
    parent: String,
    size: u64,
    files: u64,
}

impl RankedItem {
    fn new(path: &Path, size: u64, files: u64) -> Self {
        Self {
            path: strpath(path),
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            parent: path.parent().map(strpath).unwrap_or_default(),
            size,
            files,
        }
    }
}

fn rank(items: &mut Vec<RankedItem>, item: RankedItem) {
    items.push(item);
    items.sort_unstable_by(|a, b| b.size.cmp(&a.size).then(a.path.cmp(&b.path)));
    items.truncate(TOP_ITEMS);
}

#[derive(Default, Serialize)]
struct Category {
    files: u64,
    bytes: u64,
    largest: Vec<RankedItem>,
}

#[derive(Serialize)]
pub struct StorageReport {
    path: String,
    counts: ScanCounts,
    categories: BTreeMap<&'static str, Category>,
    folders: Vec<RankedItem>,
}

fn category_for(path: &Path) -> &'static str {
    static BY_EXTENSION: OnceLock<HashMap<String, String>> = OnceLock::new();
    let types = BY_EXTENSION.get_or_init(|| {
        let kinds: HashMap<String, [String; 3]> =
            serde_json::from_str(include_str!("../../src/fileKinds.json"))
                .expect("the bundled file kinds must be valid");
        kinds
            .into_values()
            .flat_map(|[_, extensions, category]| {
                extensions
                    .split_whitespace()
                    .map(|extension| (extension.to_owned(), category.clone()))
                    .collect::<Vec<_>>()
            })
            .collect()
    });
    path.extension()
        .and_then(|ext| ext.to_str())
        .and_then(|ext| types.get(&ext.to_ascii_lowercase()))
        .map_or("other", String::as_str)
}

fn skip_entry(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    !metadata.is_file() && !metadata.is_dir()
}

fn scan(
    root: &Path,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(&ScanCounts),
) -> Result<Option<StorageReport>, String> {
    if cancelled.load(Ordering::Relaxed) {
        return Ok(None);
    }
    let root = dunce::canonicalize(root).map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("请选择要扫描的文件夹".into());
    }
    let mut report = StorageReport {
        path: strpath(&root),
        counts: ScanCounts::default(),
        categories: BTreeMap::new(),
        folders: Vec::new(),
    };
    let mut walker = WalkDir::new(&root)
        .min_depth(1)
        .follow_links(false)
        .follow_root_links(false)
        .same_file_system(true)
        .into_iter();
    let mut branch: Option<RankedItem> = None;
    let mut last_update = Instant::now();
    while let Some(entry) = walker.next() {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(None);
        }
        if last_update.elapsed() >= Duration::from_millis(250) {
            progress(&report.counts);
            last_update = Instant::now();
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) if error.depth() == 0 => return Err(error.to_string()),
            Err(_) => {
                report.counts.skipped += 1;
                continue;
            }
        };
        if entry.depth() == 1 {
            if let Some(item) = branch.take() {
                rank(&mut report.folders, item);
            }
        }
        let Ok(metadata) = entry.metadata() else {
            report.counts.skipped += 1;
            if entry.file_type().is_dir() {
                walker.skip_current_dir();
            }
            continue;
        };
        if skip_entry(&metadata) {
            report.counts.skipped += 1;
            if entry.file_type().is_dir() {
                walker.skip_current_dir();
            }
            continue;
        }
        if metadata.is_dir() {
            report.counts.folders += 1;
            if entry.depth() == 1 {
                branch = Some(RankedItem::new(entry.path(), 0, 0));
            }
            continue;
        }
        let size = metadata.len();
        report.counts.files += 1;
        report.counts.bytes = report.counts.bytes.saturating_add(size);
        if let Some(folder) = &mut branch {
            folder.files += 1;
            folder.size = folder.size.saturating_add(size);
        }
        let category = report
            .categories
            .entry(category_for(entry.path()))
            .or_default();
        category.files += 1;
        category.bytes = category.bytes.saturating_add(size);
        if category.largest.len() < TOP_ITEMS
            || category.largest.last().is_some_and(|item| item.size < size)
        {
            rank(
                &mut category.largest,
                RankedItem::new(entry.path(), size, 1),
            );
        }
    }
    if let Some(item) = branch {
        rank(&mut report.folders, item);
    }
    Ok((!cancelled.load(Ordering::Relaxed)).then_some(report))
}

struct ScanJob {
    id: String,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct ScanState(Mutex<HashMap<String, ScanJob>>);

impl ScanState {
    pub(crate) fn stop_window(&self, label: &str) {
        if let Some(job) = self.0.lock().unwrap().get(label) {
            job.cancelled.store(true, Ordering::Relaxed);
        }
    }
}

#[derive(Clone, Serialize)]
struct Progress<'a> {
    id: &'a str,
    counts: &'a ScanCounts,
}

#[tauri::command]
pub async fn scan_storage(
    window: Window,
    state: State<'_, ScanState>,
    path: PathBuf,
    id: String,
) -> Result<Option<StorageReport>, String> {
    if !path.is_absolute() || uuid::Uuid::parse_str(&id).is_err() {
        return Err("扫描参数无效".into());
    }
    let label = window.label().to_owned();
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = state.0.lock().unwrap();
        if jobs.contains_key(&label) {
            return Err("当前窗口已有扫描，请等扫描结束".into());
        }
        jobs.insert(
            label.clone(),
            ScanJob {
                id: id.clone(),
                cancelled: cancelled.clone(),
            },
        );
    }
    let target = EventTarget::labeled(label.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        scan(&path, &cancelled, |counts| {
            let _ = window.emit_to(target.clone(), PROGRESS_EVENT, Progress { id: &id, counts });
        })
    })
    .await;
    state.0.lock().unwrap().remove(&label);
    result.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn cancel_storage_scan(window: Window, state: State<'_, ScanState>, id: String) {
    if let Some(job) = state
        .0
        .lock()
        .unwrap()
        .get(window.label())
        .filter(|job| job.id == id)
    {
        job.cancelled.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn detects_local_disk_capacity() {
        assert!(volumes(true).into_iter().any(|volume| {
            volume
                .total
                .zip(volume.available)
                .is_some_and(|(total, available)| total > 0 && available <= total)
        }));
    }

    #[test]
    fn counts_file_kinds_and_ranks_folders_and_files() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path();
        fs::create_dir_all(path.join("work/deep")).unwrap();
        fs::create_dir(path.join("empty")).unwrap();
        fs::write(path.join("work/deep/预算.XLSX"), [0; 40]).unwrap();
        fs::write(path.join("work/照片.PNG"), [0; 15]).unwrap();
        fs::write(path.join("压缩.zip"), [0; 100]).unwrap();
        fs::write(path.join(".pdf"), []).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(path, path.join("work/loop")).unwrap();
        let report = scan(path, &AtomicBool::new(false), |_| {})
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                report.counts.files,
                report.counts.folders,
                report.counts.bytes
            ),
            (4, 3, 155)
        );
        assert_eq!(report.categories["documents"].bytes, 40);
        assert_eq!(report.categories["images"].files, 1);
        assert_eq!(report.categories["other"].files, 1);
        assert_eq!(report.categories["archives"].largest[0].name, "压缩.zip");
        assert_eq!(
            (report.folders[0].name.as_str(), report.folders[0].size),
            ("work", 55)
        );
        #[cfg(unix)]
        assert_eq!(report.counts.skipped, 1);
        assert!(scan(path, &AtomicBool::new(true), |_| {})
            .unwrap()
            .is_none());
    }
}
