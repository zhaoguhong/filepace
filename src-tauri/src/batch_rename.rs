use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, Window};

use crate::{
    cancelled, enqueue_task,
    fs_safety::{entry_path, missing, rename_exclusive, Directory, Identity},
    strpath,
    transfer::Source,
    undo::{self, Change},
    update, valid_name, FileChange, Shared, Task,
};

#[derive(Deserialize)]
pub(crate) struct Edit {
    path: String,
    name: String,
}

pub(crate) struct Renamed {
    from: PathBuf,
    to: PathBuf,
    identity: Identity,
}

struct Plan {
    parent: Directory,
    items: Vec<(Source, PathBuf)>,
    duplicate_guard: Option<crate::duplicates::Guard>,
}

#[derive(Default)]
pub(crate) struct Plans(Mutex<HashMap<String, (String, Instant, Plan)>>);

fn validate(parent: Directory, items: Vec<(Source, PathBuf)>) -> Result<Plan, String> {
    parent.check()?;
    let mut source_paths = HashSet::new();
    let mut names = HashSet::new();
    let sources: HashSet<_> = items
        .iter()
        .map(|(source, _)| source.path.as_path())
        .collect();
    for (source, target) in &items {
        if source.path.parent() != Some(&parent.path) || target.parent() != Some(&parent.path) {
            return Err("批量改名需要同一文件夹内的项目".into());
        }
        source.check()?;
        let name = target
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("目标名称无效")?;
        valid_name(name)?;
        if !source_paths.insert(&source.path) || !names.insert(name.to_lowercase()) {
            return Err(format!("改名结果中存在重复项目：{name}"));
        }
        if !missing(target).map_err(|error| error.to_string())? {
            let selected = sources.contains(target.as_path())
                || items.iter().any(|(item, _)| {
                    item.path.file_name().is_some_and(|original| {
                        original.to_string_lossy().eq_ignore_ascii_case(name)
                    }) && Identity::at(target).as_ref().ok() == Some(item.identity())
                });
            if !selected {
                return Err(format!("目标名称已存在：{name}"));
            }
        }
    }
    Ok(Plan {
        parent,
        items,
        duplicate_guard: None,
    })
}

fn prepare(edits: Vec<Edit>) -> Result<Plan, String> {
    if edits.len() < 2 || edits.len() > 10_000 {
        return Err("请选择 2 到 10,000 个项目".into());
    }
    let mut items = Vec::with_capacity(edits.len());
    for edit in edits {
        valid_name(&edit.name)?;
        let path = entry_path(Path::new(&edit.path))?;
        let target = path.with_file_name(edit.name);
        items.push((Source::at(path)?, target));
    }
    let parent = Directory::parent(&items[0].0.path).map_err(|error| error.to_string())?;
    let mut plan = validate(parent, items)?;
    plan.items.retain(|(source, target)| &source.path != target);
    if plan.items.is_empty() {
        return Err("文件名没有变化".into());
    }
    Ok(plan)
}

#[tauri::command]
pub(crate) async fn preview_batch_rename(
    window: Window,
    edits: Vec<Edit>,
    duplicate_guard: Option<crate::duplicates::GuardRequest>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sources = edits
            .iter()
            .map(|edit| edit.path.clone())
            .collect::<Vec<_>>();
        let mut plan = prepare(edits)?;
        plan.duplicate_guard = duplicate_guard
            .map(|request| {
                window.state::<crate::duplicates::DuplicateState>().guard(
                    window.label(),
                    &request,
                    &sources,
                )
            })
            .transpose()?;
        if let Some(guard) = &plan.duplicate_guard {
            for (_, target) in &plan.items {
                guard.check_destination(target)?;
            }
        }
        let state = window.state::<Plans>();
        let mut plans = state.0.lock().unwrap();
        plans.retain(|_, (_, time, _)| time.elapsed() < Duration::from_secs(300));
        if plans.len() >= 32 {
            if let Some(oldest) = plans
                .iter()
                .min_by_key(|(_, (_, time, _))| *time)
                .map(|(token, _)| token.clone())
            {
                plans.remove(&oldest);
            }
        }
        let token = uuid::Uuid::new_v4().to_string();
        plans.insert(
            token.clone(),
            (window.label().to_owned(), Instant::now(), plan),
        );
        Ok(token)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn batch_rename(
    window: Window,
    token: String,
    app: AppHandle,
) -> Result<String, String> {
    let state = window.state::<Plans>();
    let mut plans = state.0.lock().unwrap();
    let (_, time, plan) = plans
        .remove(&token)
        .filter(|(label, _, _)| label == window.label())
        .ok_or("改名预览已失效，请重新检查")?;
    if time.elapsed() >= Duration::from_secs(300) {
        return Err("改名预览已过期，请重新检查".into());
    }
    drop(plans);
    enqueue_task(
        app,
        Task {
            kind: "rename".into(),
            sources: plan
                .items
                .iter()
                .map(|(item, _)| strpath(&item.path))
                .collect(),
            destination: strpath(&plan.parent.path),
            ..Default::default()
        },
        move |state, id, app| {
            let result = execute(&plan, state, id);
            let _ = app.emit("directory-changed", [strpath(&plan.parent.path)]);
            let changes = result?;
            undo::record(state, "撤销批量改名", vec![Change::BatchRename(changes)]);
            Ok(())
        },
    )
}

fn execute(plan: &Plan, state: &Shared, id: &str) -> Result<Vec<Renamed>, String> {
    plan.parent.check()?;
    if let Some(guard) = &plan.duplicate_guard {
        guard.verify(|| cancelled(state, id))?;
    }
    let stage = tempfile::Builder::new()
        .prefix(".filepace-stage-")
        .tempdir_in(&plan.parent.path)
        .map_err(|error| error.to_string())?
        .keep();
    // Parked originals must survive an interrupted rollback.
    let temporary: Vec<_> = (0..plan.items.len())
        .map(|index| stage.join(index.to_string()))
        .collect();
    let mut parked = 0;
    let mut published = 0;
    let mut committed_identities = Vec::with_capacity(plan.items.len());
    let result = (|| {
        for ((source, _), path) in plan.items.iter().zip(&temporary) {
            if cancelled(state, id) {
                return Err("任务已取消".into());
            }
            source.check()?;
            if let Some(guard) = &plan.duplicate_guard {
                guard.check_source(&source.path)?;
            }
            rename_exclusive(&source.path, path).map_err(|error| error.to_string())?;
            parked += 1;
        }
        for ((source, target), path) in plan.items.iter().zip(&temporary) {
            if cancelled(state, id) {
                return Err("任务已取消".into());
            }
            plan.parent.check()?;
            if let Some(guard) = &plan.duplicate_guard {
                guard.check_keeper()?;
            }
            if !Identity::at(path)
                .is_ok_and(|current| source.identity().same_file_after_rename(&current))
            {
                return Err("暂存项目已变更".into());
            }
            rename_exclusive(path, target).map_err(|error| error.to_string())?;
            published += 1;
            let identity = Identity::at(target).map_err(|error| error.to_string())?;
            if !source.identity().same_file_after_rename(&identity) {
                return Err("已改名项目已变更".into());
            }
            committed_identities.push(identity);
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut recovered = true;
        for ((source, target), path) in plan.items.iter().zip(&temporary).take(published).rev() {
            if plan.parent.check().is_err()
                || !Identity::at(target)
                    .is_ok_and(|current| source.identity().same_file_after_rename(&current))
                || rename_exclusive(target, path).is_err()
            {
                recovered = false;
            }
        }
        for ((source, _), path) in plan.items.iter().zip(&temporary).take(parked).rev() {
            if plan.parent.check().is_err()
                || !Identity::at(path)
                    .is_ok_and(|current| source.identity().same_file_after_rename(&current))
                || rename_exclusive(path, &source.path).is_err()
            {
                recovered = false;
            }
        }
        return if recovered {
            let _ = fs::remove_dir(&stage);
            Err(error)
        } else {
            Err(format!(
                "批量改名未能完整恢复。请检查原位置和 {}：{error}",
                stage.display()
            ))
        };
    }
    let _ = fs::remove_dir(&stage);
    update(state, id, |task| {
        task.completed += published as u64;
        task.file_changes
            .extend(plan.items.iter().map(|(source, target)| FileChange {
                from: strpath(&source.path),
                to: Some(strpath(target)),
                kind: "rename".into(),
            }));
    });
    Ok(plan
        .items
        .iter()
        .zip(committed_identities)
        .map(|((source, target), identity)| Renamed {
            from: source.path.clone(),
            to: target.clone(),
            identity,
        })
        .collect())
}

pub(crate) fn reverse(changes: &[Renamed], state: &Shared, id: &str) -> Result<(), String> {
    let parent = Directory::parent(&changes[0].from).map_err(|error| error.to_string())?;
    let mut items = Vec::with_capacity(changes.len());
    for item in changes {
        let source = Source::at(item.to.clone())?;
        if source.identity() != &item.identity {
            return Err(format!("项目已变更：{}", item.to.display()));
        }
        items.push((source, item.from.clone()));
    }
    execute(&validate(parent, items)?, state, id).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exchanges_names_and_undoes_as_one_batch() {
        let folder = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(folder.path()).unwrap();
        let first = root.join("first.txt");
        let second = root.join("second.txt");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();
        #[cfg(windows)]
        for (index, path) in [&first, &second].into_iter().enumerate() {
            use std::{os::windows::io::AsRawHandle, ptr};
            use windows_sys::Win32::{Foundation::FILETIME, Storage::FileSystem::SetFileTime};
            // Distinct creation times make NTFS name tunneling observable even
            // when the fixtures were originally created in the same clock tick.
            let ticks = 132_537_600_000_000_000_u64 + index as u64 * 10_000_000;
            let time = FILETIME {
                dwLowDateTime: ticks as u32,
                dwHighDateTime: (ticks >> 32) as u32,
            };
            let file = fs::OpenOptions::new().write(true).open(path).unwrap();
            assert_ne!(
                unsafe { SetFileTime(file.as_raw_handle() as _, &time, ptr::null(), ptr::null()) },
                0
            );
        }
        let state = Shared::default();
        state
            .tasks
            .lock()
            .unwrap()
            .insert("task".into(), Task::default());
        let plan = prepare(vec![
            Edit {
                path: strpath(&first),
                name: "second.txt".into(),
            },
            Edit {
                path: strpath(&second),
                name: "first.txt".into(),
            },
        ])
        .unwrap();
        let changes = execute(&plan, &state, "task").unwrap();
        assert_eq!(fs::read(&first).unwrap(), b"second");
        assert_eq!(fs::read(&second).unwrap(), b"first");
        {
            let tasks = state.tasks.lock().unwrap();
            let mutations = &tasks["task"].file_changes;
            assert_eq!(mutations.len(), 2);
            assert_eq!(mutations[0].from, strpath(&first));
            assert_eq!(mutations[0].to, Some(strpath(&second)));
            assert_eq!(mutations[1].from, strpath(&second));
            assert_eq!(mutations[1].to, Some(strpath(&first)));
        }
        reverse(&changes, &state, "task").unwrap();
        assert_eq!(fs::read(&first).unwrap(), b"first");
        assert_eq!(fs::read(&second).unwrap(), b"second");
        let tasks = state.tasks.lock().unwrap();
        let mutations = &tasks["task"].file_changes;
        assert_eq!(mutations.len(), 4);
        assert_eq!(mutations[2].from, strpath(&second));
        assert_eq!(mutations[2].to, Some(strpath(&first)));
        assert_eq!(mutations[3].from, strpath(&first));
        assert_eq!(mutations[3].to, Some(strpath(&second)));
    }

    #[test]
    fn refuses_undo_when_a_committed_name_was_replaced() {
        let folder = tempfile::tempdir().unwrap();
        let source = folder.path().join("source.txt");
        let other = folder.path().join("other.txt");
        fs::write(&source, b"original").unwrap();
        fs::write(&other, b"other original").unwrap();
        let state = Shared::default();
        state
            .tasks
            .lock()
            .unwrap()
            .insert("task".into(), Task::default());
        let plan = prepare(vec![
            Edit {
                path: strpath(&source),
                name: "renamed.txt".into(),
            },
            Edit {
                path: strpath(&other),
                name: "other-renamed.txt".into(),
            },
        ])
        .unwrap();
        let changes = execute(&plan, &state, "task").unwrap();
        let target = folder.path().join("renamed.txt");
        let parked = folder.path().join("parked.txt");
        fs::rename(&target, &parked).unwrap();
        fs::write(&target, b"replacement").unwrap();
        assert!(reverse(&changes, &state, "task").is_err());
        assert_eq!(fs::read(target).unwrap(), b"replacement");
        assert_eq!(fs::read(parked).unwrap(), b"original");
        assert_eq!(
            fs::read(folder.path().join("other-renamed.txt")).unwrap(),
            b"other original"
        );
        assert!(!source.exists());
    }
}
