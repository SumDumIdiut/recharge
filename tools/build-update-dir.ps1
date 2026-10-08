# build-update-dir.ps1 - Windows twin of build-update-dir.sh (same layout, see there).
#   tools\build-update-dir.ps1 -Platform windows-x64|linux-x64 [-Bin <binary>] -Out <dir>
param(
  [Parameter(Mandatory)][ValidateSet('windows-x64', 'linux-x64')][string]$Platform,
  [string]$Bin = '',
  [Parameter(Mandatory)][string]$Out
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$exe = if ($Platform -eq 'windows-x64') { 'recharge.exe' } else { 'recharge' }
if (-not $Bin) {
  $tdir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $repo 'app/src-tauri/target' }
  $triple = Join-Path $tdir "x86_64-pc-windows-msvc/release/$exe"
  $Bin = if (($Platform -eq 'windows-x64') -and (Test-Path $triple)) { $triple } else { Join-Path $tdir "release/$exe" }
}
if (-not (Test-Path $Bin -PathType Leaf)) { throw "binary not found: $Bin" }

if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
New-Item -ItemType Directory -Force $Out | Out-Null
Copy-Item $Bin (Join-Path $Out $exe)
Copy-Item (Join-Path $repo 'app/live.json') (Join-Path $Out 'live.json')
Copy-Item -Recurse (Join-Path $repo 'app/src') (Join-Path $Out 'src')
New-Item -ItemType Directory -Force (Join-Path $Out 'loader'), (Join-Path $Out 'electron') | Out-Null
foreach ($d in 'ModApi', 'Runtime', 'tools') { Copy-Item -Recurse (Join-Path $repo "loader/$d") (Join-Path $Out "loader/$d") }
Copy-Item (Join-Path $repo 'loader/build-loader.ps1') (Join-Path $Out 'loader')
Copy-Item (Join-Path $repo 'electron/main.js'), (Join-Path $repo 'electron/package.json') (Join-Path $Out 'electron')
Copy-Item -Recurse (Join-Path $repo 'content') (Join-Path $Out 'content')
Copy-Item (Join-Path $repo 'app/src-tauri/icons/128x128.png') (Join-Path $Out 'icon.png')
Get-ChildItem (Join-Path $Out 'loader') -Recurse -Directory -Include bin, obj | Remove-Item -Recurse -Force
Get-ChildItem $Out -Recurse -Directory -Filter node_modules | Remove-Item -Recurse -Force

$n = (Get-ChildItem $Out -Recurse -File).Count
Write-Host "update dir for ${Platform}: $Out ($n files)"
