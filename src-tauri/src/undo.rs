use std::{
    collections::HashSet,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use crate::{
    cancelled,
    fs_safety::{check_ancestors, missing, rename_exclusive, Directory, Identity},
    strpath,
    transfer::{Source, Transfer},
    update, FileChange, Shared,
};

pub(crate) enum Change {
    BatchRename(Vec<crate::batch_rename::Renamed>),
    Moved {
        from: PathBuf,
        to: PathBuf,
        identity: Identity,
    },
    MadeDirectory {
        path: PathBuf,
        identity: Identity,
    },
    RemovedDirectory(PathBuf),
}

pub(crate) struct UndoRecord {
    pub(crate) label: &'static str,
    pub(crate) changes: Vec<Change>,
}

pub(crate) fn record(shared: &Shared, label: &'static str, changes: Vec<Change>) {
    if changes.is_empty() {
        return;
    }
    let mut history = shared.undo.lock().unwrap();
    if history.len() == 20 {
        history.remove(0);
    }
    history.push(UndoRecord { label, changes });
    drop(history);
    shared.task_feed.change(None);
}

fn verify_item(path: &Path, identity: &Identity) -> Result<(), String> {
    check_ancestors(path).map_err(|error| error.to_string())?;
    if Identity::at(path).as_ref().ok() != Some(identity) {
        return Err(format!("项目已移动或替换：{}", path.display()));
    }
    Ok(())
}

fn verify_original(path: &Path) -> Result<(), String> {
    check_ancestors(path).map_err(|error| error.to_string())?;
    if !missing(path).map_err(|error| error.to_string())? {
        return Err(format!("原位置已有同名项目：{}", path.display()));
    }
    Ok(())
}

pub(crate) fn reverse(record: &mut UndoRecord, shared: &Shared, id: &str) -> Result<(), String> {
    let restoring: HashSet<_> = record
        .changes
        .iter()
        .filter_map(|change| match change {
            Change::RemovedDirectory(path) => Some(path.as_path()),
            _ => None,
        })
        .collect();
    // Find collisions before moving any item, including within a merged folder.
    for change in &record.changes {
        if cancelled(shared, id) {
            return Err("任务已取消".into());
        }
        let from = match change {
            Change::BatchRename(_) => continue,
            Change::Moved { from, to, identity } => {
                verify_item(to, identity)?;
                from
            }
            Change::MadeDirectory { path, identity } => {
                verify_item(path, identity)?;
                continue;
            }
            Change::RemovedDirectory(from) => from,
        };
        verify_original(from)?;
        let parent = from.parent().ok_or("原位置无效")?;
        if !parent.is_dir() && !restoring.contains(parent) {
            return Err(format!("原文件夹已不存在：{}", parent.display()));
        }
    }

    while let Some(change) = record.changes.last() {
        if cancelled(shared, id) {
            return Err("任务已取消".into());
        }
        match change {
            Change::BatchRename(changes) => crate::batch_rename::reverse(changes, shared, id)?,
            Change::Moved { from, to, identity } => {
                update(shared, id, |task| task.current = strpath(to));
                verify_item(to, identity)?;
                verify_original(from)?;
                match rename_exclusive(to, from) {
                    Ok(()) => update(shared, id, |task| {
                        task.completed += 1;
                        task.file_changes.push(FileChange {
                            from: strpath(to),
                            to: Some(strpath(from)),
                            kind: "move".into(),
                        });
                    }),
                    Err(error) if error.kind() == ErrorKind::CrossesDevices => {
                        let source = Source::at(to.clone())?;
                        verify_item(to, identity)?;
                        let parent = Directory::parent(from).map_err(|error| error.to_string())?;
                        let mut operation = Transfer::new(shared, id, true);
                        let result = operation.stage(&source, from, &parent, None);
                        update(shared, id, |task| {
                            task.file_changes
                                .extend(crate::moved_file_changes(&operation.journal));
                        });
                        result?;
                    }
                    Err(error) => return Err(error.to_string()),
                }
            }
            Change::MadeDirectory { path, identity } => {
                verify_item(path, identity)?;
                match fs::remove_dir(path) {
                    Ok(()) => update(shared, id, |task| {
                        task.file_changes.push(FileChange {
                            from: strpath(path),
                            to: None,
                            kind: "move".into(),
                        })
                    }),
                    // Retain any files added after the original move.
                    Err(error) if error.kind() == ErrorKind::DirectoryNotEmpty => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
            Change::RemovedDirectory(from) => {
                verify_original(from)?;
                fs::create_dir(from).map_err(|error| error.to_string())?;
                update(shared, id, |task| {
                    task.file_changes.push(FileChange {
                        from: strpath(from),
                        to: Some(strpath(from)),
                        kind: "move".into(),
                    })
                });
            }
        }
        record.changes.pop();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{copy_entry, Task};

    #[test]
    fn merged_move_undo_leaves_unrelated_files_and_can_retry_a_collision() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(source.join("moved.txt"), b"moved").unwrap();
        fs::write(source.join("same.txt"), b"skipped source").unwrap();
        fs::write(target.join("same.txt"), b"existing target").unwrap();
        let shared = Shared::default();
        shared.tasks.lock().unwrap().insert(
            "task".into(),
            Task {
                policy: Some("skip".into()),
                ..Default::default()
            },
        );
        let mut record = UndoRecord {
            label: "撤销移动",
            changes: Vec::new(),
        };
        assert!(!copy_entry(&source, &target, &shared, "task", true, &mut record.changes).unwrap());
        fs::write(source.join("moved.txt"), b"new at original path").unwrap();
        assert!(reverse(&mut record, &shared, "task").is_err());
        assert_eq!(fs::read(target.join("moved.txt")).unwrap(), b"moved");
        assert_eq!(
            fs::read(source.join("moved.txt")).unwrap(),
            b"new at original path"
        );
        fs::remove_file(source.join("moved.txt")).unwrap();
        reverse(&mut record, &shared, "task").unwrap();
        assert!(record.changes.is_empty());
        assert_eq!(fs::read(source.join("moved.txt")).unwrap(), b"moved");
        assert_eq!(
            fs::read(source.join("same.txt")).unwrap(),
            b"skipped source"
        );
        assert_eq!(
            fs::read(target.join("same.txt")).unwrap(),
            b"existing target"
        );
        assert!(!target.join("moved.txt").exists());
        let tasks = shared.tasks.lock().unwrap();
        let changes = &tasks["task"].file_changes;
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].from, strpath(&target.join("moved.txt")));
        assert_eq!(changes[0].to, Some(strpath(&source.join("moved.txt"))));
    }

    #[test]
    fn restores_a_directory_tree_and_checks_renamed_file_identity() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(source.join("empty")).unwrap();
        fs::write(source.join("item.txt"), b"contents").unwrap();
        let shared = Shared::default();
        shared
            .tasks
            .lock()
            .unwrap()
            .insert("task".into(), Task::default());
        let mut record = UndoRecord {
            label: "撤销移动",
            changes: Vec::new(),
        };
        assert!(copy_entry(&source, &target, &shared, "task", true, &mut record.changes).unwrap());
        assert!(!source.exists());
        reverse(&mut record, &shared, "task").unwrap();
        assert!(source.join("empty").is_dir());
        assert_eq!(fs::read(source.join("item.txt")).unwrap(), b"contents");
        assert!(!target.exists());

        let from = source.join("item.txt");
        let to = source.join("renamed.txt");
        rename_exclusive(&from, &to).unwrap();
        record.changes.push(Change::Moved {
            from: from.clone(),
            to: to.clone(),
            identity: Identity::at(&to).unwrap(),
        });
        rename_exclusive(&to, &source.join("elsewhere.txt")).unwrap();
        fs::write(&to, b"unrelated").unwrap();
        assert!(reverse(&mut record, &shared, "task").is_err());
        assert!(!from.exists());
        assert_eq!(fs::read(&to).unwrap(), b"unrelated");
    }
}
