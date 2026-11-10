#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod application_icon;
mod archives;
mod batch_rename;
mod compare;
mod diagnostics;
mod directory_watch;
mod fs_safety;
mod native_drag;
mod search;
mod storage;
mod system_actions;
mod system_process;
mod task_feed;
mod transfer;
mod undo;
mod updates;

use clipboard_rs::{Clipboard, ClipboardContent, ClipboardContext};
use diagnostics::Failure;
use fs_safety::{entry_path, is_link, missing, rename_exclusive, Directory, Identity, Snapshot};
use native_drag::start_file_drag;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{BufReader, ErrorKind, Read},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    time::UNIX_EPOCH,
};
use storage::{cancel_storage_scan, scan_storage, storage_volumes};
use system_actions::{open_properties, open_system_storage, open_with};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use transfer::{Source, Transfer};
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
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConflictItem {
    path: String,
    is_dir: bool,
    size: Option<u64>,
    modified: Option<i64>,
}

impl ConflictItem {
    fn at(path: &Path) -> Self {
        let metadata = path.symlink_metadata().ok();
        let regular = metadata.as_ref().filter(|meta| !is_link(meta));
        Self {
            path: strpath(path),
            is_dir: regular.is_some_and(fs::Metadata::is_dir),
            size: regular.filter(|meta| meta.is_file()).map(fs::Metadata::len),
            modified: metadata.as_ref().and_then(|meta| {
                meta.modified()
                    .ok()
                    .map(|_| filetime::FileTime::from_last_modification_time(meta).unix_seconds())
            }),
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct Conflict {
    id: String,
    source: Option<ConflictItem>,
    destination: ConflictItem,
}

#[derive(Serialize, Clone)]
#[serde(transparent)]
struct FailedSource {
    path: String,
    #[serde(skip)]
    identity: Identity,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    sequence: u64,
    kind: String,
    sources: Vec<String>,
    destination: String,
    status: String,
    current: String,
    phase: String,
    completed: u64,
    skipped: u64,
    bytes: u64,
    errors: Vec<String>,
    failed_sources: Vec<FailedSource>,
    #[serde(skip)]
    destination_folder: Option<Arc<Directory>>,
    #[serde(skip)]
    within: Option<String>,
    conflict: Option<Conflict>,
    decision: Option<String>,
    policy: Option<String>,
    cancelled: bool,
}

type TaskWork = Box<dyn FnOnce(&Shared, &str, &tauri::AppHandle) -> Result<(), String> + Send>;

#[derive(Default)]
struct TaskQueue {
    pending: VecDeque<(String, TaskWork)>,
    running: bool,
}

#[derive(Default)]
struct Shared {
    tasks: Mutex<HashMap<String, Task>>,
    task_queue: Mutex<TaskQueue>,
    task_sequence: AtomicU64,
    task_wake: Condvar,
    task_feed: task_feed::TaskFeed,
    mutation: Mutex<()>,
    installing_update: AtomicBool,
    undo: Mutex<Vec<undo::UndoRecord>>,
    sessions: Mutex<HashMap<String, serde_json::Value>>,
    closing_windows: Mutex<HashSet<String>>,
    clipboard: Mutex<(Vec<String>, bool)>,
    directory_watch: Mutex<directory_watch::DirectoryWatch>,
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
fn read_directory(path: &Path) -> Result<(PathBuf, Vec<Entry>), Failure> {
    let operation = "打开文件夹";
    let directory = dunce::canonicalize(path)
        .map_err(|error| Failure::io(operation, "解析路径", path, error))?;
    let items = fs::read_dir(&directory)
        .map_err(|error| Failure::io(operation, "打开目录", &directory, error))?;
    let mut entries = Vec::new();
    for item in items {
        let item = item.map_err(|error| Failure::io(operation, "枚举目录项", &directory, error))?;
        let path = item.path();
        // Windows already provides metadata during enumeration. Opening a
        // child by name could resolve an on-disk entry such as NUL as a device.
        let meta = match item.metadata() {
            Ok(meta) => meta,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(Failure::io(operation, "读取项目属性", &path, error)),
        };
        entries.push(entry_info(&path, &meta));
    }
    Ok((directory, entries))
}

#[tauri::command]
async fn list_directory(path: String, app: tauri::AppHandle) -> Result<Listing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (p, entries) = read_directory(Path::new(&path)).map_err(|failure| {
            let message = format!("{}失败：{}", failure.step, failure.message);
            diagnostics::record(&app, failure);
            message
        })?;
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
async fn suggest_directories(input: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&input);
        if !path.is_absolute() {
            return Ok(Vec::new());
        }
        let (parent, prefix) = if input.ends_with(['/', '\\']) {
            (path, String::new())
        } else {
            let parent = path.parent().ok_or("缺少上级文件夹")?;
            (
                parent,
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase(),
            )
        };
        let mut suggestions = Vec::new();
        for entry in fs::read_dir(parent)
            .map_err(|error| error.to_string())?
            .flatten()
        {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.to_lowercase().starts_with(&prefix)
                && entry.file_type().is_ok_and(|kind| kind.is_dir())
            {
                suggestions.push(strpath(&entry.path()));
                if suggestions.len() == 24 {
                    break;
                }
            }
        }
        suggestions.sort();
        Ok(suggestions)
    })
    .await
    .map_err(|error| error.to_string())?
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
    let _mutation = shared
        .mutation
        .try_lock()
        .map_err(|_| "正在写入文件，请稍后重试")?;
    let tasks = shared.tasks.lock().unwrap();
    ensure_mutation_allowed(&shared, &tasks)?;
    let path = canonical(&parent)?.join(name);
    fs::create_dir(&path).map_err(|e| e.to_string())?;
    drop(tasks);
    let _ = app.emit("directory-changed", [strpath(&path)]);
    Ok(())
}

fn create_text_file(parent: &str, name: &str) -> Result<(), String> {
    valid_name(name)?;
    let name = if name.to_ascii_lowercase().ends_with(".txt") {
        name.to_owned()
    } else {
        format!("{name}.txt")
    };
    fs::File::create_new(canonical(parent)?.join(name))
        .map(drop)
        .map_err(|error| {
            if error.kind() == ErrorKind::AlreadyExists {
                "同名项目已存在，请换个名称".into()
            } else {
                error.to_string()
            }
        })
}

#[tauri::command]
fn make_text_file(parent: String, name: String, app: tauri::AppHandle) -> Result<(), String> {
    let shared = app.state::<Arc<Shared>>();
    let _mutation = shared
        .mutation
        .try_lock()
        .map_err(|_| "正在写入文件，请稍后重试")?;
    let tasks = shared.tasks.lock().unwrap();
    ensure_mutation_allowed(&shared, &tasks)?;
    create_text_file(&parent, &name)?;
    drop(tasks);
    let _ = app.emit("directory-changed", [parent]);
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
    let _mutation = shared
        .mutation
        .try_lock()
        .map_err(|_| "正在写入文件，请稍后重试")?;
    let tasks = shared.tasks.lock().unwrap();
    ensure_mutation_allowed(&shared, &tasks)?;
    rename_exclusive(&src, &dst).map_err(|error| {
        if error.kind() == ErrorKind::AlreadyExists {
            "同名文件已存在".into()
        } else {
            error.to_string()
        }
    })?;
    let changed = [strpath(&src), strpath(&dst)];
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
    let _ = app.emit("directory-changed", changed);
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
        f(t);
        shared.task_feed.change(Some(id));
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
fn choose(shared: &Shared, id: &str, source: Option<&Path>, dst: &Path) -> Result<String, String> {
    if let Some(policy) = shared
        .tasks
        .lock()
        .unwrap()
        .get(id)
        .and_then(|t| t.policy.clone())
    {
        return Ok(policy);
    }
    let conflict = Conflict {
        id: uuid::Uuid::new_v4().to_string(),
        source: source.map(ConflictItem::at),
        destination: ConflictItem::at(dst),
    };
    let mut tasks = shared.tasks.lock().unwrap();
    let task = tasks.get_mut(id).ok_or("文件任务已结束")?;
    task.conflict = Some(conflict);
    task.status = "conflict".into();
    task.decision = None;
    shared.task_feed.change(Some(id));
    let mut tasks = shared
        .task_wake
        .wait_while(tasks, |tasks| {
            tasks
                .get(id)
                .is_some_and(|task| !task.cancelled && task.decision.is_none())
        })
        .unwrap();
    let task = tasks.get_mut(id).ok_or("文件任务已结束")?;
    task.conflict = None;
    if task.cancelled {
        return Err("任务已取消".into());
    }
    task.status = "running".into();
    shared.task_feed.change(Some(id));
    task.decision.take().ok_or_else(|| "无效的冲突处理".into())
}

fn resolve_conflict(
    shared: &Shared,
    id: &str,
    source: Option<&Path>,
    dst: PathBuf,
) -> Result<Option<(PathBuf, Option<Snapshot>)>, String> {
    if missing(&dst).map_err(|error| error.to_string())? {
        return Ok(Some((dst, None)));
    }
    let before = dst
        .symlink_metadata()
        .and_then(|meta| Snapshot::at(&dst, &meta));
    match choose(shared, id, source, &dst)?.as_str() {
        "skip" => {
            update(shared, id, |task| task.skipped += 1);
            Ok(None)
        }
        "keep" => Ok(Some((unique_target(&dst)?, None))),
        "replace" => {
            let identity = before.map_err(|error| error.to_string())?;
            Ok(Some((dst, Some(identity))))
        }
        _ => Err("无效的冲突处理".into()),
    }
}

#[cfg(test)]
fn copy_entry(
    src: &Path,
    dst: &Path,
    shared: &Shared,
    id: &str,
    moving: bool,
    journal: &mut Vec<Change>,
) -> Result<bool, String> {
    let source = Source::at(src.to_owned())?;
    let parent = Directory::parent(dst).map_err(|error| error.to_string())?;
    let mut operation = Transfer::new(shared, id, moving);
    let result = operation.run(&source, dst, &parent);
    journal.extend(operation.journal);
    result
}

#[tauri::command]
async fn start_task(
    kind: String,
    sources: Vec<String>,
    destination: String,
    within: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare_task(kind, sources, destination, within, None, app)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn prepare_task(
    kind: String,
    sources: Vec<String>,
    destination: String,
    within: Option<String>,
    retry: Option<&Task>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    if matches!(kind.as_str(), "zip" | "unzip") {
        return archives::start(kind, sources, destination, app);
    }
    let TransferPlan { folder, items } =
        plan_transfer(&kind, &sources, &destination, within.as_deref(), retry)?;
    enqueue_task(
        app,
        Task {
            kind: kind.clone(),
            sources,
            destination,
            destination_folder: folder.clone(),
            within,
            ..Default::default()
        },
        move |state, id, app| {
            let mut operation = Transfer::new(state, id, kind == "move");
            for (source, target) in items {
                if cancelled(state, id) {
                    break;
                }
                let path = strpath(&source.path);
                update(state, id, |task| task.current = path.clone());
                let result = if let (Some(target), Some(folder)) = (&target, folder.as_ref()) {
                    operation.run(&source, target, folder).map(|_| ())
                } else {
                    source.check().and_then(|()| {
                        trash::delete(&source.path).map_err(|error| error.to_string())?;
                        update(state, id, |task| task.completed += 1);
                        Ok(())
                    })
                };
                if let Err(error) = result {
                    update(state, id, |task| {
                        task.errors.push(format!("{path}: {error}"));
                        if !task.cancelled {
                            task.failed_sources.push(FailedSource {
                                path: path.clone(),
                                identity: source.identity().clone(),
                            });
                        }
                    });
                }
                let changed: Vec<_> = std::iter::once(path)
                    .chain(folder.as_ref().map(|folder| strpath(&folder.path)))
                    .chain(target.as_ref().map(|target| strpath(target)))
                    .collect();
                let _ = app.emit("directory-changed", changed);
            }
            undo::record(state, "撤销移动", operation.journal);
            Ok(())
        },
    )
}

struct TransferPlan {
    folder: Option<Arc<Directory>>,
    items: Vec<(Source, Option<PathBuf>)>,
}

fn plan_transfer(
    kind: &str,
    sources: &[String],
    destination: &str,
    within: Option<&str>,
    retry: Option<&Task>,
) -> Result<TransferPlan, String> {
    if !["copy", "move", "trash"].contains(&kind) {
        return Err("未知操作".into());
    }
    if sources.is_empty() {
        return Err("请选择文件".into());
    }
    let folder = if kind != "trash" {
        let path = canonical(destination)?;
        if let Some(root) = within {
            if !path.starts_with(canonical(root)?) {
                return Err("目标位置已不在对比的文件夹内".into());
            }
        }
        let directory = if let Some(previous) =
            retry.and_then(|task| task.destination_folder.as_ref())
        {
            if previous.path != path {
                return Err("目标位置已变更，请重新选择目标文件夹".into());
            }
            previous.check()?;
            previous.clone()
        } else {
            Arc::new(Directory::at(&path).map_err(|error| error.to_string())?)
        };
        Some(directory)
    } else {
        None
    };
    let mut items = Vec::with_capacity(sources.len());
    let mut seen = HashSet::new();
    let failed = retry.map(|task| {
        task.failed_sources
            .iter()
            .map(|source| (source.path.as_str(), &source.identity))
            .collect::<HashMap<_, _>>()
    });
    for source in sources {
        let path = entry_path(Path::new(source))?;
        if !seen.insert(path.clone()) {
            continue;
        }
        let target = if let Some(folder) = &folder {
            let resolved = canonical(source)?;
            let target = folder
                .path
                .join(path.file_name().ok_or("需要选择文件或文件夹")?);
            if resolved.parent().is_none()
                || folder.path.starts_with(&resolved)
                || target == resolved
                || dunce::canonicalize(&target).is_ok_and(|target| target == resolved)
            {
                return Err("不能复制或移动到自身或子目录".into());
            }
            Some(target)
        } else {
            None
        };
        let item = Source::at(path)?;
        if failed.as_ref().is_some_and(|failed| {
            failed.get(source.as_str()).copied() != Some(item.identity())
        }) {
            return Err(format!("源项目已替换，请重新选择：{source}"));
        }
        items.push((item, target));
    }
    if seen
        .iter()
        .any(|path| path.ancestors().skip(1).any(|parent| seen.contains(parent)))
    {
        return Err("请勿同时选择文件夹和其中的项目".into());
    }
    Ok(TransferPlan { folder, items })
}

fn active(task: &Task) -> bool {
    matches!(task.status.as_str(), "queued" | "running" | "conflict")
}

fn ensure_mutation_allowed(shared: &Shared, tasks: &HashMap<String, Task>) -> Result<(), String> {
    if shared.installing_update.load(Ordering::Relaxed) {
        return Err("正在安装更新，请在重启后继续文件操作".into());
    }
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
    let mut queue = state.task_queue.lock().unwrap();
    {
        let mut tasks = state.tasks.lock().unwrap();
        ensure_mutation_allowed(&state, &tasks)?;
        if task.kind == "undo" {
            if tasks.values().any(active) {
                return Err("请等文件任务结束后再撤销".into());
            }
            if state.undo.lock().unwrap().is_empty() {
                return Err("当前会话没有可撤销的操作".into());
            }
        }
        task.id = id.clone();
        task.sequence = state.task_sequence.fetch_add(1, Ordering::Relaxed);
        task.status = "queued".into();
        if tasks.len() >= 100 {
            if let Some(oldest) = tasks
                .values()
                .filter(|task| !active(task))
                .min_by_key(|task| task.sequence)
                .map(|task| task.id.clone())
            {
                tasks.remove(&oldest);
                state.task_feed.change(Some(&oldest));
            } else {
                return Err("文件任务队列已满，请等待任务完成".into());
            }
        }
        tasks.insert(id.clone(), task);
        state.task_feed.change(Some(&id));
    }
    queue.pending.push_back((id.clone(), Box::new(work)));
    if !queue.running {
        queue.running = true;
        let worker_state = state.clone();
        std::thread::spawn(move || run_tasks(worker_state, app));
    }
    Ok(id)
}

fn run_tasks(state: Arc<Shared>, app: tauri::AppHandle) {
    loop {
        let (task_id, work) = {
            let mut queue = state.task_queue.lock().unwrap();
            match queue.pending.pop_front() {
                Some(job) => job,
                None => {
                    queue.running = false;
                    return;
                }
            }
        };
        let _mutation = state.mutation.lock().unwrap();
        if !cancelled(&state, &task_id) {
            update(&state, &task_id, |task| task.status = "running".into());
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                work(&state, &task_id, &app)
            }))
            .unwrap_or_else(|_| Err("文件任务意外停止，请检查源和目标位置".into()));
            if let Err(error) = result {
                update(&state, &task_id, |task| task.errors.push(error));
            }
        }
        let mut failure = None;
        update(&state, &task_id, |t| {
            t.conflict = None;
            t.status = if t.cancelled {
                "cancelled"
            } else if let Some(error) = t.errors.first() {
                let path = if t.destination.is_empty() {
                    &t.current
                } else {
                    &t.destination
                };
                failure = Some(Failure::new(
                    "文件任务",
                    &t.kind,
                    Path::new(path),
                    error.clone(),
                ));
                "error"
            } else {
                "done"
            }
            .into()
        });
        if let Some(failure) = failure {
            diagnostics::record(&app, failure);
        }
        let changed = state.tasks.lock().unwrap().get(&task_id).and_then(|task| {
            matches!(task.kind.as_str(), "zip" | "unzip" | "undo").then(|| task.destination.clone())
        });
        if let Some(path) = changed {
            let _ = app.emit("directory-changed", (!path.is_empty()).then_some([path]));
        }
    }
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
    revision: u64,
    tasks: Vec<Task>,
    undo: Option<&'static str>,
}

#[tauri::command]
fn tasks(state: tauri::State<Arc<Shared>>) -> Activity {
    let tasks = state.tasks.lock().unwrap();
    let mut t: Vec<_> = tasks.values().cloned().collect();
    t.sort_by_key(|task| std::cmp::Reverse(task.sequence));
    let undo = state.undo.lock().unwrap().last().map(|entry| entry.label);
    Activity {
        revision: state.task_feed.revision(),
        tasks: t,
        undo,
    }
}

#[tauri::command]
fn clear_task_history(state: tauri::State<Arc<Shared>>) {
    state.tasks.lock().unwrap().retain(|id, task| {
        if active(task) {
            return true;
        }
        state.task_feed.change(Some(id));
        false
    });
}

#[tauri::command]
async fn retry_task(id: String, app: tauri::AppHandle) -> Result<String, String> {
    let task = app
        .state::<Arc<Shared>>()
        .tasks
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .filter(|task| task.status == "error" && !task.failed_sources.is_empty())
        .ok_or("没有可重试的文件项目")?;
    tauri::async_runtime::spawn_blocking(move || {
        let sources = task
            .failed_sources
            .iter()
            .map(|source| source.path.clone())
            .collect();
        prepare_task(
            task.kind.clone(),
            sources,
            task.destination.clone(),
            task.within.clone(),
            Some(&task),
            app,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
fn task_action(
    id: String,
    decision: String,
    apply_all: bool,
    conflict_id: Option<String>,
    state: tauri::State<Arc<Shared>>,
) {
    act_on_task(&state, &id, decision, apply_all, conflict_id);
}

fn act_on_task(
    shared: &Shared,
    id: &str,
    decision: String,
    apply_all: bool,
    conflict_id: Option<String>,
) {
    update(shared, id, |task| {
        if decision == "cancel" && active(task) {
            task.cancelled = true;
        } else if ["replace", "skip", "keep"].contains(&decision.as_str())
            && task.status == "conflict"
            && task.decision.is_none()
            && task.conflict.as_ref().map(|conflict| &conflict.id) == conflict_id.as_ref()
        {
            if apply_all {
                task.policy = Some(decision.clone());
            }
            task.decision = Some(decision);
        }
    });
    shared.task_wake.notify_all();
}

#[tauri::command]
async fn thumbnail(
    path: String,
    application_icon: Option<bool>,
) -> Result<tauri::ipc::Response, String> {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    static SLOTS: [tauri::async_runtime::Mutex<()>; 3] =
        [const { tauri::async_runtime::Mutex::const_new(()) }; 3];
    let slot = NEXT.fetch_add(1, Ordering::Relaxed) % SLOTS.len();
    let _worker = SLOTS[slot].lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&path);
        if application_icon == Some(true) {
            return application_icon::load(path).map(tauri::ipc::Response::new);
        }
        let file = open_regular_file(path, true)?;
        #[cfg(target_os = "macos")]
        if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "pdf" | "heic" | "heif"
                )
            })
        {
            return quick_look_thumbnail(path).map(tauri::ipc::Response::new);
        }
        let mut reader = image::ImageReader::new(BufReader::new(file))
            .with_guessed_format()
            .map_err(|e| e.to_string())?;
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(128 * 1024 * 1024);
        limits.max_image_width = Some(20_000);
        limits.max_image_height = Some(20_000);
        reader.limits(limits);
        let image = reader
            .decode()
            .map_err(|e| e.to_string())?
            .thumbnail(160, 160);
        let mut bytes = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut bytes, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        Ok(tauri::ipc::Response::new(bytes.into_inner()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
fn quick_look_thumbnail(path: &Path) -> Result<Vec<u8>, String> {
    let path = dunce::canonicalize(path).map_err(|error| error.to_string())?;
    let folder = tempfile::tempdir().map_err(|error| error.to_string())?;
    let mut command = Command::new("/usr/bin/qlmanage");
    command
        .args(["-t", "-s", "512", "-o"])
        .arg(folder.path())
        .arg(path);
    let output = system_process::run(command, || false, Some(std::time::Duration::from_secs(6)))
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("系统缩略图不可用".into());
    }
    for entry in fs::read_dir(folder.path()).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().is_ok_and(|kind| kind.is_file())
            && entry.path().extension().is_some_and(|ext| ext == "png")
        {
            return read_limited(&entry.path(), 4 * 1024 * 1024, "系统缩略图过大");
        }
    }
    Err("系统缩略图不可用".into())
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

fn read_preview_text(path: &Path) -> Result<String, String> {
    let bytes = read_limited(
        path,
        2 * 1024 * 1024,
        "文本预览上限为 2 MB，请用默认应用打开",
    )?;
    String::from_utf8(bytes).map_err(|_| "此文件暂不支持文本预览".into())
}
#[tauri::command]
async fn read_preview(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_preview_text(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_image(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_limited(Path::new(&path), 30 * 1024 * 1024, "文件预览上限为 30 MB")
            .map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|error| error.to_string())?
}
fn session_file(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap().join("sessions.json")
}

fn persist_sessions(
    app: &tauri::AppHandle,
    sessions: &HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    persist_json(&session_file(app), sessions)
}

fn persist_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let directory = path.parent().unwrap();
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut temp, value).map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Deserialize, Serialize)]
struct WindowGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

fn save_geometry(window: &tauri::Window, value: &mut serde_json::Value) {
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    if window.is_minimized().unwrap_or(false) || size.width == 0 || size.height == 0 {
        return;
    }
    value["geometry"] = serde_json::json!(WindowGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
    });
}

fn restore_geometry(window: &tauri::WebviewWindow, geometry: serde_json::Value) {
    let Ok(saved) = serde_json::from_value::<WindowGeometry>(geometry) else {
        return;
    };
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    if let Some(monitor) = monitors.iter().find(|monitor| {
        let area = monitor.work_area();
        let dx = i64::from(saved.x) - i64::from(area.position.x);
        let dy = i64::from(saved.y) - i64::from(area.position.y);
        dx >= -100
            && dy >= -100
            && dx < i64::from(area.size.width) - 80
            && dy < i64::from(area.size.height) - 80
    }) {
        let area = monitor.work_area();
        let _ = window.set_size(tauri::PhysicalSize::new(
            saved.width.clamp(320, area.size.width.max(320)),
            saved
                .height
                .clamp(240, area.size.height.max(240).saturating_sub(30).max(240)),
        ));
        let _ = window.set_position(tauri::PhysicalPosition::new(
            saved.x.max(area.position.x),
            saved.y.max(area.position.y),
        ));
        if saved.maximized {
            let _ = window.maximize();
        }
    }
}

#[tauri::command]
fn save_session(
    mut value: serde_json::Value,
    window: tauri::Window,
    state: tauri::State<Arc<Shared>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if app.get_webview_window(window.label()).is_none() {
        return Ok(());
    }
    if !value.is_object() {
        return Err("无效的窗口会话".into());
    }
    save_geometry(&window, &mut value);
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
            } else {
                let mut sessions = state.sessions.lock().unwrap();
                if let Some(session) = sessions.get_mut(window.label()) {
                    save_geometry(window, session);
                    let _ = persist_sessions(app, &sessions);
                }
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
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            if let Some(session) = state.sessions.lock().unwrap().get_mut(window.label()) {
                save_geometry(window, session);
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
        .manage(batch_rename::Plans::default())
        .manage(diagnostics::ErrorLog::default())
        .manage(native_drag::DragState::default())
        .manage(storage::ScanState::default())
        .manage(updates::UpdateState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            handle_window_close(window, event);
            native_drag::handle_window_event(window, event);
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .state::<Arc<Shared>>()
                    .directory_watch
                    .lock()
                    .unwrap()
                    .close(window.label());
                window
                    .state::<storage::ScanState>()
                    .stop_window(window.label());
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            app.state::<Arc<Shared>>().task_feed.start(handle.clone());
            app.state::<Arc<Shared>>()
                .directory_watch
                .lock()
                .unwrap()
                .start(handle.clone());
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
                    let main_geometry = sessions
                        .get("main")
                        .and_then(|session| session.get("geometry"))
                        .cloned();
                    let labels: Vec<_> = sessions
                        .iter()
                        .filter(|(label, _)| label.starts_with("files-"))
                        .map(|(label, session)| (label.clone(), session.get("geometry").cloned()))
                        .collect();
                    *app.state::<Arc<Shared>>().sessions.lock().unwrap() = sessions;
                    if let (Some(window), Some(geometry)) =
                        (app.get_webview_window("main"), main_geometry)
                    {
                        restore_geometry(&window, geometry);
                    }
                    for (label, geometry) in labels {
                        let window = tauri::WebviewWindowBuilder::new(
                            app,
                            &label,
                            tauri::WebviewUrl::App("index.html".into()),
                        )
                        .title("Filepace")
                        .inner_size(1180., 780.)
                        .min_inner_size(780., 520.)
                        .build();
                        if let (Ok(window), Some(geometry)) = (window, geometry) {
                            restore_geometry(&window, geometry);
                        }
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_directory,
            suggest_directories,
            directory_watch::watch_directories,
            diagnostics::error_log,
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
            compare::compare_directories,
            compare::cancel_compare,
            archives::list_archive,
            open_terminal,
            make_directory,
            make_text_file,
            rename_entry,
            batch_rename::preview_batch_rename,
            batch_rename::batch_rename,
            clipboard_set,
            clipboard_get,
            clipboard_copy_paths,
            start_file_drag,
            start_task,
            undo_last,
            updates::update_status,
            updates::check_update,
            updates::install_update,
            tasks,
            clear_task_history,
            retry_task,
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
                let shared = app.state::<Arc<Shared>>();
                if has_active_tasks(&shared) {
                    api.prevent_exit();
                    let _ = app.emit("exit-blocked", ());
                } else {
                    let _ = persist_sessions(app, &shared.sessions.lock().unwrap());
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_keeps_the_original_source_and_destination() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let source = root.join("sample.txt");
        let destination = root.join("compared").join("target");
        fs::create_dir_all(&destination).unwrap();
        fs::write(&source, b"original").unwrap();
        let sources = [strpath(&source)];
        let scope = strpath(destination.parent().unwrap());
        let destination_name = strpath(&destination);
        let plan = plan_transfer("move", &sources, &destination_name, Some(&scope), None).unwrap();
        let failed = Task {
            kind: "move".into(),
            destination: destination_name,
            destination_folder: plan.folder,
            within: Some(scope),
            failed_sources: vec![FailedSource {
                path: sources[0].clone(),
                identity: plan.items[0].0.identity().clone(),
            }],
            ..Default::default()
        };
        let retry = || {
            plan_transfer(
                &failed.kind,
                &sources,
                &failed.destination,
                failed.within.as_deref(),
                Some(&failed),
            )
        };
        assert!(retry().is_ok());

        let original_folder = root.join("original-target");
        fs::rename(&destination, &original_folder).unwrap();
        fs::create_dir(&destination).unwrap();
        assert!(retry().is_err());
        assert!(!destination.join("sample.txt").exists());
        fs::remove_dir(&destination).unwrap();
        fs::rename(&original_folder, &destination).unwrap();

        let original_file = root.join("original.txt");
        fs::rename(&source, &original_file).unwrap();
        fs::write(&source, b"replacement").unwrap();
        assert!(retry().is_err());
        assert_eq!(fs::read(&source).unwrap(), b"replacement");
        assert_eq!(fs::read(&original_file).unwrap(), b"original");
    }
    #[test]
    fn rejects_unsafe_names() {
        for name in ["", "..", "a/b", "a\\b"] {
            assert!(valid_name(name).is_err())
        }
        assert!(valid_name("新文件夹").is_ok());
    }
    #[test]
    fn creates_empty_text_files_and_preserves_existing_entries() {
        let directory = tempfile::tempdir().unwrap();
        let parent = strpath(directory.path());
        let notes = directory.path().join("会议记录.txt");

        create_text_file(&parent, "会议记录").unwrap();
        assert!(fs::read(&notes).unwrap().is_empty());
        create_text_file(&parent, "Draft.TXT").unwrap();
        assert!(fs::read(directory.path().join("Draft.TXT"))
            .unwrap()
            .is_empty());

        fs::write(&notes, b"existing contents").unwrap();
        assert_eq!(
            create_text_file(&parent, "会议记录.txt").unwrap_err(),
            "同名项目已存在，请换个名称"
        );
        assert_eq!(fs::read(&notes).unwrap(), b"existing contents");
        assert!(create_text_file(&parent, "../outside").is_err());
        assert!(create_text_file(&strpath(&notes), "nested").is_err());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
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
    #[cfg(windows)]
    #[test]
    fn lists_an_existing_file_with_a_reserved_device_name() {
        let dir = tempfile::tempdir().unwrap();
        let reserved = dir.path().canonicalize().unwrap().join("NUL");
        fs::write(&reserved, b"on-disk file").unwrap();
        fs::write(dir.path().join("ordinary.txt"), b"ordinary file").unwrap();

        let listing = read_directory(dir.path());
        fs::remove_file(&reserved).unwrap();
        let (_, entries) = listing.unwrap();
        assert_eq!(entries.len(), 2);
        let entry = entries.iter().find(|entry| entry.name == "NUL").unwrap();
        assert_eq!(entry.size, 12);
        assert!(!entry.is_dir && !entry.is_link);
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
        assert!(read_preview_text(&pipe).is_err());
        assert!(read_limited(&pipe, 1024, "limit").is_err());
        assert!(open_regular_file(&pipe, true).is_err());
        assert!(pipe.exists());
        assert!(!destination.exists());
    }
    #[test]
    fn conflict_snapshot_reports_file_metadata_and_labels_directories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("example.txt");
        fs::write(&path, b"example").unwrap();
        let time = 1_700_000_000;
        filetime::set_file_mtime(&path, filetime::FileTime::from_unix_time(time, 0)).unwrap();

        let item = ConflictItem::at(&path);
        assert_eq!(item.path, strpath(&path));
        assert_eq!(item.size, Some(7));
        assert_eq!(item.modified, Some(time));
        assert!(!item.is_dir);

        let folder = ConflictItem::at(dir.path());
        assert!(folder.is_dir);
        assert!(folder.modified.is_some());
        assert_eq!(folder.size, None);

        let missing = ConflictItem::at(&dir.path().join("missing.txt"));
        assert_eq!(missing.size, None);
        assert_eq!(missing.modified, None);
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
