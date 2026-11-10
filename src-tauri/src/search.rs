use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{ipc::Channel, State, Window};
use walkdir::WalkDir;

use crate::{
    entry_info,
    fs_safety::{entry_path, is_link},
    storage::{category_for, ScanState},
    strpath, system_process, Entry,
};

const LIMIT: usize = 300;

#[derive(Clone, Serialize)]
pub(crate) struct Hit {
    entry: Entry,
    parent: String,
}

#[derive(Default, Serialize)]
pub(crate) struct SearchReport {
    hits: Vec<Hit>,
    indexed: bool,
    limited: bool,
    skipped: usize,
}

struct Filter {
    query: String,
    category: String,
    hidden: bool,
    min_size: Option<u64>,
    modified_after: Option<u64>,
}

impl Filter {
    fn matches(&self, entry: &Entry) -> bool {
        let category = if entry.is_dir {
            "folder"
        } else {
            category_for(Path::new(&entry.path))
        };
        (self.category.is_empty() || self.category == category)
            && (self.hidden || !entry.hidden)
            && entry.name.to_lowercase().contains(&self.query)
            && self
                .min_size
                .is_none_or(|size| !entry.is_dir && entry.size >= size)
            && self
                .modified_after
                .is_none_or(|time| entry.modified >= time)
    }
}

impl SearchReport {
    fn add(&mut self, entry: Entry) -> bool {
        if self.hits.len() == LIMIT {
            self.limited = true;
            return false;
        }
        let parent = Path::new(&entry.path)
            .parent()
            .map(strpath)
            .unwrap_or_default();
        self.hits.push(Hit { entry, parent });
        true
    }
}

#[cfg(target_os = "macos")]
fn native_query(root: &Path, query: &str) -> Option<Command> {
    let mut command = Command::new("/usr/bin/mdfind");
    command
        .arg("-0")
        .arg("-onlyin")
        .arg(root)
        .arg("-name")
        .arg(query);
    Some(command)
}

#[cfg(windows)]
fn native_query(root: &Path, query: &str) -> Option<Command> {
    if query.contains(['%', '_', '[', ']', '*', '?']) || root.to_string_lossy().starts_with(r"\\") {
        return None;
    }
    // Pass data through environment variables. Only the fixed script is executed.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$scope = $env:FILEPACE_SEARCH_ROOT.Replace("'", "''").Replace('\', '/')
$name = $env:FILEPACE_SEARCH_TEXT.Replace("'", "''")
$connection = [Data.OleDb.OleDbConnection]::new('Provider=Search.CollatorDSO;Extended Properties="Application=Windows"')
try {
    $connection.Open()
    $command = $connection.CreateCommand()
    $command.CommandText = "SELECT TOP 1500 System.ItemPathDisplay FROM SystemIndex WHERE SCOPE='file:$scope' AND System.FileName LIKE '%$name%'"
    $results = $command.ExecuteReader()
    while ($results.Read()) {
        if (-not $results.IsDBNull(0)) {
            [Console]::Write($results.GetString(0) + [char]0)
        }
    }
} finally {
    $connection.Dispose()
}
"#;
    let executable =
        system_process::system_directory()?.join(r"WindowsPowerShell\v1.0\powershell.exe");
    let mut command = Command::new(executable);
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            SCRIPT,
        ])
        .env("FILEPACE_SEARCH_ROOT", root)
        .env("FILEPACE_SEARCH_TEXT", query);
    Some(command)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn native_query(_root: &Path, _query: &str) -> Option<Command> {
    None
}

fn search_index(
    root: &Path,
    filter: &Filter,
    query: &str,
    stop: &AtomicBool,
) -> Option<SearchReport> {
    let output = system_process::run(
        native_query(root, query)?,
        || stop.load(Ordering::Relaxed),
        Some(Duration::from_secs(4)),
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut report = SearchReport {
        indexed: true,
        ..Default::default()
    };
    let mut seen = std::collections::HashSet::new();
    for bytes in output.stdout.split(|&byte| byte == 0) {
        if stop.load(Ordering::Relaxed) {
            return None;
        }
        let Ok(path) = std::str::from_utf8(bytes) else {
            continue;
        };
        let Ok(path) = entry_path(Path::new(path)) else {
            continue;
        };
        if path == root || !path.starts_with(root) || !seen.insert(path.clone()) {
            continue;
        }
        if !filter.hidden
            && path
                .strip_prefix(root)
                .ok()?
                .components()
                .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
        {
            continue;
        }
        let Ok(metadata) = path.symlink_metadata() else {
            continue;
        };
        if is_link(&metadata) || !(metadata.is_file() || metadata.is_dir()) {
            continue;
        }
        let entry = entry_info(&path, &metadata);
        if filter.matches(&entry) && !report.add(entry) {
            break;
        }
    }
    (!report.hits.is_empty()).then_some(report)
}

fn walk(
    root: &Path,
    filter: &Filter,
    stop: &AtomicBool,
    mut on_batch: impl FnMut(&[Hit]),
) -> Result<SearchReport, String> {
    let mut report = SearchReport::default();
    let mut entries = WalkDir::new(root)
        .min_depth(1)
        .follow_links(false)
        .same_file_system(true)
        .into_iter();
    let mut sent = 0;
    let mut last = Instant::now();
    while let Some(entry) = entries.next() {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) if error.depth() == 0 => return Err(error.to_string()),
            Err(_) => {
                report.skipped += 1;
                continue;
            }
        };
        let Ok(metadata) = entry.metadata() else {
            report.skipped += 1;
            if entry.file_type().is_dir() {
                entries.skip_current_dir();
            }
            continue;
        };
        if is_link(&metadata) || !(metadata.is_file() || metadata.is_dir()) {
            if entry.file_type().is_dir() {
                entries.skip_current_dir();
            }
            continue;
        }
        let item = entry_info(entry.path(), &metadata);
        if item.is_dir && item.hidden && !filter.hidden {
            entries.skip_current_dir();
        }
        if filter.matches(&item) {
            if !report.add(item) {
                break;
            }
            if sent == 0
                || report.hits.len() - sent >= 32
                || last.elapsed() >= Duration::from_millis(160)
            {
                on_batch(&report.hits[sent..]);
                sent = report.hits.len();
                last = Instant::now();
            }
        }
    }
    Ok(report)
}

#[tauri::command]
pub(crate) async fn search_files(
    window: Window,
    state: State<'_, ScanState>,
    id: String,
    path: PathBuf,
    query: String,
    category: String,
    hidden: bool,
    exhaustive: bool,
    min_size: Option<u64>,
    modified_after: Option<u64>,
    on_batch: Channel<Vec<Hit>>,
) -> Result<Option<SearchReport>, String> {
    let query = query.trim().to_owned();
    if !path.is_absolute()
        || query.len() > 1024
        || query.contains('\0')
        || (query.is_empty()
            && category.is_empty()
            && min_size.is_none()
            && modified_after.is_none())
    {
        return Err("请输入关键词或选择搜索条件".into());
    }
    state
        .run(format!("search:{}", window.label()), id, move |stop| {
            let root = dunce::canonicalize(path).map_err(|error| error.to_string())?;
            if !root.is_dir() {
                return Err("请选择要搜索的文件夹".into());
            }
            let filter = Filter {
                query: query.to_lowercase(),
                category,
                hidden,
                min_size,
                modified_after,
            };
            let indexed = if exhaustive || query.is_empty() {
                None
            } else {
                search_index(&root, &filter, &query, stop)
            };
            let mut report = match indexed {
                Some(report) => report,
                None => walk(&root, &filter, stop, |batch| {
                    let _ = on_batch.send(batch.to_vec());
                })?,
            };
            report.hits.sort_by(|a, b| {
                a.entry
                    .name
                    .to_lowercase()
                    .cmp(&b.entry.name.to_lowercase())
                    .then_with(|| a.entry.path.cmp(&b.entry.path))
            });
            Ok((!stop.load(Ordering::Relaxed)).then_some(report))
        })
        .await
}

#[tauri::command]
pub(crate) fn cancel_search(window: Window, state: State<'_, ScanState>, id: String) {
    state.cancel(&format!("search:{}", window.label()), &id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn scans_nested_names_and_types_without_hidden_folders() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        fs::create_dir(root.join("sub")).unwrap();
        fs::create_dir(root.join(".hidden")).unwrap();
        for name in ["sub/会议.PDF", "sub/会议.png", ".hidden/会议.md"] {
            fs::write(root.join(name), b"fixture").unwrap();
        }
        let filter = Filter {
            query: "会议".into(),
            category: "documents".into(),
            hidden: false,
            min_size: Some(7),
            modified_after: None,
        };
        let stopped = AtomicBool::new(false);
        let mut batches = 0;
        let report = walk(root, &filter, &stopped, |batch| batches += batch.len()).unwrap();
        assert_eq!(report.hits.len(), 1);
        assert_eq!(batches, 1);
        assert_eq!(report.hits[0].entry.name, "会议.PDF");
        assert_eq!(report.hits[0].parent, strpath(&root.join("sub")));
        stopped.store(true, Ordering::Relaxed);
        assert!(walk(root, &filter, &stopped, |_| {})
            .unwrap()
            .hits
            .is_empty());
    }
}
