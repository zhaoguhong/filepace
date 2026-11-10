use serde::Serialize;
use std::path::PathBuf;
use tauri::Window;

#[tauri::command]
pub async fn open_properties(window: Window, path: PathBuf) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("请选择有效的文件或文件夹".into());
    }
    show_properties(window, path).await
}

#[cfg(target_os = "macos")]
async fn show_properties(_window: Window, path: PathBuf) -> Result<(), String> {
    const GET_INFO: &str = r#"
on run argv
    set itemPath to (POSIX file (item 1 of argv)) as text
    tell application id "com.apple.finder"
        open information window of item itemPath
        activate
    end tell
end run
"#;
    tauri::async_runtime::spawn_blocking(move || {
        path.symlink_metadata().map_err(|error| error.to_string())?;
        let result = std::process::Command::new("/usr/bin/osascript")
            .args(["-e", GET_INFO])
            .arg(path)
            .output()
            .map_err(|error| error.to_string())?;
        if result.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&result.stderr).trim().to_owned())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(windows)]
async fn show_properties(window: Window, path: PathBuf) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::{
        Shell::{ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_INVOKEIDLIST, SHELLEXECUTEINFOW},
        WindowsAndMessaging::SW_SHOWNORMAL,
    };

    let file: Vec<_> = path.as_os_str().encode_wide().chain([0]).collect();
    let verb: Vec<_> = "properties".encode_utf16().chain([0]).collect();
    if file[..file.len() - 1].contains(&0) {
        return Err("文件路径无效".into());
    }
    windows_shell(window, move |hwnd| {
        let mut options = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_INVOKEIDLIST | SEE_MASK_FLAG_NO_UI,
            hwnd,
            lpVerb: verb.as_ptr(),
            lpFile: file.as_ptr(),
            nShow: SW_SHOWNORMAL,
            ..Default::default()
        };
        if unsafe { ShellExecuteExW(&mut options) } == 0 {
            Err(std::io::Error::last_os_error().to_string())
        } else {
            Ok(())
        }
    })
    .await
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn show_properties(_window: Window, _path: PathBuf) -> Result<(), String> {
    Err("当前系统暂不支持打开系统属性".into())
}

#[derive(Serialize)]
pub struct OpenWithApp {
    name: String,
    path: PathBuf,
    default: bool,
}

#[tauri::command]
pub async fn open_with(
    window: Window,
    path: PathBuf,
    application: Option<PathBuf>,
) -> Result<Vec<OpenWithApp>, String> {
    if !path.is_absolute() {
        return Err("请选择要打开的文件".into());
    }
    let path = tauri::async_runtime::spawn_blocking(move || {
        let path = dunce::canonicalize(path).map_err(|error| error.to_string())?;
        if !path.is_file() {
            return Err("请选择要打开的文件".into());
        }
        Ok::<_, String>(path)
    })
    .await
    .map_err(|error| error.to_string())??;
    choose_application(window, path, application).await
}

#[cfg(target_os = "macos")]
async fn choose_application(
    _window: Window,
    path: PathBuf,
    application: Option<PathBuf>,
) -> Result<Vec<OpenWithApp>, String> {
    use objc2::{runtime::NSObjectProtocol, sel};
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};
    tauri::async_runtime::spawn_blocking(move || {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let workspace = NSWorkspace::sharedWorkspace();
        let default = workspace.URLForApplicationToOpenURL(&url);
        let default_path = default
            .as_ref()
            .and_then(|url| url.path())
            .map(|path| path.to_string());
        let apps = if workspace.respondsToSelector(sel!(URLsForApplicationsToOpenURL:)) {
            workspace.URLsForApplicationsToOpenURL(&url).to_vec()
        } else {
            default.into_iter().collect()
        };
        let mut apps: Vec<_> = apps
            .into_iter()
            .filter_map(|url| {
                let path = url.path()?.to_string();
                let is_default = default_path.as_deref() == Some(&path);
                let path = PathBuf::from(path);
                let name = path.file_stem()?.to_string_lossy().into_owned();
                Some(OpenWithApp {
                    name,
                    path,
                    default: is_default,
                })
            })
            .collect();
        if let Some(app) = application {
            if !apps.iter().any(|option| option.path == app) {
                return Err("所选应用不在系统提供的打开方式中".into());
            }
            run_open(&[
                std::ffi::OsStr::new("-a"),
                app.as_os_str(),
                path.as_os_str(),
            ])?;
            return Ok(Vec::new());
        }
        apps.sort_by(|a, b| b.default.cmp(&a.default).then(a.name.cmp(&b.name)));
        Ok(apps)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(windows)]
async fn choose_application(
    window: Window,
    path: PathBuf,
    _application: Option<PathBuf>,
) -> Result<Vec<OpenWithApp>, String> {
    use std::{os::windows::ffi::OsStrExt, ptr::null};
    use windows_sys::Win32::UI::Shell::{SHOpenWithDialog, OAIF_EXEC, OPENASINFO};
    windows_shell(window, move |hwnd| {
        let file: Vec<_> = path.as_os_str().encode_wide().chain([0]).collect();
        let options = OPENASINFO {
            pcszFile: file.as_ptr(),
            pcszClass: null(),
            oaifInFlags: OAIF_EXEC,
        };
        let status = unsafe { SHOpenWithDialog(hwnd, &options) };
        if status >= 0 || matches!(status as u32, 0x800704c7 | 0x80004004) {
            Ok(())
        } else {
            Err(format!(
                "无法打开系统的应用选择窗口（0x{:08X}）",
                status as u32
            ))
        }
    })
    .await?;
    Ok(Vec::new())
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn choose_application(
    _window: Window,
    _path: PathBuf,
    _application: Option<PathBuf>,
) -> Result<Vec<OpenWithApp>, String> {
    Err("当前系统暂不支持打开方式".into())
}

#[cfg(windows)]
async fn windows_shell(
    window: Window,
    action: impl FnOnce(windows_sys::Win32::Foundation::HWND) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    use std::ptr::null;
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    let (send, mut receive) = tauri::async_runtime::channel(1);
    let owner = window.clone();
    window
        .run_on_main_thread(move || {
            let result = owner
                .hwnd()
                .map_err(|error| error.to_string())
                .and_then(|hwnd| {
                    if unsafe { CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32) } < 0 {
                        return Err("无法初始化 Windows Shell".into());
                    }
                    let result = action(hwnd.0);
                    unsafe { CoUninitialize() };
                    result
                });
            let _ = send.try_send(result);
        })
        .map_err(|error| error.to_string())?;
    receive.recv().await.ok_or("无法启动 Windows Shell 操作")?
}

#[cfg(target_os = "macos")]
fn run_open(args: &[&std::ffi::OsStr]) -> Result<(), String> {
    let output = std::process::Command::new("/usr/bin/open")
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

#[tauri::command]
pub async fn open_system_storage(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(|| {
            run_open(&[
                std::ffi::OsStr::new("-b"),
                std::ffi::OsStr::new("com.apple.DiskUtility"),
            ])
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(windows)]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url("ms-settings:storagesense", None::<&str>)
            .map_err(|error| error.to_string())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = app;
        Err("当前系统暂不支持打开存储设置".into())
    }
}
