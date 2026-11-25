use super::*;
use std::{ffi::OsString, process::Command, time::Duration};
use trash::os_limited;
use windows::{
    core::{Interface, PWSTR},
    Win32::{
        Foundation::{E_UNEXPECTED, PROPERTYKEY},
        Storage::EnhancedStorage::{PKEY_FileName, PKEY_Size},
        System::{
            Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED},
            SystemServices::{SFGAO_FOLDER, SFGAO_STREAM},
        },
        UI::Shell::{
            BHID_EnumItems, FOLDERID_RecycleBinFolder, IEnumShellItems, IShellItem, IShellItem2,
            SHGetKnownFolderItem, KF_FLAG_DEFAULT, PID_DISPLACED_DATE, PID_DISPLACED_FROM,
            PSGUID_DISPLACED, SIGDN_DESKTOPABSOLUTEPARSING,
        },
    },
};

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
type Listing = (Vec<NativeItem>, Vec<String>);

// Shell returns these strings in COM task memory.
unsafe fn take_string(value: PWSTR) -> windows::core::Result<String> {
    if value.is_null() {
        return Err(E_UNEXPECTED.into());
    }
    let string = value.to_string();
    CoTaskMemFree(Some(value.0.cast()));
    Ok(string?)
}

fn read_item(shell: &IShellItem) -> windows::core::Result<NativeItem> {
    const ORIGINAL_FOLDER: PROPERTYKEY = PROPERTYKEY {
        fmtid: PSGUID_DISPLACED,
        pid: PID_DISPLACED_FROM,
    };
    const DELETION_DATE: PROPERTYKEY = PROPERTYKEY {
        fmtid: PSGUID_DISPLACED,
        pid: PID_DISPLACED_DATE,
    };
    let item: IShellItem2 = shell.cast()?;
    // Use the same identity fields as trash::os_limited::list so actions can
    // revalidate the snapshot. Read properties directly on this top-level item.
    unsafe {
        let id = take_string(item.GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING)?)?.into();
        let name = take_string(item.GetString(&PKEY_FileName)?)?.into();
        let original_parent = take_string(item.GetString(&ORIGINAL_FOLDER)?)?.into();
        let time = item.GetFileTime(&DELETION_DATE)?;
        let ticks = (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
        let time_deleted = (ticks / 10_000_000) as i64 - 11_644_473_600;
        let native = trash::TrashItem {
            id,
            name,
            original_parent,
            time_deleted,
        };
        // ZIP archives can be both streams and Shell folders.
        let is_dir = item.GetAttributes(SFGAO_FOLDER | SFGAO_STREAM)? == SFGAO_FOLDER;
        Ok(NativeItem {
            item: TrashItem {
                id: item_token(&native),
                name: native.name.to_string_lossy().into_owned(),
                original_path: Some(strpath(&native.original_path())),
                deleted_at: (time_deleted >= 0).then_some(time_deleted),
                size: if is_dir {
                    None
                } else {
                    item.GetUInt64(&PKEY_Size).ok()
                },
                is_dir,
            },
            path: native.id.into(),
            identity: None,
        })
    }
}

fn enumerate() -> windows::core::Result<Listing> {
    let bin: IShellItem =
        unsafe { SHGetKnownFolderItem(&FOLDERID_RecycleBinFolder, KF_FLAG_DEFAULT, None)? };
    let entries: IEnumShellItems = unsafe { bin.BindToHandler(None, &BHID_EnumItems)? };
    let mut items = Vec::new();
    let mut skipped = 0;
    loop {
        let mut next = [None];
        let mut fetched = 0;
        unsafe { entries.Next(&mut next, Some(&mut fetched))? };
        if fetched == 0 {
            break;
        }
        let [Some(item)] = next else { break };
        match read_item(&item) {
            Ok(row) => items.push(row),
            Err(_) => skipped += 1,
        }
    }
    let mut warnings = Vec::new();
    if skipped > 0 {
        warnings.push(format!("有 {skipped} 个回收站项目无法读取，请刷新后重试。"));
    }
    Ok((items, warnings))
}

fn read_shell() -> Result<Listing, String> {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }.map_err(|e| e.to_string())?;
    let result = enumerate();
    unsafe { CoUninitialize() };
    let (items, warnings) = result.map_err(|error| format!("无法读取 Windows 回收站：{error}"))?;
    if items.is_empty() && !warnings.is_empty() {
        return Err(warnings.join(" "));
    }
    Ok((items, warnings))
}

pub(crate) const LIST_ARGUMENT: &str = "--list-windows-trash";

pub(crate) fn write_listing() -> std::io::Result<()> {
    use std::io::{BufWriter, Write};
    let mut output = BufWriter::new(std::io::stdout().lock());
    serde_json::to_writer(&mut output, &read_shell())?;
    output.flush()
}

pub(super) fn list() -> Result<Listing, String> {
    // A shell extension or an unavailable disk can block a COM call indefinitely.
    // Isolate the read so a timeout actually stops it before the user retries.
    let mut command = Command::new(std::env::current_exe().map_err(|error| error.to_string())?);
    command.arg(LIST_ARGUMENT);
    let output = crate::system_process::run_with_stdout_limit(
        command,
        || false,
        Some(Duration::from_secs(60)),
        u64::MAX,
    )
    .map_err(|error| {
        if error.kind() == std::io::ErrorKind::Interrupted {
            "读取 Windows 回收站超时，请重新读取。".to_string()
        } else {
            error.to_string()
        }
    })?;
    if !output.status.success() {
        return Err(format!(
            "Windows 回收站读取进程异常退出（{}），请重新读取。",
            output.status
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("无法读取回收站结果：{error}"))?
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
        read_shell()
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
    let mut recovery = shared.recovery.begin(
        id,
        Some(&item.path),
        &target,
        Some(&source),
        true,
        "系统回收站恢复到保留位置",
    )?;
    recovery.retain();
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
