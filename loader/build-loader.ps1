<#
.SYNOPSIS
    Decompiles, patches, and rebuilds Assembly-CSharp with the RechargeLoader
    bootstrap hook, then builds and deploys every mod found under mods/.

.DESCRIPTION
    This is the entire RechargeLoader build pipeline, in one script:
      1. Build Recharge.ModApi.dll (the IRechargeMod/IRechargeHost contract).
      2. Decompile the game's own Assembly-CSharp.dll (ilspycmd).
      3. Patch pauseMenuScript.cs to call RechargeLoaderBootstrap.Init(this)
         from Awake() - this is the loader's only game-code modification.
      4. Rebuild the patched Assembly-CSharp.dll.
      5. Deploy it over the game's own copy (with a one-time ORIGINAL.dll
         backup so re-running this is always safe to redo from scratch).
      6+. Build and deploy every mod under mods/<name>/ that has both a
         .csproj and a mod.json next to it - see docs/creating-a-mod.md.
    No mod needs to be registered anywhere else; dropping a new folder under
    mods/ is enough for it to be picked up on the next run.

.PARAMETER GameDir
    Path to the installed game's root folder.

.PARAMETER StatusFile
    Optional path to a text file this script keeps updated with its current
    phase, so a GUI can poll it. Always ends with either "Done." or
    "Failed: <message>" as its last line.

.PARAMETER NoSdkDownload
    Fail instead of auto-downloading a portable .NET SDK when no compatible
    one is already on PATH.
#>
param(
    [Parameter(Mandatory = $true)][string]$GameDir,
    [string]$StatusFile,
    [switch]$NoSdkDownload
)

$ErrorActionPreference = 'Continue'

function Set-Status([string]$text) {
    Write-Host $text
    if ($StatusFile) { Set-Content -Path $StatusFile -Value $text -Force }
}

try {
    $loaderRoot = $PSScriptRoot
    $rechargeRoot = Split-Path $loaderRoot -Parent
    $ilspycmd = Join-Path $loaderRoot 'tools\ilspycmd\ilspycmd.dll'

    # Every mod is just a folder under mods/ with a .csproj + mod.json - no
    # registration needed anywhere else. Discovered fresh on each build, so
    # dropping in a new mod folder is enough to have it built and deployed.
    # Counted up front so the "N/total" status lines below are accurate even
    # for phase 1 - the mod-by-mod build loop itself runs after phase 5.
    # A folder starting with "_" (e.g. mods/_template) is never auto-built -
    # that's how docs/creating-a-mod.md's copyable starter project stays out
    # of the deployed mod list without needing its own exclusion config.
    $modsSourceDir = Join-Path $rechargeRoot 'mods'
    $modProjects = @(Get-ChildItem -Path $modsSourceDir -Filter '*.csproj' -Recurse -Depth 1 -ErrorAction SilentlyContinue |
        Where-Object { (Split-Path $_.DirectoryName -Leaf) -notlike '_*' })
    $totalPhases = 5 + $modProjects.Count

    $RequiredSdkMajor = 6
    $ilspycmdRuntimeConfig = Join-Path $loaderRoot 'tools\ilspycmd\ilspycmd.runtimeconfig.json'
    if (Test-Path $ilspycmdRuntimeConfig) {
        try {
            $cfg = Get-Content $ilspycmdRuntimeConfig -Raw | ConvertFrom-Json
            $RequiredSdkMajor = [int](($cfg.runtimeOptions.framework.version) -split '\.')[0]
        }
        catch { }
    }

    function Test-SdkCompatible([string]$dotnetExePath) {
        $sdks = & $dotnetExePath --list-sdks 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $sdks) { return $false }
        foreach ($line in $sdks) {
            if ($line -match '^(\d+)\.' -and [int]$Matches[1] -ge $RequiredSdkMajor) { return $true }
        }
        return $false
    }

    function Get-DotnetExe {
        if (Test-SdkCompatible 'dotnet') { return 'dotnet' }

        $localSdkDir = Join-Path $loaderRoot '.dotnet-sdk'
        $localDotnetExe = Join-Path $localSdkDir 'dotnet.exe'
        if ((Test-Path $localDotnetExe) -and (Test-SdkCompatible $localDotnetExe)) { return $localDotnetExe }

        if ($NoSdkDownload) {
            throw "No .NET $RequiredSdkMajor+ SDK available and automatic download was declined."
        }

        Set-Status "Downloading the .NET SDK (one-time, roughly 200 MB)..."
        New-Item -ItemType Directory -Force -Path $localSdkDir | Out-Null
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $installScript = Join-Path $env:TEMP 'dotnet-install.ps1'
        Invoke-WebRequest -Uri 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installScript -UseBasicParsing
        & $installScript -Channel "$RequiredSdkMajor.0" -InstallDir $localSdkDir -NoPath *> (Join-Path $env:TEMP 'dotnet-sdk-install.log')

        if ((Test-Path $localDotnetExe) -and (Test-SdkCompatible $localDotnetExe)) { return $localDotnetExe }
        throw "Could not obtain a .NET $RequiredSdkMajor+ SDK (none installed, and the automatic portable download failed or didn't provide a compatible version - check your internet connection)."
    }

    $dotnetExe = Get-DotnetExe

    $gameDir = $GameDir
    $managed = Join-Path $gameDir 'IGTAPsnfDemo_Data\Managed'
    $backup = Join-Path $managed 'Assembly-CSharp.ORIGINAL.dll'
    $deployed = Join-Path $managed 'Assembly-CSharp.dll'
    $rechargeCache = Join-Path $managed 'Assembly-CSharp.RECHARGE.dll'

    if (-not (Test-Path $deployed)) {
        throw "No Assembly-CSharp.dll found at $deployed - is GameDir correct?"
    }
    if (-not (Test-Path $backup)) {
        Set-Status "Backing up original Assembly-CSharp.dll..."
        Copy-Item $deployed $backup
    }

    Set-Status "1/$($totalPhases): Building Recharge.ModApi.dll..."
    $modApiProj = Join-Path $loaderRoot 'ModApi\Recharge.ModApi.csproj'
    & $dotnetExe build $modApiProj -c Release "-p:ManagedDir=$managed" *> (Join-Path $env:TEMP 'recharge-modapi-build.log')
    if ($LASTEXITCODE -ne 0) { throw "Recharge.ModApi build failed - see $env:TEMP\recharge-modapi-build.log" }
    $modApiBuilt = Join-Path $loaderRoot 'ModApi\bin\Release\netstandard2.1\Recharge.ModApi.dll'
    if (-not (Test-Path $modApiBuilt)) { throw "Recharge.ModApi.dll not found after build." }
    Copy-Item $modApiBuilt $managed -Force

    Set-Status "2/$($totalPhases): Decompiling the game's original assembly..."
    $work = Join-Path $env:TEMP 'recharge-loader-build'
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    & $dotnetExe $ilspycmd -p -o $work -r $managed $backup *> (Join-Path $work 'decompile.log')
    $pauseMenuPath = Join-Path $work 'pauseMenuScript.cs'
    if (-not (Test-Path $pauseMenuPath)) { throw "Decompile failed, see $work\decompile.log" }

    Set-Status "3/$($totalPhases): Applying the RechargeLoader patch..."
    $awakeAnchor = "`t`t`tdeleteSaveButton.text = deleteSaveMessages[0].GetLocalizedString();`r`n`t`t}"
    $hookInsert = "`t`ttry { RechargeLoaderBootstrap.Init(this); }`r`n`t`tcatch (System.Exception e) { Debug.LogError(`"[Recharge] loader init failed: `" + e); }"
    $propsInsert = "`tpublic GameObject mainBitPublic => mainBit;`r`n`tpublic GameObject settingsBitPublic => settingsBit;`r`n`r`n"

    $src = Get-Content $pauseMenuPath -Raw
    if ($src -notmatch [regex]::Escape($awakeAnchor)) {
        throw "pauseMenuScript.cs didn't match the expected shape (the game may have updated)."
    }
    $src = $src -replace [regex]::Escape($awakeAnchor), ($awakeAnchor + "`r`n" + $hookInsert)
    $src = $src -replace "(?m)^\tprivate void Start\(\)", ($propsInsert + "`tprivate void Start()")
    Set-Content -Path $pauseMenuPath -Value $src -NoNewline

    Copy-Item (Join-Path $loaderRoot 'Runtime\*.cs') $work

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

    & $dotnetExe build $csprojPath -c Release *> (Join-Path $work 'build.log')
    if ($LASTEXITCODE -ne 0) { throw "Assembly-CSharp build failed (exit $LASTEXITCODE), see $work\build.log" }
    $built = Join-Path $work 'bin\Release\netstandard2.1\Assembly-CSharp.dll'
    if (-not (Test-Path $built)) { throw "Assembly-CSharp build reported success but $built is missing." }

    Set-Status "5/$($totalPhases): Deploying the patched game assembly..."
    Copy-Item $built $deployed -Force
    Copy-Item $built $rechargeCache -Force

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

        Set-Status "$($modIndex + 5)/$($totalPhases): Building mod '$($manifest.id)'..."
        $buildLog = Join-Path $env:TEMP "recharge-mod-$($manifest.id)-build.log"
        & $dotnetExe build $proj.FullName -c Release "-p:ManagedDir=$managed" *> $buildLog
        if ($LASTEXITCODE -ne 0) { throw "Mod '$($manifest.id)' build failed - see $buildLog" }

        $modBuilt = Join-Path $modDir "bin\Release\netstandard2.1\$($manifest.entryAssembly)"
        if (-not (Test-Path $modBuilt)) { throw "Mod '$($manifest.id)' built but $($manifest.entryAssembly) wasn't produced - see $buildLog" }

        # Deploy folder is keyed by the manifest's own id, not the source
        # folder name - a mod is free to rename its dev folder without that
        # becoming a breaking change for anyone with it already installed.
        $deployModDir = Join-Path $gameDir "Recharge\Mods\$($manifest.id)"
        New-Item -ItemType Directory -Force -Path $deployModDir | Out-Null
        Copy-Item $modBuilt $deployModDir -Force
        Copy-Item $manifestPath $deployModDir -Force
        # A mod creates whatever data subfolders it needs itself at runtime
        # (see IRechargeHost.ModDataDir) - the loader doesn't need to guess.
    }

    Set-Status "Done."
}
catch {
    Set-Status "Failed: $($_.Exception.Message)"
    exit 1
}
