# Recharge

**A free, community-made launcher and mod toolkit for [IGTAP](https://store.steampowered.com/app/2440380/IGTAP/)** *(an Incremental Game That's Also a Platformer)*.

Browse and install mods, maps, skins and backgrounds; make your own levels in the built-in **Amplifier** editor; chat, share and call in the social layer — all from one app that finds your game, keeps itself up to date, and can restore vanilla any time.

> Made by the community, for the folks who play IGTAP. **Affiliated with and endorsed by the game's developers.**

## Download

**→ [codecade.co.za/recharge](https://codecade.co.za/recharge)** — grab the app from the Download tab (Stable or Beta), and browse the community library of mods, maps, skins and backgrounds while you're there.

One small file, picked for your system. Run it once and it installs itself, downloads the app, and keeps it updated from then on (only changed files are fetched; a bad update rolls back by itself).

| | Install notes |
|---|---|
| **Windows** | Run `Recharge.exe`. If SmartScreen warns, click *More info → Run anyway*. Installs to your user folder, no admin needed. |
| **Linux** | `chmod +x recharge && ./recharge`. Needs `webkit2gtk-4.1` (e.g. `sudo pacman -S webkit2gtk-4.1` or `sudo apt install libwebkit2gtk-4.1-0`). |
| **Updates** | Recharge updates itself. One launcher serves both channels; the channel you pick decides which build it installs. |

## What it does

- **Mods** — install, enable, disable and remove mods from the hub; the Installed tab lists enabled ones first.
- **Maps (Navigator)** — play custom real-asset maps and switch between Base Game and B-Side.
- **Amplifier** — an in-app level editor: tiling, spikes, moss, vines, movers, triggers, courses and file-definable custom items, with live playtest.
- **Skins (Skinmod)** — reskin the player, including custom sounds and the dash / double-jump indicators.
- **Social** — friends, DMs and group chats (reactions, replies, media, custom emoji), servers with text & voice channels, and 1:1 / group calls.
- **Games** — download older IGTAP builds from the library; WebGL builds play in their own window, standalone demos start directly.
- **Works with your setup** — detects Steam libraries, launches through Steam/Proton on Linux, and restores vanilla whenever you want.

## How it works

Recharge drives **RechargeLoader**, a small mod-loading framework that patches a single call into the game's own compiled code (`Assembly-CSharp.dll`) — no BepInEx, no injector. The patched game loads each mod's DLL from `<Game>/Recharge/Mods`. The desktop app itself is a .NET host that renders its UI in a web view (WebView2 on Windows, WebKitGTK on Linux) and talks to the community hub for the library, accounts and social features.

See [`loader/`](loader) for the loader and the `ModApi` your mods build against.

## Writing a mod

Mods are small .NET assemblies that reference `Recharge.ModApi`. The quickest start is the `_template` in the mods repos:

| Repository | Contains |
|---|---|
| [recharge-mods](https://github.com/SumDumIdiut/recharge-mods) | Example mods (multiplayer, physics, TAS tool, …) and a `_template` to start from |
| [recharge-maps](https://github.com/SumDumIdiut/recharge-maps) | Navigator |
| [recharge-skins](https://github.com/SumDumIdiut/recharge-skins) | Skinmod, with a ready-made `skin-template` |

Build your mod against the `ModApi`, drop the DLL (plus a `mod.json`) into `<Game>/Recharge/Mods/<your-mod>/`, and it loads the next time the game opens. Or upload it to the hub from **Library → Your uploads** so everyone can install it.

## For contributors

The app and loader live in this repo. Distribution is handled by the community hub and CDN (not GitHub releases) — a push to the beta/stable branch is picked up and published to the launcher automatically. If you want to build or hack on it, see the per-component READMEs and `docs/`.

---

Recharge is a community project. **Affiliated with and endorsed by the game's developers.** Not affiliated with Steam or Unity.
