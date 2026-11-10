use std::{
    collections::BTreeMap,
    io::{BufReader, Read},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

use serde::Serialize;
use tauri::{State, Window};

use crate::{
    entry_info, fs_safety::is_link, open_regular_file, storage::ScanState, strpath, Entry,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Difference {
    relative: String,
    left: Option<Entry>,
    right: Option<Entry>,
    left_parent: Option<String>,
    right_parent: Option<String>,
}

#[derive(Default, Serialize)]
pub(crate) struct Report {
    differences: Vec<Difference>,
    total: usize,
    skipped: usize,
}

fn entries(
    root: &Path,
    stop: &AtomicBool,
    skipped: &mut usize,
) -> Result<BTreeMap<PathBuf, Entry>, String> {
    let mut entries = BTreeMap::new();
    let mut walker = walkdir::WalkDir::new(root)
        .min_depth(1)
        .same_file_system(true)
        .into_iter();
    while let Some(item) = walker.next() {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let Ok(item) = item else {
            *skipped += 1;
            continue;
        };
        let Ok(metadata) = item.metadata() else {
            *skipped += 1;
            continue;
        };
        if is_link(&metadata) || !(metadata.is_dir() || metadata.is_file()) {
            if item.file_type().is_dir() {
                walker.skip_current_dir();
            }
            *skipped += 1;
            continue;
        }
        let relative = item
            .path()
            .strip_prefix(root)
            .map_err(|error| error.to_string())?;
        entries.insert(relative.to_owned(), entry_info(item.path(), &metadata));
        if entries.len() > 250_000 {
            return Err("目录对比最多扫描每侧 250,000 项，请缩小范围".into());
        }
    }
    Ok(entries)
}

fn same_bytes(left: &Entry, right: &Entry, stop: &AtomicBool) -> Result<bool, String> {
    let mut left = BufReader::new(open_regular_file(Path::new(&left.path), false)?);
    let mut right = BufReader::new(open_regular_file(Path::new(&right.path), false)?);
    let mut a = [0; 32768];
    let mut b = [0; 32768];
    while !stop.load(Ordering::Relaxed) {
        let size = left.read(&mut a).map_err(|error| error.to_string())?;
        if size == 0 {
            return right
                .read(&mut b)
                .map(|size| size == 0)
                .map_err(|error| error.to_string());
        }
        match right.read_exact(&mut b[..size]) {
            Ok(()) if a[..size] == b[..size] => {}
            Ok(()) => return Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(false),
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(false)
}

fn parent_for(root: &Path, relative: &Path, items: &BTreeMap<PathBuf, Entry>) -> Option<String> {
    let parent = relative.parent()?;
    if parent.as_os_str().is_empty() {
        return Some(strpath(root));
    }
    items
        .get(parent)
        .filter(|item| item.is_dir)
        .map(|item| item.path.clone())
}

fn scan(
    left_root: &Path,
    right_root: &Path,
    content: bool,
    stop: &AtomicBool,
) -> Result<Option<Report>, String> {
    let mut report = Report::default();
    let left = entries(left_root, stop, &mut report.skipped)?;
    let right = entries(right_root, stop, &mut report.skipped)?;
    for path in left
        .keys()
        .chain(right.keys().filter(|path| !left.contains_key(*path)))
    {
        if stop.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let a = left.get(path);
        let b = right.get(path);
        let equal = match (a, b) {
            (Some(a), Some(b)) if a.is_dir && b.is_dir => true,
            (Some(a), Some(b)) if !a.is_dir && !b.is_dir && a.size == b.size => {
                if content {
                    match same_bytes(a, b, stop) {
                        Ok(equal) => equal,
                        Err(_) => {
                            report.skipped += 1;
                            continue;
                        }
                    }
                } else {
                    a.modified == b.modified
                }
            }
            _ => false,
        };
        if !equal {
            report.total += 1;
            if report.differences.len() < 1000 {
                report.differences.push(Difference {
                    relative: strpath(path),
                    left: a.cloned(),
                    right: b.cloned(),
                    left_parent: parent_for(left_root, path, &left),
                    right_parent: parent_for(right_root, path, &right),
                });
            }
        }
    }
    Ok((!stop.load(Ordering::Relaxed)).then_some(report))
}

#[tauri::command]
pub(crate) async fn compare_directories(
    window: Window,
    state: State<'_, ScanState>,
    id: String,
    left: PathBuf,
    right: PathBuf,
    content: bool,
) -> Result<Option<Report>, String> {
    state
        .run(format!("compare:{}", window.label()), id, move |stop| {
            let left = dunce::canonicalize(left).map_err(|error| error.to_string())?;
            let right = dunce::canonicalize(right).map_err(|error| error.to_string())?;
            if !left.is_dir() || !right.is_dir() {
                return Err("请选择两个可访问的文件夹".into());
            }
            if left == right {
                return Ok(Some(Report::default()));
            }
            scan(&left, &right, content, stop)
        })
        .await
}

#[tauri::command]
pub(crate) fn cancel_compare(window: Window, state: State<'_, ScanState>, id: String) {
    state.cancel(&format!("compare:{}", window.label()), &id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn compares_contents_and_keeps_relative_targets() {
        let root = tempfile::tempdir().unwrap();
        let left = root.path().join("left");
        let right = root.path().join("right");
        fs::create_dir_all(left.join("nested")).unwrap();
        fs::create_dir_all(right.join("nested")).unwrap();
        fs::write(left.join("nested/match.txt"), b"equal").unwrap();
        fs::write(right.join("nested/match.txt"), b"equal").unwrap();
        fs::write(left.join("changed.txt"), b"abc").unwrap();
        fs::write(right.join("changed.txt"), b"xyz").unwrap();
        fs::write(right.join("nested/right.txt"), b"right").unwrap();
        let report = scan(&left, &right, true, &AtomicBool::new(false))
            .unwrap()
            .unwrap();
        assert_eq!(report.total, 2);
        let only_right = report
            .differences
            .iter()
            .find(|row| row.left.is_none())
            .unwrap();
        assert_eq!(only_right.left_parent, Some(strpath(&left.join("nested"))));
    }
}
