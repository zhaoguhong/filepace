//! Durable intent records. Restarting only reports interrupted work; it never
//! guesses whether a rename committed or removes a surviving source/backup.
use crate::{strpath, Shared, Task};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Default)]
pub(crate) struct RecoveryLog(Mutex<Option<PathBuf>>);

#[derive(Serialize, Deserialize)]
struct Record {
    id: String,
    task: String,
    source: Option<PathBuf>,
    target: PathBuf,
    stage: Option<PathBuf>,
    backup: Option<PathBuf>,
    moving: bool,
    phase: String,
}

pub(crate) struct Guard {
    file: Option<PathBuf>,
    record: Record,
    retain: bool,
}

pub(crate) fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

impl RecoveryLog {
    pub(crate) fn initialize(&self, directory: PathBuf, shared: &Shared) -> Result<(), String> {
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let mut tasks = shared.tasks.lock().unwrap();
        for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let path = entry.map_err(|error| error.to_string())?.path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let id = format!(
                "recovery-{}",
                path.file_stem().unwrap_or_default().to_string_lossy()
            );
            let task = match fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Record>(&bytes).ok())
            {
                Some(record) => {
                    let mut errors = vec![
                        "上次文件操作中断，请核对以下位置。Filepace 未自动继续传输或删除任何项目。"
                            .into(),
                        format!("最后记录的阶段：{}（实际提交状态需核对）", record.phase),
                    ];
                    if let Some(source) = &record.source {
                        errors.push(format!("源位置：{}", source.display()));
                    }
                    errors.push(format!("目标位置：{}", record.target.display()));
                    if let Some(stage) = &record.stage {
                        errors.push(format!("暂存位置（可能已不存在）：{}", stage.display()));
                    }
                    if let Some(backup) = &record.backup {
                        errors.push(format!(
                            "旧目标备份（如仍存在，请先保留）：{}",
                            backup.display()
                        ));
                    }
                    Task {
                        kind: if record.moving { "move" } else { "copy" }.into(),
                        sources: record
                            .source
                            .as_ref()
                            .map(|path| strpath(path))
                            .into_iter()
                            .collect(),
                        destination: record.target.parent().map(strpath).unwrap_or_default(),
                        current: strpath(&record.target),
                        phase: "中断后待核对".into(),
                        errors,
                        ..Default::default()
                    }
                }
                None => Task {
                    phase: "恢复记录需要检查".into(),
                    errors: vec![format!("恢复记录无法读取，已保留记录：{}", path.display())],
                    ..Default::default()
                },
            };
            let sequence = shared
                .task_sequence
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            tasks.insert(
                id.clone(),
                Task {
                    id,
                    sequence,
                    status: "error".into(),
                    ..task
                },
            );
        }
        *self.0.lock().unwrap() = Some(directory);
        Ok(())
    }

    pub(crate) fn begin(
        &self,
        task: &str,
        source: Option<&Path>,
        target: &Path,
        stage: Option<&Path>,
        moving: bool,
    ) -> Result<Guard, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let file = self
            .0
            .lock()
            .unwrap()
            .as_ref()
            .map(|directory| directory.join(format!("{id}.json")));
        let guard = Guard {
            file,
            record: Record {
                id,
                task: task.into(),
                source: source.map(Path::to_owned),
                target: target.into(),
                stage: stage.map(Path::to_owned),
                backup: None,
                moving,
                phase: "准备传输".into(),
            },
            retain: false,
        };
        guard.persist()?;
        Ok(guard)
    }

    // Clearing a notice acknowledges only its journal; user files are untouched.
    pub(crate) fn acknowledge(&self, id: &str) {
        let Some(id) = id
            .strip_prefix("recovery-")
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        else {
            return;
        };
        if let Some(directory) = self.0.lock().unwrap().as_ref() {
            let _ = fs::remove_file(directory.join(format!("{id}.json")));
            let _ = sync_directory(directory);
        }
    }
}

impl Guard {
    fn persist(&self) -> Result<(), String> {
        let Some(path) = &self.file else {
            return Ok(());
        };
        let parent = path.parent().ok_or("恢复记录路径无效")?;
        let mut file =
            tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut file, &self.record).map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
        file.as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        file.persist(path).map_err(|error| error.to_string())?;
        sync_directory(parent)
    }
    pub(crate) fn phase(&mut self, phase: &str) -> Result<(), String> {
        self.record.phase = phase.into();
        self.persist()
    }
    pub(crate) fn backup(&mut self, path: &Path) -> Result<(), String> {
        self.record.backup = Some(path.into());
        self.phase("暂存旧目标，准备提交新目标")
    }
    pub(crate) fn retain(&mut self) {
        self.retain = true;
    }
    pub(crate) fn finish(&mut self) -> Result<(), String> {
        if let Some(file) = &self.file {
            fs::remove_file(file).map_err(|error| error.to_string())?;
            sync_directory(file.parent().ok_or("恢复记录路径无效")?)?;
        }
        self.file = None;
        self.retain = false;
        Ok(())
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        if !self.retain {
            let _ = self.finish();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_reports_intent_without_touching_source_target_stage_or_backup() {
        let fixture = tempfile::tempdir().unwrap();
        let source = fixture.path().join("source");
        let target = fixture.path().join("target");
        let stage = fixture.path().join("stage");
        let backup = fixture.path().join("backup");
        for (path, bytes) in [
            (&source, b"source".as_slice()),
            (&target, b"target"),
            (&stage, b"staged"),
            (&backup, b"old"),
        ] {
            fs::write(path, bytes).unwrap();
        }
        let directory = fixture.path().join("journal");
        let shared = Shared::default();
        shared
            .recovery
            .initialize(directory.clone(), &shared)
            .unwrap();
        let mut guard = shared
            .recovery
            .begin("task", Some(&source), &target, Some(&stage), true)
            .unwrap();
        guard.backup(&backup).unwrap();
        guard.retain();
        drop(guard);
        let restarted = Shared::default();
        restarted
            .recovery
            .initialize(directory.clone(), &restarted)
            .unwrap();
        let tasks = restarted.tasks.lock().unwrap();
        assert_eq!(tasks.len(), 1);
        let task = tasks.values().next().unwrap();
        assert_eq!(task.status, "error");
        assert!(task.errors.iter().any(|error| error.contains("旧目标备份")));
        assert_eq!(fs::read(&source).unwrap(), b"source");
        assert_eq!(fs::read(&target).unwrap(), b"target");
        assert_eq!(fs::read(&stage).unwrap(), b"staged");
        assert_eq!(fs::read(&backup).unwrap(), b"old");
        restarted.recovery.acknowledge(&task.id);
        assert_eq!(fs::read_dir(directory).unwrap().count(), 0);
        assert_eq!(fs::read(backup).unwrap(), b"old");
    }
    #[test]
    fn normal_completion_and_precommit_failure_do_not_leave_notices() {
        let fixture = tempfile::tempdir().unwrap();
        let directory = fixture.path().join("journal");
        let shared = Shared::default();
        shared
            .recovery
            .initialize(directory.clone(), &shared)
            .unwrap();
        let mut guard = shared
            .recovery
            .begin("task", None, &fixture.path().join("target"), None, false)
            .unwrap();
        guard.retain();
        guard.finish().unwrap();
        drop(
            shared
                .recovery
                .begin("failed", None, &fixture.path().join("target"), None, false)
                .unwrap(),
        );
        assert_eq!(fs::read_dir(directory).unwrap().count(), 0);
    }
}
