use super::*;
use std::{ffi::OsString, process::Command};
use trash::os_limited;
fn item_token(item: &trash::TrashItem) -> String {
    token(
        &item.id.to_string_lossy(),
        &format!("{}:{}", item.original_path().display(), item.time_deleted),
    )
}
fn find(item: &NativeItem) -> Result<trash::TrashItem, String> {
    os_limited::list()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|current| item_token(current) == item.item.id)
        .ok_or_else(|| "回收站项目已变化，请刷新后重新选择".into())
}
pub(super) fn list() -> Result<(Vec<NativeItem>, Vec<String>), String> {
    let mut warnings = Vec::new();
    let items = os_limited::list()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter_map(|item| {
            let metadata = match os_limited::metadata(&item) {
                Ok(metadata) => metadata,
                Err(error) => {
                    warnings.push(format!(
                        "无法读取回收站项目「{}」：{error}；请刷新后重试。",
                        item.name.to_string_lossy()
                    ));
                    return None;
                }
            };
            let original = item.original_path();
            let id = item_token(&item);
            Some(NativeItem {
                item: TrashItem {
                    id,
                    name: item.name.to_string_lossy().into_owned(),
                    original_path: Some(strpath(&original)),
                    deleted_at: (item.time_deleted >= 0).then_some(item.time_deleted),
                    size: metadata.size.size(),
                    is_dir: metadata.size.entries().is_some(),
                },
                path: PathBuf::from(item.id),
                identity: None,
            })
        })
        .collect();
    Ok((items, warnings))
}
pub(super) fn inside_trash(path: &Path) -> bool {
    path.components().any(|part| {
        part.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case("$recycle.bin")
    })
}
pub(super) fn check(item: &NativeItem) -> Result<(), String> {
    find(item).map(|_| ())
}
pub(super) fn purge(item: &NativeItem, _: &Shared, _: &str) -> Result<(), String> {
    os_limited::purge_all([find(item)?]).map_err(|error| error.to_string())?;
    if os_limited::list()
        .map_err(|error| error.to_string())?
        .iter()
        .any(|current| item_token(current) == item.item.id)
    {
        return Err("系统未完成永久删除，请刷新后核对".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listed(path: &Path) -> NativeItem {
        let original = strpath(path);
        list()
            .unwrap()
            .0
            .into_iter()
            .find(|item| item.item.original_path.as_deref() == Some(original.as_str()))
            .expect("the fixture must be visible in the Windows Recycle Bin")
    }

    #[test]
    fn restores_unicode_names_and_keep_both_contents_through_the_windows_recycle_bin() {
        let root = tempfile::tempdir().unwrap();
        let root = crate::canonical(&strpath(root.path())).unwrap();
        let original = root.join("回收站样本.txt");
        let destination = root.join("restore");
        fs::create_dir(&destination).unwrap();
        fs::write(&original, b"original fixture bytes").unwrap();
        super::super::trash_item(&original).unwrap();
        assert!(!original.exists());
        let item = listed(&original);
        assert_eq!(item.item.name, "回收站样本.txt");
        assert_eq!(item.item.size, Some(22));
        let target = destination.join(&item.item.name);
        fs::write(&target, b"existing destination bytes").unwrap();
        let shared = Shared::default();
        shared.tasks.lock().unwrap().insert(
            "restore".into(),
            Task {
                policy: Some("keep".into()),
                ..Default::default()
            },
        );
        let target = super::super::restore_target(&item, Some(&destination)).unwrap();
        super::super::restore(&shared, "restore", &item, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"existing destination bytes");
        assert_eq!(
            fs::read(destination.join("回收站样本 (2).txt")).unwrap(),
            b"original fixture bytes"
        );
        assert!(!original.exists());
        assert!(find(&item).is_err());
        assert_eq!(shared.tasks.lock().unwrap()["restore"].completed, 1);
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 2);
    }

    #[test]
    fn purges_only_the_selected_snapshot_and_preserves_later_trash_contents() {
        let root = tempfile::tempdir().unwrap();
        let root = crate::canonical(&strpath(root.path())).unwrap();
        let selected = root.join("selected.txt");
        let later = root.join("later.txt");
        fs::write(&selected, b"selected fixture").unwrap();
        super::super::trash_item(&selected).unwrap();
        let selected_item = listed(&selected);
        fs::write(&later, b"later retained bytes").unwrap();
        super::super::trash_item(&later).unwrap();
        let later_item = listed(&later);
        let shared = Shared::default();
        purge(&selected_item, &shared, "purge").unwrap();
        assert!(find(&selected_item).is_err());
        check(&later_item).unwrap();
        shared
            .tasks
            .lock()
            .unwrap()
            .insert("restore".into(), Task::default());
        let target = super::super::restore_target(&later_item, None).unwrap();
        super::super::restore(&shared, "restore", &later_item, &target).unwrap();
        assert_eq!(fs::read(&later).unwrap(), b"later retained bytes");
        assert!(!selected.exists());
        assert!(find(&later_item).is_err());
    }
}
pub(super) fn restore_via_system(
    shared: &Shared,
    id: &str,
    item: &NativeItem,
    target: &Path,
    parent: &Directory,
) -> Result<(), String> {
    let Some((target, replacement)) = crate::resolve_conflict(shared, id, None, target.to_owned())?
    else {
        return Ok(());
    };
    parent.check()?;
    let mut native = find(item)?;
    let stage = tempfile::Builder::new()
        .prefix(".filepace-trash-restore-")
        .tempdir_in(&parent.path)
        .map_err(|error| error.to_string())?
        .keep();
    let source = stage.join(&item.item.name);
    let mut recovery = shared
        .recovery
        .begin(id, Some(&item.path), &target, Some(&source), true)?;
    recovery.retain();
    recovery.phase("系统回收站恢复到保留位置")?;
    native.original_parent = stage.clone();
    native.name = OsString::from(&item.item.name);
    os_limited::restore_all([native])
        .map_err(|error| format!("系统恢复失败：{error}；保留位置：{}", stage.display()))?;
    parent.check()?;
    crate::transfer::commit_staged(&source, &target, parent, replacement.as_ref(), shared, id)
        .map_err(|error| format!("{error}；文件已保留在 {}", source.display()))?;
    update(shared, id, |task| {
        task.completed += 1;
        task.file_changes.push(crate::FileChange {
            from: strpath(&item.path),
            to: Some(strpath(&target)),
            kind: "move".into(),
        });
    });
    let _ = fs::remove_dir(&stage);
    recovery.finish()
}

pub(super) fn choose_location() -> Result<Option<String>, String> {
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-STA", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description='选择文件夹'; if ($dialog.ShowDialog() -eq 'OK') { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::Write($dialog.SelectedPath) }"]);
    let result =
        crate::system_process::run(command, || false, None).map_err(|error| error.to_string())?;
    if !result.status.success() {
        return Err("无法打开系统文件夹选择器".into());
    }
    let path = String::from_utf8_lossy(&result.stdout)
        .trim_start_matches('\u{feff}')
        .trim()
        .to_string();
    if path.is_empty() {
        Ok(None)
    } else {
        super::validate_location(path).map(Some)
    }
}
