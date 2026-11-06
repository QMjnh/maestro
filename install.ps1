<#
.SYNOPSIS
  Installs Maestro (one player for Spotify, YouTube, and SoundCloud) for the current user. No admin needed.

.EXAMPLE
  irm https://raw.githubusercontent.com/QMjnh/maestro/main/install.ps1 | iex

.EXAMPLE
  # With options:
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/QMjnh/maestro/main/install.ps1))) -DesktopShortcut -NoLaunch

.EXAMPLE
  # Uninstall (add -Purge to also delete your settings and playlists):
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/QMjnh/maestro/main/install.ps1))) -Uninstall
#>
param(
    # Release to install, e.g. v2.1.0. Default: the newest.
    [string]$Version = 'latest',
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\Maestro",
    # Also put a shortcut on the desktop.
    [switch]$DesktopShortcut,
    # Don't add the `maestro` command to PATH.
    [switch]$NoPath,
    # Don't start Maestro when done.
    [switch]$NoLaunch,
    [switch]$Uninstall,
    # With -Uninstall: also delete settings, playlists and Maestro's browser data.
    [switch]$Purge,
    # Install this Maestro.exe instead of downloading one.
    [string]$ExePath,
    [string]$Repo = 'QMjnh/maestro'
)

# Shared with the uninstaller that gets written next to Maestro.exe.
$MaestroCommon = @'
$ErrorActionPreference = 'Stop'

function Send-SettingChange {
    # Tell Explorer and new terminals that PATH changed.
    if (-not ('MaestroSetup.Native' -as [type])) {
        Add-Type -Namespace MaestroSetup -Name Native -MemberDefinition @"
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
"@
    }
    $r = [UIntPtr]::Zero
    [void][MaestroSetup.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$r)
}

function Set-UserPathEntry([string]$Dir, [bool]$Present) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
        # Read unexpanded so entries like %USERPROFILE%\bin stay as they are.
        $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $parts = @($current -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $Dir.TrimEnd('\')) })
        if ($Present) { $parts += $Dir }
        $updated = $parts -join ';'
        if ($updated -eq $current) { return }
        $key.SetValue('Path', $updated, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    } finally { $key.Close() }
    Send-SettingChange
}

function Stop-Maestro([string]$Dir) {
    foreach ($p in @(Get-Process Maestro -ErrorAction SilentlyContinue)) {
        if (-not $p.Path -or -not $p.Path.StartsWith($Dir, [StringComparison]::OrdinalIgnoreCase)) { continue }
        [void]$p.CloseMainWindow()
        if (-not $p.WaitForExit(5000)) { $p.Kill(); $p.WaitForExit(5000) | Out-Null }
    }
}

$StartMenuLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'Maestro.lnk'
$DesktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Maestro.lnk'
$AppPathKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\maestro.exe'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Maestro'

function Remove-Maestro([string]$Dir, [bool]$Purge) {
    Write-Host '==> Removing Maestro'
    Stop-Maestro $Dir
    Remove-Item $StartMenuLink, $DesktopLink -Force -ErrorAction SilentlyContinue
    Remove-Item $AppPathKey, $UninstallKey -Recurse -Force -ErrorAction SilentlyContinue
    Set-UserPathEntry $Dir $false
    # Maestro may have added its flag to Spotify's start-with-Windows entry; take it back out.
    $run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $spotify = (Get-ItemProperty $run -Name Spotify -ErrorAction SilentlyContinue).Spotify
    if ($spotify -match '--remote-debugging-port=\d+') {
        Set-ItemProperty $run -Name Spotify -Value (($spotify -replace '\s*--remote-debugging-port=\d+', ''))
    }
    if ($Purge) {
        Remove-Item "$env:APPDATA\Maestro", "$env:LOCALAPPDATA\Maestro" -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $Dir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host 'Maestro is uninstalled.' -ForegroundColor Green
    if (-not $Purge) { Write-Host "Your settings and playlists are still in $env:APPDATA\Maestro." }
}
'@

$MaestroUninstaller = @'
param([switch]$Purge)
'@ + "`n" + $MaestroCommon + @'

Remove-Maestro $PSScriptRoot $Purge.IsPresent
'@

function Install-Maestro {
    param($Version, $InstallDir, $DesktopShortcut, $NoPath, $NoLaunch, $Uninstall, $Purge, $ExePath, $Repo)
    . ([scriptblock]::Create($MaestroCommon))
    $InstallDir = [IO.Path]::GetFullPath($InstallDir)

    if ($Uninstall) {
        Remove-Maestro $InstallDir $Purge
        return
    }

    if (-not [Environment]::Is64BitOperatingSystem) { throw 'Maestro needs 64-bit Windows 10 or 11.' }
    $exe = Join-Path $InstallDir 'Maestro.exe'

    # ---- get Maestro.exe ----
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("Maestro-" + [guid]::NewGuid() + '.exe')
    if ($ExePath) {
        Write-Host "==> Using $ExePath"
        Copy-Item $ExePath $tmp
    } else {
        if ($Version -ne 'latest' -and $Version -notlike 'v*') { $Version = "v$Version" } # release tags are v1.2.3
        $url = if ($Version -eq 'latest') { "https://github.com/$Repo/releases/latest/download/Maestro-win-x64.exe" }
               else { "https://github.com/$Repo/releases/download/$Version/Maestro-win-x64.exe" }
        Write-Host "==> Downloading Maestro ($Version)"
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $oldProgress = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue' # the progress bar makes downloads very slow in Windows PowerShell
        try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $tmp }
        catch { throw "Couldn't download $url ($($_.Exception.Message)). Check the version name, or see https://github.com/$Repo/releases." }
        finally { $ProgressPreference = $oldProgress }
    }

    # ---- put it in place ----
    Write-Host "==> Installing to $InstallDir"
    Stop-Maestro $InstallDir # updating: close the running copy first
    New-Item -ItemType Directory -Force $InstallDir | Out-Null
    Move-Item $tmp $exe -Force
    Unblock-File $exe
    Set-Content -Path (Join-Path $InstallDir 'uninstall.ps1') -Value $MaestroUninstaller -Encoding UTF8

    # ---- make it findable: Start menu (Windows search), Win+R, PATH ----
    $shell = New-Object -ComObject WScript.Shell
    $links = @($StartMenuLink) + $(if ($DesktopShortcut) { $DesktopLink } else { @() })
    foreach ($path in $links) {
        $lnk = $shell.CreateShortcut($path)
        $lnk.TargetPath = $exe
        $lnk.WorkingDirectory = $InstallDir
        $lnk.IconLocation = "$exe,0"
        $lnk.Description = 'One player for Spotify, YouTube, and SoundCloud'
        $lnk.Save()
    }
    New-Item $AppPathKey -Force | Out-Null
    Set-ItemProperty $AppPathKey -Name '(default)' -Value $exe
    Set-ItemProperty $AppPathKey -Name Path -Value $InstallDir
    if (-not $NoPath) {
        Set-UserPathEntry $InstallDir $true
        if (($env:Path -split ';') -notcontains $InstallDir) { $env:Path = "$env:Path;$InstallDir" } # this window too
    }

    # ---- Settings > Apps entry, so it can be uninstalled like any app ----
    $info = (Get-Item $exe).VersionInfo
    New-Item $UninstallKey -Force | Out-Null
    $uninstall = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`""
    @{
        DisplayName = 'Maestro'; DisplayVersion = $info.ProductVersion.Split('+')[0]; Publisher = 'Maestro'
        DisplayIcon = $exe; InstallLocation = $InstallDir; UninstallString = $uninstall; QuietUninstallString = $uninstall
        URLInfoAbout = "https://github.com/$Repo"
    }.GetEnumerator() | ForEach-Object { Set-ItemProperty $UninstallKey -Name $_.Key -Value $_.Value }
    Set-ItemProperty $UninstallKey -Name NoModify -Value 1 -Type DWord
    Set-ItemProperty $UninstallKey -Name NoRepair -Value 1 -Type DWord
    Set-ItemProperty $UninstallKey -Name EstimatedSize -Value ([int]((Get-Item $exe).Length / 1KB)) -Type DWord

    # ---- what Maestro needs from the system ----
    $webView = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
               'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
               'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $hasWebView = $webView | Where-Object { $v = (Get-ItemProperty $_ -Name pv -ErrorAction SilentlyContinue).pv; $v -and $v -ne '0.0.0.0' }
    if (-not $hasWebView) {
        Write-Host '==> Installing Microsoft Edge WebView2 (Maestro uses it to show its window)'
        $setup = Join-Path ([IO.Path]::GetTempPath()) 'MicrosoftEdgeWebview2Setup.exe'
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -UseBasicParsing -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $setup
        Start-Process $setup -ArgumentList '/silent', '/install' -Wait
        Remove-Item $setup -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path "$env:APPDATA\Spotify\Spotify.exe")) {
        Write-Warning ('Spotify desktop app not found. Install it from https://www.spotify.com/download (or SpotX) to play Spotify songs; ' +
                       'YouTube and SoundCloud work without it. The Microsoft Store version of Spotify is not supported.')
    }

    Write-Host ''
    Write-Host "Maestro $($info.ProductVersion.Split('+')[0]) is installed." -ForegroundColor Green
    Write-Host '  Open it from the Start menu (search "Maestro"), with Win+R "maestro", or by typing `maestro` in a terminal.'
    Write-Host '  Uninstall from Settings > Apps, or with -Uninstall.'
    if (-not $NoLaunch) { Start-Process $exe }
}

# Everything runs inside the function, so `irm | iex` doesn't change settings in your PowerShell window.
try {
    Install-Maestro -Version $Version -InstallDir $InstallDir -DesktopShortcut $DesktopShortcut.IsPresent -NoPath $NoPath.IsPresent `
        -NoLaunch $NoLaunch.IsPresent -Uninstall $Uninstall.IsPresent -Purge $Purge.IsPresent -ExePath $ExePath -Repo $Repo
} catch {
    Write-Host "Maestro setup failed: $($_.Exception.Message)" -ForegroundColor Red
}
