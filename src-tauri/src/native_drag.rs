use std::{collections::HashSet, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, DragDropEvent, Emitter, EventTarget, LogicalPosition, Manager, Window, WindowEvent,
};
use uuid::Uuid;

const EVENT: &str = "filepace-file-drag";

#[derive(Default)]
pub struct DragState(Mutex<Option<DragSession>>);

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PaneSide {
    Left,
    Right,
}

struct DragSession {
    id: Uuid,
    source_window: String,
    source_pane: Option<PaneSide>,
    paths: Vec<PathBuf>,
    copy_at_end: Option<bool>,
}

impl DragSession {
    fn matches(&self, paths: &[PathBuf]) -> bool {
        if self.paths == paths {
            return true;
        }
        let received: HashSet<_> = paths.iter().collect();
        received.len() == self.paths.len()
            && self.paths.iter().all(|path| {
                received.contains(path)
                    || dunce::canonicalize(path).is_ok_and(|path| received.contains(&path))
            })
    }
}

impl DragState {
    fn clear(&self, id: Uuid) -> bool {
        let mut active = self.0.lock().unwrap();
        if active.as_ref().is_some_and(|drag| drag.id == id) {
            *active = None;
            return true;
        }
        false
    }
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum FileDragEvent {
    Hover {
        position: LogicalPosition<f64>,
        kind: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        source_pane: Option<PaneSide>,
    },
    Drop {
        position: LogicalPosition<f64>,
        kind: &'static str,
        paths: Vec<PathBuf>,
        between_windows: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        source_pane: Option<PaneSide>,
    },
    Leave,
}

#[cfg(target_os = "macos")]
fn copy_key_down() -> bool {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags};
    NSEvent::modifierFlags_class().contains(NSEventModifierFlags::Option)
}

#[cfg(windows)]
fn copy_key_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
    // The sign bit reports whether Ctrl is down at the time of the call.
    unsafe { GetAsyncKeyState(i32::from(VK_CONTROL)) < 0 }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn copy_key_down() -> bool {
    false
}

fn operation(drag: &DragSession) -> &'static str {
    if drag.copy_at_end.unwrap_or_else(copy_key_down) {
        "copy"
    } else {
        "move"
    }
}

fn received_drop(
    position: LogicalPosition<f64>,
    paths: &[PathBuf],
    destination_window: &str,
    active: Option<&DragSession>,
) -> FileDragEvent {
    let origin = active.filter(|drag| drag.matches(paths));
    let between_windows = origin.is_some_and(|drag| drag.source_window != destination_window);
    let source_pane = origin
        .filter(|_| !between_windows)
        .and_then(|drag| drag.source_pane);
    FileDragEvent::Drop {
        position,
        kind: origin
            .filter(|_| between_windows || source_pane.is_some())
            .map_or("copy", operation),
        paths: origin.map_or_else(|| paths.to_vec(), |drag| drag.paths.clone()),
        between_windows,
        source_pane,
    }
}

fn finish_drag(app: &AppHandle, id: Uuid) {
    let state = app.state::<DragState>();
    let mut active = state.0.lock().unwrap();
    if let Some(drag) = active.as_mut().filter(|drag| drag.id == id) {
        drag.copy_at_end = Some(copy_key_down());
    }
    drop(active);

    // Wry queues its native drop event. Post cleanup behind it so the destination
    // can still read the origin and the modifier sampled when the drag finished.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let cleanup = app.clone();
        let _ = app.run_on_main_thread(move || {
            if cleanup.state::<DragState>().clear(id) {
                let _ = cleanup.emit(EVENT, FileDragEvent::Leave);
            }
        });
    });
}

#[tauri::command]
pub async fn start_file_drag(
    window: Window,
    paths: Vec<PathBuf>,
    source_pane: Option<PaneSide>,
) -> Result<(), String> {
    if paths.is_empty() || paths.iter().any(|path| !path.is_absolute()) {
        return Err("请选择有效的文件或文件夹".into());
    }

    let app = window.app_handle().clone();
    let (send, mut receive) = tauri::async_runtime::channel(1);
    window
        .clone()
        .run_on_main_thread(move || {
            // The WebKit gesture can end before its IPC reaches AppKit.
            #[cfg(target_os = "macos")]
            if objc2_app_kit::NSEvent::pressedMouseButtons() & 1 == 0 {
                let _ = send.try_send(Ok(()));
                return;
            }

            let state = app.state::<DragState>();
            let mut active = state.0.lock().unwrap();
            if active.is_some() {
                let _ = send.try_send(Err("已有拖放操作正在进行".into()));
                return;
            }

            let id = Uuid::new_v4();
            *active = Some(DragSession {
                id,
                source_window: window.label().into(),
                source_pane,
                paths: paths.clone(),
                copy_at_end: None,
            });
            drop(active);

            #[cfg(target_os = "linux")]
            let handle = window.gtk_window();
            #[cfg(not(target_os = "linux"))]
            let handle = Ok(window);
            let source = app.clone();
            let result = handle
                .map_err(|e: tauri::Error| e.to_string())
                .and_then(|handle| {
                    drag::start_drag(
                        &handle,
                        drag::DragItem::Files(paths),
                        drag::Image::Raw(include_bytes!("../icons/32x32.png").to_vec()),
                        move |_, _| finish_drag(&source, id),
                        // External apps receive a native copy drag. Filepace runs its
                        // own move task after a drop into a different Filepace window.
                        drag::Options::default(),
                    )
                    .map_err(|error| error.to_string())
                });
            if result.is_err() {
                state.clear(id);
            }
            let _ = send.try_send(result);
        })
        .map_err(|e| e.to_string())?;
    receive.recv().await.ok_or("无法启动拖放操作")?
}

pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::DragDrop(event) = event else {
        return;
    };

    let state = window.state::<DragState>();
    let active = state.0.lock().unwrap();
    // WKWebView reports view points. WebView2 reports physical client pixels.
    let scale = if cfg!(target_os = "macos") {
        1.0
    } else {
        window.scale_factor().unwrap_or(1.0)
    };
    let message = match event {
        DragDropEvent::Enter { position, .. } | DragDropEvent::Over { position } => {
            let Some(drag) = active.as_ref() else { return };
            let same_window = drag.source_window == window.label();
            if same_window && drag.source_pane.is_none() {
                return;
            }
            FileDragEvent::Hover {
                position: position.to_logical(scale),
                kind: operation(drag),
                source_pane: if same_window { drag.source_pane } else { None },
            }
        }
        DragDropEvent::Drop { paths, position } if !paths.is_empty() => received_drop(
            position.to_logical(scale),
            paths,
            window.label(),
            active.as_ref(),
        ),
        DragDropEvent::Drop { .. } | DragDropEvent::Leave => FileDragEvent::Leave,
        _ => return,
    };
    drop(active);
    let _ = window.emit_to(EventTarget::labeled(window.label()), EVENT, message);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_only_a_matching_drag_from_another_window_without_the_copy_key() {
        let paths = vec![PathBuf::from("file.txt"), PathBuf::from("folder")];
        let reversed_paths = vec![paths[1].clone(), paths[0].clone()];
        let external_paths = vec![PathBuf::from("other.txt"), paths[0].clone()];
        let mut drag = DragSession {
            id: Uuid::new_v4(),
            source_window: "source".into(),
            source_pane: None,
            paths: paths.clone(),
            copy_at_end: Some(false),
        };
        let point = LogicalPosition::new(0.0, 0.0);

        assert!(matches!(
            received_drop(point, &reversed_paths, "destination", Some(&drag)),
            FileDragEvent::Drop {
                kind: "move",
                between_windows: true,
                ..
            }
        ));
        assert!(matches!(
            received_drop(point, &paths, "source", Some(&drag)),
            FileDragEvent::Drop {
                kind: "copy",
                between_windows: false,
                ..
            }
        ));
        assert!(matches!(
            received_drop(point, &external_paths, "destination", Some(&drag)),
            FileDragEvent::Drop { kind: "copy", between_windows: false, paths, .. }
                if paths == external_paths
        ));
        drag.copy_at_end = Some(true);
        assert!(matches!(
            received_drop(point, &paths, "destination", Some(&drag)),
            FileDragEvent::Drop {
                kind: "copy",
                between_windows: true,
                ..
            }
        ));
        drag.source_pane = Some(PaneSide::Left);
        drag.copy_at_end = Some(false);
        assert!(matches!(
            received_drop(point, &paths, "source", Some(&drag)),
            FileDragEvent::Drop {
                kind: "move",
                between_windows: false,
                source_pane: Some(PaneSide::Left),
                ..
            }
        ));
    }
}
