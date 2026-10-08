param(
    [Parameter(Mandatory = $true)][string]$GameDir,
    [string]$StatusFile,
    [switch]$NoSdkDownload,
    [string]$SteamAppId,
    [string]$ModsDir
)

$ErrorActionPreference = 'Continue'

# Without these, dotnet's very first invocation on a machine (or against a
# freshly-installed SDK) silently spends a few minutes on one-time setup -
# expanding its NuGet fallback folder and printing a welcome banner - with no
# console output the status bar can show, so the "Building..." step looks
# hung. This skips that.
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'

# A path saved in its Windows extended-length form (\\?\C:\...) makes Windows
# PowerShell's Join-Path/Test-Path fail with 'the value of argument "drive" is
# null', so hand every incoming path over in its plain form.
function ConvertTo-PlainPath([string]$p) {
    if (-not $p) { return $p }
    if ($p -match '^\\\\\?\\UNC\\') { return '\\' + $p.Substring(8) }
    if ($p -match '^\\\\\?\\') { return $p.Substring(4) }
    return $p
}
$GameDir = ConvertTo-PlainPath $GameDir
$ModsDir = ConvertTo-PlainPath $ModsDir
$StatusFile = ConvertTo-PlainPath $StatusFile

$IsWindowsPlatform = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)
$DotnetExeName = if ($IsWindowsPlatform) { 'dotnet.exe' } else { 'dotnet' }
$TempDir = [System.IO.Path]::GetTempPath()

function Set-Status([string]$text) {
    Write-Host $text
    if ($StatusFile) { Set-Content -Path $StatusFile -Value $text -Force }
}

function Invoke-LoggedBuild([string]$LogPath, [string]$Exe, $ExeArgs) {
    $output = & $Exe @ExeArgs 2>&1 | Out-String
    try { Set-Content -Path $LogPath -Value $output -Force -ErrorAction Stop } catch { }
    return [PSCustomObject]@{ Output = $output; ExitCode = $LASTEXITCODE; LogPath = $LogPath }
}

function Format-BuildFailure([string]$Prefix, $Result) {
    $lines = $Result.Output -split "`r?`n" | Where-Object { $_.Trim() }
    $tail = ($lines | Select-Object -Last 12) -join "`n"
    if (-not $tail) { $tail = "(no output captured)" }
    return "${Prefix}:`n$tail`n(full log: $($Result.LogPath))"
}

try {
    $loaderRoot = $PSScriptRoot
    $rechargeRoot = Split-Path $loaderRoot -Parent
    $ilspycmd = Join-Path $loaderRoot 'tools/ilspycmd/ilspycmd.dll'

    # Mod sources live one folder per repo under the mods dir (a repo is either
    # a single mod or a folder of mods), so projects can sit two levels down.
    $modsSourceDir = if ($ModsDir) { $ModsDir } elseif ($env:RECHARGE_MODS_DIR) { $env:RECHARGE_MODS_DIR } else { Join-Path $rechargeRoot 'mods' }
    $modProjects = @(Get-ChildItem -Path $modsSourceDir -Filter '*.csproj' -Recurse -Depth 2 -ErrorAction SilentlyContinue |
        Where-Object { (Split-Path $_.DirectoryName -Leaf) -notlike '_*' })
    $totalPhases = 5 + $modProjects.Count

    # Namespaced by PID so two overlapping runs (e.g. two callers invoking the
    # installer at once) never share a working directory and step on each
    # other's in-progress decompiled/patched source.
    $copyRoot = Join-Path $TempDir "recharge-loader-copies-$PID"
    Remove-Item -Recurse -Force $copyRoot -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $copyRoot | Out-Null

    $RequiredSdkMajor = 6
    $ilspycmdRuntimeConfig = Join-Path $loaderRoot 'tools/ilspycmd/ilspycmd.runtimeconfig.json'
    if (Test-Path $ilspycmdRuntimeConfig) {
        try {
            $cfg = Get-Content $ilspycmdRuntimeConfig -Raw | ConvertFrom-Json
            $RequiredSdkMajor = [int](($cfg.runtimeOptions.framework.version) -split '\.')[0]
        }
        catch { }
    }

    function Test-SdkCompatible([string]$dotnetExePath) {
        try {
            $sdks = & $dotnetExePath --list-sdks 2>$null
        }
        catch { return $false }
        if ($LASTEXITCODE -ne 0 -or -not $sdks) { return $false }
        foreach ($line in $sdks) {
            if ($line -match '^(\d+)\.' -and [int]$Matches[1] -ge $RequiredSdkMajor) { return $true }
        }
        return $false
    }

    function Get-DotnetExe {
        if (Test-SdkCompatible 'dotnet') { return 'dotnet' }

        $localSdkDir = Join-Path $loaderRoot '.dotnet-sdk'
        $localDotnetExe = Join-Path $localSdkDir $DotnetExeName
        if ((Test-Path $localDotnetExe) -and (Test-SdkCompatible $localDotnetExe)) { return $localDotnetExe }

        if ($NoSdkDownload) {
            throw "No .NET $RequiredSdkMajor+ SDK available and automatic download was declined."
        }

        Set-Status "Downloading the .NET SDK (one-time, roughly 200 MB)..."
        New-Item -ItemType Directory -Force -Path $localSdkDir | Out-Null
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $installScript = Join-Path $TempDir 'dotnet-install.ps1'
        Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/dotnet/install-scripts/v2026.07.21/src/dotnet-install.ps1' -OutFile $installScript -UseBasicParsing
        if (-not (Test-Path $installScript) -or (Get-Item $installScript).Length -lt 1000) {
            throw "Downloading dotnet-install.ps1 failed or returned an unexpectedly small file - check your internet connection."
        }
        $installResult = Invoke-LoggedBuild (Join-Path $TempDir 'dotnet-sdk-install.log') $installScript @{ Channel = "$RequiredSdkMajor.0"; Quality = "ga"; InstallDir = $localSdkDir; NoPath = $true }

        if ((Test-Path $localDotnetExe) -and (Test-SdkCompatible $localDotnetExe)) { return $localDotnetExe }
        throw (Format-BuildFailure "Could not obtain a .NET $RequiredSdkMajor+ SDK (check your internet connection)" $installResult)
    }

    $dotnetExe = Get-DotnetExe

    # Packaged builds get ilspycmd bundled in by the release workflow; a build
    # from source never runs that step, so loader/tools/ilspycmd is empty and
    # the decompile phase below fails with a confusing "file not found". Fetch
    # it here instead, the same way the CI step does.
    function Get-Ilspycmd {
        if (Test-Path $ilspycmd) { return $ilspycmd }
        if ($NoSdkDownload) {
            throw "ilspycmd (the decompiler tool) isn't present at $ilspycmd and automatic download was declined."
        }

        Set-Status "Downloading ilspycmd (one-time decompiler tool)..."
        $installDir = Split-Path $ilspycmd -Parent
        $tmpInstallDir = Join-Path $TempDir 'recharge-ilspycmd-install'
        Remove-Item -Recurse -Force $tmpInstallDir -ErrorAction SilentlyContinue
        $installResult = Invoke-LoggedBuild (Join-Path $TempDir 'ilspycmd-install.log') $dotnetExe @('tool', 'install', 'ilspycmd', '--tool-path', $tmpInstallDir)
        if ($installResult.ExitCode -ne 0) { throw (Format-BuildFailure "Could not install ilspycmd (check your internet connection)" $installResult) }

        # --tool-path installs a shim + nested .store/, not the flat DLL folder
        # this script expects, so the real files get copied up from there.
        $storeDll = Get-ChildItem -Path (Join-Path $tmpInstallDir '.store') -Filter 'ilspycmd.dll' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $storeDll) {
            throw "ilspycmd installed, but ilspycmd.dll wasn't found under $tmpInstallDir\.store"
        }
        New-Item -ItemType Directory -Force -Path $installDir | Out-Null
        Copy-Item -Path (Join-Path $storeDll.DirectoryName '*') -Destination $installDir -Recurse -Force
        Remove-Item -Recurse -Force $tmpInstallDir -ErrorAction SilentlyContinue

        if (-not (Test-Path $ilspycmd)) { throw "ilspycmd.dll still missing after install." }
        return $ilspycmd
    }

    Get-Ilspycmd | Out-Null

    $gameDir = $GameDir

    if ($SteamAppId) {
        Set-Content -Path (Join-Path $gameDir 'steam_appid.txt') -Value $SteamAppId -Force -NoNewline
    }

    $dataDir = Get-ChildItem -Path $gameDir -Directory -Filter '*_Data' -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'Managed') } |
        Select-Object -First 1
    if (-not $dataDir) {
        throw "No <Name>_Data folder with a Managed subfolder found under $gameDir - is GameDir correct?"
    }
    $managed = Join-Path $dataDir.FullName 'Managed'
    $backup = Join-Path $managed 'Assembly-CSharp.ORIGINAL.dll'
    $deployed = Join-Path $managed 'Assembly-CSharp.dll'
    $rechargeCache = Join-Path $managed 'Assembly-CSharp.RECHARGE.dll'

    if (-not (Test-Path $deployed)) {
        throw "No Assembly-CSharp.dll found at $deployed - is GameDir correct?"
    }

    # $deployed is whatever the last run of this script left behind: either
    # our own patched build (== $rechargeCache) or our own restored backup
    # (== $backup). If it matches NEITHER, Steam must have dropped a fresh
    # file there since - a real game update (or the very first install) -
    # and the old $backup is now stale. Decompiling a stale backup would
    # patch an out-of-date class layout onto the new build's scene/level
    # data, which Unity reports as the level data being "corrupted" rather
    # than as a clear version-mismatch error - so always re-derive $backup
    # from whatever Steam currently has deployed, not just once ever.
    $deployedHash = (Get-FileHash $deployed -Algorithm SHA256).Hash
    $backupHash = if (Test-Path $backup) { (Get-FileHash $backup -Algorithm SHA256).Hash } else { $null }
    $rechargeHash = if (Test-Path $rechargeCache) { (Get-FileHash $rechargeCache -Algorithm SHA256).Hash } else { $null }
    if ($deployedHash -ne $backupHash -and $deployedHash -ne $rechargeHash) {
        Set-Status $(if (Test-Path $backup) { "Detected a game update - refreshing the backed-up original assembly..." } else { "Backing up original Assembly-CSharp.dll..." })
        Copy-Item $deployed $backup -Force
    }

    Set-Status "1/$($totalPhases): Building Recharge.ModApi.dll..."
    $modApiWorkDir = Join-Path $copyRoot 'ModApi'
    Copy-Item -Recurse -Force (Join-Path $loaderRoot 'ModApi') $copyRoot
    Get-ChildItem -Path $modApiWorkDir -Recurse -Directory -Include 'obj', 'bin' -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    $modApiProj = Join-Path $modApiWorkDir 'Recharge.ModApi.csproj'
    $modApiResult = Invoke-LoggedBuild (Join-Path $TempDir 'recharge-modapi-build.log') $dotnetExe @("build", $modApiProj, "-c", "Release", "-p:ManagedDir=$managed")
    if ($modApiResult.ExitCode -ne 0) { throw (Format-BuildFailure "Recharge.ModApi build failed" $modApiResult) }
    $modApiBuilt = Join-Path $modApiWorkDir 'bin/Release/netstandard2.1/Recharge.ModApi.dll'
    if (-not (Test-Path $modApiBuilt)) { throw "Recharge.ModApi.dll not found after build." }
    Copy-Item $modApiBuilt $managed -Force

    Set-Status "2/$($totalPhases): Decompiling the game's original assembly..."
    $work = Join-Path $TempDir "recharge-loader-build-$PID"
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $decompileResult = Invoke-LoggedBuild (Join-Path $work 'decompile.log') $dotnetExe @($ilspycmd, "-p", "-o", $work, "-r", $managed, $backup)
    $pauseMenuPath = Join-Path $work 'pauseMenuScript.cs'
    if (-not (Test-Path $pauseMenuPath)) { throw (Format-BuildFailure "Decompile failed" $decompileResult) }

    Set-Status "3/$($totalPhases): Applying the RechargeLoader patch..."
    $awakeAnchor = "`t`t`tdeleteSaveButton.text = deleteSaveMessages[0].GetLocalizedString();`n`t`t}"
    $hookInsert = "`t`ttry { RechargeLoaderBootstrap.Init(this); }`n`t`tcatch (System.Exception e) { Debug.LogError(`"[Recharge] loader init failed: `" + e); }"
    $propsInsert = "`tpublic GameObject mainBitPublic => mainBit;`n`tpublic GameObject settingsBitPublic => settingsBit;`n`n"

    $src = (Get-Content $pauseMenuPath -Raw) -replace "`r`n", "`n"
    if ($src -notmatch [regex]::Escape($awakeAnchor) -and $src -notmatch [regex]::Escape("RechargeLoaderBootstrap.Init")) {
        throw "pauseMenuScript.cs didn't match the expected shape (the game may have updated)."
    }
    # A backup that was already patched by an earlier run (a stale/corrupted
    # ORIGINAL.dll) decompiles with the hook/properties already present -
    # inserting them again would duplicate-define mainBitPublic/settingsBitPublic.
    if ($src -notmatch [regex]::Escape("RechargeLoaderBootstrap.Init")) {
        $src = $src -replace [regex]::Escape($awakeAnchor), ($awakeAnchor + "`n" + $hookInsert)
        $src = $src -replace "(?m)^\tprivate void Start\(\)", ($propsInsert + "`tprivate void Start()")
        Set-Content -Path $pauseMenuPath -Value $src -NoNewline
    }

    Copy-Item (Join-Path $loaderRoot 'Runtime/*.cs') $work

    Set-Status "4/$($totalPhases): Building the patched game assembly..."
    $csprojPath = Join-Path $work 'Assembly-CSharp.csproj'
    $refs = @(
        'UnityEngine.CoreModule', 'UnityEngine.ParticleSystemModule', 'UnityEngine.AudioModule',
        'Unity.TextMeshPro', 'Unity.Localization', 'UnityEngine.AnimationModule', 'Unity.InputSystem',
        'UnityEngine.Physics2DModule', 'UnityEngine.UI', 'Unity.RenderPipelines.Universal.2D.Runtime',
        'UnityEngine.ImageConversionModule',
        'com.rlabrecque.steamworks.net', 'UnityEngine.TilemapModule', 'UnityEngine.UIModule', 'DOTween',
        'UnityEngine.JSONSerializeModule', 'Unity.Mathematics', 'Assembly-CSharp-firstpass', 'UnityEngine',
        'UnityEngine.UIElementsModule', 'Newtonsoft.Json', 'UnityEngine.TextRenderingModule', 'Recharge.ModApi'
    )
    $refXml = ($refs | ForEach-Object {
        "    <Reference Include=`"$_`"><HintPath>$managed\$_.dll</HintPath></Reference>"
    }) -join "`n"
    @"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <AssemblyName>Assembly-CSharp</AssemblyName>
    <GenerateAssemblyInfo>False</GenerateAssemblyInfo>
    <TargetFramework>netstandard2.1</TargetFramework>
    <LangVersion>latest</LangVersion>
    <AllowUnsafeBlocks>True</AllowUnsafeBlocks>
    <CheckForOverflowUnderflow>False</CheckForOverflowUnderflow>
    <GenerateDependencyFile>False</GenerateDependencyFile>
  </PropertyGroup>
  <ItemGroup>
$refXml
  </ItemGroup>
</Project>
"@ | Set-Content -Path $csprojPath

    $csBuildResult = Invoke-LoggedBuild (Join-Path $work 'build.log') $dotnetExe @("build", $csprojPath, "-c", "Release")
    if ($csBuildResult.ExitCode -ne 0) { throw (Format-BuildFailure "Assembly-CSharp build failed" $csBuildResult) }
    $built = Join-Path $work 'bin/Release/netstandard2.1/Assembly-CSharp.dll'
    if (-not (Test-Path $built)) { throw "Assembly-CSharp build reported success but $built is missing." }

    Set-Status "5/$($totalPhases): Deploying the patched game assembly..."
    Copy-Item $built $deployed -Force
    Copy-Item $built $rechargeCache -Force
    # This script writes the dll straight into Managed, bypassing the app's deploy_build.
    # Without refreshing the stamp the next launch sees a stale one, reads it as a game
    # update, and overwrites ORIGINAL with our patched build - losing the only vanilla copy.
    # FNV-1a over the deployed bytes - the same hash the app's deploy_build compares.
    # BigInteger, because the multiply overflows 64 bits on every single byte.
    $mask = [System.Numerics.BigInteger]::Pow(2, 64) - 1
    $h = [System.Numerics.BigInteger]0xcbf29ce484222325
    foreach ($b in [System.IO.File]::ReadAllBytes($deployed)) {
        $h = ($h -bxor [System.Numerics.BigInteger]$b) * 0x100000001b3
        $h = $h -band $mask
    }
    Set-Content -Path (Join-Path $managed 'Assembly-CSharp.deployed.stamp') -Value ('{0:x16}' -f [uint64]$h) -NoNewline -Force

    $modIndex = 0
    foreach ($proj in $modProjects) {
        $modIndex++
        $modDir = $proj.DirectoryName
        $modFolderName = Split-Path $modDir -Leaf
        $manifestPath = Join-Path $modDir 'mod.json'
        if (-not (Test-Path $manifestPath)) {
            Write-Host "  Skipping '$modFolderName' - no mod.json next to $($proj.Name)."
            continue
        }
        $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
        if (-not $manifest.id -or -not $manifest.entryAssembly) {
            Write-Host "  Skipping '$modFolderName' - mod.json is missing id or entryAssembly."
            continue
        }

        $modWorkDir = Join-Path $copyRoot "mods/$modFolderName"
        Copy-Item -Recurse -Force $modDir $modWorkDir
        Get-ChildItem -Path $modWorkDir -Recurse -Directory -Include 'obj', 'bin' -ErrorAction SilentlyContinue |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

        Set-Status "$($modIndex + 5)/$($totalPhases): Building mod '$($manifest.id)'..."
        $buildLog = Join-Path $TempDir "recharge-mod-$($manifest.id)-build.log"
        $modResult = Invoke-LoggedBuild $buildLog $dotnetExe @("build", (Join-Path $modWorkDir $proj.Name), "-c", "Release", "-p:ManagedDir=$managed")
        if ($modResult.ExitCode -ne 0) { throw (Format-BuildFailure "Mod '$($manifest.id)' build failed" $modResult) }

        $modBuilt = Join-Path $modWorkDir "bin/Release/netstandard2.1/$($manifest.entryAssembly)"
        if (-not (Test-Path $modBuilt)) { throw (Format-BuildFailure "Mod '$($manifest.id)' built but $($manifest.entryAssembly) wasn't produced" $modResult) }

        $deployModDir = Join-Path $gameDir "Recharge/Mods/$($manifest.id)"
        New-Item -ItemType Directory -Force -Path $deployModDir | Out-Null
        Copy-Item $modBuilt $deployModDir -Force
        $deployedManifestPath = Join-Path $deployModDir 'mod.json'
        if (Test-Path $deployedManifestPath) {
            $deployedManifest = Get-Content $deployedManifestPath -Raw | ConvertFrom-Json
            if ($null -ne $deployedManifest.enabled -and $manifest.id -ne 'recharge.maps') { $manifest.enabled = $deployedManifest.enabled }
        }
        $manifest | ConvertTo-Json -Depth 10 | Set-Content -NoNewline -Path $deployedManifestPath
    }

    Set-Status "Done."
}
catch {
    Set-Status "Failed: $($_.Exception.Message)"
    exit 1
}
