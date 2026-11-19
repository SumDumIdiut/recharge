# Contributing to Recharge

Recharge is a community project — made by the folks who play
[IGTAP](https://store.steampowered.com/app/2440380/IGTAP/), and
**affiliated with and endorsed by the game's developers.** Contributions are
welcome, whether that's a new mod, a fix to the app or loader, or improvements
to the docs.

New here? Start with **[`docs/repo-structure.md`](docs/repo-structure.md)** for a
map of the repo and how a change becomes a release.

## Ways to contribute

- **Write a mod or a map** — you don't need to touch this repo at all. Build
  against `Recharge.ModApi` and upload from the app (**Library → Your uploads**),
  or open a PR to the content repos:
  [recharge-mods](https://github.com/SumDumIdiut/recharge-mods),
  [recharge-maps](https://github.com/SumDumIdiut/recharge-maps),
  [recharge-skins](https://github.com/SumDumIdiut/recharge-skins).
  See [`loader/docs/creating-a-mod.md`](loader/docs/creating-a-mod.md).
- **Work on the app, loader, launcher or tooling** — read on.

## Before you move files around

A few directories are load-bearing for CI and the build. **Grep for every
reference before moving or renaming anything in them, and update them all:**

- **`next/`** is a synced mirror of the canonical `recharge-next` tree. **Do
  not move, rename, or restructure anything inside it** — its layout must stay
  byte-for-byte compatible with the sync. Make app changes in `recharge-next`.
- **`app/`, `loader/`, `launcher/`, `installer/`, `content/`, `electron/`,
  `tools/`, `.github/`** are referenced by CI (`.github/workflows/*.yml`) and
  the build scripts. Treat their paths as an API.

## Branches and releases

Distribution runs through the community update hub and CDN
([codecade.co.za/recharge](https://codecade.co.za/recharge)) — **not GitHub
releases.** A push to a release branch is built and published automatically:

- **`dev` → beta channel**
- **`master` → stable channel**

So the branch tip *is* the release. Do your work on a feature branch and only
merge to `dev`/`master` when the change is ready to ship. See
[`docs/repo-structure.md`](docs/repo-structure.md) for which paths trigger which
workflow.

## Building from source

Each component builds on its own; you rarely need the whole thing at once.

| Component | Toolchain | Notes |
|---|---|---|
| App (`next/`) | .NET 10 + Node | `node next/tools/build-ui.mjs`, then `dotnet publish next/src/Recharge.App`. The app's own Settings tab can build & install the loader for you. |
| Loader (`loader/`) | .NET + PowerShell | `pwsh loader/build-loader.ps1 -GameDir "<path to the game>"`. |
| Launcher (`launcher/`) | Rust | `cargo build --release --manifest-path launcher/Cargo.toml`. |

CI does the real, reproducible builds — see `.github/workflows/update-hub.yml`
for the exact commands each platform runs.

## Pull requests

- Keep changes focused; describe what and why.
- If you touch a CI-referenced path, confirm the workflows still resolve by
  grepping `.github/workflows/` for the old and new paths.
- Be kind. This is a community project for a game we all enjoy.
