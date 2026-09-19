<#
Builds and publishes a new Recharge release end to end: bumps the version,
builds the Tauri release binary, packages the platform installer(s),
installs/verifies locally where possible, then commits/tags/pushes and
creates (or updates) a GitHub Release with the installer(s) attached.

Cross-platform (PowerShell Core / pwsh on Linux works the same as
powershell.exe on Windows) - each OS builds and attaches its own installer
type: Windows produces the NSIS Setup.exe, Linux produces .deb + .AppImage.
A release with assets for both OSes means running this once per OS. The
first run (whichever OS) does the version bump/commit/tag/release-create;
run it again on the other OS with -AttachToExisting to just build that
platform's installer(s) and upload them onto the release the first run
already created, without re-bumping the version.

This script does not write your commit message or release notes for you -
you supply them. Run it yourself whenever you want to cut a release without

Usage:
  ./tools/release.ps1 -Message "Fix the thing"
  ./tools/release.ps1 -Message "New feature" -Bump minor -ReleaseNotes "Adds X, fixes Y."
  ./tools/release.ps1 -Message "WIP check" -SkipPublish   # build + local install only
  ./tools/release.ps1 -Message "Retry" -SkipInstall        # skip the local install/verify step
  ./tools/release.ps1 -AttachToExisting                    # (other OS, same version) build + upload only
#>
param(
    [string]$Message,
    [ValidateSet("patch", "minor", "major")][string]$Bump = "patch",
    [string]$ReleaseNotes = "",
    [switch]$SkipInstall,
    [switch]$SkipPublish,
    [switch]$AttachToExisting
)

$ErrorActionPreference = "Stop"

if (-not $AttachToExisting -and -not $Message) {
    throw "-Message is required unless -AttachToExisting is set."
}

$IsWindowsPlatform = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Set-VersionInFile([string]$Path, [string]$Pattern, [string]$Replacement) {
    $content = Get-Content $Path -Raw
    $updated = [regex]::Replace($content, $Pattern, $Replacement)
    if ($updated -eq $content) { throw "Version pattern not found in $Path" }
    [System.IO.File]::WriteAllText($Path, $updated)
}

$pkgPath = Join-Path $root "app/package.json"
$pkgJson = Get-Content $pkgPath -Raw | ConvertFrom-Json
$currentVersion = $pkgJson.version

if ($AttachToExisting) {
    # Attaching this platform's installer(s) to a release another OS already
    # created for the version currently checked out - no bump, no commit.
    $newVersion = $currentVersion
    Write-Host "Attaching $(if ($IsWindowsPlatform) { 'Windows' } else { 'Linux' }) installer(s) to existing release v$newVersion (no version bump)."
}
else {
    # 1. Bump the version everywhere it's declared
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
    Set-VersionInFile (Join-Path $root "app/src-tauri/tauri.conf.json") "`"version`":\s*`"$escaped`"" "`"version`": `"$newVersion`""
    Set-VersionInFile (Join-Path $root "app/src-tauri/Cargo.toml") "(?m)^version = `"$escaped`"" "version = `"$newVersion`""
    Set-VersionInFile (Join-Path $root "installer/recharge-installer.nsi") "!define PRODUCT_VERSION `"$escaped`"" "!define PRODUCT_VERSION `"$newVersion`""
}

# 2. Make sure a running instance isn't holding the binary open
Get-Process recharge -ErrorAction SilentlyContinue | Stop-Process -Force

$assets = @()

if ($IsWindowsPlatform) {
    # 3. Build the release binary
    Push-Location (Join-Path $root "app")
    try {
        npx tauri build
        if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }

    # 4. Package the NSIS installer
    & (Join-Path $root "installer/build-installer.ps1")

    $setupExe = Join-Path $root "installer/output/Recharge_${newVersion}_Setup.exe"
    if (-not (Test-Path $setupExe)) { throw "Expected installer not found: $setupExe" }
    $assets += $setupExe

    # 5. Install locally and verify the FileVersion actually matches
    if (-not $SkipInstall) {
        Start-Process $setupExe -ArgumentList "/S" -Wait
        Start-Sleep -Seconds 2
        $installedPath = Join-Path $env:LOCALAPPDATA "Recharge/recharge.exe"
        $installedVersion = (Get-Item $installedPath).VersionInfo.FileVersion
        Write-Host "Installed FileVersion: $installedVersion"
        if ($installedVersion -notlike "$newVersion*") {
            throw "Installed version ($installedVersion) doesn't match the build ($newVersion)"
        }
    }
}
else {
    # 3+4. Build + package the .deb/.AppImage (no separate packaging step
    # needed - Tauri's own bundlers already produce FHS-correct output).
    & (Join-Path $root "installer/build-installer-linux.sh")

    $linuxAssets = @(Get-ChildItem (Join-Path $root "installer/output") -Filter "*$newVersion*" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '\.(deb|AppImage)$' })
    if (-not $linuxAssets) { throw "No .deb/.AppImage matching version $newVersion found in installer/output/" }
    $assets += $linuxAssets.FullName

    # 5. No unattended local-install verification on Linux - a .deb install
    # needs root (pkexec/sudo), which isn't something to run unattended from
    # a release script. Spot-check manually if needed:
    #   sudo dpkg -i installer/output/Recharge_<version>_amd64.deb
    if (-not $SkipInstall) {
        Write-Host "Skipping local install/verify on Linux - not automated here, see comment above."
    }
}

if ($SkipPublish) {
    Write-Host "SkipPublish set - stopping before commit/tag/push/release. Installer(s) at: $($assets -join ', ')"
    return
}

if (-not $AttachToExisting) {
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

    # 7. GitHub Release with the installer(s) attached
    $notes = if ($ReleaseNotes) { $ReleaseNotes } else { $Message }
    gh release create "v$newVersion" --repo SumDumIdiut/recharge --title "V$newVersion" --notes $notes @assets
    if ($LASTEXITCODE -ne 0) { throw "gh release create failed (exit $LASTEXITCODE)" }
}
else {
    # 7 (attach path). --clobber lets re-running this after a failed upload
    # overwrite a partial attempt instead of erroring on a same-named asset.
    gh release upload "v$newVersion" @assets --repo SumDumIdiut/recharge --clobber
    if ($LASTEXITCODE -ne 0) { throw "gh release upload failed (exit $LASTEXITCODE)" }
}

Write-Host "Released v$newVersion : https://github.com/SumDumIdiut/recharge/releases/tag/v$newVersion"
