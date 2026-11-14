//! Cooperative task scheduling. A paused transfer releases the mutation guard
//! only at explicit checkpoints, then services runnable queued work. Commit,
//! replacement rollback and source cleanup never yield halfway through.
use std::sync::{Arc, MutexGuard};

use tauri::{AppHandle, Emitter};

use crate::{cancelled, diagnostics, update, Failure, Shared, TaskQueue, TaskWork};

pub(crate) struct TaskExecution<'a> {
    shared: &'a Arc<Shared>,
    pub(crate) app: Option<&'a AppHandle>,
    mutation: Option<MutexGuard<'a, ()>>,
    emitted: usize,
}

impl<'a> TaskExecution<'a> {
    fn new(shared: &'a Arc<Shared>, app: Option<&'a AppHandle>) -> Self {
        Self {
            shared,
            app,
            mutation: Some(shared.mutation.lock().unwrap()),
            emitted: 0,
        }
    }

    fn publish(&mut self, id: &str) {
        let changes = self
            .shared
            .tasks
            .lock()
            .unwrap()
            .get(id)
            .map(|task| {
                let changes =
                    task.file_changes[self.emitted.min(task.file_changes.len())..].to_vec();
                self.emitted = task.file_changes.len();
                changes
            })
            .unwrap_or_default();
        if !changes.is_empty() {
            if let Some(app) = self.app {
                let _ = app.emit("files-mutated", changes);
            }
        }
    }

    pub(crate) fn checkpoint(&mut self, id: &str) -> Result<(), String> {
        let pause = self
            .shared
            .tasks
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|task| task.pause_requested && !task.cancelled);
        if pause {
            // Publish already committed files under the mutation lock before
            // another task can mutate those paths or emit its own changes.
            self.publish(id);
            update(self.shared, id, |task| {
                task.status = "paused".into();
                if let Some(clock) = task.transfer_clock.take() {
                    task.transfer_millis = task
                        .transfer_base_millis
                        .saturating_add(clock.elapsed().as_millis().min(u64::MAX as u128) as u64);
                }
            });
            drop(self.mutation.take());
            {
                let mut queue = self.shared.task_queue.lock().unwrap();
                // This worker hands off its queue-consumer role. Its old loop
                // generation is invalid even when this task later resumes.
                queue.running = false;
                queue.generation += 1;
                start_worker(self.shared, self.app.cloned(), &mut queue);
            }
            let tasks = self.shared.tasks.lock().unwrap();
            let tasks = self
                .shared
                .task_wake
                .wait_while(tasks, |tasks| {
                    tasks
                        .get(id)
                        .is_some_and(|task| task.pause_requested && !task.cancelled)
                })
                .unwrap();
            drop(tasks);
            self.mutation = Some(self.shared.mutation.lock().unwrap());
            update(self.shared, id, |task| {
                if !task.cancelled {
                    task.status = "running".into();
                    if task.current_total_bytes.is_some() {
                        task.transfer_base_millis = task.transfer_millis;
                        task.transfer_clock = Some(std::time::Instant::now());
                    }
                }
            });
        }
        if cancelled(self.shared, id) {
            Err("任务已取消".into())
        } else {
            Ok(())
        }
    }
}

pub(crate) fn refresh_positions(shared: &Shared, queue: &TaskQueue) {
    let mut tasks = shared.tasks.lock().unwrap();
    for (position, (id, _)) in queue.pending.iter().enumerate() {
        if let Some(task) = tasks.get_mut(id) {
            if task.queue_position != Some(position) {
                task.queue_position = Some(position);
                shared.task_feed.change(Some(id));
            }
        }
    }
}

pub(crate) fn next_job(shared: &Shared, queue: &mut TaskQueue) -> Option<(String, TaskWork)> {
    let mut tasks = shared.tasks.lock().unwrap();
    let position = queue.pending.iter().position(|(id, _)| {
        tasks
            .get(id)
            .is_none_or(|task| !task.pause_requested || task.cancelled)
    })?;
    let job = queue.pending.remove(position);
    if let Some((id, _)) = &job {
        if let Some(task) = tasks.get_mut(id) {
            task.queue_position = None;
            task.status = "running".into();
            task.can_pause = matches!(task.kind.as_str(), "copy" | "move" | "trash");
            shared.task_feed.change(Some(id));
        }
    }
    drop(tasks);
    refresh_positions(shared, queue);
    job
}

pub(crate) fn reorder(shared: &Shared, id: &str, direction: &str) -> Result<(), String> {
    let mut queue = shared.task_queue.lock().unwrap();
    let from = queue
        .pending
        .iter()
        .position(|(task, _)| task == id)
        .ok_or("只能调整等待队列中的任务")?;
    let to = match direction {
        "up" => from.saturating_sub(1),
        "down" => (from + 1).min(queue.pending.len() - 1),
        "first" => 0,
        _ => return Err("无效的队列调整方向".into()),
    };
    if from != to {
        let job = queue.pending.remove(from).unwrap();
        queue.pending.insert(to, job);
        refresh_positions(shared, &queue);
    }
    Ok(())
}

pub(crate) fn execute(
    shared: &Arc<Shared>,
    app: Option<&AppHandle>,
    (id, work): (String, TaskWork),
) {
    let mut execution = TaskExecution::new(shared, app);
    if !cancelled(shared, &id) {
        update(shared, &id, |task| {
            task.status = if task.pause_requested {
                "pausing"
            } else {
                "running"
            }
            .into();
            task.can_pause = matches!(task.kind.as_str(), "copy" | "move" | "trash");
        });
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            work(shared, &id, &mut execution)
        }))
        .unwrap_or_else(|_| Err("文件任务意外停止，请检查源和目标位置".into()));
        if let Err(error) = result {
            update(shared, &id, |task| task.errors.push(error));
        }
    }
    let mut failure = None;
    update(shared, &id, |task| {
        task.conflict = None;
        task.pause_requested = false;
        task.can_pause = false;
        task.status = if task.cancelled {
            "cancelled"
        } else if let Some(error) = task.errors.first() {
            let path = if task.destination.is_empty() {
                &task.current
            } else {
                &task.destination
            };
            failure = Some(Failure::new(
                "文件任务",
                &task.kind,
                std::path::Path::new(path),
                error.clone(),
            ));
            "error"
        } else {
            "done"
        }
        .into();
    });
    execution.publish(&id);
    if let Some(app) = app {
        if let Some(failure) = failure {
            diagnostics::record(app, failure);
        }
        let changed = shared.tasks.lock().unwrap().get(&id).and_then(|task| {
            matches!(task.kind.as_str(), "zip" | "unzip" | "undo").then(|| task.destination.clone())
        });
        if let Some(path) = changed {
            let _ = app.emit("directory-changed", (!path.is_empty()).then_some([path]));
        }
    }
}

pub(crate) fn start_worker(shared: &Arc<Shared>, app: Option<AppHandle>, queue: &mut TaskQueue) {
    if queue.running || queue.pending.is_empty() {
        return;
    }
    queue.running = true;
    queue.generation += 1;
    let generation = queue.generation;
    let shared = shared.clone();
    std::thread::spawn(move || loop {
        let job = {
            let mut queue = shared.task_queue.lock().unwrap();
            if queue.generation != generation {
                return;
            }
            let job = next_job(&shared, &mut queue);
            if job.is_none() {
                queue.running = false;
            }
            job
        };
        let Some(job) = job else {
            return;
        };
        execute(&shared, app.as_ref(), job);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        act_on_task,
        fs_safety::Directory,
        transfer::{Source, Transfer},
        Task,
    };
    use std::{
        fs,
        path::Path,
        time::{Duration, Instant},
    };

    fn wait(shared: &Shared, id: &str, expected: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let task = shared.tasks.lock().unwrap()[id].clone();
            if task.status == expected {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "{id}: expected {expected}, got {} ({:?})",
                task.status,
                task.errors
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn add_copy(shared: &Arc<Shared>, id: &str, source: &Path, target: &Path, moving: bool) {
        let source = Source::at(source.to_owned()).unwrap();
        let target = target.to_owned();
        let parent = Directory::parent(&target).unwrap();
        shared.tasks.lock().unwrap().insert(
            id.into(),
            Task {
                id: id.into(),
                kind: if moving { "move" } else { "copy" }.into(),
                status: "queued".into(),
                can_pause: true,
                ..Default::default()
            },
        );
        let work: TaskWork = Box::new(move |shared, id, execution| {
            let mut paused_once = false;
            let mut checkpoint = || {
                // Deterministically pause only once bytes are in a private stage.
                if !paused_once && shared.tasks.lock().unwrap()[id].bytes > 0 {
                    paused_once = true;
                    act_on_task(shared, id, "pause".into(), false, None);
                }
                execution.checkpoint(id)
            };
            let mut transfer = Transfer::new(shared, id, moving);
            transfer.set_checkpoint(&mut checkpoint);
            // Staging forces the move fixture through cross-volume semantics.
            let result = transfer.stage(&source, &target, &parent, None);
            transfer.flush_changes();
            result
        });
        let mut queue = shared.task_queue.lock().unwrap();
        queue.pending.push_back((id.into(), work));
        refresh_positions(shared, &queue);
    }

    #[test]
    fn independently_resumes_and_cancels_two_paused_transfers_while_small_job_runs() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let bytes = vec![42; 3 * 1024 * 1024];
        let source_a = root.join("a.bin");
        let source_b = root.join("b.bin");
        let target_a = root.join("out-a.bin");
        let target_b = root.join("out-b.bin");
        let small = root.join("small.txt");
        fs::write(&source_a, &bytes).unwrap();
        fs::write(&source_b, &bytes).unwrap();
        let shared = Arc::new(Shared::default());
        add_copy(&shared, "a", &source_a, &target_a, true);
        add_copy(&shared, "b", &source_b, &target_b, false);
        shared.tasks.lock().unwrap().insert(
            "small".into(),
            Task {
                status: "queued".into(),
                kind: "copy".into(),
                ..Default::default()
            },
        );
        let small_target = small.clone();
        shared.task_queue.lock().unwrap().pending.push_back((
            "small".into(),
            Box::new(move |_, _, _| {
                fs::write(&small_target, b"small task finished").map_err(|e| e.to_string())
            }),
        ));
        {
            let mut queue = shared.task_queue.lock().unwrap();
            refresh_positions(&shared, &queue);
            start_worker(&shared, None, &mut queue);
        }
        wait(&shared, "a", "paused");
        wait(&shared, "b", "paused");
        wait(&shared, "small", "done");
        assert_eq!(fs::read(&small).unwrap(), b"small task finished");
        assert_eq!(fs::read(&source_a).unwrap(), bytes);
        assert_eq!(fs::read(&source_b).unwrap(), bytes);
        assert!(!target_a.exists() && !target_b.exists());
        let paused_bytes = shared.tasks.lock().unwrap()["b"].bytes;
        act_on_task(&shared, "a", "resume".into(), false, None);
        wait(&shared, "a", "done");
        assert_eq!(fs::read(&target_a).unwrap(), bytes);
        assert!(!source_a.exists());
        assert_eq!(shared.tasks.lock().unwrap()["b"].status, "paused");
        assert_eq!(shared.tasks.lock().unwrap()["b"].bytes, paused_bytes);
        act_on_task(&shared, "b", "cancel".into(), false, None);
        wait(&shared, "b", "cancelled");
        assert_eq!(fs::read(&source_b).unwrap(), bytes);
        assert!(!target_b.exists());
        // Completion status is published while the execution still owns the
        // guard, so wait for its release instead of racing the final unwind.
        assert!(shared.mutation.lock().is_ok());
    }

    #[test]
    fn queue_reordering_skips_paused_jobs_and_keeps_positions() {
        let shared = Arc::new(Shared::default());
        for id in ["a", "b", "c"] {
            shared.tasks.lock().unwrap().insert(
                id.into(),
                Task {
                    id: id.into(),
                    status: "queued".into(),
                    can_pause: true,
                    ..Default::default()
                },
            );
            shared
                .task_queue
                .lock()
                .unwrap()
                .pending
                .push_back((id.into(), Box::new(|_, _, _| Ok(()))));
        }
        reorder(&shared, "c", "first").unwrap();
        assert_eq!(shared.tasks.lock().unwrap()["c"].queue_position, Some(0));
        reorder(&shared, "a", "down").unwrap();
        assert_eq!(shared.tasks.lock().unwrap()["a"].queue_position, Some(2));
        assert!(reorder(&shared, "a", "invalid").is_err());
        act_on_task(&shared, "c", "pause".into(), false, None);
        let job = next_job(&shared, &mut shared.task_queue.lock().unwrap()).unwrap();
        assert_eq!(job.0, "b");
        assert_eq!(shared.tasks.lock().unwrap()["c"].queue_position, Some(0));
        assert!(reorder(&shared, "b", "up").is_err());
        execute(&shared, None, job);
        assert_eq!(shared.tasks.lock().unwrap()["b"].status, "done");
        act_on_task(&shared, "c", "cancel".into(), false, None);
        let job = next_job(&shared, &mut shared.task_queue.lock().unwrap()).unwrap();
        execute(&shared, None, job);
        assert_eq!(shared.tasks.lock().unwrap()["c"].status, "cancelled");
    }

    #[test]
    #[cfg(not(windows))]
    fn rejects_changed_source_after_paused_move_and_preserves_both_locations() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let source = root.join("source.bin");
        let target = root.join("target.bin");
        let bytes = vec![7; 3 * 1024 * 1024];
        fs::write(&source, &bytes).unwrap();
        let shared = Arc::new(Shared::default());
        add_copy(&shared, "a", &source, &target, true);
        start_worker(&shared, None, &mut shared.task_queue.lock().unwrap());
        wait(&shared, "a", "paused");
        fs::write(&source, b"changed outside Filepace").unwrap();
        act_on_task(&shared, "a", "resume".into(), false, None);
        wait(&shared, "a", "error");
        assert_eq!(fs::read(&source).unwrap(), b"changed outside Filepace");
        assert!(!target.exists());
    }
    #[test]
    fn cancelled_paused_batch_retains_undo_for_committed_move() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let first = root.join("first.txt");
        let second = root.join("second.txt");
        let destination = root.join("destination");
        fs::create_dir(&destination).unwrap();
        fs::write(&first, b"first original").unwrap();
        fs::write(&second, b"second original").unwrap();
        let sources = vec![crate::strpath(&first), crate::strpath(&second)];
        let plan =
            crate::plan_transfer("move", &sources, &crate::strpath(&destination), None, None)
                .unwrap();
        let shared = Arc::new(Shared::default());
        shared.tasks.lock().unwrap().insert(
            "batch".into(),
            Task {
                kind: "move".into(),
                status: "queued".into(),
                can_pause: true,
                ..Default::default()
            },
        );
        let job: TaskWork = Box::new(move |state, id, execution| {
            let mut paused = false;
            let mut checkpoint = || {
                if !paused && state.tasks.lock().unwrap()[id].completed == 1 {
                    paused = true;
                    act_on_task(state, id, "pause".into(), false, None);
                }
                execution.checkpoint(id)
            };
            crate::execute_transfer_plan(
                state,
                id,
                "move",
                plan.items,
                plan.folder,
                None,
                None,
                &mut checkpoint,
            )
        });
        shared
            .task_queue
            .lock()
            .unwrap()
            .pending
            .push_back(("batch".into(), job));
        start_worker(&shared, None, &mut shared.task_queue.lock().unwrap());
        wait(&shared, "batch", "paused");
        assert!(!first.exists());
        assert_eq!(
            fs::read(destination.join("first.txt")).unwrap(),
            b"first original"
        );
        assert_eq!(fs::read(&second).unwrap(), b"second original");
        act_on_task(&shared, "batch", "cancel".into(), false, None);
        wait(&shared, "batch", "cancelled");
        let mut record = shared
            .undo
            .lock()
            .unwrap()
            .pop()
            .expect("committed first move must remain undoable");
        shared
            .tasks
            .lock()
            .unwrap()
            .insert("undo".into(), Task::default());
        crate::undo::reverse(&mut record, &shared, "undo").unwrap();
        assert_eq!(fs::read(&first).unwrap(), b"first original");
        assert_eq!(fs::read(&second).unwrap(), b"second original");
        assert!(!destination.join("first.txt").exists());
        assert!(!destination.join("second.txt").exists());
    }
    #[test]
    fn rechecks_queued_source_after_paused_boundary_before_move() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let source = root.join("source.txt");
        let destination = root.join("destination");
        fs::create_dir(&destination).unwrap();
        fs::write(&source, b"original").unwrap();
        let sources = vec![crate::strpath(&source)];
        let plan =
            crate::plan_transfer("move", &sources, &crate::strpath(&destination), None, None)
                .unwrap();
        let shared = Arc::new(Shared::default());
        shared.tasks.lock().unwrap().insert(
            "move".into(),
            Task {
                kind: "move".into(),
                status: "queued".into(),
                can_pause: true,
                ..Default::default()
            },
        );
        let job: TaskWork = Box::new(move |state, id, execution| {
            let mut paused = false;
            let mut checkpoint = || {
                if !paused {
                    paused = true;
                    act_on_task(state, id, "pause".into(), false, None);
                }
                execution.checkpoint(id)
            };
            crate::execute_transfer_plan(
                state,
                id,
                "move",
                plan.items,
                plan.folder,
                None,
                None,
                &mut checkpoint,
            )
        });
        shared
            .task_queue
            .lock()
            .unwrap()
            .pending
            .push_back(("move".into(), job));
        start_worker(&shared, None, &mut shared.task_queue.lock().unwrap());
        wait(&shared, "move", "paused");
        fs::write(&source, b"changed after selection").unwrap();
        act_on_task(&shared, "move", "resume".into(), false, None);
        wait(&shared, "move", "error");
        assert_eq!(fs::read(&source).unwrap(), b"changed after selection");
        assert!(!destination.join("source.txt").exists());
    }
}
