[CmdletBinding()]
param(
    [switch]$StartAtLogin,
    [switch]$Uninstall,
    [ValidateSet(30, 60, 120)][int]$MaxFps,
    [string]$AntigravityPath
)

$ErrorActionPreference = 'Stop'
$package = Join-Path $env:LOCALAPPDATA 'Wallpaper-AGY-TPS'
$launcher = Join-Path $package 'Antigravity Kit.exe'
$menuLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'Antigravity Kit.lnk'
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'Antigravity Kit.lnk'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'AntigravityKit'
$node = (Get-Command node.exe).Source
$setup = Join-Path $PSScriptRoot 'scripts\setup.mjs'

if ($Uninstall) {
    & $node $setup uninstall
    if ($LASTEXITCODE -ne 0) { throw 'Gagal melepas paket.' }
    foreach ($path in $menuLink, $startupLink, $launcher, (Join-Path $package 'node-path.txt')) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
    }
    Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
    return
}

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (!(Test-Path -LiteralPath $csc)) { throw 'Windows .NET Framework 4.x diperlukan untuk membuat shortcut desktop.' }

$ffmpeg = (Get-Command ffmpeg.exe).Source
$setupArgs = @('install', '--ffmpeg-path', $ffmpeg)
if ($AntigravityPath) { $setupArgs += @('--app-path', $AntigravityPath) }
if ($MaxFps) { $setupArgs += @('--max-fps', [string]$MaxFps) }
& $node $setup @setupArgs
if ($LASTEXITCODE -ne 0) { throw 'Instalasi paket gagal.' }

$source = Join-Path $PSScriptRoot 'scripts\StartKit.cs'
& $csc /nologo /target:winexe /reference:System.Windows.Forms.dll "/out:$launcher" $source
if ($LASTEXITCODE -ne 0) { throw 'Gagal membuat peluncur Windows.' }

$shell = New-Object -ComObject WScript.Shell
function Save-KitShortcut([string]$Path) {
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $launcher
    $shortcut.WorkingDirectory = $package
    $shortcut.Description = 'Antigravity Desktop dengan wallpaper dan meter TPS'
    $shortcut.Save()
}
Save-KitShortcut $menuLink
if ($StartAtLogin) {
    Save-KitShortcut $startupLink
    # Antigravity can rewrite its own Start Menu shortcut, so keep a second
    # autostart entry in the registry as well.
    New-Item -Path $runKey -Force | Out-Null
    Set-ItemProperty -Path $runKey -Name $runName -Value ('"' + $launcher + '"') -Type String
}
Write-Host 'Buka Antigravity Kit dari Start Menu.'
