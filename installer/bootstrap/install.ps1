# Installs (or updates to) the latest Recharge release. Nothing here is tied
# to a version: it asks GitHub for the newest release each time it runs.
param(
    [switch]$DryRun,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = 'SumDumIdiut/recharge'
Write-Host 'Looking up the latest Recharge release...'
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'RechargeSetup' }
$asset = $release.assets | Where-Object { $_.name -like '*setup.exe' } | Select-Object -First 1
if (-not $asset) { throw "No Windows installer found in release $($release.tag_name)." }
Write-Host "Latest version: $($release.tag_name)"

if ($DryRun) { Write-Output $asset.browser_download_url; return }

$installer = Join-Path $env:TEMP $asset.name
Write-Host "Downloading $($asset.name)..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer -UseBasicParsing

Write-Host 'Installing...'
$proc = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
Remove-Item $installer -Force -ErrorAction SilentlyContinue
if ($proc.ExitCode -ne 0) { throw "The installer exited with code $($proc.ExitCode)." }

$exe = Join-Path $env:LOCALAPPDATA 'Recharge\recharge.exe'
if (-not $NoLaunch -and (Test-Path $exe)) { Start-Process $exe }
Write-Host 'Recharge is installed.'
