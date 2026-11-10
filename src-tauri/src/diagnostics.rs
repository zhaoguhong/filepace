use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const MAX_ERRORS: usize = 100;

#[derive(Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Failure {
    operation: String,
    pub(crate) step: String,
    path: String,
    pub(crate) message: String,
    os_code: Option<i32>,
}

impl Failure {
    pub(crate) fn new(operation: &str, step: &str, path: &Path, message: String) -> Self {
        Self {
            operation: operation.into(),
            step: step.into(),
            path: crate::strpath(path),
            message,
            os_code: None,
        }
    }

    pub(crate) fn io(operation: &str, step: &str, path: &Path, error: io::Error) -> Self {
        Self {
            os_code: error.raw_os_error(),
            ..Self::new(operation, step, path, error.to_string())
        }
    }
}

#[derive(Deserialize, Serialize)]
pub(crate) struct ErrorRecord {
    time: u64,
    #[serde(flatten)]
    failure: Failure,
}

#[derive(Default)]
pub(crate) struct ErrorLog(Mutex<()>);

fn log_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_log_dir()
        .map(|dir| dir.join("errors.json"))
        .map_err(|error| error.to_string())
}

fn read(path: &Path) -> Result<Vec<ErrorRecord>, String> {
    match fs::read(path) {
        Ok(data) => serde_json::from_slice(&data).map_err(|error| error.to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn append(path: &Path, failure: Failure, time: u64) -> Result<(), String> {
    let mut entries = read(path)?;
    // Directory watcher refreshes can report the same failure repeatedly.
    if entries
        .iter()
        .rev()
        .any(|entry| time.saturating_sub(entry.time) < 60 && entry.failure == failure)
    {
        return Ok(());
    }
    entries.push(ErrorRecord { time, failure });
    entries.drain(..entries.len().saturating_sub(MAX_ERRORS));
    crate::persist_json(path, &entries)
}

pub(crate) fn record(app: &tauri::AppHandle, failure: Failure) {
    let Ok(path) = log_file(app) else { return };
    let state = app.state::<ErrorLog>();
    let _guard = state.0.lock().unwrap();
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let _ = append(&path, failure, time);
}

#[tauri::command]
pub(crate) async fn error_log(app: tauri::AppHandle) -> Result<Vec<ErrorRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ErrorLog>();
        let _guard = state.0.lock().unwrap();
        let mut entries = read(&log_file(&app)?)?;
        entries.reverse();
        Ok(entries)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_recent_failures_and_preserves_the_system_error_code() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("errors.json");
        assert!(read(&path).unwrap().is_empty());
        let failure = || {
            Failure::io(
                "打开文件夹",
                "读取项目属性",
                Path::new("NUL"),
                io::Error::from_raw_os_error(1),
            )
        };
        append(&path, failure(), 1).unwrap();
        append(&path, failure(), 2).unwrap();
        let records = read(&path).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].failure.os_code, Some(1));
        for index in 0..MAX_ERRORS {
            let failure = Failure::new(
                "打开文件夹",
                "读取项目属性",
                Path::new("fixture"),
                format!("fixture failure {index}"),
            );
            append(&path, failure, 100 + index as u64).unwrap();
        }
        let records = read(&path).unwrap();
        assert_eq!(records.len(), MAX_ERRORS);
        assert_eq!(records[0].time, 100);
        assert_eq!(records.last().unwrap().time, 100 + MAX_ERRORS as u64 - 1);
    }
}
