//! Cancellable, incremental directory reads. Filesystem calls may still wait on
//! the operating system, but a superseded read stops before the next entry.
use crate::{
    diagnostics::{self, Failure},
    entry_info, strpath, Entry, Listing,
};
use serde::{Deserialize, Serialize};
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

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Delivery {
    #[default]
    Legacy,
    Stream,
    Snapshot,
}

#[derive(Serialize)]
pub(crate) struct Batch {
    path: String,
    parent: Option<String>,
    entries: Vec<Entry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<usize>,
}

#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum DirectoryResult {
    Snapshot(Listing),
    Streamed { streamed: bool },
}

fn read_with_delivery(
    path: &Path,
    cancelled: &AtomicBool,
    delivery: Delivery,
    mut on_batch: impl FnMut(Batch) -> bool,
) -> Result<Option<DirectoryResult>, Failure> {
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
    let mut sent = 0;
    let mut buffered = 0;
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
        entries.push(entry_info(&item_path, &meta));
        if delivery == Delivery::Snapshot {
            continue;
        }
        buffered += 1;
        if buffered >= 256 || last_batch.elapsed() >= Duration::from_millis(80) {
            let batch = if delivery == Delivery::Stream {
                std::mem::take(&mut entries)
            } else {
                entries[sent..].to_vec()
            };
            if !on_batch(Batch {
                path: path.clone(),
                parent: parent.clone(),
                entries: batch,
                total: None,
            }) {
                return Ok(None);
            }
            sent += buffered;
            buffered = 0;
            last_batch = Instant::now();
        }
    }
    if cancelled.load(Ordering::Relaxed) {
        return Ok(None);
    }
    // Once streaming starts the final count and tail travel on the same
    // ordered channel. The invoke acknowledgement can arrive before either.
    if delivery == Delivery::Stream && sent != 0 {
        let total = sent + entries.len();
        return Ok(on_batch(Batch {
            path,
            parent,
            entries,
            total: Some(total),
        })
        .then_some(DirectoryResult::Streamed { streamed: true }));
    }
    Ok(Some(DirectoryResult::Snapshot(Listing {
        path,
        parent,
        entries,
    })))
}

#[cfg(test)]
pub(crate) fn read(
    path: &Path,
    cancelled: &AtomicBool,
    on_batch: impl FnMut(Batch) -> bool,
) -> Result<Option<Listing>, Failure> {
    Ok(
        read_with_delivery(path, cancelled, Delivery::Legacy, on_batch)?.map(
            |result| match result {
                DirectoryResult::Snapshot(listing) => listing,
                DirectoryResult::Streamed { .. } => unreachable!(),
            },
        ),
    )
}

#[tauri::command]
pub(crate) async fn list_directory(
    path: String,
    id: Option<String>,
    delivery: Option<Delivery>,
    on_batch: Channel<Batch>,
    window: Window,
    app: tauri::AppHandle,
    state: State<'_, Requests>,
) -> Result<Option<DirectoryResult>, String> {
    let owner = window.label().to_string();
    let requests = state.inner().clone();
    let cancelled = match &id {
        Some(id) => requests.begin(&owner, id)?,
        None => Arc::new(AtomicBool::new(false)),
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        read_with_delivery(
            Path::new(&path),
            &cancelled,
            delivery.unwrap_or_default(),
            |batch| on_batch.send(batch).is_ok(),
        )
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
    fn streams_each_entry_once_and_refreshes_without_partial_batches() {
        let directory = tempfile::tempdir().unwrap();
        let mut created = 0;
        for count in [0, 1, 255, 256, 257, 1025] {
            for index in created..count {
                fs::write(directory.path().join(format!("{index}.txt")), b"keep").unwrap();
            }
            created = count;
            for delivery in [Delivery::Stream, Delivery::Snapshot] {
                let mut received = Vec::new();
                let mut final_count = None;
                let result = read_with_delivery(
                    directory.path(),
                    &AtomicBool::new(false),
                    delivery,
                    |batch| {
                        assert!(delivery == Delivery::Stream);
                        assert!(final_count.is_none());
                        assert!(batch.entries.len() <= 256);
                        received.extend(batch.entries.into_iter().map(|entry| entry.name));
                        final_count = batch.total;
                        true
                    },
                )
                .unwrap()
                .unwrap();
                match result {
                    DirectoryResult::Snapshot(listing) => {
                        assert!(received.is_empty());
                        assert!(delivery == Delivery::Snapshot || count < 256);
                        received.extend(listing.entries.into_iter().map(|entry| entry.name));
                    }
                    DirectoryResult::Streamed { streamed } => {
                        assert!(streamed);
                        assert_eq!(final_count, Some(count));
                    }
                }
                assert_eq!(received.len(), count);
                for index in 0..count {
                    assert_eq!(
                        fs::read(directory.path().join(format!("{index}.txt"))).unwrap(),
                        b"keep"
                    );
                }
                let names: std::collections::HashSet<_> = received.into_iter().collect();
                assert_eq!(names.len(), count);
                assert!((0..count).all(|index| names.contains(&format!("{index}.txt"))));
            }
        }
    }

    #[test]
    fn failed_stream_does_not_confirm_completion() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..257 {
            fs::write(directory.path().join(index.to_string()), []).unwrap();
        }
        let mut received = 0;
        let result = read_with_delivery(
            directory.path(),
            &AtomicBool::new(false),
            Delivery::Stream,
            |batch| {
                received += batch.entries.len();
                batch.total.is_none()
            },
        )
        .unwrap();
        assert_eq!(received, 257);
        assert!(result.is_none());
    }
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
    #[ignore = "opt-in warm directory enumeration and JSON payload benchmark"]
    fn benchmark_directory_delivery() {
        for count in [10_000, 100_000] {
            let directory = tempfile::tempdir().unwrap();
            for index in 0..count {
                fs::write(
                    directory.path().join(format!("file-{index:06}.txt")),
                    b"keep",
                )
                .unwrap();
            }
            let modes = [Delivery::Legacy, Delivery::Stream, Delivery::Snapshot];
            let mut samples: [Vec<Duration>; 3] = Default::default();
            let mut bytes = [0; 3];
            let mut records = [0; 3];
            for round in 0..6 {
                for trial in 0..3 {
                    let index = (trial + round) % 3;
                    let mut logical_bytes = 0;
                    let mut logical_entries = 0;
                    let started = Instant::now();
                    let result = read_with_delivery(
                        directory.path(),
                        &AtomicBool::new(false),
                        modes[index],
                        |batch| {
                            logical_bytes += serde_json::to_vec(&batch).unwrap().len();
                            logical_entries += batch.entries.len();
                            true
                        },
                    )
                    .unwrap()
                    .unwrap();
                    logical_bytes += serde_json::to_vec(&result).unwrap().len();
                    if let DirectoryResult::Snapshot(listing) = result {
                        logical_entries += listing.entries.len();
                    }
                    samples[index].push(started.elapsed());
                    bytes[index] = logical_bytes;
                    records[index] = logical_entries;
                }
            }
            for (index, label) in ["legacy", "stream", "snapshot"].iter().enumerate() {
                samples[index].sort();
                eprintln!(
                    "{count} {label}: median {:?}, JSON bytes {}, entry records {}",
                    (samples[index][2] + samples[index][3]) / 2,
                    bytes[index],
                    records[index]
                );
            }
            assert_eq!(records[1..], [count, count]);
            assert_eq!(
                fs::read(directory.path().join("file-000000.txt")).unwrap(),
                b"keep"
            );
        }
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
