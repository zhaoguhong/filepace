# Run only in the disposable GitHub Actions desktop session.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Use a disposable Windows runner' }
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class FilepaceSmokeMouse {
    [DllImport("user32.dll", SetLastError=true)]
    private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32.dll")]
    private static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll", SetLastError=true)]
    private static extern bool PostMessage(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool MoveWindow(IntPtr window, int x, int y, int width, int height, bool repaint);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out int process);
    public static int ForegroundProcess() {
        int process;
        GetWindowThreadProcessId(GetForegroundWindow(), out process);
        return process;
    }
    public static void PressKey(byte key) {
        keybd_event(key, 0, 0, UIntPtr.Zero);
        keybd_event(key, 0, 2, UIntPtr.Zero);
    }
    public static void ControlKey(byte key) {
        keybd_event(17, 0, 0, UIntPtr.Zero);
        try { PressKey(key); }
        finally { keybd_event(17, 0, 2, UIntPtr.Zero); }
    }
    public static void Close(IntPtr window) {
        if (!PostMessage(window, 0x0010, UIntPtr.Zero, IntPtr.Zero)) {
            throw new System.ComponentModel.Win32Exception();
        }
    }
    private static void Move(int x, int y) {
        if (!SetCursorPos(x, y)) throw new System.ComponentModel.Win32Exception();
    }
    private static void Mouse(uint flags) { mouse_event(flags, 0, 0, 0, UIntPtr.Zero); }
    public static void Click(int x, int y, bool right) {
        Move(x, y);
        Mouse(right ? 8u : 2u);
        Mouse(right ? 16u : 4u);
    }
    public static void Drag(int x, int y, int targetX, int targetY, bool copy) {
        Move(x, y);
        Mouse(2u);
        try {
            for (int i = 1; i <= 25; i++) {
                if (copy && i == 12) keybd_event(17, 0, 0, UIntPtr.Zero);
                Move(x + (targetX - x) * i / 25, y + (targetY - y) * i / 25);
                Thread.Sleep(24);
            }
            Thread.Sleep(250);
        } finally {
            Mouse(4u);
            if (copy) {
                Thread.Sleep(160);
                keybd_event(17, 0, 2, UIntPtr.Zero);
            }
        }
    }
}
'@

$root = Join-Path $env:RUNNER_TEMP ('filepace-smoke-' + [Guid]::NewGuid().ToString('N'))
$source = Join-Path $root '整理前'
$destination = Join-Path $root '整理后'
$nested = Join-Path $source '图片'
$detached = Join-Path $source '窗口目标'
$null = New-Item -ItemType Directory -Path $nested, $destination, $detached -Force
$content = 'Filepace installer fixture'
[IO.File]::WriteAllText((Join-Path $source 'move.docx'), $content)
[IO.File]::WriteAllText((Join-Path $source 'copy.txt'), $content)
[IO.File]::WriteAllBytes((Join-Path $nested 'large.PNG'), [byte[]]::new(4096))
[IO.File]::WriteAllText((Join-Path $nested '会议查找.txt'), $content)
[IO.File]::WriteAllText((Join-Path $source 'detached-move.txt'), $content)
[IO.File]::WriteAllText((Join-Path $source 'detached-copy.txt'), $content)
$appDir = Join-Path $env:LOCALAPPDATA 'Filepace'
$executable = Join-Path $appDir 'filepace.exe'
$uninstaller = Join-Path $appDir 'uninstall.exe'
$config = Join-Path $env:APPDATA 'app.filepace.desktop'
$sessionFile = Join-Path $config 'sessions.json'
if ((Test-Path $executable) -or (Test-Path $sessionFile)) { throw 'Expected a clean profile' }
$installers = @(Get-ChildItem 'src-tauri/target/release/bundle/nsis' -Filter '*-setup.exe')
if ($installers.Count -ne 1) { throw 'Expected one NSIS installer' }

# This executable is a local protocol fixture, never an installed AI client.
# It neither contacts a service nor uses credentials or account quota.
$diagnosisFixture = Join-Path $root 'diagnosis-cli'
$null = New-Item -ItemType Directory -Path $diagnosisFixture
$diagnosisCommand = Join-Path $diagnosisFixture 'codex.exe'
$diagnosisPrompt = Join-Path $diagnosisFixture 'prompt.txt'
$diagnosisStarted = Join-Path $diagnosisFixture 'started'
$diagnosisRelease = Join-Path $diagnosisFixture 'allow-report'
$diagnosisFinished = Join-Path $diagnosisFixture 'finished'
Add-Type -OutputAssembly $diagnosisCommand -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
public static class FilepaceDiagnosisFixture {
    public static int Main(string[] args) {
        if (Array.IndexOf(args, "--version") >= 0 || (args.Length == 1 && args[0] == "version")) {
            Console.WriteLine("codex-cli 0.0.0-filepace-fixture");
            return 0;
        }
        if (Array.IndexOf(args, "--help") >= 0) {
            Console.WriteLine("Local Filepace fixture: exec --json --output-schema <path> -");
            return 0;
        }
        if (args.Length == 0 || args[0] != "exec" || Array.IndexOf(args, "--json") < 0) {
            Console.Error.WriteLine("Unexpected local fixture arguments");
            return 2;
        }
        string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string prompt;
        using (var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false))) {
            prompt = input.ReadToEnd();
        }
        if (!prompt.Contains("\"scopeName\"")) {
            Console.Error.WriteLine("Missing directory snapshot in fixture input");
            return 3;
        }
        File.WriteAllText(Path.Combine(root, "prompt.txt"), prompt, new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(root, "started"), "started");
        Thread.Sleep(3000);
        // Wait for real UI navigation before replying, even on a slow runner.
        // The deadline also lets the fixture terminate if smoke automation fails.
        DateTime deadline = DateTime.UtcNow.AddSeconds(20);
        while (!File.Exists(Path.Combine(root, "allow-report"))) {
            if (DateTime.UtcNow >= deadline) {
                Console.Error.WriteLine("Fixture timed out waiting for background navigation");
                return 4;
            }
            Thread.Sleep(100);
        }
        string report = "{\"summary\":\"FILEPACE_NATIVE_DIAGNOSIS_FIXTURE_OK\",\"findings\":[],\"limitations\":[]}";
        string text = report.Replace("\\", "\\\\").Replace("\"", "\\\"");
        Console.WriteLine("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"" + text + "\"}}");
        File.WriteAllText(Path.Combine(root, "finished"), "finished");
        return 0;
    }
}
'@

function New-Pane($id, $path) {
    return @{
        active = $id
        tabs = @(@{
            id = $id; path = $path; history = @($path); index = 0; query = ''; view = 'list'
            sort = 'name'; descending = $false; selected = @(); scroll = 0
        })
    }
}
$main = New-Pane 'source' $source
$main.right = New-Pane 'destination' $destination
$main.focused = 'left'
$null = New-Item -ItemType Directory -Path $config -Force
[IO.File]::WriteAllText($sessionFile, (@{ main = $main } | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))

function Wait-ForElement($area, $label, [System.Windows.Automation.ControlType]$ControlType = $null) {
    $deadline = (Get-Date).AddSeconds(15)
    do {
        $elements = $area.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition
        )
        foreach ($element in $elements) {
            if ($element.Current.Name -like $label -and -not $element.Current.IsOffscreen -and
                ($null -eq $ControlType -or $element.Current.ControlType -eq $ControlType)) { return $element }
        }
        Start-Sleep -Milliseconds 150
    } while ((Get-Date) -lt $deadline)
    $elements | ForEach-Object { $_.Current.Name } | Where-Object { $_ } | Select-Object -First 45 | Write-Host
    throw "Did not find visible UI element '$label'"
}

function Click-Element($element, [switch]$Right) {
    $bounds = $element.Current.BoundingRectangle
    if ($bounds.IsEmpty) { throw "Missing bounds for $($element.Current.Name)" }
    [FilepaceSmokeMouse]::Click(($bounds.Left + $bounds.Width / 2), ($bounds.Top + $bounds.Height / 2), $Right.IsPresent)
}

function Assert-TaskPanelClosed($area) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty, '关闭任务面板'
    )
    if ($area.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)) {
        throw 'A file task opened the task panel automatically'
    }
}

function Enter-Text($element, [string]$value) {
    Click-Element $element
    Set-Clipboard -Value $value
    [FilepaceSmokeMouse]::ControlKey(65)
    [FilepaceSmokeMouse]::ControlKey(86)
}

function Scroll-Analysis($area, [bool]$ToBottom) {
    $elements = $area.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($element in $elements) {
        if ($element.Current.IsOffscreen) { continue }
        $pattern = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pattern) -and
            $pattern.Current.VerticallyScrollable) {
            $position = if ($ToBottom) { 100 } else { 0 }
            $pattern.SetScrollPercent([System.Windows.Automation.ScrollPattern]::NoScroll, $position)
            Start-Sleep -Milliseconds 200
            return
        }
    }
}

function Assert-Fixture([string]$path) {
    $deadline = (Get-Date).AddSeconds(10)
    while (-not (Test-Path $path) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if ([IO.File]::ReadAllText($path) -ne $content) { throw "Unexpected contents at $path" }
}

function Close-Properties {
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    $deadline = (Get-Date).AddSeconds(15)
    do {
        $windows = $desktop.FindAll(
            [System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.Condition]::TrueCondition
        )
        foreach ($window in $windows) {
            $name = $window.Current.Name
            if ($name -match '^copy(?:\.txt)? Properties$') {
                Write-Host "Observed native properties window: $name"
                $pattern = $null
                if ($window.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$pattern)) {
                    $pattern.Close()
                } else {
                    [FilepaceSmokeMouse]::Close([IntPtr]$window.Current.NativeWindowHandle)
                }
                return
            }
        }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    $windows | ForEach-Object { Write-Host "Window: $($_.Current.Name)" }
    throw 'Did not observe the native properties window'
}

function Wait-ForForegroundProcess([string]$name) {
    $deadline = (Get-Date).AddSeconds(10)
    do {
        $process = Get-Process -Id ([FilepaceSmokeMouse]::ForegroundProcess()) -ErrorAction SilentlyContinue
        if ($process.ProcessName -eq $name) { return }
        Start-Sleep -Milliseconds 150
    } while ((Get-Date) -lt $deadline)
    throw "Did not observe $name in the foreground"
}

$app = $null
try {
    $install = Start-Process $installers[0].FullName -ArgumentList '/S' -Wait -PassThru
    if ($install.ExitCode -ne 0 -or -not (Test-Path $executable)) { throw 'Installation failed' }
    $app = Start-Process $executable -PassThru
    $deadline = (Get-Date).AddSeconds(20)
    do {
        if ($app.HasExited) { throw "Filepace exited with $($app.ExitCode)" }
        Start-Sleep -Milliseconds 250
        $app.Refresh()
    } while ($app.MainWindowHandle -eq 0 -and (Get-Date) -lt $deadline)
    if ($app.MainWindowHandle -eq 0) { throw 'Filepace did not open a window' }
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)

    Click-Element (Wait-ForElement $window '存储概览')
    $null = Wait-ForElement $window '*已用比例'
    Click-Element (Wait-ForElement $window '目录分析')
    $null = Wait-ForElement $window '扫描范围'
    Click-Element (Wait-ForElement $window '开始扫描')
    $null = Wait-ForElement $window '文件分类'
    Click-Element (Wait-ForElement $window '图片*1*')
    $null = Wait-ForElement $window '最大的文件 · 图片'
    Click-Element (Wait-ForElement $window '返回文件')
    Write-Host 'Verified volume data, directory scan, and category filtering in the installed app.'

    Click-Element (Wait-ForElement $window '目录分析')
    Click-Element (Wait-ForElement $window '智能诊断' ([System.Windows.Automation.ControlType]::TabItem))
    Scroll-Analysis $window $true
    Click-Element (Wait-ForElement $window 'AI 工具' ([System.Windows.Automation.ControlType]::ComboBox))
    # Native HTML select type-ahead selects Codex even if another CLI was detected.
    foreach ($key in @(36, 67, 79, 68, 69, 88, 13)) {
        [FilepaceSmokeMouse]::PressKey($key)
    }
    Scroll-Analysis $window $true
    Click-Element (Wait-ForElement $window '指定命令路径')
    Scroll-Analysis $window $true
    Enter-Text (Wait-ForElement $window 'Codex 可执行文件' ([System.Windows.Automation.ControlType]::Edit)) $diagnosisCommand
    Click-Element (Wait-ForElement $window '重新检测')
    Scroll-Analysis $window $false
    $start = Wait-ForElement $window '开始诊断'
    $deadline = (Get-Date).AddSeconds(10)
    while (-not $start.Current.IsEnabled -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if (-not $start.Current.IsEnabled) { throw 'The local diagnosis fixture was not enabled' }
    Click-Element $start
    $deadline = (Get-Date).AddSeconds(10)
    while (-not (Test-Path $diagnosisStarted) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path $diagnosisStarted)) { throw 'The local diagnosis fixture did not receive a request' }
    $prompt = [IO.File]::ReadAllText($diagnosisPrompt, [Text.Encoding]::UTF8)
    if (-not $prompt.Contains(('"scopeName":"' + [IO.Path]::GetFileName($source) + '"'))) {
        throw 'Diagnosis did not use the original source directory snapshot'
    }
    Click-Element (Wait-ForElement $window '返回文件')
    $leftPane = Wait-ForElement $window '左栏'
    Click-Element (Wait-ForElement $leftPane '编辑路径')
    Enter-Text (Wait-ForElement $leftPane '完整路径') $destination
    [FilepaceSmokeMouse]::PressKey(13)
    $null = Wait-ForElement $leftPane '这个文件夹还是空的'
    if (Test-Path $diagnosisFinished) { throw 'Diagnosis completed before background directory navigation' }
    [IO.File]::WriteAllText($diagnosisRelease, 'ready')
    Click-Element (Wait-ForElement $window ('诊断已完成：' + [IO.Path]::GetFileName($source)))
    Scroll-Analysis $window $true
    $null = Wait-ForElement $window 'FILEPACE_NATIVE_DIAGNOSIS_FIXTURE_OK'
    Scroll-Analysis $window $false
    $null = Wait-ForElement $window $source
    if (-not (Test-Path $diagnosisFinished)) { throw 'The local diagnosis fixture did not finish' }
    Click-Element (Wait-ForElement $window '返回文件')
    $leftPane = Wait-ForElement $window '左栏'
    $null = Wait-ForElement $leftPane '这个文件夹还是空的'
    Click-Element (Wait-ForElement $leftPane '编辑路径')
    Enter-Text (Wait-ForElement $leftPane '完整路径') $source
    [FilepaceSmokeMouse]::PressKey(13)
    $null = Wait-ForElement $leftPane 'copy.txt*'
    Write-Host 'Verified native background diagnosis, directory switching, completion entry, and original report using a local CLI fixture without account usage.'

    $rightPane = Wait-ForElement $window '右栏'
    $list = (Wait-ForElement $rightPane '文件列表').Current.BoundingRectangle
    foreach ($file in @('move.docx', 'copy.txt')) {
        $from = (Wait-ForElement $window "$file*").Current.BoundingRectangle
        [FilepaceSmokeMouse]::Drag(
            ($from.Left + [Math]::Min(30, $from.Width / 2)), ($from.Top + $from.Height / 2),
            ($list.Left + 70), ($list.Bottom - 40), ($file -eq 'copy.txt')
        )
        $newFile = Join-Path $destination $file
        $deadline = (Get-Date).AddSeconds(8)
        while (-not (Test-Path $newFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
        if ([IO.File]::ReadAllText($newFile) -ne $content) { throw "Unexpected contents at $newFile" }
    }
    if (Test-Path (Join-Path $source 'move.docx')) { throw 'Move left its source behind' }
    if ([IO.File]::ReadAllText((Join-Path $source 'copy.txt')) -ne $content) { throw 'Copy changed its source' }
    Write-Host 'Verified split-pane move and Ctrl-copy.'

    $leftPane = Wait-ForElement $window '左栏'
    Click-Element (Wait-ForElement $leftPane 'copy.txt*') -Right
    Click-Element (Wait-ForElement $window '属性')
    Close-Properties
    Click-Element (Wait-ForElement $leftPane 'copy.txt*') -Right
    Click-Element (Wait-ForElement $window '复制名称')
    $null = Wait-ForElement $window '已复制名称'
    if ((Get-Clipboard -Raw) -ne 'copy.txt') { throw 'Unexpected copied file name' }
    if (-not [FilepaceSmokeMouse]::MoveWindow($app.MainWindowHandle, 8, 12, 1000, 680, $true)) {
        throw 'Could not fit the app into the test desktop'
    }
    Start-Sleep -Milliseconds 350
    Click-Element (Wait-ForElement $leftPane 'copy.txt*') -Right
    Click-Element (Wait-ForElement $window '打开方式')
    # The Shell chooser is hosted outside Filepace and may be absent from the UIA tree.
    Wait-ForForegroundProcess 'OpenWith'
    $chooser = [FilepaceSmokeMouse]::GetForegroundWindow()
    [FilepaceSmokeMouse]::PressKey(27)
    Start-Sleep -Milliseconds 400
    if ([FilepaceSmokeMouse]::GetForegroundWindow() -eq $chooser) {
        [FilepaceSmokeMouse]::Close($chooser)
        Start-Sleep -Milliseconds 350
    }
    $windowBounds = $window.Current.BoundingRectangle
    [FilepaceSmokeMouse]::Click(($windowBounds.Left + 140), ($windowBounds.Top + 13), $false)
    Wait-ForForegroundProcess 'filepace'
    Write-Host 'Verified the native Open With chooser.'

    Click-Element (Wait-ForElement $window '撤销移动')
    Assert-Fixture (Join-Path $source 'move.docx')
    if (Test-Path (Join-Path $destination 'move.docx')) { throw 'Undo left the moved file behind' }
    Assert-TaskPanelClosed $window
    Click-Element (Wait-ForElement $window '文件任务')
    $null = Wait-ForElement $window '已完成'
    Click-Element (Wait-ForElement $window '关闭任务面板')
    Click-Element (Wait-ForElement $leftPane 'copy.txt*') -Right
    Click-Element (Wait-ForElement $window '重命名')
    Enter-Text (Wait-ForElement $window '新文件名') 'renamed.txt'
    [FilepaceSmokeMouse]::PressKey(13)
    Assert-Fixture (Join-Path $source 'renamed.txt')
    Click-Element (Wait-ForElement $window '撤销改名')
    Assert-Fixture (Join-Path $source 'copy.txt')
    if (Test-Path (Join-Path $source 'renamed.txt')) { throw 'Undo left the renamed file behind' }
    Assert-TaskPanelClosed $window
    Write-Host 'Verified undo of a move and a rename.'

    Click-Element (Wait-ForElement $window '搜索子文件夹')
    Enter-Text (Wait-ForElement $window '文件名关键词') '会议查找'
    Click-Element (Wait-ForElement $window '开始搜索')
    Click-Element (Wait-ForElement $window '会议查找.txt*')
    $leftPane = Wait-ForElement $window '左栏'
    $null = Wait-ForElement $leftPane '会议查找.txt*'
    Click-Element (Wait-ForElement $leftPane '后退')
    Write-Host 'Verified searching a subfolder and revealing the result.'

    Click-Element (Wait-ForElement $leftPane 'copy.txt*') -Right
    Click-Element (Wait-ForElement $window '压缩为 ZIP')
    $zip = Wait-ForElement $leftPane 'copy.zip*'
    Assert-TaskPanelClosed $window
    Click-Element $zip -Right
    Click-Element (Wait-ForElement $window '解压到同名文件夹')
    Assert-Fixture (Join-Path $source 'copy\copy.txt')
    Assert-Fixture (Join-Path $source 'copy.txt')
    Assert-TaskPanelClosed $window
    Write-Host 'Verified ZIP creation, extraction, and original contents.'

    $mainHandle = [IntPtr]$window.Current.NativeWindowHandle
    Click-Element (Wait-ForElement $leftPane '窗口目标*') -Right
    Click-Element (Wait-ForElement $window '在新窗口打开')
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    $deadline = (Get-Date).AddSeconds(12)
    do {
        $other = $desktop.FindAll('Children', [System.Windows.Automation.Condition]::TrueCondition) |
            Where-Object { $_.Current.Name -eq 'Filepace' -and $_.Current.ProcessId -eq $app.Id -and $_.Current.NativeWindowHandle -ne $mainHandle.ToInt64() } |
            Select-Object -First 1
        if (-not $other) { Start-Sleep -Milliseconds 150 }
    } while (-not $other -and (Get-Date) -lt $deadline)
    if (-not $other) { throw 'No second Filepace window' }
    $null = Wait-ForElement $other '文件列表'
    if (-not [FilepaceSmokeMouse]::MoveWindow($mainHandle, 8, 16, 780, 680, $true)) { throw 'Could not place source window' }
    if (-not [FilepaceSmokeMouse]::MoveWindow([IntPtr]$other.Current.NativeWindowHandle, 233, 36, 780, 680, $true)) { throw 'Could not place destination window' }
    Start-Sleep -Milliseconds 500
    $list = (Wait-ForElement $other '文件列表').Current.BoundingRectangle
    $sourceBounds = $window.Current.BoundingRectangle
    $targetX = [Math]::Max($list.Right - 75, $sourceBounds.Right + 24)
    if ($targetX -ge $list.Right - 10) { throw 'No visible drop area in the destination window' }
    foreach ($file in @('detached-copy.txt', 'detached-move.txt')) {
        [FilepaceSmokeMouse]::Click(130, 30, $false)
        Start-Sleep -Milliseconds 300
        if ([FilepaceSmokeMouse]::GetForegroundWindow() -ne $mainHandle) { throw 'Source window did not activate' }
        $from = (Wait-ForElement $leftPane "$file*").Current.BoundingRectangle
        [FilepaceSmokeMouse]::Drag(
            ($from.Left + [Math]::Min(25, $from.Width / 2)), ($from.Top + $from.Height / 2),
            $targetX, ($list.Top + 65), ($file -eq 'detached-copy.txt')
        )
        Assert-Fixture (Join-Path $detached $file)
        Assert-TaskPanelClosed $other
    }
    if (Test-Path (Join-Path $source 'detached-move.txt')) { throw 'Separate-window move left its source behind' }
    Assert-Fixture (Join-Path $source 'detached-copy.txt')
    [FilepaceSmokeMouse]::Close([IntPtr]$other.Current.NativeWindowHandle)
    Write-Host 'Verified separate-window move and Ctrl-copy.'
} finally {
    if ($app -and -not $app.HasExited) {
        $null = $app.CloseMainWindow()
        if (-not $app.WaitForExit(5000)) { $app.Kill(); $app.WaitForExit() }
    }
    if (Test-Path $uninstaller) {
        $uninstall = Start-Process $uninstaller -ArgumentList '/S' -Wait -PassThru
        if ($uninstall.ExitCode -ne 0 -or (Test-Path $executable)) { throw 'Uninstallation failed' }
        Write-Host 'Uninstalled the current-user package.'
    }
}
