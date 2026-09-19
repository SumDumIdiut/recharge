# Recharge

A mod manager for **IGTAP** (*an Incremental Game That's Also a Platformer*, the Steam Demo). A Tauri desktop app that finds your install, manages mods and maps, and drives RechargeLoader — a lightweight mod-loading framework that patches one call into the game's compiled code, no BepInEx required. Runs on Windows and Linux (native, or via Proton where needed).

## Installing

Run the installer from a [release](../../releases), or build it yourself:

```bash
cd app
npm install
npm run tauri build                              # Windows
npm run tauri build -- --bundles deb,appimage    # Linux
```

Windows packaging needs [PowerShell](https://learn.microsoft.com/powershell/scripting/install/installing-powershell); Linux needs [PowerShell Core](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-linux) (`pwsh`) for the same loader pipeline, plus Steam for launching the game.

## How it works

The Tauri app (JS/HTML frontend, Rust backend) manages your mods and drives RechargeLoader. "Update RechargeLoader" decompiles `Assembly-CSharp.dll`, patches in one call, rebuilds it, and redeploys it. On the next pause-menu open, the loader resolves dependencies and loads each mod's DLL.

## Layout

| Path | What it is |
|---|---|
| `app/` | The desktop app (Tauri 2 + Rust + vanilla JS) |
| `loader/` | RechargeLoader itself — build/patch pipeline and the mod API |
| `mods/` | The bundled mods (multiplayer, maps, custom skins, physics tweaks, TAS, etc.) |
| `content/` | The app's local Browse-tab catalog of packaged mods/maps |
| `installer/` | Per-platform installer build scripts |

## Mod & content hub

The app can install mods/maps directly from `codecade.co.za/recharge`, a community submission library, either from inside the app's Browse tab or via a "Beam to Client" button on the hub's own web page.
