# API reference

Everything a mod compiles against and every field of `mod.json`, in one
place. For a narrative walkthrough, see [`creating-a-mod.md`](creating-a-mod.md).
All of it lives in `loader/ModApi/` (compiled to `Recharge.ModApi.dll`) unless
noted otherwise.

## `IRechargeMod`

`IRechargeMod.cs`. Exactly one public, non-abstract class implementing this
must exist in your mod's `entryAssembly` — `RechargeLoaderBootstrap` finds it
by scanning the assembly's types with reflection
(`typeof(IRechargeMod).IsAssignableFrom(t)`), so there's nothing to register
by name.

```csharp
public interface IRechargeMod
{
    string Id { get; }
    string DisplayName { get; }
    Version Version { get; }

    void OnLoad(IRechargeHost host);
    void OnUnload();
}
```

| Member | Notes |
|---|---|
| `Id` | Should match `mod.json`'s `"id"`. Used as the deploy folder name, the `ModDataDir`/`LoadConfig`/`SaveConfig` key, and how another mod finds this one via `host.GetMod(id)`. |
| `DisplayName` | Shown in load-order log lines and Recharge's own UI. Purely cosmetic. |
| `Version` | A `System.Version` (e.g. `new Version(1, 0, 0)`). Logged on load; not currently compared against anything. |
| `OnLoad(IRechargeHost host)` | Called once, in dependency order (see [`mod.json`](#modjson)'s `dependencies`), the first time the player opens the pause menu in a session. Exceptions thrown here are caught per-mod and logged — one mod failing to load doesn't take down the others. |
| `OnUnload()` | Reserved for a future hot-unload feature — never called today. Implement it anyway: unsubscribe from any events you subscribed to (including on `host.Events`/`host.OnUpdate`), stop coroutines, destroy `GameObject`s you created. |

## `IRechargeHost`

`IRechargeHost.cs`. The one object `OnLoad` receives — your mod's loader-provided
entry point. A fresh `RechargeHost` instance is constructed per mod (so
`Log`/`LogWarning`/`LogError` can prefix lines with your mod's id), but the
event bus, per-frame ticker, and mod registry underneath are one shared
instance for the whole session.

```csharp
public interface IRechargeHost
{
    pauseMenuScript PauseMenu { get; }

    void Log(string message);
    void LogWarning(string message);
    void LogError(string message);

    string ModDataDir(string modId);

    IEventBus Events { get; }
    event Action OnUpdate;
    event Action OnLateUpdate;
    event Action OnFixedUpdate;

    IRechargeMod GetMod(string modId);
    T GetModApi<T>(string modId) where T : class;

    T LoadConfig<T>(string modId, string fileName = "config.json") where T : new();
    void SaveConfig<T>(string modId, T config, string fileName = "config.json");

    Sprite LoadSprite(byte[] imageBytes, float pixelsPerUnit = 100f);
}
```

### Logging

| Member | Notes |
|---|---|
| `Log` / `LogWarning` / `LogError` | Wrap `Debug.Log`/`Debug.LogWarning`/`Debug.LogError` with a `[Recharge:<your mod id>]` prefix, landing in `Player.log` like any Unity log call. Prefer these over calling `Debug.Log` directly so your lines are attributable and greppable. |

### Game access

| Member | Notes |
|---|---|
| `PauseMenu` | The real, live `pauseMenuScript` instance whose `Awake()` triggered loading. See [`pauseMenuScript` additions](#pausemenuscript-additions) and [`PauseMenuHelper`](#pausemenuhelper) below. |
| `ModDataDir(modId)` | Returns (creating if needed) `<GameDir>\Recharge\Mods\<modId>\data\` — your mod's private folder. Pass your own `Id`. `LoadConfig`/`SaveConfig` already use this for you; call it directly for anything else (save files, caches, downloaded assets). |

### Events — `IEventBus` / `RechargeEvents`

`IEventBus.cs` / `RechargeEvents.cs`. The "custom event calls" mechanism: a
named pub/sub bus, one instance shared by every mod for the whole session.

```csharp
public interface IEventBus
{
    void Emit(string eventName, object payload = null);
    void On(string eventName, Action<object> handler);
    void Off(string eventName, Action<object> handler);
}
```

`Emit` fires synchronously, in subscription order, to every current
subscriber; a handler that throws is caught and logged (not fatal, doesn't
stop the remaining handlers). Use it both ways:

- **React to the loader's own lifecycle** via the well-known names in
  `RechargeEvents`:

  | Constant | Fires | Payload |
  |---|---|---|
  | `RechargeEvents.ModLoaded` | Right after each mod's `OnLoad` returns successfully | that mod's `Id` (`string`) |
  | `RechargeEvents.ModsReady` | Once, after every mod has finished loading | none |
  | `RechargeEvents.SceneLoaded` | Every `SceneManager.sceneLoaded` | the scene's name (`string`) |
  | `RechargeEvents.PlayerSpawned` | Once per scene, first frame a `GameObject` tagged `Player` with a `Movement` component is found (polled via the shared ticker — there's no cheaper real hook) | the player `GameObject` |

- **Talk to other mods** with your own event names — pick something
  namespaced to your mod id (`"yourname.modname.something"`) so you don't
  collide with another mod's own events:

  ```csharp
  // mod A:
  host.Events.Emit("yourname.modname.scoreChanged", newScore);
  // mod B:
  host.Events.On("yourname.modname.scoreChanged", payload => { var score = (int)payload; ... });
  ```

### Per-frame hooks

| Member | Notes |
|---|---|
| `OnUpdate` / `OnLateUpdate` / `OnFixedUpdate` | Fire every frame/late-update/fixed-step from one shared `MonoBehaviour` (`RechargeTicker`) — saves a mod from creating its own `GameObject` solely to get a per-frame callback. A handler that throws is logged, other subscribers still run that frame. |

### Finding other mods

| Member | Notes |
|---|---|
| `GetMod(modId)` | Looks up an already-loaded mod by id. Returns `null` if not loaded (including "not loaded *yet*" — see [dependencies](#modjson) if you need a specific load order, or subscribe to `RechargeEvents.ModsReady` if "eventually" is good enough). |
| `GetModApi<T>(modId)` | Same lookup, cast to `T` (typically an interface or base class the target implements) — `null` if not loaded *or* doesn't implement `T`. |

### Config

| Member | Notes |
|---|---|
| `LoadConfig<T>(modId, fileName = "config.json")` | Reads `<ModDataDir>\<fileName>` as JSON into a new `T`. Returns `new T()` if the file doesn't exist or fails to parse (logged as a warning, never throws — a corrupt config shouldn't stop your mod from loading). |
| `SaveConfig<T>(modId, config, fileName = "config.json")` | Writes `config` as indented JSON to the same path. No autosave — call this whenever your config changes. |

`T` needs a parameterless constructor (`where T : new()` on `LoadConfig`) and
should be a plain data class — see the template's `MyConfig` for the
smallest possible example.

### Images

| Member | Notes |
|---|---|
| `LoadSprite(imageBytes, pixelsPerUnit = 100f)` | Decodes PNG/JPG bytes into a real `Sprite` (pivot centered), ready to assign to a `SpriteRenderer`/`Image`. Returns `null` if the bytes don't decode. Wraps `ImageConversion.LoadImage` + `Sprite.Create` so you don't hand-roll it. |

## `pauseMenuScript` additions

RechargeLoader's game patch (`build-loader.ps1`, phase 3) adds exactly two
public properties to the real `pauseMenuScript` class, since its equivalent
fields are `private` in the shipped game:

```csharp
public GameObject mainBitPublic => mainBit;       // the main pause panel (Resume/Settings/.../Quit)
public GameObject settingsBitPublic => settingsBit; // the Settings sub-panel, used as a clone source
```

`PauseMenuHelper` (below) uses both of these for you — reach for them
directly only if you need something the helper doesn't cover. Everything
else you'd read off `host.PauseMenu` (`menuOpen`, `menuButtonPressed()`,
etc.) is the game's own pre-existing public API, unrelated to RechargeLoader.

## `PauseMenuHelper`

`PauseMenuHelper.cs`. Adds a row to the pause menu's main panel — the exact
pattern both real mods (`recharge-maps`, `recharge-multiplayer`) hand-rolled
independently before this existed, generalized into one static utility.
Order-independent across mods: each call inserts directly above
`QuitToDesktop` and pushes whatever was there down by one row, so it
composes correctly regardless of which mod's `OnLoad` runs first.

```csharp
public static class PauseMenuHelper
{
    public static GameObject AddRow(pauseMenuScript menu, string rowName, string label, Action onClick);
    public static GameObject AddPanelRow(pauseMenuScript menu, string rowName, string label);
    public static void SetButtonLabel(GameObject buttonGo, string text);
}
```

| Member | Notes |
|---|---|
| `AddRow(menu, rowName, label, onClick)` | A row that runs `onClick` directly — no sub-panel. Use for a one-shot action. Returns the row's `GameObject`, or `null` if the real menu's expected shape wasn't found (defensive — logs nothing itself, check for `null` if you want to know). |
| `AddPanelRow(menu, rowName, label)` | A row that opens a blank sub-panel (cloned from the real Settings panel, so it matches the game's visual style) when clicked — its Back button is already wired to return to the main panel. Fill the returned (initially inactive) `GameObject` with your own UI. |
| `SetButtonLabel(buttonGo, text)` | Relabels a cloned button's TMP text and strips any inherited localization hookup so your text actually sticks. Used internally by the two calls above; exposed since it's just as useful when hand-styling rows yourself. |

`rowName` is both the idempotency key (calling again with the same name is a
safe no-op — fine to call unconditionally every `OnLoad`) and, for
`AddPanelRow`, the sub-panel's `GameObject` name suffix (`"<rowName>Bit"`).

For anything beyond a blank panel with a title/Back button already wired up,
read `mods/recharge-maps/MapMenuBuilder.cs` (the pre-`PauseMenuHelper` hand
version this was extracted from, ~200 fully commented lines) for a full
worked example of building out real content inside the panel.

## `Reflect`

`Reflect.cs`. Generic reflection helpers for the game's private
fields/properties/methods — almost nothing on the real game classes is
public. Static, no state, doesn't need a live `IRechargeHost`.

```csharp
public static class Reflect
{
    public static T GetField<T>(object target, string fieldName);
    public static void SetField(object target, string fieldName, object value);
    public static T TryGetField<T>(object target, string fieldName, T fallback = default);
    public static TValue GetStaticField<T, TValue>(string fieldName);
    public static T GetProperty<T>(object target, string propertyName);
    public static object InvokeMethod(object target, string methodName, params object[] args);
    public static Type NestedType<T>(string nestedTypeName);
}
```

```csharp
var respawnPoint = Reflect.GetField<Vector3>(movement, "respawnPoint");
Reflect.SetField(spring, "strength", 2.5f);
Reflect.InvokeMethod(platform, "JumpToState", 0);
var positionDataType = Reflect.NestedType<PlatformMover>("PositionData"); // a private nested struct
```

`GetField`/`SetField`/`TryGetField` walk up the base-type chain, so they
work even when the field is declared on a base class rather than the
target's own runtime type. `InvokeMethod` resolves overloads by argument
*count* only (fine for the common case — most real game methods you'll reach
this way aren't overloaded); if that's ambiguous for your target, fetch the
exact `MethodInfo` yourself instead.

## `mod.json`

Read by `RechargeLoaderBootstrap` at runtime *and* by `build-loader.ps1` at
build time (to know each mod's `id`/`entryAssembly` for deployment) — keep it
valid JSON matching this shape:

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

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | **yes** | Stable unique identifier; also the deploy folder name and `ModDataDir`/config/`GetMod` key. |
| `displayName` | string | recommended | Human-readable name shown in logs/UI. |
| `version` | string | recommended | Your own semver string. Informational only today. |
| `author` | string | no | Informational only. |
| `entryAssembly` | string | **yes** | File name of the built mod DLL, resolved relative to the mod's own deployed folder. Must match the `.csproj`'s `<AssemblyName>` + `.dll`. |
| `minLoaderVersion` | string | no | If set and parses as a `Version` greater than `RechargeLoaderBootstrap.LoaderVersion`, the mod is skipped (logged as an error, not a crash). |
| `enabled` | bool | no (default `true`) | Set `false` to have the loader skip this mod without removing its files. |
| `dependencies` | string[] | no (default empty) | Other mods' `id`s this mod **requires** — not just an ordering hint. `RechargeLoaderBootstrap` resolves every discovered mod's dependency graph before loading anything: a mod loads only if every one of its dependencies also loads (recursively - if B requires missing/disabled C, both B and anything that requires B are skipped too), and among mods that will load, dependencies always finish `OnLoad` before their dependents start. A missing/disabled/incompatible dependency, or a cycle, is logged as an error naming the specific mod and reason - only that mod (and whatever transitively required it) is skipped, everyone else still loads normally. |

Unknown extra fields are ignored, not an error (Newtonsoft's
`JsonConvert.DeserializeObject` skips them) — add your own freely if useful
for your own tooling.

## Loader internals (for reference, not something you call)

| Type | File | Role |
|---|---|---|
| `RechargeLoaderBootstrap` | `Runtime/RechargeLoaderBootstrap.cs` | The static class the game patch calls into. Discovers every `mod.json` under `<GameDir>\Recharge\Mods\`, topologically sorts by `dependencies`, then for each: `Assembly.LoadFrom`s `entryAssembly`, finds the `IRechargeMod` in it, registers it, calls `OnLoad`. Owns the shared `EventBus`/`RechargeTicker`/mod registry and emits `ModLoaded`/`ModsReady`/`SceneLoaded`/`PlayerSpawned`. Exposes `LoaderVersion` and `ModsRoot`. |
| `RechargeHost` | `Runtime/RechargeHost.cs` | The concrete `IRechargeHost` — one instance per mod (for log prefixing), sharing the bus/ticker/registry above. |
| `EventBus` | `Runtime/EventBus.cs` | Concrete `IEventBus`. |
| `RechargeTicker` | `Runtime/RechargeTicker.cs` | The one shared `MonoBehaviour` backing `OnUpdate`/`OnLateUpdate`/`OnFixedUpdate`. |

These four files are copied verbatim into the decompiled game project and
compiled straight into `Assembly-CSharp.dll` (see the main
[README](../README.md#how-it-works)) — they're never shipped as a separate
DLL, unlike everything under `ModApi/`.
