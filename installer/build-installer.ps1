param(
    [string]$MakeNsis = "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$releaseDir = Join-Path $root "..\app\src-tauri\target\release"
$confPath = Join-Path $root "..\app\src-tauri\tauri.conf.json"

if (-not (Test-Path (Join-Path $releaseDir "recharge.exe"))) {
    throw "recharge.exe not found in $releaseDir - run 'npm run tauri build' in app/ first."
}

if (-not (Test-Path $MakeNsis)) {
    throw "makensis.exe not found at $MakeNsis - pass -MakeNsis <path>."
}

# `cargo tauri build` copies bundle.resources INTO target/release/ but never
# removes files left over from a previous build whose resource list was
# different (confirmed: removing a mod from tauri.conf.json's resources still
# left its old folder sitting under target/release/mods/). Tauri's own NSIS
# script is immune - it enumerates files from the current config, not the
# stale directory - but this script's `File /r` in recharge-installer.nsi
# copies whatever it finds on disk, so a stale leftover would silently ship.
# Prune anything under content/loader/mods that isn't a currently-declared
# resource before packaging.
$conf = Get-Content $confPath -Raw | ConvertFrom-Json
$declared = @($conf.bundle.resources.PSObject.Properties.Value)
foreach ($top in 'content', 'loader', 'mods') {
    $dir = Join-Path $releaseDir $top
    if (-not (Test-Path $dir)) { continue }
    Get-ChildItem $dir | ForEach-Object {
        $rel = "$top/$($_.Name)"
        $known = $declared | Where-Object { $_ -eq $rel -or $_ -like "$rel/*" }
        if (-not $known) {
            Write-Host "Pruning stale resource not in tauri.conf.json: $rel"
            Remove-Item $_.FullName -Recurse -Force
        }
    }
}

New-Item -ItemType Directory -Force -Path (Join-Path $root "output") | Out-Null
& $MakeNsis (Join-Path $root "recharge-installer.nsi")
