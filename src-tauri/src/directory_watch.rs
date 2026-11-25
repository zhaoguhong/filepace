use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        mpsc::{self, SyncSender},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, Window};

use crate::{strpath, Shared};

#[derive(Default)]
struct PendingChanges {
    paths: HashSet<String>,
    rescan: bool,
}

impl PendingChanges {
    fn add(&mut self, paths: Option<Vec<String>>) {
        match paths {
            Some(paths) if !self.rescan => self.paths.extend(paths),
            None => {
                self.rescan = true;
                self.paths.clear();
            }
            _ => {}
        }
    }
}

#[derive(Default)]
pub(crate) struct DirectoryEvents {
    pending: Mutex<PendingChanges>,
    wake: OnceLock<SyncSender<()>>,
}

impl DirectoryEvents {
    fn start(&self, app: AppHandle) {
        let (sender, receiver) = mpsc::sync_channel(1);
        if self.wake.set(sender).is_err() {
            return;
        }
        std::thread::spawn(move || {
            let shared = app.state::<Arc<Shared>>();
            while receiver.recv().is_ok() {
                std::thread::sleep(Duration::from_millis(90));
                let batch = std::mem::take(&mut *shared.directory_events.pending.lock().unwrap());
                if batch.rescan {
                    let _ = app.emit("directory-changed", ());
                } else if !batch.paths.is_empty() {
                    let _ = app.emit("directory-changed", batch.paths);
                }
            }
        });
    }

    pub(crate) fn add(&self, paths: Option<Vec<String>>) {
        let Some(wake) = self.wake.get() else { return };
        self.pending.lock().unwrap().add(paths);
        let _ = wake.try_send(());
    }
}

#[derive(Default)]
pub(crate) struct DirectoryWatch {
    watcher: Option<RecommendedWatcher>,
    windows: HashMap<String, (u64, HashSet<PathBuf>)>,
    registered: HashSet<PathBuf>,
}

impl DirectoryWatch {
    pub(crate) fn start(&mut self, app: AppHandle) {
        app.state::<Arc<Shared>>()
            .directory_events
            .start(app.clone());
        self.watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| match event {
                Ok(event) if !event.need_rescan() => {
                    if matches!(event.kind, EventKind::Access(_)) {
                        return;
                    }
                    let paths: Vec<_> = event
                        .paths
                        .iter()
                        .filter(|path| {
                            !path.components().any(|part| {
                                let name = part.as_os_str().to_string_lossy();
                                name.starts_with(".filepace-stage-")
                                    || name.starts_with(".filepace-replaced-")
                            })
                        })
                        .map(|path| strpath(path))
                        .collect();
                    if !paths.is_empty() {
                        app.state::<Arc<Shared>>().directory_events.add(Some(paths));
                    }
                }
                _ => {
                    app.state::<Arc<Shared>>().directory_events.add(None);
                }
            })
            .ok();
    }

    fn sync(&mut self) {
        let Some(watcher) = self.watcher.as_mut() else {
            return;
        };
        let desired: HashSet<_> = self
            .windows
            .values()
            .flat_map(|(_, paths)| paths.iter().cloned())
            .collect();
        self.registered.retain(|path| {
            if desired.contains(path) {
                true
            } else {
                let _ = watcher.unwatch(path);
                false
            }
        });
        for path in desired {
            if !self.registered.contains(&path)
                && watcher.watch(&path, RecursiveMode::NonRecursive).is_ok()
            {
                self.registered.insert(path);
            }
        }
    }

    pub(crate) fn close(&mut self, label: &str) {
        self.windows.remove(label);
        self.sync();
    }
}

#[tauri::command]
pub(crate) async fn watch_directories(
    window: Window,
    paths: Vec<String>,
    generation: u64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let label = window.label().to_owned();
        let paths = paths
            .into_iter()
            .filter_map(|path| dunce::canonicalize(path).ok())
            .collect();
        let app = window.app_handle();
        let shared = app.state::<Arc<Shared>>();
        let mut watch = shared.directory_watch.lock().unwrap();
        if app.get_webview_window(&label).is_none()
            || watch
                .windows
                .get(&label)
                .is_some_and(|(current, _)| *current >= generation)
        {
            return;
        }
        watch.windows.insert(label, (generation, paths));
        watch.sync();
    })
    .await
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watcher_and_transfer_changes_share_paths_and_preserve_rescans() {
        let mut batch = PendingChanges::default();
        for i in 0..10_000 {
            let source = format!("/source/{i}");
            let target = format!("/destination/{i}");
            batch.add(Some(vec![
                source.clone(),
                "/destination".into(),
                target.clone(),
            ]));
            batch.add(Some(vec![source, target]));
        }
        assert_eq!(batch.paths.len(), 20_001);
        assert!(!batch.rescan);
        batch.add(None);
        batch.add(Some(vec!["/later".into()]));
        assert!(batch.rescan);
        assert!(batch.paths.is_empty());
        let _ = std::mem::take(&mut batch);
        batch.add(Some(vec!["/next".into()]));
        assert_eq!(batch.paths.len(), 1);
        assert!(!batch.rescan);
    }
}
