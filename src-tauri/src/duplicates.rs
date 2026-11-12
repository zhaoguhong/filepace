use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{ipc::Channel, Manager, State, Window};

use crate::{
    entry_info,
    fs_safety::{check_ancestors, is_link, Directory, Snapshot},
    open_regular_file,
    storage::ScanState,
    strpath, Entry,
};

#[derive(Clone, Copy)]
struct Limits {
    files: usize,
    groups: usize,
    members: usize,
    read_bytes: u64,
}

const LIMITS: Limits = Limits {
    files: 100_000,
    groups: 1_000,
    members: 10_000,
    read_bytes: 32 * 1024 * 1024 * 1024,
};

#[derive(Clone, Serialize)]
struct Group {
    id: String,
    files: Vec<Entry>,
    size: u64,
    #[serde(skip)]
    snapshots: Vec<Snapshot>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Report {
    path: String,
    groups: Vec<Group>,
    scanned_files: usize,
    scanned_bytes: u64,
    skipped: usize,
    limited: bool,
    hard_links: usize,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    phase: &'static str,
    scanned_files: usize,
    scanned_bytes: u64,
    checked_files: usize,
    checked_bytes: u64,
}

#[derive(Clone)]
struct Candidate {
    entry: Entry,
    snapshot: Snapshot,
}

const CHANGED: &str = "重复组的文件已有变化，请重新检查后再整理。";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuardRequest {
    scan_id: String,
    group_id: String,
    keeper: String,
}

#[derive(Default)]
pub(crate) struct DuplicateState(Mutex<HashMap<String, (String, Arc<Report>)>>);

impl DuplicateState {
    fn remember(&self, owner: String, id: String, report: &Report) {
        self.0
            .lock()
            .unwrap()
            .insert(owner, (id, Arc::new(report.clone())));
    }

    pub(crate) fn close(&self, owner: &str) {
        self.0.lock().unwrap().remove(owner);
    }

    pub(crate) fn guard(
        &self,
        owner: &str,
        request: &GuardRequest,
        sources: &[String],
    ) -> Result<Guard, String> {
        let reports = self.0.lock().unwrap();
        let (_, report) = reports
            .get(owner)
            .filter(|(id, _)| *id == request.scan_id)
            .ok_or(CHANGED)?;
        let group = report
            .groups
            .iter()
            .find(|group| group.id == request.group_id)
            .ok_or(CHANGED)?;
        let candidate = |path: &str| {
            group
                .files
                .iter()
                .zip(&group.snapshots)
                .find(|(entry, _)| entry.path == path)
                .map(|(entry, snapshot)| Candidate {
                    entry: entry.clone(),
                    snapshot: snapshot.clone(),
                })
                .ok_or_else(|| CHANGED.to_owned())
        };
        let keeper = candidate(&request.keeper)?;
        if sources.is_empty() || sources.iter().any(|source| source == &request.keeper) {
            return Err("要保留的文件不能加入本组的整理操作。".into());
        }
        let copies = sources
            .iter()
            .map(|source| candidate(source))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Guard { keeper, copies })
    }
}

// The retained native snapshots travel with a queued task or rename plan. A
// filesystem watcher is only a UI hint: it is never authority to remove a copy.
#[derive(Clone)]
pub(crate) struct Guard {
    keeper: Candidate,
    copies: Vec<Candidate>,
}

impl Guard {
    pub(crate) fn restrict(&self, paths: &[String]) -> Result<Self, String> {
        if !self.covers(paths) {
            return Err(CHANGED.into());
        }
        Ok(Self {
            keeper: self.keeper.clone(),
            copies: self
                .copies
                .iter()
                .filter(|copy| paths.contains(&copy.entry.path))
                .cloned()
                .collect(),
        })
    }

    pub(crate) fn check_destination(&self, target: &Path) -> Result<(), String> {
        if target == Path::new(&self.keeper.entry.path)
            || crate::fs_safety::Identity::at(target)
                .is_ok_and(|identity| identity == self.keeper.snapshot.identity)
        {
            return Err("目标会替换本组保留的文件，请选择其他文件夹。".into());
        }
        Ok(())
    }

    pub(crate) fn covers(&self, paths: &[String]) -> bool {
        !paths.is_empty()
            && paths
                .iter()
                .all(|path| self.copies.iter().any(|copy| &copy.entry.path == path))
    }

    pub(crate) fn verify(&self, cancelled: impl Fn() -> bool) -> Result<(), String> {
        let stop = AtomicBool::new(false);
        let mut on_progress = |_| {};
        let mut reader = Reader {
            stop: &stop,
            external_cancel: Some(&cancelled),
            progress: Progress::default(),
            on_progress: &mut on_progress,
            emitted: Instant::now(),
            budget: LIMITS.read_bytes,
        };
        for copy in &self.copies {
            match same_bytes(&self.keeper, copy, &mut reader) {
                Ok(true) => {}
                Err(ReadFailure::Cancelled) => return Err("文件任务已取消".into()),
                _ => return Err(CHANGED.into()),
            }
        }
        Ok(())
    }

    pub(crate) fn check_source(&self, path: &Path) -> Result<(), String> {
        let copy = self
            .copies
            .iter()
            .find(|copy| Path::new(&copy.entry.path) == path)
            .ok_or(CHANGED)?;
        self.keeper.open().map_err(|_| CHANGED.to_owned())?;
        copy.open().map_err(|_| CHANGED.to_owned())?;
        Ok(())
    }

    pub(crate) fn check_keeper(&self) -> Result<(), String> {
        self.keeper.open().map_err(|_| CHANGED.to_owned())?;
        Ok(())
    }
}

impl Candidate {
    fn open(&self) -> Result<File, ReadFailure> {
        let path = Path::new(&self.entry.path);
        check_ancestors(path).map_err(|_| ReadFailure::Changed)?;
        let file = open_regular_file(path, false).map_err(|_| ReadFailure::Changed)?;
        self.check(&file)?;
        Ok(file)
    }

    fn check(&self, file: &File) -> Result<(), ReadFailure> {
        let metadata = file.metadata().map_err(|_| ReadFailure::Changed)?;
        if Snapshot::from_file(file, &metadata).ok().as_ref() != Some(&self.snapshot)
            || !self.snapshot.matches(Path::new(&self.entry.path))
        {
            return Err(ReadFailure::Changed);
        }
        Ok(())
    }
}

enum ReadFailure {
    Changed,
    Cancelled,
    Limited,
}

struct Reader<'a> {
    stop: &'a AtomicBool,
    external_cancel: Option<&'a dyn Fn() -> bool>,
    progress: Progress,
    on_progress: &'a mut dyn FnMut(Progress),
    emitted: Instant,
    budget: u64,
}

impl Reader<'_> {
    fn publish(&mut self, phase: &'static str, force: bool) {
        self.progress.phase = phase;
        if force || self.emitted.elapsed() >= Duration::from_millis(120) {
            (self.on_progress)(self.progress.clone());
            self.emitted = Instant::now();
        }
    }

    fn check(&self) -> Result<(), ReadFailure> {
        if self.stop.load(Ordering::Relaxed)
            || self.external_cancel.is_some_and(|cancelled| cancelled())
        {
            Err(ReadFailure::Cancelled)
        } else {
            Ok(())
        }
    }

    fn read(&mut self, file: &mut File, buffer: &mut [u8]) -> Result<(), ReadFailure> {
        self.check()?;
        if self.budget < buffer.len() as u64 {
            return Err(ReadFailure::Limited);
        }
        let mut filled = 0;
        while filled < buffer.len() {
            self.check()?;
            let count = file
                .read(&mut buffer[filled..])
                .map_err(|_| ReadFailure::Changed)?;
            if count == 0 {
                return Err(ReadFailure::Changed);
            }
            self.budget -= count as u64;
            self.progress.checked_bytes += count as u64;
            filled += count;
            self.publish(self.progress.phase, false);
        }
        Ok(())
    }
}

fn hash(candidate: &Candidate, reader: &mut Reader<'_>) -> Result<[u8; 32], ReadFailure> {
    reader.check()?;
    let mut file = candidate.open()?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut remaining = candidate.entry.size;
    while remaining > 0 {
        let size = remaining.min(buffer.len() as u64) as usize;
        reader.read(&mut file, &mut buffer[..size])?;
        digest.update(&buffer[..size]);
        remaining -= size as u64;
    }
    candidate.check(&file)?;
    reader.progress.checked_files += 1;
    Ok(digest.finalize().into())
}

fn same_bytes(
    left: &Candidate,
    right: &Candidate,
    reader: &mut Reader<'_>,
) -> Result<bool, ReadFailure> {
    reader.check()?;
    let mut a = left.open()?;
    let mut b = right.open()?;
    if left.entry.size != right.entry.size {
        return Ok(false);
    }
    let mut left_buffer = [0u8; 64 * 1024];
    let mut right_buffer = [0u8; 64 * 1024];
    let mut remaining = left.entry.size;
    while remaining > 0 {
        let size = remaining.min(left_buffer.len() as u64) as usize;
        reader.read(&mut a, &mut left_buffer[..size])?;
        reader.read(&mut b, &mut right_buffer[..size])?;
        if left_buffer[..size] != right_buffer[..size] {
            return Ok(false);
        }
        remaining -= size as u64;
    }
    left.check(&a)?;
    right.check(&b)?;
    Ok(true)
}

fn scan(
    root: &Path,
    hidden: bool,
    stop: &AtomicBool,
    limits: Limits,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<Option<Report>, String> {
    let directory = Directory::at(root).map_err(|error| error.to_string())?;
    let mut report = Report {
        path: strpath(root),
        ..Default::default()
    };
    let mut reader = Reader {
        stop,
        external_cancel: None,
        progress: Progress::default(),
        on_progress,
        emitted: Instant::now(),
        budget: limits.read_bytes,
    };
    reader.publish("scan", true);
    let mut sizes = BTreeMap::<u64, Vec<Candidate>>::new();
    let mut identities = HashSet::new();
    let mut visited = 0usize;
    let mut walk = walkdir::WalkDir::new(root)
        .min_depth(1)
        .follow_links(false)
        .same_file_system(true)
        .into_iter();
    while let Some(item) = walk.next() {
        if stop.load(Ordering::Relaxed) {
            return Ok(None);
        }
        directory.check()?;
        if visited >= limits.files.saturating_mul(4) {
            report.limited = true;
            break;
        }
        visited += 1;
        let Ok(item) = item else {
            report.skipped += 1;
            continue;
        };
        if check_ancestors(item.path()).is_err() {
            if item.file_type().is_dir() {
                walk.skip_current_dir();
            }
            report.skipped += 1;
            continue;
        }
        let Ok(metadata) = item.path().symlink_metadata() else {
            report.skipped += 1;
            continue;
        };
        let entry = entry_info(item.path(), &metadata);
        if is_link(&metadata) {
            if item.file_type().is_dir() {
                walk.skip_current_dir();
            }
            report.skipped += 1;
            continue;
        }
        if !hidden && entry.hidden {
            if metadata.is_dir() {
                walk.skip_current_dir();
            }
            continue;
        }
        if metadata.is_dir() {
            continue;
        }
        if !metadata.is_file() {
            report.skipped += 1;
            continue;
        }
        if report.scanned_files >= limits.files {
            report.limited = true;
            break;
        }
        report.scanned_files += 1;
        report.scanned_bytes = report.scanned_bytes.saturating_add(metadata.len());
        reader.progress.scanned_files = report.scanned_files;
        reader.progress.scanned_bytes = report.scanned_bytes;
        reader.publish("scan", false);
        let Ok(snapshot) = Snapshot::at(item.path(), &metadata) else {
            report.skipped += 1;
            continue;
        };
        if !identities.insert(snapshot.identity.clone()) {
            report.hard_links += 1;
            continue;
        }
        sizes
            .entry(metadata.len())
            .or_default()
            .push(Candidate { entry, snapshot });
    }

    let mut members = 0;
    let mut hashing_started = false;
    let mut verifying_started = false;
    'sizes: for (size, candidates) in sizes {
        if stop.load(Ordering::Relaxed) {
            return Ok(None);
        }
        if candidates.len() < 2 {
            continue;
        }
        reader.publish("hash", !hashing_started);
        hashing_started = true;
        let mut hashes = BTreeMap::<[u8; 32], Vec<Candidate>>::new();
        for candidate in candidates {
            match hash(&candidate, &mut reader) {
                Ok(digest) => hashes.entry(digest).or_default().push(candidate),
                Err(ReadFailure::Cancelled) => return Ok(None),
                Err(ReadFailure::Limited) => {
                    report.limited = true;
                    break;
                }
                Err(ReadFailure::Changed) => report.skipped += 1,
            }
        }
        reader.publish("verify", !verifying_started);
        verifying_started = true;
        for candidates in hashes.into_values().filter(|group| group.len() > 1) {
            // Byte comparison remains the final authority, even if a digest
            // collision occurs. Each read verifies both the handle and pathname.
            let mut verified = Vec::<Vec<Candidate>>::new();
            for candidate in candidates {
                let mut matched = None;
                for (index, group) in verified.iter().enumerate() {
                    match same_bytes(&group[0], &candidate, &mut reader) {
                        Ok(true) => {
                            matched = Some(index);
                            break;
                        }
                        Ok(false) => {}
                        Err(ReadFailure::Cancelled) => return Ok(None),
                        Err(ReadFailure::Limited) => {
                            report.limited = true;
                            break 'sizes;
                        }
                        Err(ReadFailure::Changed) => {
                            report.skipped += 1;
                            matched = Some(usize::MAX);
                            break;
                        }
                    }
                }
                match matched {
                    Some(usize::MAX) => {}
                    Some(index) => verified[index].push(candidate),
                    None => verified.push(vec![candidate]),
                }
            }
            for group in verified {
                let mut valid: Vec<_> = group
                    .into_iter()
                    .filter_map(|candidate| {
                        if candidate.snapshot.matches(Path::new(&candidate.entry.path)) {
                            Some(candidate)
                        } else {
                            report.skipped += 1;
                            None
                        }
                    })
                    .collect();
                if valid.len() < 2 {
                    continue;
                }
                valid.sort_by(|a, b| a.entry.path.cmp(&b.entry.path));
                if report.groups.len() >= limits.groups
                    || limits.members.saturating_sub(members) < 2
                {
                    report.limited = true;
                    break 'sizes;
                }
                let available = limits.members.saturating_sub(members);
                if valid.len() > available {
                    valid.truncate(available);
                    report.limited = true;
                }
                members += valid.len();
                let (files, snapshots) = valid
                    .into_iter()
                    .map(|candidate| (candidate.entry, candidate.snapshot))
                    .unzip();
                report.groups.push(Group {
                    id: format!("duplicate-{}", report.groups.len() + 1),
                    files,
                    size,
                    snapshots,
                });
            }
        }
        if reader.budget == 0 {
            report.limited = true;
            break;
        }
    }
    if stop.load(Ordering::Relaxed) {
        return Ok(None);
    }
    directory.check()?;
    for group in &mut report.groups {
        let mut valid = Vec::new();
        for (entry, snapshot) in group.files.drain(..).zip(group.snapshots.drain(..)) {
            if stop.load(Ordering::Relaxed) {
                return Ok(None);
            }
            if snapshot.matches(Path::new(&entry.path)) {
                valid.push((entry, snapshot));
            } else {
                report.skipped += 1;
            }
        }
        (group.files, group.snapshots) = valid.into_iter().unzip();
    }
    report.groups.retain(|group| group.files.len() > 1);
    report
        .groups
        .sort_by(|a, b| b.size.cmp(&a.size).then(a.id.cmp(&b.id)));
    reader.publish("verify", true);
    Ok((!stop.load(Ordering::Relaxed)).then_some(report))
}

#[tauri::command]
pub(crate) async fn find_duplicates(
    window: Window,
    state: State<'_, ScanState>,
    path: PathBuf,
    id: String,
    hidden: bool,
    on_progress: Channel<Progress>,
) -> Result<Option<Report>, String> {
    if !path.is_absolute() {
        return Err("请选择绝对目录路径".into());
    }
    let owner = window.label().to_owned();
    let report = state
        .run(
            format!("duplicates:{}", window.label()),
            id.clone(),
            move |stop| {
                let root = dunce::canonicalize(path).map_err(|error| error.to_string())?;
                if !root.is_dir() {
                    return Err("请选择可访问的文件夹".into());
                }
                scan(&root, hidden, stop, LIMITS, &mut |progress| {
                    let _ = on_progress.send(progress);
                })
            },
        )
        .await?;
    if let Some(report) = &report {
        window.state::<DuplicateState>().remember(owner, id, report);
    }
    Ok(report)
}

#[tauri::command]
pub(crate) fn cancel_duplicates(window: Window, state: State<'_, ScanState>, id: String) {
    state.cancel(&format!("duplicates:{}", window.label()), &id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn guarded_fixture() -> (tempfile::TempDir, DuplicateState, GuardRequest, Vec<String>) {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        fs::create_dir(root.join("nested")).unwrap();
        let keeper = root.join("nested/keeper.txt");
        let copy = root.join("nested/copy.txt");
        fs::write(&keeper, b"same").unwrap();
        fs::write(&copy, b"same").unwrap();
        let report = scan_all(&root, false);
        let request = GuardRequest {
            scan_id: "scan".into(),
            group_id: report.groups[0].id.clone(),
            keeper: strpath(&keeper),
        };
        let state = DuplicateState::default();
        state.remember("window".into(), "scan".into(), &report);
        (fixture, state, request, vec![strpath(&copy)])
    }

    #[test]
    fn action_guard_rechecks_unwatched_nested_files_and_preserves_changed_contents() {
        let (_fixture, state, request, sources) = guarded_fixture();
        let guard = state.guard("window", &request, &sources).unwrap();
        guard.verify(|| false).unwrap();
        fs::write(&sources[0], b"new!").unwrap();
        assert!(guard.verify(|| false).unwrap_err().contains("重新检查"));
        assert!(guard.check_source(Path::new(&sources[0])).is_err());
        assert_eq!(fs::read(&sources[0]).unwrap(), b"new!");
        assert_eq!(fs::read(&request.keeper).unwrap(), b"same");
    }

    #[test]
    fn action_guard_rejects_changed_keeper_cross_window_access_and_keeper_as_source() {
        let (_fixture, state, request, sources) = guarded_fixture();
        assert!(state.guard("other-window", &request, &sources).is_err());
        assert!(state
            .guard("window", &request, &[request.keeper.clone()])
            .is_err());
        let guard = state.guard("window", &request, &sources).unwrap();
        assert!(guard.check_destination(Path::new(&request.keeper)).is_err());
        fs::write(&request.keeper, b"edit").unwrap();
        assert!(guard.verify(|| false).is_err());
        assert!(guard.check_keeper().is_err());
        assert_eq!(fs::read(&sources[0]).unwrap(), b"same");
        state.close("window");
        assert!(state.guard("window", &request, &sources).is_err());
    }

    #[test]
    fn action_guard_cancels_revalidation_and_restricts_retry_to_remaining_sources() {
        let (fixture, state, request, sources) = guarded_fixture();
        let guard = state.guard("window", &request, &sources).unwrap();
        assert!(guard.verify(|| true).unwrap_err().contains("取消"));
        assert!(!guard.covers(&[request.keeper.clone()]));
        assert!(guard.restrict(&[request.keeper.clone()]).is_err());
        let same_copy = fixture
            .path()
            .canonicalize()
            .unwrap()
            .join("nested/third.txt");
        fs::write(&same_copy, b"same").unwrap();
        let report = scan_all(&fixture.path().canonicalize().unwrap(), false);
        state.remember("window".into(), "scan".into(), &report);
        let all = vec![sources[0].clone(), strpath(&same_copy)];
        let guard = state.guard("window", &request, &all).unwrap();
        fs::rename(&sources[0], fixture.path().join("moved.txt")).unwrap();
        assert!(guard.verify(|| false).is_err());
        guard
            .restrict(&[strpath(&same_copy)])
            .unwrap()
            .verify(|| false)
            .unwrap();
        assert_eq!(fs::read(&same_copy).unwrap(), b"same");
        assert_eq!(fs::read(fixture.path().join("moved.txt")).unwrap(), b"same");
    }

    #[test]
    fn queued_transfer_rechecks_keeper_after_conflict_wait_before_moving_source() {
        let (fixture, state, request, sources) = guarded_fixture();
        let guard = state.guard("window", &request, &sources).unwrap();
        let destination = fixture.path().canonicalize().unwrap().join("destination");
        fs::create_dir(&destination).unwrap();
        let target = destination.join("copy.txt");
        fs::write(&target, b"original destination").unwrap();
        let shared = Arc::new(crate::Shared::default());
        shared.tasks.lock().unwrap().insert(
            "guarded".into(),
            crate::Task {
                id: "guarded".into(),
                status: "running".into(),
                ..Default::default()
            },
        );
        let worker_state = shared.clone();
        let source = PathBuf::from(&sources[0]);
        let worker_target = target.clone();
        let worker = std::thread::spawn(move || {
            let source = crate::transfer::Source::at(source).unwrap();
            let parent = Directory::parent(&worker_target).unwrap();
            let mut transfer = crate::transfer::Transfer::new(&worker_state, "guarded", true);
            transfer.set_duplicate_guard(Some(&guard));
            transfer.run(&source, &worker_target, &parent)
        });
        let mut conflict = None;
        for _ in 0..200 {
            conflict = shared.tasks.lock().unwrap()["guarded"]
                .conflict
                .as_ref()
                .map(|conflict| conflict.id.clone());
            if conflict.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if conflict.is_none() {
            crate::act_on_task(&shared, "guarded", "cancel".into(), false, None);
            let _ = worker.join();
            panic!("guarded transfer did not reach conflict");
        }
        fs::write(&request.keeper, b"edit").unwrap();
        crate::act_on_task(&shared, "guarded", "replace".into(), false, conflict);
        assert!(worker.join().unwrap().unwrap_err().contains("重新检查"));
        assert_eq!(fs::read(&sources[0]).unwrap(), b"same");
        assert_eq!(fs::read(&request.keeper).unwrap(), b"edit");
        assert_eq!(fs::read(&target).unwrap(), b"original destination");
    }

    fn scan_all(root: &Path, hidden: bool) -> Report {
        scan(
            &root.canonicalize().unwrap(),
            hidden,
            &AtomicBool::new(false),
            LIMITS,
            &mut |_| {},
        )
        .unwrap()
        .unwrap()
    }

    #[test]
    fn verifies_complete_bytes_instead_of_names_or_sizes_and_preserves_sources() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        fs::create_dir(root.join("nested")).unwrap();
        fs::write(root.join("first.txt"), b"same").unwrap();
        fs::write(root.join("nested/different-name.bin"), b"same").unwrap();
        fs::write(root.join("same-size.txt"), b"else").unwrap();
        fs::write(root.join("unique.txt"), b"unique length").unwrap();
        let report = scan_all(root, false);
        assert_eq!(report.scanned_files, 4);
        assert_eq!(report.groups.len(), 1);
        assert_eq!(report.groups[0].size, 4);
        assert_eq!(report.groups[0].files.len(), 2);
        assert!(!report.limited);
        assert_eq!(fs::read(root.join("first.txt")).unwrap(), b"same");
        assert_eq!(
            fs::read(root.join("nested/different-name.bin")).unwrap(),
            b"same"
        );
        assert_eq!(fs::read(root.join("same-size.txt")).unwrap(), b"else");
        assert_eq!(fs::read(root.join("unique.txt")).unwrap(), b"unique length");
    }

    #[test]
    fn excludes_hard_link_aliases_and_obeys_hidden_tree_setting() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        fs::create_dir(root.join(".hidden")).unwrap();
        fs::write(root.join("one"), b"same").unwrap();
        fs::hard_link(root.join("one"), root.join("alias")).unwrap();
        fs::write(root.join("two"), b"same").unwrap();
        fs::write(root.join(".hidden/three"), b"same").unwrap();
        let report = scan_all(root, false);
        assert_eq!(report.hard_links, 1);
        assert_eq!(report.groups.len(), 1);
        assert_eq!(report.groups[0].files.len(), 2);
        let report = scan_all(root, true);
        assert_eq!(report.hard_links, 1);
        assert_eq!(report.groups[0].files.len(), 3);
        assert_eq!(fs::read(root.join("one")).unwrap(), b"same");
        assert_eq!(fs::read(root.join("alias")).unwrap(), b"same");
    }

    #[cfg(unix)]
    #[test]
    fn ignores_links_including_linked_directories_and_special_files() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("root");
        let outside = fixture.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("one"), b"same").unwrap();
        fs::write(outside.join("two"), b"same").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked-directory")).unwrap();
        std::os::unix::fs::symlink(outside.join("two"), root.join("linked-file")).unwrap();
        use std::os::unix::ffi::OsStrExt;
        let pipe = std::ffi::CString::new(root.join("pipe").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(pipe.as_ptr(), 0o600) }, 0);
        let report = scan_all(&root, false);
        assert_eq!(report.scanned_files, 1);
        assert_eq!(report.skipped, 3);
        assert!(report.groups.is_empty());
        assert_eq!(fs::read(outside.join("two")).unwrap(), b"same");
    }

    #[test]
    fn discards_files_changed_after_hashing_and_observes_cancellation() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        fs::write(root.join("one"), b"same").unwrap();
        fs::write(root.join("two"), b"same").unwrap();
        let mut changed = false;
        let report = scan(
            &root,
            false,
            &AtomicBool::new(false),
            LIMITS,
            &mut |progress| {
                if progress.phase == "verify" && !changed {
                    fs::write(root.join("two"), b"new!").unwrap();
                    changed = true;
                }
            },
        )
        .unwrap()
        .unwrap();
        assert!(changed);
        assert!(report.groups.is_empty());
        assert!(report.skipped > 0);
        let stop = AtomicBool::new(false);
        let report = scan(&root, false, &stop, LIMITS, &mut |progress| {
            if progress.phase == "hash" {
                stop.store(true, Ordering::Relaxed);
            }
        })
        .unwrap();
        assert!(report.is_none());
        assert_eq!(fs::read(root.join("one")).unwrap(), b"same");
        assert_eq!(fs::read(root.join("two")).unwrap(), b"new!");
    }

    #[test]
    fn reports_scan_display_and_read_limits_without_claiming_full_coverage() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        for name in ["one", "two", "three"] {
            fs::write(root.join(name), b"same").unwrap();
        }
        for limits in [
            Limits { files: 2, ..LIMITS },
            Limits {
                members: 2,
                ..LIMITS
            },
            Limits {
                read_bytes: 1,
                ..LIMITS
            },
        ] {
            let report = scan(&root, false, &AtomicBool::new(false), limits, &mut |_| {})
                .unwrap()
                .unwrap();
            assert!(report.limited);
            assert!(report.groups.iter().all(|group| group.files.len() <= 2));
        }
        for name in ["one", "two", "three"] {
            assert_eq!(fs::read(root.join(name)).unwrap(), b"same");
        }
    }

    #[test]
    fn treats_empty_files_as_duplicates_and_byte_comparison_rejects_mismatch() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        fs::write(root.join("empty-one"), b"").unwrap();
        fs::write(root.join("empty-two"), b"").unwrap();
        let report = scan_all(&root, false);
        assert_eq!(report.groups.len(), 1);
        assert_eq!(report.groups[0].size, 0);

        let candidate = |name: &str, bytes: &[u8]| {
            let path = root.join(name);
            fs::write(&path, bytes).unwrap();
            let metadata = path.symlink_metadata().unwrap();
            Candidate {
                entry: entry_info(&path, &metadata),
                snapshot: Snapshot::at(&path, &metadata).unwrap(),
            }
        };
        let one = candidate("one", b"same");
        let other = candidate("other", b"else");
        let mut reader = Reader {
            stop: &AtomicBool::new(false),
            external_cancel: None,
            progress: Progress::default(),
            on_progress: &mut |_| {},
            emitted: Instant::now(),
            budget: 1024,
        };
        assert!(matches!(same_bytes(&one, &other, &mut reader), Ok(false)));
        fs::rename(root.join("one"), root.join("original")).unwrap();
        fs::write(root.join("one"), b"same").unwrap();
        assert!(matches!(hash(&one, &mut reader), Err(ReadFailure::Changed)));
        assert_eq!(fs::read(root.join("original")).unwrap(), b"same");
    }

    #[test]
    fn bounds_progress_messages_across_many_size_buckets() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        for size in 1..=100 {
            let contents = vec![b'x'; size];
            fs::write(root.join(format!("{size}-one")), &contents).unwrap();
            fs::write(root.join(format!("{size}-two")), &contents).unwrap();
        }
        let started = Instant::now();
        let mut updates = 0;
        let report = scan(&root, false, &AtomicBool::new(false), LIMITS, &mut |_| {
            updates += 1
        })
        .unwrap()
        .unwrap();
        assert_eq!(report.groups.len(), 100);
        assert!(
            updates <= started.elapsed().as_millis() / 100 + 8,
            "progress emitted {updates} messages for a short scan"
        );
        assert_eq!(fs::read(root.join("100-one")).unwrap(), vec![b'x'; 100]);
        assert_eq!(fs::read(root.join("100-two")).unwrap(), vec![b'x'; 100]);
    }
}
