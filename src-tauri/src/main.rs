#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod archives;
mod fs_safety;
mod native_drag;
mod search;
mod storage;
mod system_actions;
mod system_process;
mod undo;

use clipboard_rs::{Clipboard, ClipboardContent, ClipboardContext};
use fs_safety::{entry_path, is_link, missing, rename_exclusive, Identity};
use native_drag::start_file_drag;
use notify::Watcher;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufReader, ErrorKind, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, UNIX_EPOCH},
};
use storage::{cancel_storage_scan, scan_storage, storage_volumes};
use system_actions::{open_properties, open_system_storage, open_with};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use undo::Change;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    is_link: bool,
    size: u64,
    modified: u64,
    hidden: bool,
}
#[derive(Serialize)]
struct Listing {
    path: String,
    parent: Option<String>,
    entries: Vec<Entry>,
}
#[derive(Serialize)]
struct Place {
    name: String,
    path: String,
    kind: String,
}
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    kind: String,
    sources: Vec<String>,
    destination: String,
    status: String,
    current: String,
    completed: u64,
    bytes: u64,
    errors: Vec<String>,
    conflict: Option<String>,
    decision: Option<String>,
    policy: Option<String>,
    cancelled: bool,
}
#[derive(Default)]
struct Shared {
    tasks: Mutex<HashMap<String, Task>>,
    undo: Mutex<Vec<undo::UndoRecord>>,
    sessions: Mutex<HashMap<String, serde_json::Value>>,
    closing_windows: Mutex<HashSet<String>>,
    clipboard: Mutex<(Vec<String>, bool)>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    watched: Mutex<Vec<PathBuf>>,
}
fn strpath(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
fn valid_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty()
        || name == "."
        || name == ".."
        || name.chars().any(|c| c == '/' || c == '\\' || c == '\0')
    {
        return Err("文件名无效".into());
    }
    #[cfg(windows)]
    {
        let stem = name
            .split('.')
            .next()
            .unwrap_or_default()
            .trim_end_matches(' ')
            .to_ascii_uppercase();
        let reserved = matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ["COM", "LPT"].into_iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
        if reserved
            || name.ends_with([' ', '.'])
            || name
                .chars()
                .any(|c| c < ' ' || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        {
            return Err("Windows 文件名无效或为系统保留名称".into());
        }
    }
    Ok(())
}
fn is_hidden(name: &str, meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        name.starts_with('.') || meta.file_attributes() & 2 != 0
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        name.starts_with('.')
    }
}
fn canonical(path: &str) -> Result<PathBuf, String> {
    dunce::canonicalize(path).map_err(|e| format!("无法访问 {path}: {e}"))
}

fn open_regular_file(path: &Path, follow_symlinks: bool) -> Result<fs::File, String> {
    let metadata = if follow_symlinks {
        fs::metadata(path)
    } else {
        fs::symlink_metadata(path)
    }
    .map_err(|error| error.to_string())?;
    if !metadata.is_file() || (!follow_symlinks && is_link(&metadata)) {
        return Err("只支持读取普通文件".into());
    }

    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut flags = libc::O_NONBLOCK;
        if !follow_symlinks {
            flags |= libc::O_NOFOLLOW;
        }
        options.custom_flags(flags);
    }
    #[cfg(windows)]
    if !follow_symlinks {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || (!follow_symlinks && is_link(&metadata)) {
        return Err("只支持读取普通文件".into());
    }
    Ok(file)
}

fn entry_info(path: &Path, meta: &fs::Metadata) -> Entry {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let is_link = is_link(meta);
    Entry {
        hidden: is_hidden(&name, meta),
        name,
        path: strpath(path),
        is_dir: if is_link {
            path.is_dir()
        } else {
            meta.is_dir()
        },
        is_link,
        size: meta.len(),
        modified: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0),
    }
}
#[tauri::command]
async fn list_directory(path: String, app: tauri::AppHandle) -> Result<Listing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = canonical(&path)?;
        let mut entries = Vec::new();
        for item in fs::read_dir(&p).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            let path = item.path();
            let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            entries.push(entry_info(&path, &meta));
        }
        let shared = app.state::<Arc<Shared>>();
        let mut watched = shared.watched.lock().unwrap();
        if !watched.contains(&p) {
            if let Some(w) = shared.watcher.lock().unwrap().as_mut() {
                let _ = w.watch(&p, notify::RecursiveMode::NonRecursive);
            }
            watched.push(p.clone());
        }
        Ok(Listing {
            path: strpath(&p),
            parent: p.parent().map(strpath),
            entries,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn places() -> Vec<Place> {
    let mut out = Vec::new();
    for (name, path) in [
        ("个人目录", dirs::home_dir()),
        ("桌面", dirs::desktop_dir()),
        ("下载", dirs::download_dir()),
        ("文档", dirs::document_dir()),
        ("图片", dirs::picture_dir()),
    ] {
        if let Some(p) = path {
            if p.exists() {
                out.push(Place {
                    name: name.into(),
                    path: strpath(&p),
                    kind: "favorite".into(),
                });
            }
        }
    }
    out.extend(storage::disk_places());
    out
}
#[tauri::command]
fn open_entry(path: String, app: tauri::AppHandle) -> Result<(), String> {
    let path = canonical(&path)?;
    app.opener()
        .open_path(strpath(&path), None::<&str>)
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn open_terminal(path: String, in_parent: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let absolute = std::path::absolute(&path).map_err(|e| e.to_string())?;
        let directory = if in_parent {
            absolute.parent().ok_or("找不到上一级文件夹")?
        } else {
            absolute.as_path()
        };
        let directory = canonical(&strpath(directory))?;
        if !directory.is_dir() {
            return Err("命令行的起始位置必须是文件夹".into());
        }
        launch_terminal(&directory)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
fn launch_terminal(directory: &Path) -> Result<(), String> {
    let status = Command::new("/usr/bin/open")
        .args(["-b", "com.apple.Terminal"])
        .arg(directory)
        .status()
        .map_err(|e| format!("无法打开终端：{e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("无法打开终端：{status}"))
    }
}

#[cfg(windows)]
fn launch_terminal(directory: &Path) -> Result<(), String> {
    use std::{
        ffi::OsString,
        os::windows::{ffi::OsStringExt, process::CommandExt},
    };
    use windows_sys::Win32::{
        System::SystemInformation::GetSystemDirectoryW, System::Threading::CREATE_NEW_CONSOLE,
    };

    let mut system_directory = [0u16; 260];
    let len = unsafe {
        GetSystemDirectoryW(system_directory.as_mut_ptr(), system_directory.len() as u32)
    } as usize;
    if len == 0 || len >= system_directory.len() {
        return Err("找不到 Windows 系统目录".into());
    }
    let powershell = PathBuf::from(OsString::from_wide(&system_directory[..len]))
        .join("WindowsPowerShell/v1.0/powershell.exe");
    Command::new(powershell)
        .args(["-NoLogo", "-NoProfile"])
        .current_dir(directory)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map(drop)
        .map_err(|e| format!("无法打开 PowerShell：{e}"))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn launch_terminal(_directory: &Path) -> Result<(), String> {
    Err("当前系统暂不支持打开命令行".into())
}

#[tauri::command]
fn make_directory(parent: String, name: String, app: tauri::AppHandle) -> Result<(), String> {
    valid_name(&name)?;
    let shared = app.state::<Arc<Shared>>();
    let tasks = shared.tasks.lock().unwrap();
    ensure_mutation_allowed(&tasks)?;
    fs::create_dir(canonical(&parent)?.join(name)).map_err(|e| e.to_string())?;
    drop(tasks);
    let _ = app.emit("directory-changed", ());
    Ok(())
}
#[tauri::command]
fn rename_entry(path: String, name: String, app: tauri::AppHandle) -> Result<(), String> {
    valid_name(&name)?;
    let src = entry_path(Path::new(&path))?;
    let dst = src.parent().ok_or("不能重命名根目录")?.join(name);
    if src == dst {
        return Ok(());
    }
    let shared = app.state::<Arc<Shared>>();
    let tasks = shared.tasks.lock().unwrap();
    ensure_mutation_allowed(&tasks)?;
    rename_exclusive(&src, &dst).map_err(|error| {
        if error.kind() == ErrorKind::AlreadyExists {
            "同名文件已存在".into()
        } else {
            error.to_string()
        }
    })?;
    if let Ok(identity) = Identity::at(&dst) {
        undo::record(
            &shared,
            "撤销改名",
            vec![Change::Moved {
                from: src,
                to: dst,
                identity,
            }],
        );
    }
    drop(tasks);
    let _ = app.emit("directory-changed", ());
    Ok(())
}
#[tauri::command]
fn clipboard_set(
    paths: Vec<String>,
    cut: bool,
    state: tauri::State<Arc<Shared>>,
) -> Result<(), String> {
    let ctx = ClipboardContext::new().map_err(|e| e.to_string())?;
    let mut content = vec![ClipboardContent::Files(paths.clone())];
    content.push(ClipboardContent::Other(
        "app.filepace.cut".into(),
        vec![if cut { 1 } else { 0 }],
    ));
    #[cfg(target_os = "windows")]
    content.push(ClipboardContent::Other(
        "Preferred DropEffect".into(),
        (if cut { 2u32 } else { 1u32 }).to_le_bytes().to_vec(),
    ));
    ctx.set(content).map_err(|e| e.to_string())?;
    *state.clipboard.lock().unwrap() = (paths, cut);
    Ok(())
}
#[tauri::command]
fn clipboard_get() -> Result<(Vec<String>, bool), String> {
    let ctx = ClipboardContext::new().map_err(|e| e.to_string())?;
    let paths = ctx.get_files().unwrap_or_default();
    #[allow(unused_mut)]
    let mut cut = ctx
        .get_buffer("app.filepace.cut")
        .map(|b| b.first() == Some(&1))
        .unwrap_or(false);
    #[cfg(target_os = "windows")]
    {
        cut |= ctx
            .get_buffer("Preferred DropEffect")
            .map(|b| b.first() == Some(&2))
            .unwrap_or(false);
    }
    Ok((paths, cut))
}
#[tauri::command]
fn clipboard_copy_paths(paths: Vec<String>, names_only: Option<bool>) -> Result<(), String> {
    let paths = paths
        .into_iter()
        .map(|path| {
            if names_only.unwrap_or(false) {
                Ok(Path::new(&path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or(path))
            } else {
                std::path::absolute(path).map(|path| strpath(&path))
            }
        })
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let separator = if cfg!(windows) { "\r\n" } else { "\n" };
    ClipboardContext::new()
        .and_then(|clipboard| clipboard.set_text(paths.join(separator)))
        .map_err(|e| e.to_string())
}

fn update(shared: &Shared, id: &str, f: impl FnOnce(&mut Task)) {
    if let Some(t) = shared.tasks.lock().unwrap().get_mut(id) {
        f(t)
    }
}
fn cancelled(shared: &Shared, id: &str) -> bool {
    shared
        .tasks
        .lock()
        .unwrap()
        .get(id)
        .map(|t| t.cancelled)
        .unwrap_or(true)
}
fn unique_target(path: &Path) -> Result<PathBuf, String> {
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let ext = path
        .extension()
        .map(|x| format!(".{}", x.to_string_lossy()))
        .unwrap_or_default();
    for i in 2.. {
        let p = path.with_file_name(format!("{stem} ({i}){ext}"));
        if missing(&p).map_err(|error| error.to_string())? {
            return Ok(p);
        }
    }
    unreachable!()
}
fn choose(shared: &Shared, id: &str, dst: &Path) -> Result<String, String> {
    if let Some(policy) = shared
        .tasks
        .lock()
        .unwrap()
        .get(id)
        .and_then(|t| t.policy.clone())
    {
        return Ok(policy);
    }
    update(shared, id, |t| {
        t.conflict = Some(strpath(dst));
        t.status = "conflict".into();
        t.decision = None;
    });
    loop {
        if cancelled(shared, id) {
            return Err("任务已取消".into());
        }
        let decision = {
            shared
                .tasks
                .lock()
                .unwrap()
                .get_mut(id)
                .and_then(|t| t.decision.take())
        };
        if let Some(d) = decision {
            update(shared, id, |t| {
                t.conflict = None;
                t.status = "running".into()
            });
            return Ok(d);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn resolve_conflict(
    shared: &Shared,
    id: &str,
    dst: PathBuf,
) -> Result<Option<(PathBuf, Option<Identity>)>, String> {
    if missing(&dst).map_err(|error| error.to_string())? {
        return Ok(Some((dst, None)));
    }
    let before = Identity::at(&dst);
    match choose(shared, id, &dst)?.as_str() {
        "skip" => Ok(None),
        "keep" => Ok(Some((unique_target(&dst)?, None))),
        "replace" => {
            let identity = before.map_err(|error| error.to_string())?;
            Ok(Some((dst, Some(identity))))
        }
        _ => Err("无效的冲突处理".into()),
    }
}

fn trash_existing(path: &Path, identity: &Identity) -> Result<(), String> {
    if Identity::at(path).as_ref().ok() != Some(identity) {
        return Err("目标在确认期间已变更，请重试".into());
    }
    trash::delete(path).map_err(|error| format!("无法将原项目移到回收站：{error}"))
}

fn copy_entry(
    src: &Path,
    dest: &Path,
    shared: &Shared,
    id: &str,
    moving: bool,
    journal: &mut Vec<Change>,
) -> Result<bool, String> {
    if cancelled(shared, id) {
        return Err("任务已取消".into());
    }
    let meta = fs::symlink_metadata(src).map_err(|e| e.to_string())?;
    if is_link(&meta) {
        return Err(format!("暂不传输链接：{}", strpath(src)));
    }
    if !meta.is_file() && !meta.is_dir() {
        return Err(format!("暂不传输特殊文件：{}", strpath(src)));
    }
    update(shared, id, |t| t.current = strpath(src));
    let merge = meta.is_dir()
        && dest
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.is_dir() && !is_link(&metadata));
    let Some((dst, replace)) = (if merge {
        Some((dest.to_path_buf(), None))
    } else {
        resolve_conflict(shared, id, dest.to_path_buf())?
    }) else {
        return Ok(false);
    };
    if meta.is_dir() {
        if let Some(identity) = &replace {
            trash_existing(&dst, identity)?;
        }
        match fs::create_dir(&dst) {
            Ok(()) => {
                if moving {
                    if let Ok(identity) = Identity::at(&dst) {
                        journal.push(Change::MadeDirectory {
                            path: dst.clone(),
                            identity,
                        });
                    }
                }
            }
            Err(error)
                if merge
                    && error.kind() == ErrorKind::AlreadyExists
                    && dst
                        .symlink_metadata()
                        .is_ok_and(|metadata| metadata.is_dir() && !is_link(&metadata)) => {}
            Err(error) => return Err(error.to_string()),
        }
        let mut all = true;
        for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            match copy_entry(
                &entry.path(),
                &dst.join(entry.file_name()),
                shared,
                id,
                moving,
                journal,
            ) {
                Ok(copied) => all &= copied,
                Err(error) => {
                    all = false;
                    update(shared, id, |t| {
                        t.errors
                            .push(format!("{}: {error}", strpath(&entry.path())))
                    });
                    if cancelled(shared, id) {
                        return Err("任务已取消".into());
                    }
                }
            }
        }
        if moving && all {
            fs::remove_dir(src).map_err(|e| e.to_string())?;
            journal.push(Change::RemovedDirectory(src.to_path_buf()));
        }
        return Ok(all);
    }
    if let Some(identity) = transfer_file(src, &dst, shared, id, moving, replace.as_ref())? {
        journal.push(Change::Moved {
            from: src.to_path_buf(),
            to: dst,
            identity,
        });
    }
    Ok(true)
}

// Copies commit from a temporary sibling. Cancellation keeps the original file.
fn transfer_file(
    src: &Path,
    dst: &Path,
    shared: &Shared,
    id: &str,
    moving: bool,
    replace: Option<&Identity>,
) -> Result<Option<Identity>, String> {
    let mut input = open_regular_file(src, false)?;
    let meta = input.metadata().map_err(|error| error.to_string())?;
    let original = Identity::from_file(&input).map_err(|error| error.to_string())?;
    let mut temp = tempfile::Builder::new()
        .prefix(".filepace-")
        .suffix(".partial")
        .tempfile_in(dst.parent().ok_or("目标路径无效")?)
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let output = temp.as_file_mut();
        let mut buf = vec![0u8; 1024 * 1024];
        loop {
            if cancelled(shared, id) {
                return Err("任务已取消".into());
            }
            let n = input.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            output.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            update(shared, id, |t| t.bytes += n as u64);
        }
        output.sync_all().map_err(|e| e.to_string())?;
        fs::set_permissions(temp.path(), meta.permissions()).map_err(|e| e.to_string())?;
        // Commit without replacing a destination created by another process.
        filetime::set_file_times(
            temp.path(),
            filetime::FileTime::from_last_access_time(&meta),
            filetime::FileTime::from_last_modification_time(&meta),
        )
        .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        for name in xattr::list(src).map_err(|e| e.to_string())? {
            if let Some(value) = xattr::get(src, &name).map_err(|e| e.to_string())? {
                xattr::set(temp.path(), &name, &value).map_err(|e| e.to_string())?;
            }
        }
        let current = fs::symlink_metadata(src).map_err(|e| e.to_string())?;
        if Identity::at(src).as_ref().ok() != Some(&original)
            || current.len() != meta.len()
            || current.modified().ok() != meta.modified().ok()
        {
            return Err("复制期间源文件发生变化，保留原文件，请重试".into());
        }
        if cancelled(shared, id) {
            return Err("任务已取消".into());
        }
        if let Some(identity) = replace {
            trash_existing(dst, identity)?;
        }
        let output = temp
            .persist_noclobber(dst)
            .map_err(|e| format!("无法提交目标文件（原文件保留）：{e}"))?;
        let identity = if moving {
            let identity = Identity::from_file(&output).map_err(|error| error.to_string())?;
            if Identity::at(src).as_ref().ok() != Some(&original) {
                return Err("目标已写入，源文件发生变化并已保留".into());
            }
            fs::remove_file(src).map_err(|e| format!("目标已写入，无法移除源文件：{e}"))?;
            Some(identity)
        } else {
            None
        };
        update(shared, id, |t| t.completed += 1);
        Ok(identity)
    })();
    result
}
#[tauri::command]
fn start_task(
    kind: String,
    sources: Vec<String>,
    destination: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    if matches!(kind.as_str(), "zip" | "unzip") {
        return archives::start(kind, sources, app);
    }
    if !["copy", "move", "trash"].contains(&kind.as_str()) {
        return Err("未知操作".into());
    }
    if sources.is_empty() {
        return Err("请选择文件".into());
    }
    let destination_path = if kind != "trash" {
        let p = canonical(&destination)?;
        if !p.is_dir() {
            return Err("目标必须是文件夹".into());
        }
        Some(p)
    } else {
        None
    };
    let mut transfers = Vec::with_capacity(sources.len());
    for source in &sources {
        let path = entry_path(Path::new(source))?;
        let resolved = canonical(source)?;
        let target = if let Some(dst) = &destination_path {
            let name = path.file_name().ok_or("需要选择文件或文件夹")?;
            let target = dst.join(name);
            if resolved.parent().is_none()
                || dst.starts_with(&resolved)
                || target == resolved
                || dunce::canonicalize(&target).is_ok_and(|target| target == resolved)
            {
                return Err("不能复制或移动到自身或子目录".into());
            }
            Some(target)
        } else {
            None
        };
        transfers.push((path, target));
    }
    enqueue_task(
        app,
        Task {
            kind: kind.clone(),
            sources,
            destination,
            ..Default::default()
        },
        move |state, id, app| {
            let mut journal = Vec::new();
            for (src, dst) in transfers {
                if cancelled(state, id) {
                    break;
                }
                let source = strpath(&src);
                update(state, id, |t| t.current = source.clone());
                let result = if let Some(dst) = dst {
                    copy_entry(&src, &dst, state, id, kind == "move", &mut journal)
                } else {
                    trash::delete(&src)
                        .map(|_| {
                            update(state, id, |t| t.completed += 1);
                            true
                        })
                        .map_err(|e| e.to_string())
                };
                if let Err(e) = result {
                    update(state, id, |t| t.errors.push(format!("{source}: {e}")));
                }
                let _ = app.emit("directory-changed", ());
            }
            undo::record(state, "撤销移动", journal);
            Ok(())
        },
    )
}

fn active(task: &Task) -> bool {
    matches!(task.status.as_str(), "running" | "conflict")
}

fn ensure_mutation_allowed(tasks: &HashMap<String, Task>) -> Result<(), String> {
    if tasks
        .values()
        .any(|task| task.kind == "undo" && active(task))
    {
        return Err("正在撤销文件操作，请稍后重试".into());
    }
    Ok(())
}

fn enqueue_task(
    app: tauri::AppHandle,
    mut task: Task,
    work: impl FnOnce(&Shared, &str, &tauri::AppHandle) -> Result<(), String> + Send + 'static,
) -> Result<String, String> {
    let state = app.state::<Arc<Shared>>().inner().clone();
    let id = uuid::Uuid::new_v4().to_string();
    {
        let mut tasks = state.tasks.lock().unwrap();
        ensure_mutation_allowed(&tasks)?;
        if task.kind == "undo" {
            if tasks.values().any(active) {
                return Err("请等文件任务结束后再撤销".into());
            }
            if state.undo.lock().unwrap().is_empty() {
                return Err("当前会话没有可撤销的操作".into());
            }
        }
        task.id = id.clone();
        task.status = "running".into();
        tasks.insert(id.clone(), task);
    }
    let task_id = id.clone();
    std::thread::spawn(move || {
        if let Err(error) = work(&state, &task_id, &app) {
            update(&state, &task_id, |task| task.errors.push(error));
        }
        update(&state, &task_id, |t| {
            t.conflict = None;
            t.status = if t.cancelled {
                "cancelled"
            } else if t.errors.is_empty() {
                "done"
            } else {
                "error"
            }
            .into()
        });
        let _ = app.emit("directory-changed", ());
    });
    Ok(id)
}

#[tauri::command]
fn undo_last(app: tauri::AppHandle) -> Result<String, String> {
    enqueue_task(
        app,
        Task {
            kind: "undo".into(),
            ..Default::default()
        },
        |state, id, _| {
            let mut record = state.undo.lock().unwrap().pop().ok_or("没有可撤销的操作")?;
            let result = undo::reverse(&mut record, state, id);
            undo::record(state, record.label, record.changes);
            result
        },
    )
}

#[derive(Serialize)]
struct Activity {
    tasks: Vec<Task>,
    undo: Option<&'static str>,
}

#[tauri::command]
fn tasks(state: tauri::State<Arc<Shared>>) -> Activity {
    let mut t: Vec<_> = state.tasks.lock().unwrap().values().cloned().collect();
    t.sort_by(|a, b| a.id.cmp(&b.id));
    let undo = state.undo.lock().unwrap().last().map(|entry| entry.label);
    Activity { tasks: t, undo }
}
#[tauri::command]
fn task_action(id: String, decision: String, apply_all: bool, state: tauri::State<Arc<Shared>>) {
    update(&state, &id, |t| {
        if decision == "cancel" {
            t.cancelled = true
        } else if ["replace", "skip", "keep"].contains(&decision.as_str()) {
            if apply_all {
                t.policy = Some(decision.clone())
            }
            t.decision = Some(decision)
        }
    })
}
#[tauri::command]
async fn thumbnail(path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = open_regular_file(Path::new(&path), true)?;
        let mut reader = image::ImageReader::new(BufReader::new(file))
            .with_guessed_format()
            .map_err(|e| e.to_string())?;
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(128 * 1024 * 1024);
        reader.limits(limits);
        let image = reader
            .decode()
            .map_err(|e| e.to_string())?
            .thumbnail(160, 160);
        let mut bytes = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut bytes, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        Ok(bytes.into_inner())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn read_limited(path: &Path, limit: u64, too_large: &str) -> Result<Vec<u8>, String> {
    let file = open_regular_file(path, true)?;
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    if size > limit {
        return Err(too_large.into());
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(too_large.into());
    }
    Ok(bytes)
}

#[tauri::command]
fn read_preview(path: String) -> Result<String, String> {
    let bytes = read_limited(
        Path::new(&path),
        2 * 1024 * 1024,
        "文本预览上限为 2 MB，请用默认应用打开",
    )?;
    String::from_utf8(bytes).map_err(|_| "此文件暂不支持文本预览".into())
}
#[tauri::command]
fn read_image(path: String) -> Result<Vec<u8>, String> {
    read_limited(Path::new(&path), 20 * 1024 * 1024, "图片预览上限为 20 MB")
}
fn session_file(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap().join("sessions.json")
}

fn persist_sessions(
    app: &tauri::AppHandle,
    sessions: &HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    let path = session_file(app);
    let directory = path.parent().unwrap();
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut temp, sessions).map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_session(
    value: serde_json::Value,
    window: tauri::Window,
    state: tauri::State<Arc<Shared>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if app.get_webview_window(window.label()).is_none() {
        return Ok(());
    }
    let mut sessions = state.sessions.lock().unwrap();
    sessions.insert(window.label().into(), value);
    persist_sessions(&app, &sessions)
}
#[tauri::command]
fn load_session(
    window: tauri::Window,
    state: tauri::State<Arc<Shared>>,
) -> Option<serde_json::Value> {
    state.sessions.lock().unwrap().get(window.label()).cloned()
}
fn has_active_tasks(state: &Shared) -> bool {
    state.tasks.lock().unwrap().values().any(active)
}

fn handle_window_close(window: &tauri::Window, event: &tauri::WindowEvent) {
    let app = window.app_handle();
    let state = app.state::<Arc<Shared>>();
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            let mut closing = state.closing_windows.lock().unwrap();
            let last = app
                .webview_windows()
                .keys()
                .all(|label| label == window.label() || closing.contains(label));
            if last && has_active_tasks(&state) {
                api.prevent_close();
                let _ = window.emit_to(
                    tauri::EventTarget::labeled(window.label()),
                    "exit-blocked",
                    (),
                );
            } else if !last {
                closing.insert(window.label().into());
            }
        }
        tauri::WindowEvent::Destroyed => {
            if state.closing_windows.lock().unwrap().remove(window.label()) {
                let mut sessions = state.sessions.lock().unwrap();
                sessions.remove(window.label());
                if let Err(error) = persist_sessions(app, &sessions) {
                    eprintln!("无法保存窗口会话：{error}");
                }
            }
        }
        _ => {}
    }
}
#[tauri::command]
async fn new_window(value: serde_json::Value, app: tauri::AppHandle) -> Result<(), String> {
    let label = format!("files-{}", uuid::Uuid::new_v4());
    app.state::<Arc<Shared>>()
        .sessions
        .lock()
        .unwrap()
        .insert(label.clone(), value);
    let result =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
            .title("Filepace")
            .inner_size(1180., 780.)
            .min_inner_size(780., 520.)
            .build();
    if let Err(error) = result {
        app.state::<Arc<Shared>>()
            .sessions
            .lock()
            .unwrap()
            .remove(&label);
        return Err(error.to_string());
    }
    Ok(())
}

fn clear_tab_selection(pane: &mut serde_json::Value) {
    if let Some(tabs) = pane.get_mut("tabs").and_then(|tabs| tabs.as_array_mut()) {
        for tab in tabs {
            tab["selected"] = serde_json::json!([]);
        }
    }
}
fn main() {
    let shared = Arc::new(Shared::default());
    tauri::Builder::default()
        .manage(shared)
        .manage(native_drag::DragState::default())
        .manage(storage::ScanState::default())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            handle_window_close(window, event);
            native_drag::handle_window_event(window, event);
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .state::<storage::ScanState>()
                    .stop_window(window.label());
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let watch_handle = handle.clone();
            let watcher =
                notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                    if result.is_ok() {
                        let _ = watch_handle.emit("directory-changed", ());
                    }
                })?;
            *app.state::<Arc<Shared>>().watcher.lock().unwrap() = Some(watcher);
            if let Ok(data) = fs::read(session_file(&handle)) {
                if let Ok(mut sessions) =
                    serde_json::from_slice::<HashMap<String, serde_json::Value>>(&data)
                {
                    if !sessions.contains_key("main") {
                        if let Some(first) = sessions.keys().next().cloned() {
                            let value = sessions.remove(&first).unwrap();
                            sessions.insert("main".into(), value);
                        }
                    }
                    for value in sessions.values_mut() {
                        clear_tab_selection(value);
                        if let Some(right) = value.get_mut("right") {
                            clear_tab_selection(right);
                        }
                    }
                    let labels: Vec<_> = sessions
                        .keys()
                        .filter(|s| s.starts_with("files-"))
                        .cloned()
                        .collect();
                    *app.state::<Arc<Shared>>().sessions.lock().unwrap() = sessions;
                    for label in labels {
                        let _ = tauri::WebviewWindowBuilder::new(
                            app,
                            &label,
                            tauri::WebviewUrl::App("index.html".into()),
                        )
                        .title("Filepace")
                        .inner_size(1180., 780.)
                        .min_inner_size(780., 520.)
                        .build();
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_directory,
            places,
            open_entry,
            open_properties,
            open_with,
            open_system_storage,
            storage_volumes,
            scan_storage,
            cancel_storage_scan,
            search::search_files,
            search::cancel_search,
            open_terminal,
            make_directory,
            rename_entry,
            clipboard_set,
            clipboard_get,
            clipboard_copy_paths,
            start_file_drag,
            start_task,
            undo_last,
            tasks,
            task_action,
            read_preview,
            thumbnail,
            read_image,
            save_session,
            load_session,
            new_window,
        ])
        .build(tauri::generate_context!())
        .expect("启动 Filepace 失败")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if has_active_tasks(&app.state::<Arc<Shared>>()) {
                    api.prevent_exit();
                    let _ = app.emit("exit-blocked", ());
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsafe_names() {
        for name in ["", "..", "a/b", "a\\b"] {
            assert!(valid_name(name).is_err())
        }
        assert!(valid_name("新文件夹").is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn rejects_windows_device_names_and_alternate_streams() {
        for name in [
            "C:folder",
            "doc.txt:stream",
            "NUL.txt",
            "com¹.log",
            "LPT9",
            "trailing.",
            "trailing ",
        ] {
            assert!(valid_name(name).is_err(), "accepted {name}");
        }
        assert!(valid_name("report COM1.txt").is_ok());
    }
    #[test]
    fn preview_checks_the_read_limit() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("preview.txt");
        fs::write(&file, b"preview").unwrap();
        assert_eq!(read_limited(&file, 7, "limit").unwrap(), b"preview");
        assert_eq!(read_limited(&file, 6, "limit").unwrap_err(), "limit");
    }
    #[cfg(unix)]
    #[test]
    fn preview_and_transfer_reject_named_pipes() {
        let dir = tempfile::tempdir().unwrap();
        let pipe = dir.path().join("pipe.png");
        assert!(Command::new("mkfifo")
            .arg(&pipe)
            .status()
            .unwrap()
            .success());
        let shared = Shared::default();
        shared
            .tasks
            .lock()
            .unwrap()
            .insert("t".into(), Task::default());
        let destination = dir.path().join("target.png");
        assert!(copy_entry(&pipe, &destination, &shared, "t", true, &mut Vec::new()).is_err());
        assert!(read_preview(strpath(&pipe)).is_err());
        assert!(read_image(strpath(&pipe)).is_err());
        assert!(open_regular_file(&pipe, true).is_err());
        assert!(pipe.exists());
        assert!(!destination.exists());
    }
    #[test]
    fn copy_and_move_preserve_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("source");
        fs::write(&src, b"important bytes").unwrap();
        let dst = dir.path().join("target");
        let shared = Shared::default();
        shared
            .tasks
            .lock()
            .unwrap()
            .insert("t".into(), Task::default());
        copy_entry(&src, &dst, &shared, "t", false, &mut Vec::new()).unwrap();
        assert_eq!(fs::read(&dst).unwrap(), b"important bytes");
        assert!(src.exists());
        let moved = dir.path().join("moved");
        copy_entry(&src, &moved, &shared, "t", true, &mut Vec::new()).unwrap();
        assert!(!src.exists());
        assert!(moved.exists());
    }
    #[test]
    fn cancellation_preserves_source() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("source");
        fs::write(&src, b"data").unwrap();
        let shared = Shared::default();
        shared.tasks.lock().unwrap().insert(
            "t".into(),
            Task {
                cancelled: true,
                ..Default::default()
            },
        );
        assert!(copy_entry(
            &src,
            &dir.path().join("dest"),
            &shared,
            "t",
            true,
            &mut Vec::new()
        )
        .is_err());
        assert!(src.exists());
        assert!(!dir.path().join("dest").exists());
    }
    #[test]
    fn skip_keeps_both_originals() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("source");
        let dst = dir.path().join("dest");
        fs::write(&src, b"new").unwrap();
        fs::write(&dst, b"old").unwrap();
        let shared = Shared::default();
        shared.tasks.lock().unwrap().insert(
            "t".into(),
            Task {
                policy: Some("skip".into()),
                ..Default::default()
            },
        );
        assert!(!copy_entry(&src, &dst, &shared, "t", true, &mut Vec::new()).unwrap());
        assert_eq!(fs::read(dst).unwrap(), b"old");
        assert!(src.exists());
    }
}

#[cfg(test)]
mod conflict_tests {
    use super::*;
    #[test]
    fn keep_both_never_overwrites_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("source.txt");
        let dst = dir.path().join("target.txt");
        fs::write(&src, b"new").unwrap();
        fs::write(&dst, b"old").unwrap();
        let state = Shared::default();
        state.tasks.lock().unwrap().insert(
            "t".into(),
            Task {
                policy: Some("keep".into()),
                ..Default::default()
            },
        );
        copy_entry(&src, &dst, &state, "t", false, &mut Vec::new()).unwrap();
        assert_eq!(fs::read(&dst).unwrap(), b"old");
        assert_eq!(fs::read(dir.path().join("target (2).txt")).unwrap(), b"new");
    }
    #[test]
    fn merged_move_retains_skipped_source() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("source");
        let dst = dir.path().join("target");
        fs::create_dir(&src).unwrap();
        fs::create_dir(&dst).unwrap();
        fs::write(src.join("conflict"), b"new").unwrap();
        fs::write(dst.join("conflict"), b"old").unwrap();
        fs::write(src.join("unique"), b"unique").unwrap();
        let state = Shared::default();
        state.tasks.lock().unwrap().insert(
            "t".into(),
            Task {
                policy: Some("skip".into()),
                ..Default::default()
            },
        );
        assert!(!copy_entry(&src, &dst, &state, "t", true, &mut Vec::new()).unwrap());
        assert!(src.join("conflict").exists());
        assert!(!src.join("unique").exists());
        assert!(dst.join("unique").exists());
        assert_eq!(fs::read(dst.join("conflict")).unwrap(), b"old");
    }
    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlink_during_copy() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("original");
        fs::write(&target, b"untouched").unwrap();
        let link = dir.path().join("link");
        symlink(&target, &link).unwrap();
        let state = Shared::default();
        state
            .tasks
            .lock()
            .unwrap()
            .insert("t".into(), Task::default());
        assert!(copy_entry(
            &link,
            &dir.path().join("copy"),
            &state,
            "t",
            true,
            &mut Vec::new()
        )
        .is_err());
        assert_eq!(fs::read(target).unwrap(), b"untouched");
        assert!(link.is_symlink());
    }
}
