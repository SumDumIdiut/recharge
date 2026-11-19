# Repo structure

A map of what lives where in this repository and how a change becomes a release.
Recharge is a community launcher + mod toolkit for [IGTAP](https://store.steampowered.com/app/2440380/IGTAP/);
the user-facing download is at **[codecade.co.za/recharge](https://codecade.co.za/recharge)**, not GitHub releases.

## Top-level layout

| Path | What it is |
|---|---|
| `next/` | **The current app — "Recharge", a .NET host that renders its UI in a web view (WebView2 on Windows, WebKitGTK on Linux).** This is what ships today on both channels. See the sync note below. |
| `loader/` | **RechargeLoader** — the mod-loading framework that patches a single call into the game's compiled `Assembly-CSharp.dll` (no BepInEx, no injector), plus `ModApi/`, the interface mods build against. Start at [`loader/docs/creating-a-mod.md`](../loader/docs/creating-a-mod.md). |
| `launcher/` | The tiny Rust bootstrapper users actually download. It installs the app, keeps it updated from the hub/CDN (only changed files are fetched, a bad update self-rolls-back), and serves both channels. |
| `content/` | Bundled community content and the index builder (`build-index.js`) that produces `index.json`. |
| `installer/` | Version-independent bootstrap installers (NSIS on Windows, shell on Linux, Arch `PKGBUILD`). |
| `electron/` | A small Electron "game runner" that plays a Unity WebGL build in its own window. The app downloads the Electron runtime on demand and launches this. **Not legacy** — it is how older/WebGL IGTAP builds from the Library run. |
| `tools/` | Build and publish scripts (`publish-update.mjs`, `build-next-dir.sh`, `build-update-dir.*`) and developer utilities (bots, the `course-solver/`, devtools). |
| `app/` | The previous Tauri app. Superseded as the shipping app by `next/`, but **still a live source**: CI reads `app/src/version.json` (base version), `app/live.json` (API level), and publishes the Amplifier editor from `app/src/maps/**` (see `amp-hub.yml`). Do not treat it as dead. |
| `.github/workflows/` | CI. See the pipeline below. |
| `.cargo/` | Cargo config for the Rust crates (`launcher/`, `app/src-tauri/`). |

## `next/` is a mirror — do not reorganize it

`next/` is **synced from the canonical `recharge-next` tree** (by that tree's
`tools/sync-to-recharge.sh`). Its internal layout must stay byte-for-byte
compatible with the sync, so do not move, rename, or restructure anything under
`next/`. Make changes to the app in the `recharge-next` tree and let the sync
bring them here.

## How a change ships

Distribution is the community **update hub + CDN** ([codecade.co.za/recharge](https://codecade.co.za/recharge)),
not GitHub releases. Branches map to channels:

- **`dev` → beta**
- **`master` → stable**

CI (`.github/workflows/`) reacts to pushes:

| Workflow | Fires on | Does |
|---|---|---|
| `update-hub.yml` | pushes touching `app/**` (except `app/src/maps/**`), `loader/**`, `electron/**`, `next/**`, `content/**`, `launcher/**`, or the listed `tools/` build scripts | Builds the app for Windows + Linux and publishes it to the hub for the branch's channel. The launcher binary is re-published only when `launcher/**` changed. |
| `amp-hub.yml` | pushes touching `app/src/maps/**` | Publishes just the **Amplifier** editor as its own component, so an editor fix reaches users without cutting a whole new app version. |
| `bootstrap.yml` | pushes touching `installer/bootstrap/**` (on `master`) | Rebuilds the permanent, version-independent installer. |
| `autorelease.yml`, `release.yml` | manual only (`workflow_dispatch`) | Dormant legacy GitHub-release flows, kept for reference. |

Because a push to `dev`/`master` auto-publishes, **the branch tip is the
release.** Land work on a feature branch first; only move it to `dev`/`master`
when it is meant to go out.

## Reading more

- Per-component details live in each directory's `README.md`.
- Mod authors: [`loader/docs/creating-a-mod.md`](../loader/docs/creating-a-mod.md) and [`loader/docs/api-reference.md`](../loader/docs/api-reference.md).
- Contributing workflow: [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
