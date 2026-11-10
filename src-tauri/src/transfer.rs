use std::{
    fs::{self, Metadata},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
};

use crate::{
    cancelled,
    fs_safety::{is_link, rename_exclusive, Directory, Identity, Snapshot},
    open_regular_file, resolve_conflict, strpath,
    undo::Change,
    update, Shared,
};

pub(crate) struct Source {
    pub(crate) path: PathBuf,
    parent: Directory,
    snapshot: Snapshot,
    metadata: Metadata,
}

impl Source {
    pub(crate) fn identity(&self) -> &Identity {
        &self.snapshot.identity
    }

    pub(crate) fn at(path: PathBuf) -> Result<Self, String> {
        let parent = Directory::parent(&path).map_err(|error| error.to_string())?;
        let metadata = path.symlink_metadata().map_err(|error| error.to_string())?;
        let snapshot = Snapshot::at(&path, &metadata).map_err(|error| error.to_string())?;
        Ok(Self {
            path,
            parent,
            snapshot,
            metadata,
        })
    }

    pub(crate) fn check(&self) -> Result<(), String> {
        self.parent.check()?;
        if self.snapshot.matches(&self.path) {
            Ok(())
        } else {
            Err(format!("源项目已变更：{}", self.path.display()))
        }
    }

    fn check_transferable(&self) -> Result<(), String> {
        self.check()?;
        if is_link(&self.metadata) {
            return Err(format!("暂不传输链接：{}", self.path.display()));
        }
        Ok(())
    }

    fn remove(&self) -> Result<(), String> {
        if self.metadata.is_dir() {
            self.parent.check()?;
            if Identity::at(&self.path).as_ref().ok() != Some(&self.snapshot.identity) {
                return Err(format!("源文件夹已变更：{}", self.path.display()));
            }
            fs::remove_dir(&self.path)
        } else {
            self.check()?;
            fs::remove_file(&self.path)
        }
        .map_err(|error| format!("目标已提交，无法移除源项目：{error}"))
    }
}

// Keep the old item in a private sibling directory until the staged item
// commits. A failed rollback leaves the old item at the reported backup path.
pub(crate) fn commit_staged(
    stage: &Path,
    target: &Path,
    parent: &Directory,
    replace: Option<&Snapshot>,
    shared: &Shared,
    id: &str,
) -> Result<(), String> {
    parent.check()?;
    if cancelled(shared, id) {
        return Err("任务已取消".into());
    }
    let Some(expected) = replace else {
        return rename_exclusive(stage, target).map_err(|error| error.to_string());
    };
    stage
        .symlink_metadata()
        .map_err(|error| error.to_string())?;
    if !expected.matches(target) {
        return Err("目标在确认期间已变更，请重试".into());
    }
    let backup_dir = tempfile::Builder::new()
        .prefix(".filepace-replaced-")
        .tempdir_in(&parent.path)
        .map_err(|error| error.to_string())?;
    let backup = backup_dir
        .path()
        .join(target.file_name().ok_or("目标名称无效")?);
    parent.check()?;
    if !expected.matches(target) {
        return Err("目标在确认期间已变更，请重试".into());
    }
    rename_exclusive(target, &backup).map_err(|error| error.to_string())?;
    let backup_dir = backup_dir.keep();
    let result = parent.check().and_then(|()| {
        if !expected.matches_after_rename(&backup) {
            return Err("目标在替换期间已变更".into());
        }
        rename_exclusive(stage, target).map_err(|error| error.to_string())
    });
    if let Err(error) = result {
        if parent.check().is_ok() && rename_exclusive(&backup, target).is_ok() {
            let _ = fs::remove_dir(&backup_dir);
            return Err(format!("无法提交目标，已恢复原目标：{error}"));
        }
        return Err(format!(
            "无法提交目标。原目标保存在 {}：{error}",
            backup.display()
        ));
    }
    match trash::delete(&backup) {
        Ok(()) => {
            let _ = fs::remove_dir(backup_dir);
        }
        Err(error) => update(shared, id, |task| {
            task.errors.push(format!(
                "目标已提交。旧目标保存在 {}：{error}",
                backup.display()
            ));
        }),
    }
    Ok(())
}

pub(crate) struct Transfer<'a> {
    shared: &'a Shared,
    id: &'a str,
    moving: bool,
    buffer: Vec<u8>,
    pub(crate) journal: Vec<Change>,
}

impl<'a> Transfer<'a> {
    pub(crate) fn new(shared: &'a Shared, id: &'a str, moving: bool) -> Self {
        Self {
            shared,
            id,
            moving,
            buffer: Vec::new(),
            journal: Vec::new(),
        }
    }

    fn check_cancelled(&self) -> Result<(), String> {
        if cancelled(self.shared, self.id) {
            Err("任务已取消".into())
        } else {
            Ok(())
        }
    }

    pub(crate) fn run(
        &mut self,
        source: &Source,
        target: &Path,
        parent: &Directory,
    ) -> Result<bool, String> {
        self.check_cancelled()?;
        source.check_transferable()?;
        parent.check()?;
        update(self.shared, self.id, |task| {
            task.current = strpath(&source.path)
        });

        if source.metadata.is_dir() {
            match Directory::at(target) {
                Ok(directory) => return self.merge(source, &directory),
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) if error.kind() == ErrorKind::Other => {}
                Err(error) => return Err(error.to_string()),
            }
        }

        let Some((target, replace)) =
            resolve_conflict(self.shared, self.id, Some(&source.path), target.to_owned())?
        else {
            return Ok(false);
        };
        source.check()?;
        parent.check()?;
        self.check_cancelled()?;
        if self.moving && replace.is_none() {
            match rename_exclusive(&source.path, &target) {
                Ok(()) => {
                    self.journal.push(Change::Moved {
                        from: source.path.clone(),
                        to: target,
                        identity: source.snapshot.identity.clone(),
                    });
                    update(self.shared, self.id, |task| task.completed += 1);
                    return Ok(true);
                }
                Err(error) if error.kind() == ErrorKind::CrossesDevices => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        self.stage(source, &target, parent, replace.as_ref())?;
        Ok(true)
    }

    fn merge(&mut self, source: &Source, target: &Directory) -> Result<bool, String> {
        let source_directory = Directory::at(&source.path).map_err(|error| error.to_string())?;
        source.check()?;
        let mut all = true;
        for entry in fs::read_dir(&source.path).map_err(|error| error.to_string())? {
            self.check_cancelled()?;
            source_directory.check()?;
            let entry = entry.map_err(|error| error.to_string())?;
            let result = Source::at(entry.path())
                .and_then(|child| self.run(&child, &target.path.join(entry.file_name()), target));
            match result {
                Ok(copied) => all &= copied,
                Err(error) => {
                    all = false;
                    update(self.shared, self.id, |task| {
                        task.errors
                            .push(format!("{}: {error}", entry.path().display()))
                    });
                }
            }
        }
        if self.moving && all {
            source.remove()?;
            self.journal
                .push(Change::RemovedDirectory(source.path.clone()));
        }
        Ok(all)
    }

    pub(crate) fn stage(
        &mut self,
        source: &Source,
        target: &Path,
        parent: &Directory,
        replace: Option<&Snapshot>,
    ) -> Result<(), String> {
        self.check_cancelled()?;
        source.check_transferable()?;
        parent.check()?;
        let temporary = tempfile::Builder::new()
            .prefix(".filepace-stage-")
            .tempdir_in(&parent.path)
            .map_err(|error| error.to_string())?;
        let payload = temporary.path().join("item");
        if !source.metadata.is_dir() {
            self.copy_file(source, &payload)?;
            source.check()?;
            let staged = snapshot_at(&payload)?;
            update(self.shared, self.id, |task| task.phase = "提交目标".into());
            commit_staged(&payload, target, parent, replace, self.shared, self.id)?;
            if self.moving {
                if !staged.matches_after_rename(target) {
                    return Err("目标在提交后已变更，保留源项目".into());
                }
                source.remove()?;
                self.journal.push(Change::Moved {
                    from: source.path.clone(),
                    to: target.to_owned(),
                    identity: staged.identity,
                });
            }
            update(self.shared, self.id, |task| task.completed += 1);
            return Ok(());
        }

        let mut children = Vec::new();
        update(self.shared, self.id, |task| {
            task.phase = "扫描文件夹".into()
        });
        for entry in walkdir::WalkDir::new(&source.path)
            .follow_links(false)
            .min_depth(1)
        {
            self.check_cancelled()?;
            let entry = entry.map_err(|error| error.to_string())?;
            let relative = entry
                .path()
                .strip_prefix(&source.path)
                .map_err(|error| error.to_string())?;
            children.push((Source::at(entry.path().to_owned())?, relative.to_owned()));
        }
        source.check()?;
        fs::create_dir(&payload).map_err(|error| error.to_string())?;
        for (child, relative) in &children {
            self.check_cancelled()?;
            child.check_transferable()?;
            update(self.shared, self.id, |task| {
                task.current = strpath(&child.path)
            });
            let staged = payload.join(relative);
            if child.metadata.is_dir() {
                fs::create_dir(staged).map_err(|error| error.to_string())?;
            } else {
                self.copy_file(child, &staged)?;
            }
        }
        for (child, relative) in children.iter().rev() {
            child.check()?;
            if child.metadata.is_dir() {
                preserve_metadata(child, &payload.join(relative))?;
            }
        }
        preserve_metadata(source, &payload)?;
        source.check()?;

        let mut committed = Vec::new();
        if self.moving {
            for (_, relative) in &children {
                committed.push(snapshot_at(&payload.join(relative))?);
            }
        }
        let root_identity = Identity::at(&payload).map_err(|error| error.to_string())?;
        update(self.shared, self.id, |task| task.phase = "提交目标".into());
        commit_staged(&payload, target, parent, replace, self.shared, self.id)?;
        update(self.shared, self.id, |task| {
            task.completed += children.len() as u64 + 1
        });
        if !self.moving {
            return Ok(());
        }
        self.journal.push(Change::MadeDirectory {
            path: target.to_owned(),
            identity: root_identity,
        });
        for ((child, relative), identity) in children.iter().zip(&committed) {
            if child.metadata.is_dir() {
                self.journal.push(Change::MadeDirectory {
                    path: target.join(relative),
                    identity: identity.identity.clone(),
                });
            }
        }
        for ((child, relative), identity) in children.into_iter().zip(committed).rev() {
            self.check_cancelled()?;
            let to = target.join(relative);
            if !identity.matches_after_rename(&to) {
                return Err(format!("目标已变更，保留剩余源项目：{}", to.display()));
            }
            child.remove()?;
            self.journal.push(if child.metadata.is_dir() {
                Change::RemovedDirectory(child.path)
            } else {
                Change::Moved {
                    from: child.path,
                    to,
                    identity: identity.identity,
                }
            });
        }
        source.remove()?;
        self.journal
            .push(Change::RemovedDirectory(source.path.clone()));
        Ok(())
    }

    fn copy_file(&mut self, source: &Source, path: &Path) -> Result<(), String> {
        let mut input = open_regular_file(&source.path, false)?;
        let metadata = input.metadata().map_err(|error| error.to_string())?;
        let opened = Snapshot::from_file(&input, &metadata).map_err(|error| error.to_string())?;
        if opened != source.snapshot {
            return Err(format!("源项目已变更：{}", source.path.display()));
        }
        let mut output = fs::File::create_new(path).map_err(|error| error.to_string())?;
        update(self.shared, self.id, |task| {
            task.phase = "写入暂存文件".into()
        });
        if self.buffer.is_empty() {
            self.buffer.resize(1024 * 1024, 0);
        }
        loop {
            self.check_cancelled()?;
            let size = input
                .read(&mut self.buffer)
                .map_err(|error| error.to_string())?;
            if size == 0 {
                break;
            }
            output
                .write_all(&self.buffer[..size])
                .map_err(|error| error.to_string())?;
            update(self.shared, self.id, |task| task.bytes += size as u64);
        }
        source.check()?;
        preserve_metadata(source, path)?;
        output.sync_all().map_err(|error| error.to_string())
    }
}

fn snapshot_at(path: &Path) -> Result<Snapshot, String> {
    path.symlink_metadata()
        .and_then(|metadata| Snapshot::at(path, &metadata))
        .map_err(|error| error.to_string())
}

fn preserve_metadata(source: &Source, path: &Path) -> Result<(), String> {
    let metadata = &source.metadata;
    filetime::set_file_times(
        path,
        filetime::FileTime::from_last_access_time(metadata),
        filetime::FileTime::from_last_modification_time(metadata),
    )
    .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let from =
            CString::new(source.path.as_os_str().as_bytes()).map_err(|error| error.to_string())?;
        let to = CString::new(path.as_os_str().as_bytes()).map_err(|error| error.to_string())?;
        let flags = libc::COPYFILE_ACL | libc::COPYFILE_XATTR | libc::COPYFILE_NOFOLLOW;
        if unsafe { libc::copyfile(from.as_ptr(), to.as_ptr(), std::ptr::null_mut(), flags) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    for name in xattr::list(&source.path).map_err(|error| error.to_string())? {
        if let Some(value) = xattr::get(&source.path, &name).map_err(|error| error.to_string())? {
            xattr::set(path, &name, &value).map_err(|error| error.to_string())?;
        }
    }
    fs::set_permissions(path, metadata.permissions()).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{act_on_task, Task};
    use std::time::{Duration, Instant};

    fn setup() -> (tempfile::TempDir, Shared) {
        let state = Shared::default();
        state
            .tasks
            .lock()
            .unwrap()
            .insert("task".into(), Task::default());
        (tempfile::tempdir().unwrap(), state)
    }

    #[test]
    fn refuses_a_replaced_source_during_conflict() {
        let (fixture, state) = setup();
        let source_path = fixture.path().join("source.txt");
        let original = fixture.path().join("original.txt");
        let target = fixture.path().join("target.txt");
        fs::write(&source_path, b"selected").unwrap();
        fs::write(&target, b"existing").unwrap();
        let source = Source::at(source_path.clone()).unwrap();
        let parent = Directory::parent(&target).unwrap();
        std::thread::scope(|scope| {
            let worker =
                scope.spawn(|| Transfer::new(&state, "task", true).run(&source, &target, &parent));
            let limit = Instant::now() + Duration::from_secs(3);
            let conflict = loop {
                if let Some(conflict) = state.tasks.lock().unwrap()["task"].conflict.clone() {
                    break conflict.id;
                }
                if Instant::now() >= limit {
                    act_on_task(&state, "task", "cancel".into(), false, None);
                    // Also unblock a worker which reaches the conflict after the deadline.
                    update(&state, "task", |task| task.cancelled = true);
                    state.task_wake.notify_all();
                    panic!("the transfer did not reach the conflict");
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            let swap = fs::rename(&source_path, &original)
                .and_then(|()| fs::write(&source_path, b"different file"));
            act_on_task(&state, "task", "replace".into(), true, Some("stale".into()));
            act_on_task(&state, "task", "keep".into(), false, Some(conflict));
            swap.unwrap();
            assert!(worker.join().unwrap().unwrap_err().contains("源项目已变更"));
        });
        assert_eq!(fs::read(original).unwrap(), b"selected");
        assert_eq!(fs::read(source_path).unwrap(), b"different file");
        assert_eq!(fs::read(target).unwrap(), b"existing");
        assert!(!fixture.path().join("target (2).txt").exists());
        assert!(state.tasks.lock().unwrap()["task"].policy.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn same_volume_move_preserves_directory_metadata_and_hard_links() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let (fixture, state) = setup();
        let original = fixture.path().join("original");
        let target = fixture.path().join("target");
        fs::create_dir(&original).unwrap();
        fs::write(original.join("file"), b"contents").unwrap();
        let alias = fixture.path().join("alias");
        fs::hard_link(original.join("file"), &alias).unwrap();
        fs::set_permissions(&original, fs::Permissions::from_mode(0o700)).unwrap();
        let mtime = filetime::FileTime::from_unix_time(1_600_000_000, 0);
        filetime::set_file_mtime(&original, mtime).unwrap();
        let source = Source::at(original.clone()).unwrap();
        let parent = Directory::parent(&target).unwrap();
        assert!(Transfer::new(&state, "task", true)
            .run(&source, &target, &parent)
            .unwrap());
        assert!(!original.exists());
        assert_eq!(fs::read(target.join("file")).unwrap(), b"contents");
        assert_eq!(
            fs::metadata(&alias).unwrap().ino(),
            fs::metadata(target.join("file")).unwrap().ino()
        );
        assert_eq!(fs::metadata(&target).unwrap().mode() & 0o777, 0o700);
        assert_eq!(
            filetime::FileTime::from_last_modification_time(&fs::metadata(target).unwrap()),
            mtime
        );
    }

    #[cfg(unix)]
    #[test]
    fn replacement_keeps_the_original_target_if_staging_fails() {
        let (fixture, state) = setup();
        let original = fixture.path().join("original");
        let target = fixture.path().join("target");
        fs::create_dir(&original).unwrap();
        fs::write(original.join("file"), b"source").unwrap();
        std::os::unix::fs::symlink(original.join("file"), original.join("link")).unwrap();
        fs::write(&target, b"old target").unwrap();
        update(&state, "task", |task| task.policy = Some("replace".into()));
        let source = Source::at(original.clone()).unwrap();
        let parent = Directory::parent(&target).unwrap();
        assert!(Transfer::new(&state, "task", true)
            .run(&source, &target, &parent)
            .is_err());
        assert_eq!(fs::read(original.join("file")).unwrap(), b"source");
        assert_eq!(fs::read(target).unwrap(), b"old target");
        assert_eq!(fs::read_dir(fixture.path()).unwrap().count(), 2);
    }
}
