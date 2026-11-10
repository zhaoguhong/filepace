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

use crate::{Shared, Task};

#[derive(Default)]
pub(crate) struct TaskFeed {
    revision: AtomicU64,
    changed: Mutex<HashSet<String>>,
    wake: OnceLock<SyncSender<()>>,
}

#[derive(Clone, Serialize)]
struct Delta {
    revision: u64,
    updates: Vec<Task>,
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
                            updates.push(task.clone());
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
