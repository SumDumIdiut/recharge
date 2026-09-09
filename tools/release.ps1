<#
Builds and publishes a new Recharge release end to end: bumps the version,
builds the Tauri release binary, packages the NSIS installer, installs it
locally to verify, then commits/tags/pushes and creates a GitHub Release
with the installer attached.

This script does not write your commit message or release notes for you -
you supply them. Run it yourself whenever you want to cut a release without
going through Claude for each step.

Usage:
  .\tools\release.ps1 -Message "Fix the thing"
  .\tools\release.ps1 -Message "New feature" -Bump minor -ReleaseNotes "Adds X, fixes Y."
  .\tools\release.ps1 -Message "WIP check" -SkipPublish   # build + local install only
  .\tools\release.ps1 -Message "Retry" -SkipInstall        # skip the local install/verify step
#>
param(
    [Parameter(Mandatory = $true)][string]$Message,
    [ValidateSet("patch", "minor", "major")][string]$Bump = "patch",
    [string]$ReleaseNotes = "",
    [switch]$SkipInstall,
    [switch]$SkipPublish
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Set-VersionInFile([string]$Path, [string]$Pattern, [string]$Replacement) {
    $content = Get-Content $Path -Raw
    $updated = [regex]::Replace($content, $Pattern, $Replacement)
    if ($updated -eq $content) { throw "Version pattern not found in $Path" }
    [System.IO.File]::WriteAllText($Path, $updated)
}

# 1. Bump the version everywhere it's declared
$pkgPath = Join-Path $root "app\package.json"
$pkgJson = Get-Content $pkgPath -Raw | ConvertFrom-Json
$currentVersion = $pkgJson.version
$parts = $currentVersion -split '\.' | ForEach-Object { [int]$_ }
switch ($Bump) {
    "major" { $parts[0]++; $parts[1] = 0; $parts[2] = 0 }
    "minor" { $parts[1]++; $parts[2] = 0 }
    "patch" { $parts[2]++ }
}
$newVersion = "$($parts[0]).$($parts[1]).$($parts[2])"
Write-Host "Bumping version: $currentVersion -> $newVersion"

$escaped = [regex]::Escape($currentVersion)
Set-VersionInFile $pkgPath "`"version`":\s*`"$escaped`"" "`"version`": `"$newVersion`""
Set-VersionInFile (Join-Path $root "app\src-tauri\tauri.conf.json") "`"version`":\s*`"$escaped`"" "`"version`": `"$newVersion`""
Set-VersionInFile (Join-Path $root "app\src-tauri\Cargo.toml") "(?m)^version = `"$escaped`"" "version = `"$newVersion`""
Set-VersionInFile (Join-Path $root "installer\recharge-installer.nsi") "!define PRODUCT_VERSION `"$escaped`"" "!define PRODUCT_VERSION `"$newVersion`""

# 2. Make sure a running instance isn't holding the exe file open
Get-Process recharge -ErrorAction SilentlyContinue | Stop-Process -Force

# 3. Build the release binary
Push-Location (Join-Path $root "app")
try {
    npx tauri build
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

# 4. Package the NSIS installer
& (Join-Path $root "installer\build-installer.ps1")

$setupExe = Join-Path $root "installer\output\Recharge_${newVersion}_Setup.exe"
if (-not (Test-Path $setupExe)) { throw "Expected installer not found: $setupExe" }

# 5. Install locally and verify the FileVersion actually matches
if (-not $SkipInstall) {
    Start-Process $setupExe -ArgumentList "/S" -Wait
    Start-Sleep -Seconds 2
    $installedPath = Join-Path $env:LOCALAPPDATA "Recharge\recharge.exe"
    $installedVersion = (Get-Item $installedPath).VersionInfo.FileVersion
    Write-Host "Installed FileVersion: $installedVersion"
    if ($installedVersion -notlike "$newVersion*") {
        throw "Installed version ($installedVersion) doesn't match the build ($newVersion)"
    }
}

if ($SkipPublish) {
    Write-Host "SkipPublish set - stopping before commit/tag/push/release. Installer is at $setupExe"
    return
}

# 6. Commit, tag, push
Push-Location $root
try {
    git add -A
    git commit -m $Message
    if ($LASTEXITCODE -ne 0) { throw "git commit failed (exit $LASTEXITCODE)" }
    git tag "v$newVersion"
    git push origin master
    if ($LASTEXITCODE -ne 0) { throw "git push origin master failed (exit $LASTEXITCODE)" }
    git push origin "v$newVersion"
    if ($LASTEXITCODE -ne 0) { throw "git push origin v$newVersion failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

# 7. GitHub Release with the installer attached
$notes = if ($ReleaseNotes) { $ReleaseNotes } else { $Message }
gh release create "v$newVersion" --repo SumDumIdiut/recharge --title "V$newVersion" --notes $notes $setupExe
if ($LASTEXITCODE -ne 0) { throw "gh release create failed (exit $LASTEXITCODE)" }

Write-Host "Released v$newVersion : https://github.com/SumDumIdiut/recharge/releases/tag/v$newVersion"
