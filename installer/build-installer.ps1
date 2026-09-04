param(
    [string]$MakeNsis = "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$releaseDir = Join-Path $root "..\app\src-tauri\target\release"

if (-not (Test-Path (Join-Path $releaseDir "recharge.exe"))) {
    throw "recharge.exe not found in $releaseDir - run 'npm run tauri build' in app/ first."
}

if (-not (Test-Path $MakeNsis)) {
    throw "makensis.exe not found at $MakeNsis - pass -MakeNsis <path>."
}

New-Item -ItemType Directory -Force -Path (Join-Path $root "output") | Out-Null
& $MakeNsis (Join-Path $root "recharge-installer.nsi")
