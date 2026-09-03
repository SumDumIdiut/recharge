# Creating a mod

A RechargeLoader mod is: a folder under `mods/`, a `mod.json` manifest, a
`.csproj` that compiles against the real game DLLs, and one class implementing
`IRechargeMod`. That's the whole contract — no base class to inherit, no
loader-specific project template, nothing to register anywhere else.

## 1. Copy the template

```powershell
Copy-Item -Recurse "mods\_template" "mods\my-mod"
```

(`mods/_template/` is skipped by `build-loader.ps1`'s auto-discovery — see
[`README.md`](../README.md#building) — precisely so it stays a clean copy
source instead of getting built and installed itself.)

You get three files:

```
mods/my-mod/
  mod.json           the manifest (id, display name, version, entry DLL, dependencies)
  ExampleMod.csproj   compiles ExampleMod.dll against the real game DLLs
  ExampleMod.cs       an IRechargeMod that exercises every host capability once
```

Rename them to taste (the `.cs`/`.csproj` file names don't matter to the
loader — only `mod.json`'s `entryAssembly` and the `AssemblyName` MSBuild
property need to agree with each other). The template's `ExampleMod.cs`
isn't a bare stub — it's a working demo of config, events, the per-frame
ticker, and the pause-menu helper, all in one file with inline comments.
Delete whichever parts your mod doesn't need.

## 2. Fill in `mod.json`

```json
{
  "id": "yourname.modname",
  "displayName": "My Mod",
  "version": "1.0.0",
  "author": "Your Name",
  "entryAssembly": "ExampleMod.dll",
  "minLoaderVersion": "1.0.0",
  "enabled": true,
  "dependencies": []
}
```

| Field | Meaning |
|---|---|
| `id` | Stable, unique identifier. Used as the deploy folder name, this mod's config/data-folder key, and how another mod finds this one via `host.GetMod(id)`. Convention: `yourname.modname`, lowercase. Changing it later is effectively shipping a new mod, not updating the old one. |
| `displayName` | What a player sees (Recharge's Mods tab, load-order logs). Free to change anytime. |
| `version` | Your own semver. Not currently enforced by anything, but a real mod should bump it. |
| `entryAssembly` | The built DLL file name the loader should `Assembly.LoadFrom`. Must match the `.csproj`'s `<AssemblyName>`. |
| `minLoaderVersion` | If set and greater than the installed loader's version (`RechargeLoaderBootstrap.LoaderVersion`), this mod is skipped with a logged error instead of loaded. Leave unset if you don't need a floor. |
| `enabled` | Set `false` to have the loader skip this mod without deleting it. |
| `dependencies` | Other mods' `id`s that must finish loading before this one starts — see [Dependencies](#dependencies) below. Leave empty (or omit) if you don't need one. |

Full field-by-field reference: [`api-reference.md`](api-reference.md#modjson).

## 3. Write `OnLoad`

```csharp
using System;
using Recharge.ModApi;

public class ExampleMod : IRechargeMod
{
    public string Id => "yourname.modname";
    public string DisplayName => "My Mod";
    public Version Version => new Version(1, 0, 0);

    public void OnLoad(IRechargeHost host)
    {
        host.Log(DisplayName + " loaded!");
        // ... your mod starts here
    }

    public void OnUnload() { }
}
```

`OnLoad` runs once, in dependency order, the first time the player opens the
pause menu (see [`README.md`](../README.md#how-it-works) for why that's the
trigger point). By then the whole game is already up — `GameObject.Find`,
`Object.FindObjectOfType<T>()`, `SceneManager`, coroutines via a
`MonoBehaviour` you create, all work normally. There's no special "mod
context" to work within; a RechargeLoader mod is just ordinary Unity/C# code
that happens to start running from this one entry point.

Full interface reference (every member of `IRechargeMod` and
`IRechargeHost`, plus every other framework class): [`api-reference.md`](api-reference.md).

## 4. Reference the Unity/game DLLs you need

The template's `.csproj` already references the modules the template itself
uses (`UnityEngine`, `UnityEngine.CoreModule`, `Assembly-CSharp`,
`Recharge.ModApi`). If you get a compile error for a type that isn't found,
it lives in a different module DLL — add a `<Reference>` for it the same way:

```xml
<Reference Include="UnityEngine.TilemapModule"><HintPath>$(ManagedDir)\UnityEngine.TilemapModule.dll</HintPath></Reference>
```

To find which module a type lives in, either check Unity's own docs for that
type's namespace, or just look in `<GameDir>\<Game>_Data\Managed\` — every
`UnityEngine.*Module.dll` there is fair game, and `Assembly-CSharp.dll` has
every one of the game's own classes (`spikeScript`, `Movement`,
`courseScript`, ...). `mods/recharge-maps/RechargeMaps.csproj` references
21 different DLLs (including `Unity.TextMeshPro`, `DOTween`,
`UnityEngine.Tilemaps`) if you want a fuller example to copy references from.

`$(ManagedDir)` is an MSBuild property `build-loader.ps1` passes in
(`-p:ManagedDir=<path>`) when it builds your mod — you don't set it yourself,
and it's why `dotnet build` on your `.csproj` directly (without that flag)
fails to resolve references. To build/check your mod standalone while
iterating, pass it yourself:

```powershell
dotnet build mods\my-mod\ExampleMod.csproj -c Release `
  "-p:ManagedDir=C:\...\<Game>_Data\Managed"
```

## 5. Build and test

```powershell
pwsh loader/build-loader.ps1 -GameDir "C:\...\<game folder>"
```

(Or click **Install / Update** in Recharge's Settings tab — same script,
same result.) This rebuilds the loader *and* every mod under `mods/`,
including yours, and deploys everything. Launch the game, open the pause
menu once (that's what fires `OnLoad`), and check `Player.log`
(`%APPDATA%\..\LocalLow\<studio>\<game>\Player.log`) for your mod's log
lines — `[Recharge] Loaded mod 'My Mod' v1.0.0` confirms the loader found and
ran it; anything logged via `host.Log(...)` shows up as
`[Recharge:yourname.modname] ...` right after.

There's no hot-reload — every code change needs a re-run of
`build-loader.ps1` and a fresh game launch, since the patch lives inside
`Assembly-CSharp.dll` itself and mods load once per session.

## Recipe: adding a pause-menu button

```csharp
// A row that just does something when clicked:
PauseMenuHelper.AddRow(host.PauseMenu, "MyModRow", "My Mod", () => host.Log("clicked!"));

// A row that opens your own sub-panel:
var panel = PauseMenuHelper.AddPanelRow(host.PauseMenu, "MyModRow", "My Mod");
// panel is inactive, with its title set and Back button already wired back
// to the main menu - add your own UI content to it here.
```

That's the whole thing — `PauseMenuHelper` (see
[`api-reference.md`](api-reference.md#pausemenuhelper)) is a shared
extraction of the row-insertion pattern both real mods used to hand-roll
independently (~200 lines each, nearly identical). It's order-independent
across mods automatically: each call inserts directly above `QuitToDesktop`
and pushes whatever was there down by one row, so it composes correctly no
matter which mod's `OnLoad` runs first.

If you need something beyond a blank panel with a title/Back button, read
`mods/recharge-maps/MapMenuBuilder.cs` — the original hand-built version this
helper was extracted from — for a full worked example of populating real
content (a scrollable list of clickable rows) inside a panel like the one
`AddPanelRow` gives you.

## Recipe: reaching real game state

Most real game classes expose almost nothing `public`. `Reflect` (see
[`api-reference.md`](api-reference.md#reflect)) wraps the reflection
boilerplate every mod otherwise hand-rolls:

```csharp
var respawnPoint = Reflect.GetField<Vector3>(movement, "respawnPoint");
Reflect.SetField(spring, "strength", 2.5f);
Reflect.InvokeMethod(platform, "JumpToState", 0);
```

## Events and inter-mod communication

`host.Events` is a named pub/sub bus shared by every mod for the whole
session — use it to react to the loader's own lifecycle, and to talk to
other mods without a compile-time reference to their assembly:

```csharp
host.Events.On(RechargeEvents.ModsReady, _ =>
{
    var maps = host.GetMod("recharge.maps");
    if (maps != null) host.Log("Found: " + maps.DisplayName);
});

host.Events.On(RechargeEvents.PlayerSpawned, payload =>
{
    var player = (GameObject)payload;
    // ...
});

// Your own events, for other mods to react to - namespace the name to your
// own mod id so you don't collide with someone else's event of the same name:
host.Events.Emit("yourname.modname.scoreChanged", newScore);
```

See [`api-reference.md`](api-reference.md#events--ieventbus--rechargeevents)
for the full list of events the loader itself emits.

### Dependencies

`dependencies` is a real **require**, not just an ordering hint. If your mod
needs another mod present *and already loaded* — not just "eventually," which
`RechargeEvents.ModsReady` already covers — declare it:

```json
{ "id": "yourname.addon", "dependencies": ["recharge.maps"] }
```

`RechargeLoaderBootstrap` resolves every discovered mod's dependency graph
before loading anything: `yourname.addon` (in this example) loads only if
`recharge.maps` also loads, and when it does, `recharge.maps`'s `OnLoad` is
guaranteed to have already finished. If `recharge.maps` is missing, disabled,
or fails its own `minLoaderVersion` check, `yourname.addon` is skipped too —
logged as an error naming the exact reason. This cascades: if your mod
depends on something that itself depends on something missing, your mod is
skipped as well. A dependency cycle (A requires B, B requires A) skips every
mod in the cycle, since neither can ever legitimately go first. None of this
affects any *other* mod's own loading — one mod's unmet requirement never
blocks the rest of the mod set.

If you only want your mod to *behave differently* when another mod happens
to be present — not refuse to load without it — check for it optionally
instead of declaring a hard dependency:

```csharp
var maps = host.GetMod("recharge.maps"); // null if not loaded, no error either way
if (maps != null) { /* ... */ }
```

## Common pitfalls

- **"Type or namespace not found" at compile time** → the type lives in a
  Unity module DLL you haven't referenced yet. See step 4.
- **Mod doesn't appear in `Player.log` at all** → check `mod.json` is valid
  JSON, `entryAssembly` matches the built DLL's actual file name, and
  `enabled` is `true`. `RechargeLoaderBootstrap.Init` logs one line per
  *found* mod folder attempt, including failures — search `Player.log` for
  `[Recharge]`.
- **`NullReferenceException` reading `host.PauseMenu.mainBitPublic`** → you
  called something at the wrong time. `OnLoad` itself always has a fully
  constructed `pauseMenuScript`, so this usually means code deferred to a
  later frame/coroutine ran before the object it expected was ready — guard
  with a null check rather than assuming load order.
- **Two mods' inserted rows overlap** → use `PauseMenuHelper` instead of
  hardcoding a fixed pixel offset from `Settings` — it already computes each
  insertion relative to whatever row currently sits above `QuitToDesktop`,
  which is what makes row-insertion order-independent across mods.
- **My mod doesn't load at all, and I didn't disable it** → check `Player.log`
  for a `"not loaded: it requires ..."` error — one of its declared
  `dependencies` is missing, disabled, incompatible, or part of a cycle, so
  your mod was skipped too (see [Dependencies](#dependencies)). This is
  intentional: `dependencies` is a hard requirement, not a soft ordering hint.
