use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, Window};

use crate::{strpath, Shared};

#[derive(Default)]
pub(crate) struct DirectoryWatch {
    watcher: Option<RecommendedWatcher>,
    windows: HashMap<String, (u64, HashSet<PathBuf>)>,
    registered: HashSet<PathBuf>,
}

impl DirectoryWatch {
    pub(crate) fn start(&mut self, app: AppHandle) {
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
                        let _ = app.emit("directory-changed", paths);
                    }
                }
                _ => {
                    let _ = app.emit("directory-changed", ());
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
