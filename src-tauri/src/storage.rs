use std::{
    collections::{BTreeMap, HashMap, VecDeque},
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
const RECENT_SCANS: usize = 8;
const TREE_ITEMS: usize = 8192;
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
#[serde(rename_all = "camelCase")]
pub struct ScanCounts {
    files: u64,
    folders: u64,
    bytes: u64,
    #[cfg(unix)]
    allocated_bytes: u64,
    skipped: u64,
}

#[derive(Clone, Serialize)]
pub(crate) struct RankedItem {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) parent: String,
    pub(crate) size: u64,
    pub(crate) files: u64,
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

#[derive(Clone, Default, Serialize)]
pub(crate) struct Category {
    pub(crate) files: u64,
    pub(crate) bytes: u64,
    pub(crate) largest: Vec<RankedItem>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageTreeNode {
    path: String,
    name: String,
    parent: String,
    size: u64,
    files: u64,
    is_dir: bool,
    modified: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageReport {
    pub(crate) path: String,
    pub(crate) counts: ScanCounts,
    pub(crate) categories: BTreeMap<&'static str, Category>,
    pub(crate) folders: Vec<RankedItem>,
    tree: Vec<StorageTreeNode>,
    tree_complete: bool,
}

pub(crate) fn category_for(path: &Path) -> &'static str {
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
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_lowercase();
    // @ keys in fileKinds.json match the full name rather than an extension.
    let type_key = if name.starts_with(".env.") {
        "@.env".to_owned()
    } else if name.starts_with("dockerfile.") || name.starts_with("containerfile.") {
        format!("@{}", name.split('.').next().unwrap_or(""))
    } else {
        match name.rsplit_once('.') {
            Some((stem, extension)) if !stem.is_empty() && !extension.is_empty() => {
                extension.to_owned()
            }
            _ => format!("@{name}"),
        }
    };
    types.get(&type_key).map_or("other", String::as_str)
}

fn skip_entry(metadata: &Metadata) -> bool {
    crate::fs_safety::is_link(metadata) || (!metadata.is_file() && !metadata.is_dir())
}

pub(crate) fn scan(
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
        tree: Vec::new(),
        tree_complete: true,
    };
    let mut walker = WalkDir::new(&root)
        .min_depth(1)
        .follow_links(false)
        .follow_root_links(false)
        .same_file_system(true)
        .into_iter();
    let mut branch: Option<RankedItem> = None;
    let mut ancestors: Vec<Option<usize>> = Vec::new();
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
        ancestors.truncate(entry.depth().saturating_sub(1));
        let node_index = if report.tree.len() < TREE_ITEMS {
            let item = RankedItem::new(
                entry.path(),
                if metadata.is_file() {
                    metadata.len()
                } else {
                    0
                },
                u64::from(metadata.is_file()),
            );
            let index = report.tree.len();
            report.tree.push(StorageTreeNode {
                path: item.path,
                name: item.name,
                parent: item.parent,
                size: item.size,
                files: item.files,
                is_dir: metadata.is_dir(),
                modified: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |time| time.as_secs()),
            });
            Some(index)
        } else {
            report.tree_complete = false;
            None
        };
        if metadata.is_dir() {
            ancestors.push(node_index);
            report.counts.folders += 1;
            if entry.depth() == 1 {
                branch = Some(RankedItem::new(entry.path(), 0, 0));
            }
            continue;
        }
        let size = metadata.len();
        for index in ancestors.iter().flatten() {
            let node = &mut report.tree[*index];
            node.size = node.size.saturating_add(size);
            node.files += 1;
        }
        report.counts.files += 1;
        report.counts.bytes = report.counts.bytes.saturating_add(size);
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            report.counts.allocated_bytes = report
                .counts
                .allocated_bytes
                .saturating_add(metadata.blocks().saturating_mul(512));
        }
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
pub struct ScanState {
    jobs: Mutex<HashMap<String, ScanJob>>,
    reports: Mutex<HashMap<String, VecDeque<(String, Arc<StorageReport>)>>>,
    pending_cancellations: Mutex<VecDeque<(String, String)>>,
}

impl ScanState {
    pub(crate) fn stop_window(&self, label: &str) {
        self.reports.lock().unwrap().remove(label);
        let jobs = self.jobs.lock().unwrap();
        for key in [
            label,
            &format!("search:{label}"),
            &format!("compare:{label}"),
            &format!("duplicates:{label}"),
            &format!("diagnosis:{label}"),
        ] {
            if let Some(job) = jobs.get(key) {
                job.cancelled.store(true, Ordering::Relaxed);
            }
        }
    }

    pub(crate) async fn run<T: Send + 'static>(
        &self,
        key: String,
        id: String,
        work: impl FnOnce(&AtomicBool) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        if uuid::Uuid::parse_str(&id).is_err() {
            return Err("任务编号无效".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut jobs = self.jobs.lock().unwrap();
            if jobs.contains_key(&key) {
                return Err("当前窗口已有同类任务，请等它结束".into());
            }
            let mut pending = self.pending_cancellations.lock().unwrap();
            if let Some(index) = pending
                .iter()
                .position(|(owner, pending_id)| owner == &key && pending_id == &id)
            {
                pending.remove(index);
                cancelled.store(true, Ordering::Relaxed);
            }
            jobs.insert(
                key.clone(),
                ScanJob {
                    id,
                    cancelled: cancelled.clone(),
                },
            );
        }
        let result = tauri::async_runtime::spawn_blocking(move || work(&cancelled)).await;
        self.jobs.lock().unwrap().remove(&key);
        result.map_err(|error| error.to_string())?
    }

    pub(crate) fn cancel(&self, key: &str, id: &str) {
        if uuid::Uuid::parse_str(id).is_err() {
            return;
        }
        let jobs = self.jobs.lock().unwrap();
        if let Some(job) = jobs.get(key).filter(|job| job.id == id) {
            job.cancelled.store(true, Ordering::Relaxed);
        } else {
            // IPC cancellation may arrive before the async command registers.
            let mut pending = self.pending_cancellations.lock().unwrap();
            if pending.len() >= 128 {
                pending.pop_front();
            }
            pending.push_back((key.into(), id.into()));
        }
    }

    fn remember_report(&self, label: String, id: String, report: StorageReport) {
        let mut all = self.reports.lock().unwrap();
        let reports = all.entry(label).or_default();
        // A rescan supersedes the older snapshot of this canonical scope.
        reports.retain(|(scan_id, previous)| scan_id != &id && previous.path != report.path);
        reports.push_back((id, Arc::new(report)));
        while reports.len() > RECENT_SCANS {
            reports.pop_front();
        }
    }

    pub(crate) fn report(&self, label: &str, id: &str) -> Result<Arc<StorageReport>, String> {
        self.reports
            .lock()
            .unwrap()
            .get(label)
            .and_then(|reports| reports.iter().find(|(scan_id, _)| scan_id == id))
            .map(|(_, report)| report.clone())
            .ok_or_else(|| "扫描结果已失效，请先重新扫描当前范围".into())
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
    if !path.is_absolute() {
        return Err("扫描参数无效".into());
    }
    let label = window.label().to_owned();
    let target = EventTarget::labeled(label.clone());
    let progress_id = id.clone();
    let result = state
        .run(label.clone(), id.clone(), move |cancelled| {
            scan(&path, cancelled, |counts| {
                let _ = window.emit_to(
                    target.clone(),
                    PROGRESS_EVENT,
                    Progress {
                        id: &progress_id,
                        counts,
                    },
                );
            })
        })
        .await?;
    if let Some(report) = &result {
        state.remember_report(label, id, report.clone());
    }
    Ok(result)
}

#[tauri::command]
pub fn cancel_storage_scan(window: Window, state: State<'_, ScanState>, id: String) {
    state.cancel(window.label(), &id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn remembers_cancellation_that_arrives_before_job_registration() {
        let state = ScanState::default();
        let id = uuid::Uuid::new_v4().to_string();
        let key = "diagnosis:pending-window".to_owned();
        state.cancel(&key, &id);
        let cancelled = tauri::async_runtime::block_on(
            state.run(key, id, |cancelled| Ok(cancelled.load(Ordering::Relaxed))),
        )
        .unwrap();
        assert!(cancelled);
    }

    #[test]
    fn diagnosis_snapshots_belong_to_one_window_and_scan() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("original.txt"), b"preserve me").unwrap();
        let report = Arc::new(
            scan(root.path(), &AtomicBool::new(false), |_| {})
                .unwrap()
                .unwrap(),
        );
        let state = ScanState::default();
        state.remember_report("left".into(), "scan-1".into(), (*report).clone());
        assert!(state.report("left", "scan-1").is_ok());
        assert!(state.report("right", "scan-1").is_err());
        assert!(state.report("left", "scan-2").is_err());
        state.stop_window("left");
        assert!(state.report("left", "scan-1").is_err());
        assert_eq!(
            fs::read(root.path().join("original.txt")).unwrap(),
            b"preserve me"
        );
    }

    #[test]
    fn retains_recent_scopes_but_replaces_rescans_and_bounds_history() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("original.txt"), b"preserve me").unwrap();
        let original = scan(root.path(), &AtomicBool::new(false), |_| {})
            .unwrap()
            .unwrap();
        let state = ScanState::default();
        for index in 0..RECENT_SCANS {
            let mut report = original.clone();
            report.path = format!("scope-{index}");
            state.remember_report("left".into(), format!("scan-{index}"), report);
        }
        assert!(state.report("left", "scan-0").is_ok());
        assert!(state.report("left", "scan-7").is_ok());
        let mut report = original.clone();
        report.path = "scope-0".into();
        state.remember_report("left".into(), "rescan-0".into(), report);
        assert!(state.report("left", "scan-0").is_err());
        assert!(state.report("left", "rescan-0").is_ok());
        assert!(state.report("left", "scan-1").is_ok());
        state.remember_report("left".into(), "new-scope".into(), original);
        assert!(state.report("left", "scan-1").is_err());
        assert!(state.report("right", "rescan-0").is_err());
        assert_eq!(state.reports.lock().unwrap()["left"].len(), RECENT_SCANS);
        assert_eq!(
            fs::read(root.path().join("original.txt")).unwrap(),
            b"preserve me"
        );
    }

    #[test]
    fn classifies_code_and_extensionless_files_from_the_shared_icon_table() {
        for name in [
            "main.PY",
            "Main.java",
            "app.JS",
            "App.TSX",
            "module.cts",
            "notebook.ipynb",
            "run.ps1",
            "Dockerfile",
            "Dockerfile.dev",
            "Containerfile.prod",
            "Makefile",
            ".gitignore",
            ".env",
            ".ENV.local",
            ".zshrc",
        ] {
            assert_eq!(category_for(Path::new(name)), "code", "{name}");
        }
        assert_eq!(category_for(Path::new("LICENSE")), "documents");
        for name in [".pdf", "unknown.xyz", "no extension"] {
            assert_eq!(category_for(Path::new(name)), "other", "{name}");
        }
    }

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
        let work = report.tree.iter().find(|node| node.name == "work").unwrap();
        let deep = report.tree.iter().find(|node| node.name == "deep").unwrap();
        assert_eq!(
            (work.size, work.files, deep.size, deep.files),
            (55, 2, 40, 1)
        );
        assert!(report.tree_complete);
        assert_eq!(
            report
                .tree
                .iter()
                .filter(|node| !node.is_dir)
                .map(|node| node.size)
                .sum::<u64>(),
            report.counts.bytes
        );
        assert_eq!(fs::read(path.join("work/deep/预算.XLSX")).unwrap(), [0; 40]);
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
    #[test]
    fn bounded_tree_keeps_directory_totals_after_truncation() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("many")).unwrap();
        for index in 0..TREE_ITEMS + 3 {
            fs::write(root.path().join("many").join(index.to_string()), [1u8; 2]).unwrap();
        }
        let report = scan(root.path(), &AtomicBool::new(false), |_| {})
            .unwrap()
            .unwrap();
        assert_eq!(report.tree.len(), TREE_ITEMS);
        assert!(!report.tree_complete);
        assert_eq!(report.tree[0].size, ((TREE_ITEMS + 3) * 2) as u64);
        assert_eq!(report.tree[0].files, (TREE_ITEMS + 3) as u64);
        assert_eq!(report.counts.bytes, report.tree[0].size);
        assert_eq!(fs::read(root.path().join("many/0")).unwrap(), [1u8; 2]);
    }
}
