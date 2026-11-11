use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    process::{Child, Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;

struct ProcessId {
    pid: u32,
    #[cfg(windows)]
    job: usize,
}

#[derive(Default)]
struct Registry {
    running: HashMap<String, ProcessId>,
    closed: HashSet<String>,
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(Mutex::default)
}

fn terminate(process: &ProcessId) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(process.pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::JobObjects::TerminateJobObject(process.job as _, 1);
    }
}

/// The final window can exit before a worker observes its cancellation flag.
/// Terminate synchronously and serialize closing with new process registration.
pub(crate) fn stop_window(owner: &str) {
    let mut registry = registry().lock().unwrap();
    registry.closed.insert(owner.into());
    if let Some(process) = registry.running.get(owner) {
        terminate(process);
    }
}

struct Process {
    child: Child,
    owner: Option<String>,
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
}

impl Process {
    fn spawn(command: &mut Command, owner: Option<&str>) -> Result<Self, String> {
        let mut registry = registry().lock().unwrap();
        if owner.is_some_and(|owner| registry.closed.contains(owner)) {
            return Err("窗口已关闭，诊断已停止".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        let child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("无法启动 AI 命令：{error}"))?;
        #[cfg(windows)]
        let job = {
            use std::{
                mem::{size_of, zeroed},
                os::windows::io::AsRawHandle,
                ptr::null,
            };
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
            };
            let mut child = child;
            let job = unsafe { CreateJobObjectW(null(), null()) };
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let assigned = !job.is_null()
                && unsafe {
                    SetInformationJobObject(
                        job,
                        JobObjectExtendedLimitInformation,
                        &limits as *const _ as *const _,
                        size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    ) != 0
                        && AssignProcessToJobObject(job, child.as_raw_handle() as _) != 0
                };
            if !assigned {
                let _ = child.kill();
                let _ = child.wait();
                if !job.is_null() {
                    unsafe {
                        CloseHandle(job);
                    }
                }
                return Err("无法为 AI 命令建立进程限制".into());
            }
            // Keep the child binding available below on both platforms.
            (child, job)
        };
        #[cfg(windows)]
        let (child, job) = job;
        if let Some(owner) = owner {
            registry.running.insert(
                owner.into(),
                ProcessId {
                    pid: child.id(),
                    #[cfg(windows)]
                    job: job as usize,
                },
            );
        }
        Ok(Self {
            child,
            owner: owner.map(String::from),
            #[cfg(windows)]
            job,
        })
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if let Some(owner) = &self.owner {
            let mut registry = registry().lock().unwrap();
            if registry
                .running
                .get(owner)
                .is_some_and(|process| process.pid == self.child.id())
            {
                registry.running.remove(owner);
            }
        }
        // Each invocation owns its group/job, including Node/Bun wrapper children.
        terminate(&ProcessId {
            pid: self.child.id(),
            #[cfg(windows)]
            job: self.job as usize,
        });
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Drain both pipes concurrently and keep cancellation effective even when a
/// wrapper has exited but a descendant still owns stdin/stdout.
pub(crate) fn run(
    command: &mut Command,
    input: Vec<u8>,
    cancelled: &AtomicBool,
    timeout: Duration,
    owner: Option<&str>,
) -> Result<Output, String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("诊断已停止".into());
    }
    let mut process = Process::spawn(command, owner)?;
    let (sender, receiver) = mpsc::channel();
    for (index, mut pipe) in [
        Box::new(process.child.stdout.take().unwrap()) as Box<dyn Read + Send>,
        Box::new(process.child.stderr.take().unwrap()) as Box<dyn Read + Send>,
    ]
    .into_iter()
    .enumerate()
    {
        let sender = sender.clone();
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe
                .by_ref()
                .take(OUTPUT_LIMIT as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| format!("无法读取 AI 输出：{error}"))
                .and_then(|_| {
                    if bytes.len() > OUTPUT_LIMIT {
                        Err("AI 输出超过限制，请缩小分析范围后重试".into())
                    } else {
                        Ok(bytes)
                    }
                });
            let _ = sender.send((index, result));
        });
    }
    let mut stdin = process.child.stdin.take().unwrap();
    thread::spawn(move || {
        let result = stdin
            .write_all(&input)
            .map(|_| Vec::new())
            .map_err(|error| format!("无法发送扫描摘要：{error}"));
        drop(stdin);
        let _ = sender.send((2, result));
    });
    let started = Instant::now();
    let mut status = None;
    let mut input_error = None;
    let mut outputs: [Option<Vec<u8>>; 3] = [None, None, None];
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err("诊断已停止".into());
        }
        if started.elapsed() >= timeout {
            return Err("AI 命令响应超时，请检查登录、网络或账号额度后重试".into());
        }
        while let Ok((index, result)) = receiver.try_recv() {
            if index == 2 {
                input_error = result.err();
                outputs[index] = Some(Vec::new());
            } else {
                outputs[index] = Some(result?);
            }
        }
        if status.is_none() {
            status = process
                .child
                .try_wait()
                .map_err(|error| format!("无法等待 AI 命令：{error}"))?;
        }
        if let Some(status) = status.filter(|_| outputs.iter().all(Option::is_some)) {
            if status.success() {
                if let Some(error) = input_error {
                    return Err(error);
                }
            }
            return Ok(Output {
                status,
                stdout: outputs[0].take().unwrap(),
                stderr: outputs[1].take().unwrap(),
            });
        }
        thread::sleep(Duration::from_millis(30));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn drains_output_and_handles_large_stdin_without_deadlock() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "cat; printf error >&2"]);
        let input = vec![b'x'; 192 * 1024];
        let output = run(
            &mut command,
            input.clone(),
            &AtomicBool::new(false),
            Duration::from_secs(5),
            None,
        )
        .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, input);
        assert_eq!(output.stderr, b"error");
    }

    #[test]
    fn stops_a_process_tree_and_an_inherited_open_pipe() {
        let root = tempfile::tempdir().unwrap();
        let late = root.path().join("should-not-exist");
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "(sleep 0.5; touch \"$1\") & exit 0", "fixture"]);
        command.arg(&late);
        let started = Instant::now();
        assert!(run(
            &mut command,
            vec![],
            &AtomicBool::new(false),
            Duration::from_millis(150),
            None,
        )
        .unwrap_err()
        .contains("超时"));
        assert!(started.elapsed() < Duration::from_secs(2));
        thread::sleep(Duration::from_millis(600));
        assert!(!late.exists());
    }

    #[test]
    fn rejects_excess_output_and_observes_cancellation() {
        let stop = AtomicBool::new(true);
        assert!(run(
            &mut Command::new("/bin/echo"),
            vec![],
            &stop,
            Duration::from_secs(1),
            None,
        )
        .unwrap_err()
        .contains("停止"));
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "yes output"]);
        assert!(run(
            &mut command,
            vec![],
            &AtomicBool::new(false),
            Duration::from_secs(5),
            None,
        )
        .unwrap_err()
        .contains("超过限制"));
    }

    #[test]
    fn closing_a_window_terminates_its_process_and_prevents_late_startup() {
        let owner = uuid::Uuid::new_v4().to_string();
        thread::scope(|scope| {
            let worker = scope.spawn(|| {
                let mut command = Command::new("/bin/sh");
                command.args(["-c", "sleep 30 & wait"]);
                run(
                    &mut command,
                    vec![],
                    &AtomicBool::new(false),
                    Duration::from_secs(3),
                    Some(&owner),
                )
            });
            let started = Instant::now();
            while !registry().lock().unwrap().running.contains_key(&owner) {
                assert!(started.elapsed() < Duration::from_secs(2));
                thread::sleep(Duration::from_millis(10));
            }
            stop_window(&owner);
            assert!(!worker.join().unwrap().unwrap().status.success());
        });
        assert!(run(
            &mut Command::new("/bin/echo"),
            vec![],
            &AtomicBool::new(false),
            Duration::from_secs(1),
            Some(&owner)
        )
        .unwrap_err()
        .contains("窗口已关闭"));
    }

    #[test]
    fn cancellation_interrupts_an_active_command() {
        let cancelled = AtomicBool::new(false);
        thread::scope(|scope| {
            scope.spawn(|| {
                thread::sleep(Duration::from_millis(100));
                cancelled.store(true, Ordering::Relaxed);
            });
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "sleep 30"]);
            let started = Instant::now();
            assert!(run(
                &mut command,
                vec![],
                &cancelled,
                Duration::from_secs(3),
                None
            )
            .unwrap_err()
            .contains("停止"));
            assert!(started.elapsed() < Duration::from_secs(2));
        });
    }
}
