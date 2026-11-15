//! System trash enumeration and explicitly confirmed, snapshot-bound tasks.
use crate::{
    enqueue_task,
    fs_safety::{Directory, Identity},
    strpath,
    transfer::{Source, Transfer},
    update, Shared, Task,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrashItem {
    id: String,
    name: String,
    original_path: Option<String>,
    deleted_at: Option<i64>,
    size: Option<u64>,
    is_dir: bool,
}
#[derive(Clone)]
struct NativeItem {
    item: TrashItem,
    path: PathBuf,
    identity: Option<Identity>,
}
#[derive(Default)]
pub(crate) struct TrashState {
    items: Mutex<HashMap<String, NativeItem>>,
}
#[derive(Serialize)]
pub(crate) struct TrashReport {
    items: Vec<TrashItem>,
    warnings: Vec<String>,
}

fn token(path: &str, fingerprint: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{path}\0{fingerprint}").as_bytes())
    )
}

#[tauri::command]
pub(crate) async fn list_trash(app: tauri::AppHandle) -> Result<TrashReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (items, warnings) = platform::list()?;
        let mut result = items
            .iter()
            .map(|item| item.item.clone())
            .collect::<Vec<_>>();
        result.sort_by(|a, b| {
            b.deleted_at
                .cmp(&a.deleted_at)
                .then_with(|| a.name.cmp(&b.name))
        });
        let state = app.state::<TrashState>();
        let mut cache = state.items.lock().unwrap();
        // Tokens are shared by all windows. A refresh must not invalidate
        // another window's confirmation; the task re-enumerates before use.
        if cache.len() > 50_000 {
            cache.clear();
        }
        cache.extend(items.into_iter().map(|item| (item.item.id.clone(), item)));
        Ok(TrashReport {
            items: result,
            warnings,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn start_trash_task(
    action: String,
    ids: Vec<String>,
    destination: Option<String>,
    confirmed: bool,
    app: tauri::AppHandle,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !matches!(action.as_str(), "restore" | "purge") || ids.is_empty() {
            return Err("请选择回收站项目".into());
        }
        if action == "purge" && !confirmed {
            return Err("永久删除需要明确确认".into());
        }
        let mut seen = HashSet::new();
        let cached = app.state::<TrashState>();
        let cached = cached.items.lock().unwrap();
        let items = ids
            .iter()
            .filter(|id| seen.insert((*id).clone()))
            .map(|id| {
                cached
                    .get(id)
                    .cloned()
                    .ok_or_else(|| "回收站项目已变化，请刷新后重新选择".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        drop(cached);
        #[cfg(target_os = "macos")]
        if items.iter().any(|item| item.identity.is_none()) {
            return Err("macOS 尚未允许访问回收站。请在系统设置 → 隐私与安全性 → 完全磁盘访问权限中允许 Filepace，重新打开应用后重试。".into());
        }
        let folder = destination.as_deref().map(crate::canonical).transpose()?;
        if let Some(folder) = &folder {
            Directory::at(folder).map_err(|error| error.to_string())?;
        }
        // Validate every destination before scheduling, including absent original
        // parents. Never recreate deleted directory trees without a user choice.
        let targets = if action == "restore" {
            items
                .iter()
                .map(|item| restore_target(item, folder.as_deref()))
                .collect::<Result<Vec<_>, _>>()?
        } else {
            vec![]
        };
        let display = items.iter().map(|item| item.item.name.clone()).collect();
        enqueue_task(
            app,
            Task {
                kind: action.clone(),
                sources: display,
                destination: destination.unwrap_or_default(),
                ..Default::default()
            },
            move |shared, id, execution| {
                for (index, item) in items.iter().enumerate() {
                    execution.checkpoint(id)?;
                    update(shared, id, |task| {
                        task.current = item.item.name.clone();
                        task.phase = if action == "restore" {
                            "恢复回收站项目"
                        } else {
                            "永久删除回收站项目"
                        }
                        .into();
                    });
                    // Only items shown in the confirmed snapshot are eligible.
                    let result = platform::check(item).and_then(|()| {
                        if action == "purge" {
                        platform::purge(item, shared, id)
                        } else {
                            restore(shared, id, item, &targets[index])
                        }
                    });
                    match result {
                        Ok(()) => update(shared, id, |task| {
                            if action == "purge" {
                                task.completed += 1;
                            }
                        }),
                        Err(error) => update(shared, id, |task| {
                            task.errors.push(format!("{}：{error}", item.item.name))
                        }),
                    }
                }
                Ok(())
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

fn restore_target(item: &NativeItem, chosen: Option<&Path>) -> Result<PathBuf, String> {
    crate::valid_name(&item.item.name)?;
    let target = if let Some(folder) = chosen {
        folder.join(&item.item.name)
    } else {
        PathBuf::from(
            item.item
                .original_path
                .as_ref()
                .ok_or("原位置记录不可用，请选择恢复目标文件夹")?,
        )
    };
    let parent = target.parent().ok_or("恢复目标无效")?;
    let parent = crate::canonical(&strpath(parent))
        .map_err(|_| "原文件夹已不存在或无法访问，请选择其他恢复目标文件夹".to_string())?;
    let folder = Directory::at(&parent).map_err(|error| error.to_string())?;
    let target = folder.path.join(target.file_name().ok_or("恢复目标无效")?);
    crate::fs_safety::ensure_mutation_path(&target)?;
    if platform::inside_trash(&target) {
        return Err("恢复目标不能位于回收站中".into());
    }
    Ok(target)
}

fn restore(shared: &Shared, id: &str, item: &NativeItem, target: &Path) -> Result<(), String> {
    let parent =
        Directory::at(target.parent().ok_or("恢复目标无效")?).map_err(|error| error.to_string())?;
    #[cfg(not(windows))]
    if let Ok(source) = Source::at(item.path.clone()) {
        if item
            .identity
            .as_ref()
            .is_some_and(|identity| identity != source.identity())
        {
            return Err("回收站项目已被替换，请刷新".into());
        }
        let mut transfer = Transfer::new(shared, id, true);
        let result = transfer.run(&source, target, &parent);
        update(shared, id, |task| {
            task.file_changes
                .extend(crate::moved_file_changes(&transfer.journal))
        });
        let moved = result?;
        if moved {
            platform::after_transfer(item);
        }
        return Ok(());
    }
    platform::restore_via_system(shared, id, item, target, &parent)
}

#[tauri::command]
pub(crate) fn validate_location(path: String) -> Result<String, String> {
    let path = crate::canonical(&path)?;
    Directory::at(&path).map_err(|error| error.to_string())?;
    if platform::inside_trash(&path) {
        return Err("请选择回收站之外的文件夹".into());
    }
    Ok(strpath(&path))
}
#[tauri::command]
pub(crate) async fn choose_location() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(platform::choose_location)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn open_trash_permissions() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
            .status()
            .map_err(|error| error.to_string())?
            .success()
            .then_some(())
            .ok_or_else(|| "无法打开系统隐私设置".into())
    }
    #[cfg(not(target_os = "macos"))]
    Err("请在系统设置中检查文件访问权限".into())
}

#[cfg(target_os = "macos")]
fn purge_path(path: &Path, identity: &Identity, shared: &Shared, id: &str) -> Result<(), String> {
    crate::fs_safety::ensure_mutation_path(path)?;
    let parent =
        Directory::at(path.parent().ok_or("回收站位置无效")?).map_err(|error| error.to_string())?;
    if Identity::at(path).as_ref().ok() != Some(identity) {
        return Err("回收站项目已被替换，请刷新".into());
    }
    let stage = tempfile::Builder::new()
        .prefix(".filepace-trash-purge-")
        .tempdir_in(&parent.path)
        .map_err(|error| error.to_string())?
        .keep();
    let staged = stage.join(path.file_name().ok_or("回收站项目名称无效")?);
    let mut recovery = shared
        .recovery
        .begin(id, Some(path), &staged, Some(&staged), true)?;
    recovery.phase("准备永久删除已确认的回收站项目")?;
    parent.check()?;
    crate::fs_safety::rename_exclusive(path, &staged).map_err(|error| error.to_string())?;
    recovery.retain();
    let result = (|| {
        if !identity
            .same_file_after_rename(&Identity::at(&staged).map_err(|error| error.to_string())?)
        {
            let _ = crate::fs_safety::rename_exclusive(&staged, path);
            return Err("回收站项目在删除前被替换，已停止永久删除".into());
        }
        let metadata = staged
            .symlink_metadata()
            .map_err(|error| error.to_string())?;
        recovery.phase("永久删除已隔离并核对身份的项目")?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            fs::remove_dir_all(&staged)
        } else {
            fs::remove_file(&staged)
        }
        .map_err(|error| error.to_string())?;
        fs::remove_dir(&stage).map_err(|error| error.to_string())?;
        recovery.finish()
    })();
    result.map_err(|error| format!("{error}；请核对保留位置：{}", stage.display()))
}

pub(crate) fn trash_item(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return platform::trash_item(path);
    #[cfg(not(target_os = "macos"))]
    trash::delete(path).map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
#[path = "trash_macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "trash_windows.rs"]
mod platform;
#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::*;
    pub(super) fn list() -> Result<(Vec<NativeItem>, Vec<String>), String> {
        Err("当前系统暂不支持回收站浏览".into())
    }
    pub(super) fn check(_: &NativeItem) -> Result<(), String> {
        Err("当前系统暂不支持此操作".into())
    }
    pub(super) fn purge(_: &NativeItem, _: &Shared, _: &str) -> Result<(), String> {
        Err("当前系统暂不支持此操作".into())
    }
    pub(super) fn inside_trash(_: &Path) -> bool {
        false
    }
    pub(super) fn after_transfer(_: &NativeItem) {}
    pub(super) fn restore_via_system(
        _: &Shared,
        _: &str,
        _: &NativeItem,
        _: &Path,
        _: &Directory,
    ) -> Result<(), String> {
        Err("当前系统暂不支持此操作".into())
    }
    pub(super) fn choose_location() -> Result<Option<String>, String> {
        Err("当前系统暂不支持文件夹选择".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item(path: &Path, original: &Path) -> NativeItem {
        NativeItem {
            item: TrashItem {
                id: "fixture".into(),
                name: "sample.txt".into(),
                original_path: Some(strpath(original)),
                deleted_at: None,
                size: Some(14),
                is_dir: false,
            },
            path: path.to_owned(),
            identity: Some(Identity::at(path).unwrap()),
        }
    }
    #[test]
    fn restore_refuses_missing_original_parent_and_allows_an_explicit_folder() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("trashed");
        fs::write(&source, b"retained bytes").unwrap();
        let item = item(&source, &root.path().join("missing/sample.txt"));
        assert!(restore_target(&item, None).is_err());
        let target = restore_target(&item, Some(root.path())).unwrap();
        assert_eq!(
            target,
            root.path().canonicalize().unwrap().join("sample.txt")
        );
        assert_eq!(fs::read(source).unwrap(), b"retained bytes");
    }
    #[cfg(not(windows))]
    #[test]
    fn restoration_keeps_both_contents_on_conflict_and_rejects_replaced_sources() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("trashed");
        let target = root.path().join("sample.txt");
        fs::write(&source, b"restored contents").unwrap();
        fs::write(&target, b"existing contents").unwrap();
        let original = item(&source, &target);
        let shared = Shared::default();
        shared.tasks.lock().unwrap().insert(
            "restore".into(),
            Task {
                policy: Some("keep".into()),
                ..Default::default()
            },
        );
        restore(&shared, "restore", &original, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"existing contents");
        assert_eq!(
            fs::read(root.path().join("sample (2).txt")).unwrap(),
            b"restored contents"
        );
        assert!(!source.exists());
        fs::write(&source, b"different contents").unwrap();
        assert!(restore(&shared, "restore", &original, &target).is_err());
        assert_eq!(fs::read(source).unwrap(), b"different contents");
    }

    #[cfg(not(windows))]
    #[test]
    fn cancelled_folder_restore_publishes_completed_moves_and_preserves_remaining_bytes() {
        use std::{
            sync::Arc,
            thread,
            time::{Duration, Instant},
        };
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("trashed");
        let target = root.path().join("restored");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        for name in ["one.txt", "two.txt", "three.txt"] {
            fs::write(source.join(name), name.as_bytes()).unwrap();
        }
        // Use the actual directory order so cancellation is deterministic on
        // filesystems that enumerate names differently.
        let names: Vec<_> = fs::read_dir(&source)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        fs::write(target.join(&names[1]), b"existing destination").unwrap();
        let original = item(&source, &target);
        let shared = Arc::new(Shared::default());
        shared
            .tasks
            .lock()
            .unwrap()
            .insert("restore".into(), Task::default());
        let worker_shared = shared.clone();
        let worker_target = target.clone();
        let worker =
            thread::spawn(move || restore(&worker_shared, "restore", &original, &worker_target));
        let deadline = Instant::now() + Duration::from_secs(5);
        let reached_conflict = loop {
            if shared.tasks.lock().unwrap()["restore"].status == "conflict" {
                break true;
            }
            if Instant::now() >= deadline || worker.is_finished() {
                break false;
            }
            thread::sleep(Duration::from_millis(5));
        };
        update(&shared, "restore", |task| task.cancelled = true);
        shared.task_wake.notify_all();
        assert!(worker.join().unwrap().is_err());
        assert!(reached_conflict);
        assert!(!source.join(&names[0]).exists());
        assert_eq!(
            fs::read(target.join(&names[0])).unwrap(),
            names[0].to_string_lossy().as_bytes()
        );
        for name in &names[1..] {
            assert_eq!(
                fs::read(source.join(name)).unwrap(),
                name.to_string_lossy().as_bytes()
            );
        }
        assert_eq!(
            fs::read(target.join(&names[1])).unwrap(),
            b"existing destination"
        );
        assert!(!target.join(&names[2]).exists());
        let tasks = shared.tasks.lock().unwrap();
        assert_eq!(tasks["restore"].file_changes.len(), 1);
        assert_eq!(
            tasks["restore"].file_changes[0].from,
            strpath(&source.join(&names[0]))
        );
        assert_eq!(
            tasks["restore"].file_changes[0].to.as_deref(),
            Some(strpath(&target.join(&names[0])).as_str())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn permanent_delete_checks_identity_and_never_follows_a_symbolic_link() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("retained.txt");
        let link = root.path().join("trashed-link");
        fs::write(&target, b"keep these bytes").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let identity = Identity::at(&link).unwrap();
        let shared = Shared::default();
        purge_path(&link, &identity, &shared, "purge").unwrap();
        assert!(!link.symlink_metadata().is_ok());
        assert_eq!(fs::read(&target).unwrap(), b"keep these bytes");
        fs::write(&link, b"new unrelated file").unwrap();
        assert!(purge_path(&link, &identity, &shared, "purge").is_err());
        assert_eq!(fs::read(&link).unwrap(), b"new unrelated file");
        assert_eq!(fs::read(&target).unwrap(), b"keep these bytes");
        let current = Identity::at(&link).unwrap();
        let protection = crate::fs_safety::protect_mutation_path(&link);
        assert!(purge_path(&link, &current, &shared, "purge").is_err());
        assert_eq!(fs::read(&link).unwrap(), b"new unrelated file");
        drop(protection);
    }
}
