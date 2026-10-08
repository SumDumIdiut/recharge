# Recharge

A mod manager for **IGTAP** (*an Incremental Game That's Also a Platformer*). Recharge finds your game install, installs and manages mods, maps and skins, and keeps itself up to date - on Windows and Linux.

## Download

**[Download Recharge](https://codecade.co.za/recharge/update/download)** - one small file, picked for your system (Windows: `Recharge.exe`, Linux: `recharge`; or ask for a platform: [`/download/windows-x64`](https://codecade.co.za/recharge/update/download/windows-x64), [`/download/linux-x64`](https://codecade.co.za/recharge/update/download/linux-x64)).

Run it once: it installs itself (Windows: `%LOCALAPPDATA%\Recharge`, Linux: `~/.local/share/recharge`), downloads the app, adds a start-menu / application-menu entry, and from then on starts Recharge and keeps it up to date - only changed files are downloaded, a broken update rolls back by itself. `--channel beta` switches to the beta channel, `--repair` re-checks every file, `--uninstall` removes it.

Already have Recharge from the old installer? Settings offers **Switch to the new Recharge updater**; your settings, mods and maps stay where they are.

### Legacy installers

The previous installers still work and are what existing installs update through until they switch:

- **Windows:** [`RechargeSetup.exe`](https://github.com/SumDumIdiut/recharge/releases/download/installer/RechargeSetup.exe)
- **Linux:** `curl -fsSL https://github.com/SumDumIdiut/recharge/releases/download/installer/install.sh | bash` (`apt` on Debian/Ubuntu, otherwise `~/.local`; `--user` forces that)

Every build is also on the [Releases](https://github.com/SumDumIdiut/recharge/releases) page (`.deb` for Linux, `Setup.exe` for Windows).

## What it does

- **Mods** - install, enable, disable and remove mods; the Installed tab lists enabled ones first.
- **Navigator (maps)** - play custom real-asset maps and switch between Base Game and B-Side.
- **Skinmod (skins)** - reskin the player, including custom sounds and the dash / double-jump indicators.
- **Games** - download older IGTAP builds from the library: Unity WebGL builds play in their own window (a small Electron runtime is downloaded the first time), and standalone demos are unpacked and started directly.
- **Browse and upload** - a community library at [codecade.co.za/recharge](https://codecade.co.za/recharge), with accounts so you can manage your own uploads.
- **Works with your setup** - detects Steam libraries, launches the game (through Steam/Proton on Linux), and can restore vanilla at any time. The demo can be played, but only unmodded.

## How it works

Recharge drives **RechargeLoader**, a small mod-loading framework that patches one call into the game's own compiled code (`Assembly-CSharp.dll`) - no BepInEx or injector. The patched game loads each mod's DLL from `<Game>/Recharge/Mods` when the pause menu first opens. See [`loader/README.md`](loader/README.md) and [`loader/docs/`](loader/docs) to write your own mod.

## Mods

Mod source lives in its own repositories; Recharge pulls the one you install into its mods folder and compiles it.

| Repository | Contains |
|---|---|
| [recharge-mods](https://github.com/SumDumIdiut/recharge-mods) | DOTnet (multiplayer), Example Mod, Icy Physics, TAS Tool, and a `_template` to start a new mod |
| [recharge-maps](https://github.com/SumDumIdiut/recharge-maps) | Navigator |
| [recharge-skins](https://github.com/SumDumIdiut/recharge-skins) | Skinmod, with a ready-made `skin-template` folder |

## Building from source

Needs [Rust](https://rustup.rs), Node.js, and [PowerShell](https://learn.microsoft.com/powershell/scripting/install/installing-powershell) (`pwsh` on Linux) for the loader build. On Linux also the Tauri system libraries (`libwebkit2gtk-4.1`, `gtk3`, `librsvg`).

```
cd app
npm install
npm run tauri dev                       # run it
npm run tauri build -- --no-bundle      # release binary in app/src-tauri/target/release
```

For local mod development, clone the mod repos into `mods/` (git-ignored) or point `RECHARGE_MODS_DIR` at a folder that holds them; `loader/build-loader.ps1 -GameDir <game> [-ModsDir <dir>]` compiles and deploys everything. Most changes ship without any package: the app pulls `app/src` (its screens) and `loader/` from this repo's `master` branch on launch and every 20 minutes and runs them from its data folder, so **pushing to `master` updates everyone** (a banner offers a reload). Only a change to the compiled app (`app/src-tauri`) needs a new package, which GitHub Actions versions, builds and publishes automatically. If a change adds or alters a Rust command, bump `API_LEVEL` in `app/src-tauri/src/commands/live.rs` and `apiLevel` in `app/live.json` together, so older installs wait for the package instead of loading screens they can't run. **Channels:** the live code comes from `master` (Stable) or `dev` (Beta), chosen in Settings; work on `dev`, and merge it into `master` when it's ready for everyone. Package releases are built from `master` only. For local development, set `RECHARGE_LIVE_LOCAL=<repo checkout>` to load the live bundle from disk instead of GitHub, or `RECHARGE_NO_LIVE=1` to use only the built-in screens.

## Repository layout

| Path | What it is |
|---|---|
| `app/` | The desktop app: Tauri 2 (Rust in `src-tauri/`) with a plain JS front end in `src/`. |
| `electron/` | The tiny Electron app that plays a Unity WebGL build in a window (started by Recharge's Games tab). |
| `loader/` | RechargeLoader: `build-loader.ps1` (decompile, patch, build, deploy) and the `ModApi` / `Runtime` code every mod builds against. |
| `installer/` | Installers: `bootstrap/` (the permanent, version-independent ones above), plus the Windows NSIS script and Arch `PKGBUILD`. |
| `content/` | The app's local catalog of packaged mods. |
| `launcher/` | The one-file launcher: installs itself, downloads/updates the app from the update hub (staged, hash-verified, rollback). |
| `tools/` | Developer scripts: `publish-update.mjs` (publish a build to the update hub), `build-update-dir.sh` / `.ps1` (assemble a platform dir), release helper, dev tooling. |
| `.github/workflows/` | `autorelease.yml` builds and publishes a package when the compiled app changes (`release.yml` builds a manually pushed `v*` tag); `bootstrap.yml` publishes the permanent installers; `update-hub.yml` builds launcher + app for both platforms and publishes them to the update hub (master = stable, dev = beta). It needs the repo secret **`UPDATE_KEY`** (the hub's `UPDATE_KEY`); optional variable `UPDATE_BASE`. The launcher is published only when `launcher/**` changed, or when the workflow is started by hand with "launcher" ticked (do that once for the first publish). |

## Recharge Hub

[codecade.co.za/recharge](https://codecade.co.za/recharge) is the community library. The app installs from it directly, and the site's **Beam to Client** button installs into a running Recharge through a local-only endpoint (`127.0.0.1:39284`).
