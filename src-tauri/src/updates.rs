use std::{
    sync::{atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{active, Shared};

const EVENT: &str = "filepace-update";
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Serialize)]
pub(crate) struct UpdateStatus {
    current: String,
    phase: &'static str,
    version: Option<String>,
    message: Option<String>,
}

struct Work {
    phase: &'static str,
    version: Option<String>,
    message: Option<String>,
    pending: Option<(Update, Vec<u8>)>,
    checked: Option<Instant>,
}

pub(crate) struct UpdateState(Mutex<Work>);

impl Default for UpdateState {
    fn default() -> Self {
        Self(Mutex::new(Work {
            phase: "idle",
            version: None,
            message: None,
            pending: None,
            checked: None,
        }))
    }
}

impl Work {
    fn status(&self, app: &AppHandle) -> UpdateStatus {
        UpdateStatus {
            current: app.package_info().version.to_string(),
            phase: self.phase,
            version: self.version.clone(),
            message: self.message.clone(),
        }
    }
}

fn announce(app: &AppHandle, status: UpdateStatus) {
    let _ = app.emit(EVENT, status);
}

#[tauri::command]
pub(crate) fn update_status(app: AppHandle, state: State<'_, UpdateState>) -> UpdateStatus {
    state.0.lock().unwrap().status(&app)
}

#[tauri::command]
pub(crate) async fn check_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
    automatic: bool,
) -> Result<(), String> {
    let status = {
        let mut work = state.0.lock().unwrap();
        if matches!(
            work.phase,
            "checking" | "downloading" | "ready" | "installing"
        ) || (automatic && work.checked.is_some_and(|time| time.elapsed() < INTERVAL))
        {
            return Ok(());
        }
        work.checked = Some(Instant::now());
        work.phase = "checking";
        work.version = None;
        work.message = None;
        work.status(&app)
    };
    announce(&app, status);

    let result = async {
        let updater = app
            .updater_builder()
            .timeout(Duration::from_secs(40))
            .build()?;
        let Some(update) = updater.check().await? else {
            return Ok(None);
        };
        let status = {
            let mut work = state.0.lock().unwrap();
            work.phase = "downloading";
            work.version = Some(update.version.clone());
            work.status(&app)
        };
        announce(&app, status);
        let bytes = update.download(|_, _| {}, || {}).await?;
        Ok::<_, tauri_plugin_updater::Error>(Some((update, bytes)))
    }
    .await;
    let status = {
        let mut work = state.0.lock().unwrap();
        match result {
            Ok(Some(pending)) => {
                work.pending = Some(pending);
                work.phase = "ready";
            }
            Ok(None) => work.phase = "current",
            Err(error) => {
                work.phase = "error";
                work.message = Some(format!("无法检查或下载更新：{error}"));
            }
        }
        work.status(&app)
    };
    announce(&app, status);
    Ok(())
}

#[tauri::command]
pub(crate) async fn install_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<(), String> {
    let shared = app.state::<Arc<Shared>>();
    let (pending, status) = {
        // Mutations and installation acquire this same lock before starting.
        let tasks = shared.tasks.lock().unwrap();
        if tasks.values().any(active) {
            return Err("请等文件任务结束后再安装更新".into());
        }
        let mut work = state.0.lock().unwrap();
        let pending = work.pending.take().ok_or("更新尚未下载完成")?;
        shared.installing_update.store(true, Ordering::Relaxed);
        work.phase = "installing";
        (pending, work.status(&app))
    };
    announce(&app, status);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = pending.0.install(&pending.1);
        (pending, result)
    })
    .await;
    if matches!(&result, Ok((_, Ok(())))) {
        app.restart();
    }
    let (message, status) = {
        let mut work = state.0.lock().unwrap();
        let message = match result {
            Ok((_, Ok(()))) => unreachable!(),
            Ok((pending, Err(error))) => {
                work.phase = "ready";
                work.pending = Some(pending);
                format!("无法安装更新：{error}")
            }
            Err(error) => {
                work.phase = "error";
                format!("更新任务异常结束：{error}")
            }
        };
        work.message = Some(message.clone());
        shared.installing_update.store(false, Ordering::Relaxed);
        (message, work.status(&app))
    };
    announce(&app, status);
    Err(message)
}
