# RechargeLoader

RechargeLoader is the mod-loading framework for **IGTAP** (*an Incremental
Game That's Also a Platformer*). It lets independent mods load into the real
game, get a handle on real game objects (the pause menu, in particular), and
run alongside each other — without any of them needing to know about the
others, and without depending on a third-party injector like BepInEx.

Two real mods already ship on top of it — **DOTnet** (real-time multiplayer,
`mods/recharge-multiplayer/`) and **Maps** (a real-asset map system,
`mods/recharge-maps/`) — both built the same way any new mod is: a folder
under `mods/`, a `mod.json`, and one class implementing `IRechargeMod`.

- **New to modding this game?** Start with [`docs/creating-a-mod.md`](docs/creating-a-mod.md) —
  a full walkthrough from an empty folder to a mod loaded in-game.
- **Need exact types/signatures?** See [`docs/api-reference.md`](docs/api-reference.md).
- **Just want to build/install?** `pwsh loader/build-loader.ps1 -GameDir "<path to the game>"` —
  see [Building](#building) below. Recharge's own Settings tab does this for
  you with one click; the script is what actually runs.

## How it works

Most Unity mod loaders (BepInEx, MelonLoader, ...) work by hijacking the
game's *process* — a native DLL (`winhttp.dll`/Doorstop, or a similar trick)
loads before Unity does and injects a runtime that then loads mod DLLs.
RechargeLoader does something different and much smaller in scope: it patches
**one call** into the game's own compiled code.

```
                    ┌─────────────────────────────────────────┐
                    │            Assembly-CSharp.dll            │
                    │                                           │
  build-loader.ps1  │   pauseMenuScript.Awake()                │
   patches this ──► │     ...                                  │
   one call in      │     RechargeLoaderBootstrap.Init(this);  │
                    │     ...                                  │
                    └───────────────────┬───────────────────────┘
                                         │ first pause menu open
                                         ▼
                    ┌─────────────────────────────────────────┐
                    │       RechargeLoaderBootstrap.Init        │
                    │  for each folder in <Game>/Recharge/Mods:  │
                    │    read mod.json → load <entryAssembly>  │
                    │    find the IRechargeMod in it → OnLoad  │
                    └─────────────────────────────────────────┘
```

Concretely, `build-loader.ps1`:

1. **Decompiles** the game's real `Assembly-CSharp.dll` with [ilspycmd](tools/ilspycmd)
   into a real, buildable C# project (kept in `%TEMP%\recharge-loader-build`,
   regenerated every run — nothing here is hand-maintained source).
2. **Patches** exactly one anchor in the decompiled `pauseMenuScript.cs`: right
   after its `Awake()` sets up the delete-save-data button, it inserts a
   `try { RechargeLoaderBootstrap.Init(this); } catch { ... }` call. That's
   the entire modification to the game's own code — everything else a mod
   does happens from ordinary C#/Unity APIs after that point, same as any
   other MonoBehaviour-adjacent code would.
3. **Rebuilds** the whole assembly with that one line added, and **deploys**
   it over the game's own `Assembly-CSharp.dll` (after backing up the
   original once, to `Assembly-CSharp.ORIGINAL.dll` — every subsequent build
   re-patches from that clean backup, never from an already-patched copy, so
   the pipeline is idempotent and safe to re-run).
4. **Builds every mod** it finds under `mods/*/` (see
   [Building](#building)) and deploys each one's DLL + `mod.json` to
   `<GameDir>\Recharge\Mods\<mod id>\`.

At runtime, the very first time the player opens the pause menu,
`pauseMenuScript.Awake()` runs the patched-in call, `RechargeLoaderBootstrap.Init`
reads every `mod.json` under `<GameDir>\Recharge\Mods\` and resolves each
one's declared `dependencies`: a mod loads only if every dependency it
requires also loads (recursively - depending on something whose own
dependency is missing skips both), and among mods that will load, each
dependency finishes `OnLoad` before its dependents start. For each mod that
resolves, in that order: loads `entryAssembly` via `Assembly.LoadFrom`, finds
the one class in it that implements `IRechargeMod`, registers it, and calls
`OnLoad(host)`. A mod with no declared dependency on another isn't guaranteed
to load before or after it — declare `dependencies` in `mod.json` if you need
a specific mod to be present and already loaded, or subscribe to
`RechargeEvents.ModsReady` if "after everyone's loaded" is good enough (see
[`docs/api-reference.md`](docs/api-reference.md)).

No native patch, no DLL injection, no external process. If something goes
wrong, deleting `Assembly-CSharp.dll` and renaming `Assembly-CSharp.ORIGINAL.dll`
back gets you an untouched game.

## What a mod gets

Beyond the bare `IRechargeMod`/`IRechargeHost` contract, the framework
provides:

- **A session-wide event bus** (`host.Events`) — react to loader lifecycle
  events (mod loaded, all mods ready, scene loaded, player spawned) or define
  your own for talking to other mods, all without a compile-time reference to
  their assembly.
- **Per-frame hooks** (`host.OnUpdate`/`OnLateUpdate`/`OnFixedUpdate`) — no
  need to spin up your own `GameObject` just to get a tick callback.
- **Inter-mod lookup** (`host.GetMod`/`GetModApi<T>`) plus **dependency-ordered
  loading** (`mod.json`'s `dependencies`) — find another mod, or guarantee it
  loaded first.
- **Config** (`host.LoadConfig<T>`/`SaveConfig<T>`) — JSON-backed settings
  with zero boilerplate.
- **`PauseMenuHelper`** — add a real pause-menu row/sub-panel in two lines,
  extracted from the ~200-line pattern both real mods used to hand-roll
  independently. Order-independent across mods.
- **`Reflect`** — generic helpers for the game's private fields/properties/methods,
  since almost nothing on the real game classes is `public`.
- **`LoadSprite`** — turn raw PNG/JPG bytes into a real `Sprite` in one call.

Full reference for every one of these: [`docs/api-reference.md`](docs/api-reference.md).

## Why not BepInEx?

Nothing wrong with BepInEx — it's the standard tool for this and works fine
alongside other mods. RechargeLoader exists because this project wanted:

- **No separate injector to install/maintain.** A player installs one thing
  (the patched `Assembly-CSharp.dll`), not a second bootstrap layer.
- **A tiny, auditable footprint.** The entire "hook" is the one inserted line
  described above — easy to point at and say "this is everything RechargeLoader
  changes about the game's own code."
- **A build pipeline that self-repairs.** Every run re-decompiles from a
  clean backup and re-patches from scratch, so there's no drift between what
  the patch *should* do and what's actually deployed.

If you'd rather build a BepInEx plugin instead, that's a completely separate,
unrelated path — nothing here stops it, and nothing here requires it.

## Building

```powershell
pwsh loader/build-loader.ps1 -GameDir "C:\Program Files (x86)\Steam\steamapps\common\<game folder>"
```

Requires a .NET 6+ SDK. If none is found on `PATH`, the script downloads a
portable one into `loader/.dotnet-sdk/` automatically (one-time, ~200 MB) —
pass `-NoSdkDownload` to fail instead of downloading. Pass `-StatusFile <path>`
to have it write its current phase (`"N/total: <message>"`, finishing with
`"Done."` or `"Failed: <message>"`) to a file a GUI can poll — this is exactly
how Recharge's own Settings tab drives it (see `app/src-tauri/src/commands/loader.rs`).

Every run:

- Rebuilds `Recharge.ModApi.dll` and the patched `Assembly-CSharp.dll` from
  scratch (phases 1–5, fixed).
- Discovers every `mods/<name>/*.csproj` that has a `mod.json` beside it
  (except folders starting with `_`, like `mods/_template/` — see
  [`docs/creating-a-mod.md`](docs/creating-a-mod.md)), builds each one with
  `-p:ManagedDir=<game>\..._Data\Managed`, and deploys the built DLL +
  manifest to `<GameDir>\Recharge\Mods\<mod.json's id>\`.

Dropping a new mod folder under `mods/` is the entire "registration" step —
nothing else needs editing to have it picked up on the next build.

## Project layout

```
loader/
  ModApi/                  Recharge.ModApi.dll source - everything a mod
                            compiles against.
    IRechargeMod.cs           The contract every mod implements.
    IRechargeHost.cs          The contract every mod consumes.
    IEventBus.cs              The event-bus interface (host.Events).
    RechargeEvents.cs         Well-known event name constants.
    PauseMenuHelper.cs        Add a pause-menu row/panel in two lines.
    Reflect.cs                Generic private-field/property/method helpers.
  Runtime/                 Copied into the decompiled game project and
                            compiled straight into Assembly-CSharp.dll -
                            never shipped as a separate DLL.
    RechargeLoaderBootstrap.cs  The static entry point the game patch calls.
    RechargeHost.cs              Concrete IRechargeHost (one per mod).
    EventBus.cs                  Concrete IEventBus (one shared instance).
    RechargeTicker.cs            The shared MonoBehaviour behind OnUpdate/etc.
  tools/ilspycmd/           The decompiler build-loader.ps1 shells out to.
  build-loader.ps1          The pipeline described above.
  docs/
    creating-a-mod.md       Start here to write a new mod.
    api-reference.md        Full reference for everything above, plus mod.json.
mods/
  _template/                Copy this to start a new mod (see docs/creating-a-mod.md) -
                            demonstrates every IRechargeHost capability at least once.
  recharge-multiplayer/     Real mod: DOTnet (real-time multiplayer).
  recharge-maps/            Real mod: Maps (real-asset map system).
```
