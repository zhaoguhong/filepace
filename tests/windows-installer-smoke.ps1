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
        if (copy) keybd_event(17, 0, 0, UIntPtr.Zero);
        try {
            for (int i = 1; i <= 25; i++) {
                Move(x + (targetX - x) * i / 25, y + (targetY - y) * i / 25);
                Thread.Sleep(24);
            }
        } finally {
            Mouse(4u);
            if (copy) keybd_event(17, 0, 2, UIntPtr.Zero);
        }
    }
}
'@

$root = Join-Path $env:RUNNER_TEMP ('filepace-smoke-' + [Guid]::NewGuid().ToString('N'))
$source = Join-Path $root '整理前'
$destination = Join-Path $root '整理后'
$nested = Join-Path $source '图片'
$null = New-Item -ItemType Directory -Path $nested, $destination -Force
$content = 'Filepace installer fixture'
[IO.File]::WriteAllText((Join-Path $source 'move.docx'), $content)
[IO.File]::WriteAllText((Join-Path $source 'copy.txt'), $content)
[IO.File]::WriteAllBytes((Join-Path $nested 'large.PNG'), [byte[]]::new(4096))
$appDir = Join-Path $env:LOCALAPPDATA 'Filepace'
$executable = Join-Path $appDir 'filepace.exe'
$uninstaller = Join-Path $appDir 'uninstall.exe'
$config = Join-Path $env:APPDATA 'app.filepace.desktop'
$sessionFile = Join-Path $config 'sessions.json'
if ((Test-Path $executable) -or (Test-Path $sessionFile)) { throw 'Expected a clean profile' }
$installers = @(Get-ChildItem 'src-tauri/target/release/bundle/nsis' -Filter '*-setup.exe')
if ($installers.Count -ne 1) { throw 'Expected one NSIS installer' }

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

function Wait-ForElement($area, $label) {
    $deadline = (Get-Date).AddSeconds(15)
    do {
        $elements = $area.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition
        )
        foreach ($element in $elements) {
            if ($element.Current.Name -like $label -and -not $element.Current.IsOffscreen) { return $element }
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

function Close-NativeDialog([string]$kind) {
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    $deadline = (Get-Date).AddSeconds(15)
    do {
        $windows = $desktop.FindAll(
            [System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.Condition]::TrueCondition
        )
        foreach ($window in $windows) {
            $name = $window.Current.Name
            $process = (Get-Process -Id $window.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName
            if (($kind -eq 'properties' -and $name -like '*copy.txt*Properties*') -or
                ($kind -eq 'open-with' -and ($name -match 'Open With|Select an app' -or $process -eq 'OpenWith'))) {
                Write-Host "Observed native $kind window: $name ($process)"
                $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
                return
            }
        }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    $windows | ForEach-Object { Write-Host "Window: $($_.Current.Name)" }
    throw "Did not observe the native $kind window"
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
    Click-Element (Wait-ForElement $window '开始扫描')
    $null = Wait-ForElement $window '文件分类'
    Click-Element (Wait-ForElement $window '图片*1*')
    $null = Wait-ForElement $window '最大的文件 · 图片'
    Click-Element (Wait-ForElement $window '返回文件')
    Write-Host 'Verified volume data, directory scan, and category filtering in the installed app.'

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
    Close-NativeDialog 'properties'
    Click-Element (Wait-ForElement $leftPane 'copy.txt*') -Right
    Click-Element (Wait-ForElement $window '打开方式')
    Close-NativeDialog 'open-with'
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
