use std::{
    io::{self, Read},
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
pub(crate) fn system_directory() -> Option<std::path::PathBuf> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
    let mut buffer = [0u16; 260];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    (length > 0 && length < buffer.len()).then(|| OsString::from_wide(&buffer[..length]).into())
}

pub(crate) fn run(
    mut command: Command,
    stop: impl Fn() -> bool,
    timeout: Option<Duration>,
) -> io::Result<Output> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = capture(child.stdout.take().unwrap(), 8 * 1024 * 1024);
    let stderr = capture(child.stderr.take().unwrap(), 32 * 1024);
    let start = Instant::now();
    let status = loop {
        if stop() || timeout.is_some_and(|limit| start.elapsed() >= limit) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(io::ErrorKind::Interrupted, "系统操作已停止"));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(30)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
    };
    Ok(Output {
        status,
        stdout: stdout
            .join()
            .map_err(|_| io::Error::other("无法读取系统输出"))??,
        stderr: stderr
            .join()
            .map_err(|_| io::Error::other("无法读取系统错误"))??,
    })
}

fn capture(
    reader: impl Read + Send + 'static,
    max: u64,
) -> thread::JoinHandle<io::Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut output = Vec::new();
        reader.take(max + 1).read_to_end(&mut output)?;
        if output.len() as u64 > max {
            return Err(io::Error::other("系统输出超过限制"));
        }
        Ok(output)
    })
}
