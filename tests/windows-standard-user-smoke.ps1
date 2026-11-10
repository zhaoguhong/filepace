param([Parameter(Mandatory)] [string]$Installer, [switch]$RequireEmptyRuntime)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Use a disposable Windows runner' }
$Installer = (Resolve-Path $Installer).Path
$name = 'Filepace' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$staging = Join-Path $env:PUBLIC $name
$null = New-Item -ItemType Directory $staging
Copy-Item $Installer (Join-Path $staging 'setup.exe')
$password = ConvertTo-SecureString ("Aa1!" + [Guid]::NewGuid().ToString('N')) -AsPlainText -Force
$account = New-LocalUser -Name $name -Password $password -AccountNeverExpires
try {
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account -ErrorAction SilentlyContinue
    $null = icacls $staging /grant "*$($account.SID):(OI)(CI)M"
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant access to the test fixture' }
    if ($RequireEmptyRuntime) { New-Item -ItemType File (Join-Path $staging 'require-empty') | Out-Null }
    @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Start-Transcript (Join-Path $PSScriptRoot 'check.log') | Out-Null
$app = $null
function RuntimeVersion {
    $key = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($prefix in @('HKLM:\SOFTWARE\WOW6432Node', 'HKLM:\SOFTWARE', 'HKCU:\SOFTWARE')) {
        $value = (Get-ItemProperty "$prefix\Microsoft\EdgeUpdate\Clients\$key" -ErrorAction SilentlyContinue).pv
        if ($value -and $value -ne '0.0.0.0') { return $value }
    }
}
try {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Expected an unelevated standard user'
    }
    $before = RuntimeVersion
    Write-Host "WebView2 before installation: $before"
    if ((Test-Path (Join-Path $PSScriptRoot 'require-empty')) -and $before) {
        throw 'WebView2 was already installed'
    }
    $profile = [Environment]::GetFolderPath('LocalApplicationData')
    $appFolder = Join-Path $profile 'Filepace'
    $executable = Join-Path $appFolder 'filepace.exe'
    if (Test-Path $executable) { throw 'Expected a fresh user profile' }
    $setup = Start-Process (Join-Path $PSScriptRoot 'setup.exe') -ArgumentList '/S' -PassThru
    if (-not $setup.WaitForExit(180000)) { $setup.Kill(); throw 'Installation timed out' }
    if ($setup.ExitCode -ne 0 -or -not (Test-Path $executable)) { throw "Installer exit code: $($setup.ExitCode)" }
    $after = RuntimeVersion
    if (-not $after) { throw 'No WebView2 runtime was detected after installation' }
    Write-Host "WebView2 after installation: $after"
    $app = Start-Process $executable -PassThru
    $deadline = (Get-Date).AddSeconds(25)
    do {
        Start-Sleep -Milliseconds 300
        $app.Refresh()
        if ($app.HasExited) { throw "Filepace exited with $($app.ExitCode)" }
        $browser = Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe' AND ParentProcessId = $($app.Id)"
    } while ((-not $browser -or $app.MainWindowHandle -eq 0) -and (Get-Date) -lt $deadline)
    if (-not $browser -or $app.MainWindowHandle -eq 0) { throw 'Filepace did not open a WebView2 window' }
    $null = $app.CloseMainWindow()
    if (-not $app.WaitForExit(5000)) { throw 'Filepace did not close' }
    $uninstall = Start-Process (Join-Path $appFolder 'uninstall.exe') -ArgumentList '/S' -Wait -PassThru
    if ($uninstall.ExitCode -ne 0 -or (Test-Path $executable)) { throw 'Uninstallation failed' }
    Write-Host 'Verified install, WebView2 launch, and uninstall from an unelevated standard account.'
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'verified'), 'ok')
    exit 0
} catch {
    Write-Host $_
    exit 1
} finally {
    if ($app -and -not $app.HasExited) { $app.Kill() }
    Stop-Transcript | Out-Null
}
'@ | Set-Content (Join-Path $staging 'check.ps1') -Encoding UTF8
    $options = @{
        Credential = [Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$name", $password)
        LoadUserProfile = $true
        WorkingDirectory = $staging
        ArgumentList = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File check.ps1'
        PassThru = $true
    }
    $check = Start-Process "$PSHOME\powershell.exe" @options
    if (-not $check.WaitForExit(240000)) { $check.Kill(); throw 'Standard-user check timed out' }
    $log = Join-Path $staging 'check.log'
    if (Test-Path $log) {
        Get-Content $log | Where-Object { $_ -match '^WebView2|^Verified|^Filepace|^Installer|^No WebView2|^Expected|^An error' } | Write-Host
    }
    # The cross-account process handle can report a null ExitCode.
    if (-not (Test-Path (Join-Path $staging 'verified'))) {
        throw "Standard-user check failed with exit code $($check.ExitCode)"
    }
} finally {
    Remove-LocalUser -SID $account.SID
    Remove-Item $staging -Recurse -Force
}
