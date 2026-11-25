use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{Conflict, Shared, Task};

// Cloning task internals here used to copy every source, committed change and
// retry identity on each progress tick while holding the worker's task lock.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskSummary {
    id: String,
    pub(crate) sequence: u64,
    kind: String,
    destination: String,
    status: String,
    current: String,
    phase: String,
    completed: u64,
    skipped: u64,
    bytes: u64,
    total_bytes: Option<u64>,
    current_bytes: u64,
    current_total_bytes: Option<u64>,
    transfer_millis: u64,
    source_count: usize,
    first_source: Option<String>,
    error_count: usize,
    failed_count: usize,
    conflict: Option<Conflict>,
    can_pause: bool,
    pause_requested: bool,
    queue_position: Option<usize>,
}

impl From<&Task> for TaskSummary {
    fn from(task: &Task) -> Self {
        Self {
            id: task.id.clone(),
            sequence: task.sequence,
            kind: task.kind.clone(),
            destination: task.destination.clone(),
            status: task.status.clone(),
            current: task.current.clone(),
            phase: task.phase.clone(),
            completed: task.completed,
            skipped: task.skipped,
            bytes: task.bytes,
            total_bytes: task.total_bytes,
            current_bytes: task.current_bytes,
            current_total_bytes: task.current_total_bytes,
            transfer_millis: task.transfer_millis,
            source_count: task.sources.len(),
            first_source: task.sources.first().cloned(),
            error_count: task.errors.len(),
            failed_count: task.failed_sources.len(),
            conflict: task.conflict.clone(),
            can_pause: task.can_pause,
            pause_requested: task.pause_requested,
            queue_position: task.queue_position,
        }
    }
}

#[derive(Default)]
pub(crate) struct TaskFeed {
    revision: AtomicU64,
    changed: Mutex<HashSet<String>>,
    wake: OnceLock<SyncSender<()>>,
}

#[derive(Clone, Serialize)]
struct Delta {
    revision: u64,
    updates: Vec<TaskSummary>,
    removed: Vec<String>,
    undo: Option<&'static str>,
}

impl TaskFeed {
    pub(crate) fn revision(&self) -> u64 {
        self.revision.load(Ordering::Relaxed)
    }

    pub(crate) fn change(&self, id: Option<&str>) {
        let Some(wake) = self.wake.get() else { return };
        let mut changed = self.changed.lock().unwrap();
        if let Some(id) = id {
            changed.insert(id.to_owned());
        }
        self.revision.fetch_add(1, Ordering::Relaxed);
        let _ = wake.try_send(());
    }

    pub(crate) fn start(&self, app: AppHandle) {
        let (sender, receiver) = mpsc::sync_channel(1);
        if self.wake.set(sender).is_err() {
            return;
        }
        std::thread::spawn(move || {
            let shared = app.state::<Arc<Shared>>();
            let mut last = 0;
            while receiver.recv().is_ok() {
                std::thread::sleep(Duration::from_millis(110));
                let delta = {
                    let tasks = shared.tasks.lock().unwrap();
                    let mut changed = shared.task_feed.changed.lock().unwrap();
                    let revision = shared.task_feed.revision();
                    if revision == last {
                        continue;
                    }
                    last = revision;
                    let mut updates = Vec::new();
                    let mut removed = Vec::new();
                    for id in changed.drain() {
                        if let Some(task) = tasks.get(&id) {
                            updates.push(TaskSummary::from(task));
                        } else {
                            removed.push(id);
                        }
                    }
                    let undo = shared.undo.lock().unwrap().last().map(|entry| entry.label);
                    Delta {
                        revision,
                        updates,
                        removed,
                        undo,
                    }
                };
                let _ = app.emit("task-activity", delta);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FileChange;

    #[test]
    fn task_progress_payload_stays_bounded_with_ten_thousand_sources() {
        let mut task = Task {
            id: "batch".into(),
            kind: "move".into(),
            destination: "/fixture/destination".into(),
            status: "running".into(),
            ..Default::default()
        };
        let mut sources = Vec::new();
        for i in 0..10_000 {
            let from = format!("/fixture/source/{i:05}.txt");
            let to = format!("/fixture/destination/{i:05}.txt");
            sources.push(from.clone());
            task.file_changes.push(FileChange {
                from,
                to: Some(to),
                kind: "move".into(),
            });
        }
        task.sources = sources.into();
        let full_bytes = serde_json::to_vec(&task).unwrap().len();
        let summary = serde_json::to_vec(&TaskSummary::from(&task)).unwrap();
        let fields: serde_json::Value = serde_json::from_slice(&summary).unwrap();
        assert_eq!(fields["sourceCount"], 10_000);
        assert_eq!(fields["firstSource"], "/fixture/source/00000.txt");
        assert!(fields.get("sources").is_none());
        assert!(fields.get("fileChanges").is_none());
        assert!(summary.len() < 1024);
        eprintln!(
            "10,000-source task: old JSON {full_bytes} bytes, summary {} bytes",
            summary.len()
        );
    }
}
