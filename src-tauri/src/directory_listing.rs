//! Cancellable, incremental directory reads. Filesystem calls may still wait on
//! the operating system, but a superseded read stops before the next entry.
use crate::{
    diagnostics::{self, Failure},
    entry_info, strpath, Entry, Listing,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::ErrorKind,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, State, Window};

#[derive(Clone, Default)]
pub(crate) struct Requests(Arc<Mutex<HashMap<(String, String), Request>>>);
struct Request {
    cancelled: Arc<AtomicBool>,
    started: bool,
}

impl Requests {
    fn begin(&self, window: &str, id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut requests = self.0.lock().unwrap();
        let request = requests
            .entry((window.into(), id.into()))
            .or_insert_with(|| Request {
                cancelled: Arc::new(AtomicBool::new(false)),
                started: false,
            });
        if request.started {
            return Err("读取请求已存在".into());
        }
        request.started = true;
        Ok(request.cancelled.clone())
    }
    fn finish(&self, window: &str, id: &str) {
        self.0.lock().unwrap().remove(&(window.into(), id.into()));
    }
    fn cancel(&self, window: &str, id: &str) {
        let mut requests = self.0.lock().unwrap();
        // Keep early cancellations until registration, with a bounded number of
        // tombstones for requests that never arrive.
        if requests.values().filter(|request| !request.started).count() >= 128 {
            if let Some(key) = requests
                .iter()
                .find(|(_, request)| !request.started)
                .map(|(key, _)| key.clone())
            {
                requests.remove(&key);
            }
        }
        requests
            .entry((window.into(), id.into()))
            .or_insert_with(|| Request {
                cancelled: Arc::new(AtomicBool::new(true)),
                started: false,
            })
            .cancelled
            .store(true, Ordering::Relaxed);
    }
    pub(crate) fn close(&self, window: &str) {
        let mut requests = self.0.lock().unwrap();
        requests.retain(|(owner, _), request| {
            if owner != window {
                return true;
            }
            request.cancelled.store(true, Ordering::Relaxed);
            false
        });
    }
}

#[derive(Clone, Serialize)]
pub(crate) struct Batch {
    path: String,
    parent: Option<String>,
    entries: Vec<Entry>,
}

pub(crate) fn read(
    path: &Path,
    cancelled: &AtomicBool,
    mut on_batch: impl FnMut(Batch) -> bool,
) -> Result<Option<Listing>, Failure> {
    let operation = "打开文件夹";
    if cancelled.load(Ordering::Relaxed) {
        return Ok(None);
    }
    let directory = dunce::canonicalize(path)
        .map_err(|error| Failure::io(operation, "解析路径", path, error))?;
    let items = fs::read_dir(&directory)
        .map_err(|error| Failure::io(operation, "打开目录", &directory, error))?;
    let path = strpath(&directory);
    let parent = directory.parent().map(strpath);
    let mut entries = Vec::new();
    let mut batch = Vec::new();
    let mut last_batch = Instant::now();
    for item in items {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let item = item.map_err(|error| Failure::io(operation, "枚举目录项", &directory, error))?;
        let item_path = item.path();
        // DirEntry metadata preserves Windows enumeration behavior for device
        // names and reads symlink metadata without following links.
        let meta = match item.metadata() {
            Ok(meta) => meta,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(Failure::io(operation, "读取项目属性", &item_path, error)),
        };
        let entry = entry_info(&item_path, &meta);
        batch.push(entry.clone());
        entries.push(entry);
        if batch.len() >= 256 || last_batch.elapsed() >= Duration::from_millis(80) {
            if !on_batch(Batch {
                path: path.clone(),
                parent: parent.clone(),
                entries: std::mem::take(&mut batch),
            }) {
                return Ok(None);
            }
            last_batch = Instant::now();
        }
    }
    if cancelled.load(Ordering::Relaxed) {
        return Ok(None);
    }
    // The final return is authoritative, so it also works for callers without
    // a channel and replaces any earlier partial snapshot on the frontend.
    Ok(Some(Listing {
        path,
        parent,
        entries,
    }))
}

#[tauri::command]
pub(crate) async fn list_directory(
    path: String,
    id: Option<String>,
    on_batch: Channel<Batch>,
    window: Window,
    app: tauri::AppHandle,
    state: State<'_, Requests>,
) -> Result<Option<Listing>, String> {
    let owner = window.label().to_string();
    let requests = state.inner().clone();
    let cancelled = match &id {
        Some(id) => requests.begin(&owner, id)?,
        None => Arc::new(AtomicBool::new(false)),
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        read(Path::new(&path), &cancelled, |batch| {
            on_batch.send(batch).is_ok()
        })
        .map_err(|failure| {
            let message = format!("{}失败：{}", failure.step, failure.message);
            diagnostics::record(&app, failure);
            message
        })
    })
    .await
    .map_err(|error| error.to_string());
    if let Some(id) = id {
        requests.finish(&owner, &id);
    }
    result?
}

#[tauri::command]
pub(crate) fn cancel_directory_listing(id: String, window: Window, state: State<'_, Requests>) {
    state.cancel(window.label(), &id);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streams_a_large_directory_and_returns_the_complete_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..1025 {
            fs::write(
                directory.path().join(format!("{index:04}.txt")),
                b"unchanged",
            )
            .unwrap();
        }
        let expected_path = strpath(&dunce::canonicalize(directory.path()).unwrap());
        let mut received = Vec::new();
        let result = read(directory.path(), &AtomicBool::new(false), |batch| {
            assert_eq!(batch.path, expected_path);
            assert!(!batch.entries.is_empty() && batch.entries.len() <= 256);
            received.extend(batch.entries);
            true
        })
        .unwrap()
        .unwrap();
        assert!(received.len() >= 256);
        assert_eq!(result.entries.len(), 1025);
        assert!(received
            .iter()
            .all(|entry| result.entries.iter().any(|item| item.path == entry.path)));
        assert_eq!(
            fs::read(directory.path().join("0000.txt")).unwrap(),
            b"unchanged"
        );
    }
    #[test]
    fn cancellation_stops_enumeration_without_mutating_files() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..600 {
            fs::write(directory.path().join(index.to_string()), b"keep").unwrap();
        }
        let cancelled = AtomicBool::new(false);
        let mut batches = 0;
        assert!(read(directory.path(), &cancelled, |_| {
            batches += 1;
            cancelled.store(true, Ordering::Relaxed);
            true
        })
        .unwrap()
        .is_none());
        assert_eq!(batches, 1);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 600);
    }
    #[test]
    fn cancellation_before_registration_is_scoped_to_the_window() {
        let requests = Requests::default();
        requests.cancel("left", "request");
        assert!(requests
            .begin("left", "request")
            .unwrap()
            .load(Ordering::Relaxed));
        let right = requests.begin("right", "request").unwrap();
        assert!(!right.load(Ordering::Relaxed));
        requests.close("right");
        assert!(right.load(Ordering::Relaxed));
        requests.finish("left", "request");
        assert!(requests.0.lock().unwrap().is_empty());
    }
}
