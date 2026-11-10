use std::{
    fs::{self, OpenOptions},
    io::{BufReader, Read, Seek, Write},
    path::{Path, PathBuf},
    process::Command,
};

use tauri::AppHandle;
use walkdir::WalkDir;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::{
    cancelled, enqueue_task,
    fs_safety::{check_ancestors, entry_path, is_link, rename_exclusive},
    open_regular_file, resolve_conflict, strpath, system_process, trash_existing, update,
    valid_name, Shared, Task,
};

const MAX_ENTRIES: usize = 250_000;

pub(crate) fn start(kind: String, sources: Vec<String>, app: AppHandle) -> Result<String, String> {
    let paths = sources
        .iter()
        .map(|path| entry_path(Path::new(path)))
        .collect::<Result<Vec<_>, _>>()?;
    let parent = paths
        .first()
        .and_then(|path| path.parent())
        .ok_or("请选择文件或文件夹")?
        .to_path_buf();
    if paths.iter().any(|path| path.parent() != Some(&parent)) {
        return Err("请选择同一个文件夹中的项目".into());
    }
    let unpack = kind == "unzip";
    let first = &paths[0];
    let name = first.file_name().ok_or("文件名无效")?.to_string_lossy();
    let stem = first.file_stem().ok_or("文件名无效")?.to_string_lossy();
    let target = if unpack {
        if paths.len() != 1
            || !first
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
        {
            return Err("请选择一个 ZIP 压缩包".into());
        }
        stem.into_owned()
    } else if paths.len() > 1 {
        "归档.zip".into()
    } else if first.is_dir()
        || first
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
    {
        format!("{name}.zip")
    } else {
        format!("{stem}.zip")
    };
    valid_name(&target)?;
    let target = parent.join(target);
    if paths.contains(&target)
        || dunce::canonicalize(&target).is_ok_and(|resolved| {
            paths
                .iter()
                .any(|path| dunce::canonicalize(path).is_ok_and(|path| path == resolved))
        })
    {
        return Err("压缩包或解压目录不能与源项目同名".into());
    }
    enqueue_task(
        app,
        Task {
            kind,
            sources,
            destination: strpath(&parent),
            ..Default::default()
        },
        move |state, id, _| {
            if unpack {
                extract(&paths[0], target, state, id)
            } else {
                compress(&paths, &parent, target, state, id)
            }
        },
    )
}

fn check_cancelled(state: &Shared, id: &str) -> Result<(), String> {
    if cancelled(state, id) {
        Err("任务已取消".into())
    } else {
        Ok(())
    }
}

fn transfer(
    mut input: impl Read,
    mut output: impl Write,
    expected: u64,
    state: &Shared,
    id: &str,
) -> Result<(), String> {
    let mut remaining = expected;
    let mut buffer = vec![0; 256 * 1024];
    loop {
        check_cancelled(state, id)?;
        let count = input.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            return if remaining == 0 {
                Ok(())
            } else {
                Err("文件大小与记录不符".into())
            };
        }
        remaining = remaining
            .checked_sub(count as u64)
            .ok_or("文件大小超过记录")?;
        output
            .write_all(&buffer[..count])
            .map_err(|error| error.to_string())?;
        update(state, id, |task| task.bytes += count as u64);
    }
}

#[cfg(target_os = "macos")]
fn native_compressor() -> Option<Command> {
    Some(Command::new("/usr/bin/tar"))
}

#[cfg(windows)]
fn native_compressor() -> Option<Command> {
    let tar = system_process::system_directory()?.join("tar.exe");
    tar.is_file().then(|| Command::new(tar))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn native_compressor() -> Option<Command> {
    None
}

fn zip_path(name: &str) -> Result<PathBuf, String> {
    let name = name.strip_suffix('/').unwrap_or(name);
    let mut path = PathBuf::new();
    for component in name.split('/') {
        valid_name(component)?;
        if component.as_bytes().get(1) == Some(&b':') {
            return Err("压缩包路径包含驱动器名称".into());
        }
        path.push(component);
    }
    Ok(path)
}

fn zip_name(path: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for part in path.components() {
        let name = part.as_os_str().to_str().ok_or("文件名无法写入 ZIP")?;
        valid_name(name)?;
        parts.push(name);
    }
    let name = parts.join("/");
    zip_path(&name)?;
    Ok(name)
}

fn validate_zip<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    state: &Shared,
    id: &str,
    expected: Option<&std::collections::HashSet<&str>>,
) -> Result<u64, String> {
    if archive.len() > MAX_ENTRIES || archive.has_duplicate_names() {
        return Err("ZIP 中的项目过多或存在重复名称".into());
    }
    if expected.is_some_and(|names| names.len() != archive.len()) {
        return Err("压缩包的项目数量与选择不一致".into());
    }
    let mut bytes = 0u64;
    for index in 0..archive.len() {
        check_cancelled(state, id)?;
        let item = archive
            .by_index_data(index)
            .map_err(|error| error.to_string())?;
        let name = item.name().map_err(|error| error.to_string())?;
        zip_path(&name)?;
        if expected.is_some_and(|names| !names.contains(name.trim_end_matches('/'))) {
            return Err(format!("压缩后的文件名与源文件不一致：{name}"));
        }
        if item.enclosed_name().is_none()
            || item.is_symlink()
            || item
                .unix_mode()
                .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o040000 | 0o100000))
        {
            return Err(format!("ZIP 内有不支持的链接、特殊文件或路径：{name}"));
        }
        bytes = bytes.checked_add(item.size()).ok_or("解压大小超出范围")?;
    }
    Ok(bytes)
}

fn archive_items(
    paths: &[PathBuf],
    parent: &Path,
    state: &Shared,
    id: &str,
) -> Result<Vec<(PathBuf, String)>, String> {
    let mut items = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for root in paths {
        for entry in WalkDir::new(root)
            .follow_links(false)
            .follow_root_links(false)
        {
            check_cancelled(state, id)?;
            let entry = entry.map_err(|error| error.to_string())?;
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            if is_link(&metadata) || !(metadata.is_file() || metadata.is_dir()) {
                return Err(format!(
                    "ZIP 暂不支持链接或特殊文件：{}",
                    entry.path().display()
                ));
            }
            let relative = entry
                .path()
                .strip_prefix(parent)
                .map_err(|error| error.to_string())?;
            let name = zip_name(relative)?;
            if !seen.insert(name.clone()) {
                return Err(format!("重复选择了项目：{name}"));
            }
            if items.len() == MAX_ENTRIES {
                return Err("选择的项目过多，请分批压缩".into());
            }
            items.push((entry.into_path(), name));
        }
    }
    Ok(items)
}

fn compress(
    paths: &[PathBuf],
    parent: &Path,
    target: PathBuf,
    state: &Shared,
    id: &str,
) -> Result<(), String> {
    let Some((target, replace)) = resolve_conflict(state, id, target)? else {
        return Ok(());
    };
    check_ancestors(&target).map_err(|error| error.to_string())?;
    let items = archive_items(paths, parent, state, id)?;
    let expected = items.iter().map(|(_, name)| name.as_str()).collect();
    update(state, id, |task| task.current = strpath(&paths[0]));
    let mut stage = tempfile::Builder::new()
        .prefix(".filepace-")
        .suffix(".partial")
        .tempfile_in(parent)
        .map_err(|error| error.to_string())?;
    // A NUL-separated manifest supplies the paths already validated above.
    // System tar provides the ZIP codec on both desktop platforms.
    let mut native = false;
    if let Some(mut command) = native_compressor() {
        let mut manifest = tempfile::NamedTempFile::new().map_err(|error| error.to_string())?;
        for (_, name) in &items {
            manifest
                .write_all(name.as_bytes())
                .and_then(|_| manifest.write_all(&[0]))
                .map_err(|error| error.to_string())?;
        }
        command
            .args(["-cf"])
            .arg(stage.path())
            .args(["--format", "zip", "--no-recursion", "--null", "-T"])
            .arg(manifest.path())
            .current_dir(parent)
            .env("COPYFILE_DISABLE", "1");
        if system_process::run(command, || cancelled(state, id), None)
            .is_ok_and(|output| output.status.success())
        {
            native = stage
                .reopen()
                .ok()
                .and_then(|file| ZipArchive::new(BufReader::new(file)).ok())
                .is_some_and(|mut zip| validate_zip(&mut zip, state, id, Some(&expected)).is_ok());
        }
        check_cancelled(state, id)?;
    }
    if !native {
        stage
            .as_file()
            .set_len(0)
            .map_err(|error| error.to_string())?;
        let mut zip = ZipWriter::new(stage.as_file_mut());
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .large_file(true);
        for (path, name) in &items {
            check_cancelled(state, id)?;
            update(state, id, |task| task.current = strpath(path));
            let metadata = path.symlink_metadata().map_err(|error| error.to_string())?;
            check_ancestors(path).map_err(|error| error.to_string())?;
            if metadata.is_dir() && !is_link(&metadata) {
                zip.add_directory(name, options)
                    .map_err(|error| error.to_string())?;
            } else {
                let input = open_regular_file(path, false)?;
                let size = input.metadata().map_err(|error| error.to_string())?.len();
                zip.start_file(name, options)
                    .map_err(|error| error.to_string())?;
                transfer(input, &mut zip, size, state, id)?;
            }
        }
        zip.finish().map_err(|error| error.to_string())?;
    }
    stage
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    if !native {
        let file = stage.reopen().map_err(|error| error.to_string())?;
        let mut archive =
            ZipArchive::new(BufReader::new(file)).map_err(|error| error.to_string())?;
        validate_zip(&mut archive, state, id, Some(&expected))?;
    }
    check_cancelled(state, id)?;
    check_ancestors(&target).map_err(|error| error.to_string())?;
    if let Some(identity) = &replace {
        trash_existing(&target, identity)?;
    }
    let output = stage
        .persist_noclobber(&target)
        .map_err(|error| error.to_string())?;
    let size = output.metadata().map(|meta| meta.len()).unwrap_or_default();
    update(state, id, |task| {
        task.completed = items.len() as u64;
        if native {
            task.bytes = size;
        }
    });
    Ok(())
}

fn extract(src: &Path, target: PathBuf, state: &Shared, id: &str) -> Result<(), String> {
    let Some((target, replace)) = resolve_conflict(state, id, target)? else {
        return Ok(());
    };
    check_ancestors(&target).map_err(|error| error.to_string())?;
    let parent = target.parent().ok_or("解压位置无效")?;
    let input = open_regular_file(src, false)?;
    let mut archive = ZipArchive::new(BufReader::new(input)).map_err(|error| error.to_string())?;
    let size = validate_zip(&mut archive, state, id, None)?;
    if free_space(parent).is_some_and(|available| available < size) {
        return Err("可用空间不足，无法解压".into());
    }
    let stage = tempfile::Builder::new()
        .prefix(".filepace-")
        .tempdir_in(parent)
        .map_err(|error| error.to_string())?;
    for index in 0..archive.len() {
        check_cancelled(state, id)?;
        let item = archive.by_index(index).map_err(|error| error.to_string())?;
        let name = item.name().map_err(|error| error.to_string())?.into_owned();
        let path = stage.path().join(zip_path(&name)?);
        update(state, id, |task| task.current = name);
        if item.is_dir() {
            fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        } else {
            fs::create_dir_all(path.parent().ok_or("ZIP 内路径无效")?)
                .map_err(|error| error.to_string())?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|error| error.to_string())?;
            let size = item.size();
            transfer(item, &mut file, size, state, id)?;
            file.sync_all().map_err(|error| error.to_string())?;
        }
        update(state, id, |task| task.completed += 1);
    }
    check_cancelled(state, id)?;
    check_ancestors(&target).map_err(|error| error.to_string())?;
    if let Some(identity) = &replace {
        trash_existing(&target, identity)?;
    }
    rename_exclusive(stage.path(), &target).map_err(|error| error.to_string())?;
    let _ = stage.keep();
    Ok(())
}

#[cfg(unix)]
fn free_space(path: &Path) -> Option<u64> {
    use std::{ffi::CString, mem::MaybeUninit, os::unix::ffi::OsStrExt};
    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats = MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return None;
    }
    let stats = unsafe { stats.assume_init() };
    Some((stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64))
}

#[cfg(windows)]
fn free_space(path: &Path) -> Option<u64> {
    use std::{os::windows::ffi::OsStrExt, ptr::null_mut};
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let path: Vec<_> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut available = 0;
    (unsafe { GetDiskFreeSpaceExW(path.as_ptr(), &mut available, null_mut(), null_mut()) } != 0)
        .then_some(available)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip_round_trip_preserves_names_bytes_and_empty_folders() {
        let fixture = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(fixture.path()).unwrap();
        let original = root.join("文件夹");
        fs::create_dir_all(original.join("空目录")).unwrap();
        let original_data = vec![0x42; 16384];
        fs::write(original.join("一份文件.txt"), &original_data).unwrap();
        let archive = root.join("文件夹.zip");
        let extracted = root.join("解压后");
        let state = Shared::default();
        state
            .tasks
            .lock()
            .unwrap()
            .insert("task".into(), Task::default());
        compress(&[original.clone()], &root, archive.clone(), &state, "task").unwrap();
        extract(&archive, extracted.clone(), &state, "task").unwrap();
        assert!(extracted.join("文件夹/空目录").is_dir());
        assert_eq!(
            fs::read(extracted.join("文件夹/一份文件.txt")).unwrap(),
            original_data
        );
        assert_eq!(
            fs::read(original.join("一份文件.txt")).unwrap(),
            original_data
        );
        assert!(archive.exists());
    }

    #[test]
    fn rejects_unsafe_paths_and_leaves_existing_destination_untouched() {
        for path in [
            "../outside.txt",
            "/root.txt",
            "C:/root.txt",
            "a/../b",
            "a\\b",
            "a//b",
        ] {
            assert!(zip_path(path).is_err(), "accepted {path}");
        }
        let fixture = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(fixture.path()).unwrap();
        let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .start_file("XX/escape.txt", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"danger").unwrap();
        let mut bytes = writer.finish().unwrap().into_inner();
        for index in 0..bytes.len() - 13 {
            if &bytes[index..index + 13] == b"XX/escape.txt" {
                bytes[index..index + 2].copy_from_slice(b"..");
            }
        }
        let archive = root.join("bad.zip");
        fs::write(&archive, bytes).unwrap();
        let target = root.join("target");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep.txt"), b"keep").unwrap();
        let state = Shared::default();
        state.tasks.lock().unwrap().insert(
            "task".into(),
            Task {
                policy: Some("replace".into()),
                ..Default::default()
            },
        );
        assert!(extract(&archive, target.clone(), &state, "task").is_err());
        assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"keep");
        assert!(!root.join("escape.txt").exists());
        assert_eq!(fs::read_dir(root).unwrap().count(), 2);
    }
}
