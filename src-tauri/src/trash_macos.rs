use super::*;
use std::{
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn script(source: &str, javascript: bool, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("/usr/bin/osascript");
    if javascript {
        command.args(["-l", "JavaScript"]);
    }
    command.args(["-e", source]).args(args);
    let result = crate::system_process::run(command, || false, Some(Duration::from_secs(120)))
        .map_err(|error| error.to_string())?;
    if !result.status.success() {
        return Err(format!(
            "系统回收站操作失败：{}",
            String::from_utf8_lossy(&result.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&result.stdout).trim().to_string())
}
fn seconds(time: Option<SystemTime>) -> i64 {
    time.and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_secs() as i64)
        .unwrap_or(0)
}
fn fingerprint(size: Option<u64>, created: i64, modified: i64) -> String {
    format!("{size:?}:{created}:{modified}")
}
fn roots() -> Vec<PathBuf> {
    let mut roots = dirs::home_dir()
        .map(|home| vec![home.join(".Trash")])
        .unwrap_or_default();
    let uid = unsafe { libc::geteuid() }.to_string();
    if let Ok(volumes) = fs::read_dir("/Volumes") {
        for volume in volumes.flatten() {
            roots.push(volume.path().join(".Trashes").join(&uid));
        }
    }
    roots
}
pub(super) fn inside_trash(path: &Path) -> bool {
    roots().iter().any(|root| path.starts_with(root))
}
fn from_url(url: &str) -> Result<PathBuf, String> {
    let url = tauri::Url::parse(url).map_err(|error| error.to_string())?;
    let path = url.to_file_path().map_err(|_| "回收站文件位置无效")?;
    Ok(path
        .strip_prefix("/.nofollow")
        .map(|path| Path::new("/").join(path))
        .unwrap_or(path))
}
#[derive(Serialize, Deserialize, Clone)]
struct Ledger {
    original: String,
    deleted: i64,
    fingerprint: String,
}
fn ledger_path() -> Option<PathBuf> {
    dirs::data_local_dir().map(|root| root.join("app.filepace.desktop").join("trash-index.json"))
}
static LEDGER_LOCK: Mutex<()> = Mutex::new(());
fn ledger() -> HashMap<String, Ledger> {
    ledger_path()
        .and_then(|path| fs::read(path).ok())
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default()
}
pub(crate) fn trash_item(path: &Path) -> Result<(), String> {
    let metadata = path.symlink_metadata().map_err(|error| error.to_string())?;
    let print = fingerprint(
        (!metadata.is_dir()).then_some(metadata.len()),
        seconds(metadata.created().ok()),
        seconds(metadata.modified().ok()),
    );
    let trashed = if metadata.file_type().is_symlink() {
        use objc2_foundation::{NSFileManager, NSString, NSURL};
        let url = NSURL::fileURLWithPath(&NSString::from_str(&strpath(path)));
        let mut resulting = None;
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting))
            .map_err(|error| error.to_string())?;
        resulting
            .and_then(|url| url.path())
            .map(|path| PathBuf::from(path.to_string()))
    } else {
        let url = script("on run argv\nset sourceItem to POSIX file (item 1 of argv) as alias\ntell application \"Finder\"\nset movedItem to delete sourceItem\ntry\nreturn URL of movedItem\non error\nreturn \"\"\nend try\nend tell\nend run", false, &[&strpath(path)])?;
        from_url(&url).ok()
    };
    // Once the OS has trashed the source, supplementary metadata failures
    // must not report the file mutation itself as failed.
    let Some(trashed) = trashed.filter(|path| inside_trash(path)) else {
        return Ok(());
    };
    let _lock = LEDGER_LOCK.lock().unwrap();
    let mut ledger = ledger();
    ledger.insert(
        strpath(&trashed),
        Ledger {
            original: strpath(path),
            deleted: seconds(Some(SystemTime::now())),
            fingerprint: print,
        },
    );
    if let Some(path) = ledger_path() {
        // Metadata is supplementary. A ledger write failure must never make a
        // completed system trash operation appear to have retained the source.
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(data) = serde_json::to_vec(&ledger) {
            if let Some(parent) = path.parent() {
                if let Ok(mut temp) = tempfile::NamedTempFile::new_in(parent) {
                    use std::io::Write;
                    if temp.write_all(&data).is_ok() && temp.as_file().sync_all().is_ok() {
                        let _ = temp.persist(&path);
                    }
                }
            }
        }
    }
    Ok(())
}

fn added_date(path: &Path) -> Option<i64> {
    use objc2::{msg_send, runtime::AnyObject};
    use objc2_foundation::{NSString, NSURL};
    unsafe {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&strpath(path)));
        let mut value: *mut AnyObject = std::ptr::null_mut();
        let key = NSString::from_str("NSURLAddedToDirectoryDateKey");
        let success: bool = msg_send![&*url, getResourceValue: &mut value, forKey: &*key, error: std::ptr::null_mut::<*mut AnyObject>()];
        if !success || value.is_null() {
            return None;
        }
        let seconds: f64 = msg_send![value, timeIntervalSince1970];
        (seconds.is_finite() && seconds > 0.).then_some(seconds as i64)
    }
}
pub(super) fn list() -> Result<(Vec<NativeItem>, Vec<String>), String> {
    let mut items = Vec::new();
    let mut warnings = Vec::new();
    let mut denied = false;
    let ledger = ledger();
    for root in roots() {
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                denied = true;
                continue;
            }
        };
        let original =
            super::super::trash_metadata::read(&root.join(".DS_Store")).unwrap_or_default();
        for entry in entries.flatten() {
            if entry.file_name() == ".DS_Store" || entry.file_name() == ".localized" {
                continue;
            }
            let path = entry.path();
            let Ok(metadata) = path.symlink_metadata() else {
                continue;
            };
            let size = (!metadata.is_dir()).then_some(metadata.len());
            let print = fingerprint(
                size,
                seconds(metadata.created().ok()),
                seconds(metadata.modified().ok()),
            );
            let record = ledger
                .get(&strpath(&path))
                .filter(|record| record.fingerprint == print);
            let old = original
                .get(&entry.file_name().to_string_lossy().into_owned())
                .cloned()
                .or_else(|| record.map(|record| record.original.clone()));
            let name = old
                .as_deref()
                .and_then(|path| Path::new(path).file_name())
                .unwrap_or(&entry.file_name())
                .to_string_lossy()
                .into_owned();
            let identity = Identity::at(&path).ok();
            items.push(NativeItem {
                item: TrashItem {
                    id: token(&strpath(&path), &format!("{print}:{identity:?}")),
                    name,
                    original_path: old,
                    deleted_at: added_date(&path).or_else(|| record.map(|record| record.deleted)),
                    size,
                    is_dir: metadata.is_dir(),
                },
                path,
                identity,
            });
        }
    }
    if denied {
        // Finder's scripting dictionary enumerates the same system trash even
        // when macOS protects direct directory access. Never report EPERM as empty.
        #[derive(Deserialize)]
        struct FinderItem {
            url: String,
            name: String,
            size: Option<u64>,
            created: i64,
            modified: i64,
            #[serde(rename = "isDir")]
            is_dir: bool,
        }
        let output = script(
            r#"var f=Application('Finder'); var t=f.trash; var u=t.items.url(), n=t.items.name(), s=t.items.size(), c=t.items.creationDate(), m=t.items.modificationDate(); var folders=new Set(t.folders.url()); JSON.stringify(u.map(function(url,i){return {url:url,name:n[i],size:folders.has(url)?null:(typeof s[i]==='number'?s[i]:null),created:Math.floor(new Date(c[i]).getTime()/1000)||0,modified:Math.floor(new Date(m[i]).getTime()/1000)||0,isDir:folders.has(url)};}));"#,
            true,
            &[],
        )?;
        let listed: Vec<FinderItem> = serde_json::from_str(&output)
            .map_err(|error| format!("无法读取系统回收站：{error}"))?;
        for raw in listed {
            let path = from_url(&raw.url)?;
            if !inside_trash(&path) {
                continue;
            }
            if items.iter().any(|item| item.path == path) {
                continue;
            }
            let print = fingerprint(raw.size, raw.created, raw.modified);
            let record = ledger
                .get(&strpath(&path))
                .filter(|record| record.fingerprint == print);
            let old = record.map(|record| record.original.clone());
            let name = old
                .as_deref()
                .and_then(|path| Path::new(path).file_name())
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or(raw.name);
            items.push(NativeItem {
                item: TrashItem {
                    id: token(&strpath(&path), &print),
                    name,
                    original_path: old,
                    deleted_at: record.map(|record| record.deleted),
                    size: raw.size,
                    is_dir: raw.is_dir,
                },
                path,
                identity: None,
            });
        }
        warnings.push("macOS 限制了回收站目录访问。若部分项目的原位置或删除时间未知，或无法恢复、永久删除，请在系统设置 → 隐私与安全性 → 完全磁盘访问权限中允许 Filepace，然后重新打开应用。".into());
    }
    Ok((items, warnings))
}
pub(super) fn check(item: &NativeItem) -> Result<(), String> {
    if !inside_trash(&item.path)
        || !roots()
            .iter()
            .any(|root| item.path.parent() == Some(root.as_path()))
    {
        return Err("只能操作系统回收站中的顶层项目".into());
    }
    if let Some(identity) = &item.identity {
        if &Identity::at(&item.path).map_err(|_| "回收站项目已变化，请刷新")? == identity
        {
            return Ok(());
        }
    } else if list()?
        .0
        .iter()
        .any(|current| current.item.id == item.item.id)
    {
        return Ok(());
    }
    Err("回收站项目已变化，请刷新后重新选择".into())
}
pub(super) fn purge(item: &NativeItem, shared: &Shared, id: &str) -> Result<(), String> {
    check(item)?;
    let identity = item
        .identity
        .as_ref()
        .ok_or("请在系统设置中授予 Filepace 完全磁盘访问权限")?;
    super::purge_path(&item.path, identity, shared, id)
}
pub(super) fn after_transfer(_: &NativeItem) {}
pub(super) fn restore_via_system(
    _: &Shared,
    _: &str,
    _: &NativeItem,
    _: &Path,
    _: &Directory,
) -> Result<(), String> {
    Err("无法访问回收站源项目。请在系统设置 → 隐私与安全性 → 完全磁盘访问权限中允许 Filepace，重新打开应用后再恢复。".into())
}
pub(super) fn choose_location() -> Result<Option<String>, String> {
    match script("try\nreturn POSIX path of (choose folder with prompt \"选择文件夹\")\non error number -128\nreturn \"\"\nend try", false, &[]) { Ok(path) if path.is_empty() => Ok(None), Ok(path) => super::validate_location(path).map(Some), Err(error) => Err(error) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Read-only check of the current user's system trash; requires Finder automation access"]
    fn system_trash_listing() {
        let (items, warnings) = list().unwrap();
        assert!(items.iter().all(|item| inside_trash(&item.path)));
        eprintln!(
            "Enumerated {} system trash items, {} permission notices",
            items.len(),
            warnings.len()
        );
    }
    #[test]
    fn rejects_other_users_trash_and_decodes_finder_urls() {
        assert!(!inside_trash(Path::new("/tmp/.Trash/user-file")));
        assert_eq!(
            from_url("file:///.nofollow/tmp/test%20file").unwrap(),
            PathBuf::from("/tmp/test file")
        );
    }
}
