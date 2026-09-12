# Recharge Maps — how it actually works

This document exists because the in-app visual map editor that used to live at
`app/src/editor/` was removed (it had real, unresolved rendering bugs and the
UI iteration loop was too slow to be worth continuing). The underlying map
*loading* system in this mod is unaffected and works — this is the reference
for whoever picks this up next, whether that's a human or a future Claude
session with no memory of how this was built.

If you're looking for "the editor", there isn't one right now. Maps are
authored by hand-editing `map.json` files (see schema below) or by whatever
importer/editor gets built next. Everything described here is the runtime
that *loads and plays* those files inside the actual game.

## The big picture

This is a RechargeLoader mod (`mods/recharge-maps/`, id `recharge.maps`,
entry point `RechargeMapsMod.cs`). It does three things:

1. **Loads custom maps** into an isolated pocket of world space so they play
   like real IGTAP courses, using real cloned game objects (real spikes, real
   gates, real physics) — not placeholder art.
2. **Applies "overlay" maps** directly onto the real Base Game / B-side scene
   instead of an isolated pocket, for maps that are extra content bolted onto
   an existing course rather than a standalone level (the imported "Nari
   CSide" map is the reference case — it's not a real course, it's extra
   blocks/spikes meant to sit on top of the real B-side).
3. **Exports real game textures and course-layout snapshots** to disk so an
   out-of-process tool (the removed editor, or whatever replaces it) can see
   real art and real level geometry without needing a live connection to the
   running game.

Nothing here needs native game-code patches. Everything is done by cloning
real live objects found in the currently-loaded scene and repositioning them
with `Transform`/reflection. This was a deliberate choice made early in this
project specifically to avoid the native-patch risk surface.

## File map

| File | Responsibility |
|---|---|
| `RechargeMapsMod.cs` | Mod entry point. Boots `MapManager`, installs the pause-menu picker, re-installs it on every scene load (a fresh `pauseMenuScript` exists per scene). |
| `MapManager.cs` | The actual loader. Everything about spawning/positioning objects into a course, pocket vs overlay logic, camera rescue, save/delete. |
| `RealAssetPalette.cs` | Finds and caches real live game objects/tiles/sprites so `MapManager` has something real to clone. Also does the texture/snapshot export for external tools. |
| `MapMenuBuilder.cs` | Builds the in-game pause-menu "Start Game" picker (Base Game / B-side / each custom map), and the parallel Delete-save picker. |
| `MapDefinition.cs` | The JSON schema POCOs (Newtonsoft.Json). |
| `MapPaths.cs` | Where everything lives on disk. |
| `MapRewardTrigger.cs` | A trigger component granting author-configured currency on touch (used by watt tiles and non-co-located end gates). |
| `MapGroup`/`MapReward`/`MapCustomImage`/`PlatformPosition` | Nested schema types, all in `MapDefinition.cs`. |

## Where maps live on disk

```
<GameDir>\Recharge\Mods\recharge.maps\
  maps\
    <mapId>\
      map.json
      assets\ or gallery\        (custom images referenced by assetId)
  textures\
    ground\ blueBlocks\ orangeBlocks\ spike\ startGate\ endGate\ upgradeBox\ spring\ tree\
      0.png, 1.png, ...
      manifest.json               (real names, in file-index order)
      rules.json                  (ground/blueBlocks/orangeBlocks only - RuleTile data)
  course-snapshots\
    Overworld.json                (Base Game)
    OverworldHard.json             (B-side)
```

`<mapId>` is both the stable id (folder name, used in file paths and as a
key into the real per-course save system) and defaults to being the display
name too, unless `map.json`'s own `name` field overrides it.

Two **reserved** map ids exist for editing the real game rather than an
imported level: `_BaseGameEdits` and `_BSideEdits` (`MapManager.BaseGameEditsMapId`
/ `BSideEditsMapId`). A map folder with one of these names is always treated
as an overlay (`isOverlay` is forced true for them conceptually, though
nothing currently *writes* to them — see "Orphaned pieces" below). If such a
folder exists, `MapMenuBuilder`'s Base Game/B-side "Play" actions
auto-apply it every time that difficulty is entered
(`MapManager.SnapCameraToRealPlayerWhenReady(autoApplyMapId)`).

## Pocket mode vs overlay mode

This is the single most important architectural fact about this mod.

**Pocket mode** (`MapManager.LoadMap`/`SpawnGroup`) is for a standalone
custom level. It clones a real `courseScript` (the decorative "course 1"
behind the main menu is the donor) into an isolated spot in world space,
`PocketOrigin = (50000, 50000)`, strips the donor's own hazard content
(`Destroy` everything under the clone's `DisableBits` child), then spawns
every object in the map's `objects[]` array at `PocketOrigin + (x, y)`. The
player gets teleported there. Nothing about this touches the real Overworld/
B-side scene — it's a shared scene, but the pocket is far enough away that
nothing overlaps.

**Overlay mode** (`MapManager.ApplyOverlay`) is for content meant to sit
directly in the real, current scene — no pocket, no player teleport, no
camera change, no cloned course. Objects are spawned at their literal real
`(x, y)` world coordinates (`_activeOrigin = Vector2.zero` for the duration
of the spawn pass — see `WorldPos` below). This is how the imported "Nari
CSide" map works: B-side loads normally, then this map's blocks/spikes get
added directly into that already-loaded real scene.

`MapDefinition.IsOverlay` (JSON: `"isOverlay"`) selects which mode a map
uses. `MapManager.PlayMap` branches on `IsOverlayMap(mapId)`: overlay maps
route through B-side's own scene-load path (`menu.changeSceneHard()`, then
apply once a player exists); pocket maps use `LoadMap` directly if a player
already exists, or wait for one via `changeScene()` + a pending-load flag.

**A single static field controls which coordinate space every spawn method
targets**: `MapManager._activeOrigin` (nullable `Vector2`). `WorldPos(obj)`
returns `(_activeOrigin ?? PocketOrigin) + (x, y)`. Pocket mode never touches
it (stays null → uses `PocketOrigin`); overlay mode sets it to `Vector2.zero`
for the duration of the spawn loop, in a `try/finally` so it's always reset
even on exception. This one flag is what lets every `SpawnXxx` method be
shared between both modes without duplicating logic.

`MapManager.IsInPocket()` / `CurrentOrigin` are the public read side of this,
for any future authoring tool that needs to know "am I looking at an
isolated pocket or the real scene" and "what's the coordinate origin right
now" (this is what the removed editor used to decide relative-vs-absolute
coordinates when saving).

## Object types supported per mode

Not every object type is wired into both `SpawnGroup` (pocket) and
`ApplyOverlay` (overlay) — they were added independently as needed. Current
state:

| type | Pocket (`SpawnGroup`) | Overlay (`ApplyOverlay`) |
|---|---|---|
| `ground` (cell-based real tile paint) | yes | no |
| `coloredGround` (blue/orange swap tile paint, cell-based) | yes | no |
| `block` (generic solid, custom or placeholder sprite) | yes | yes |
| `blueBlock` / `orangeBlock` (solid, real blue/orange tile sprite, world-coord not cell-based) | yes | yes |
| `spike` | yes | yes |
| `checkpoint` | yes | yes |
| `spring` | yes | no |
| `platform` | yes | no |
| `deco` (tree decoration) | yes | no |
| `customImage` | yes | no |
| `wattTile` (currency-on-touch trigger) | yes | yes |
| `modifyObject` (see below) | yes (clones) | yes (**moves the real object**) |

If you add a new type to one mode, check whether it makes sense in the other
before assuming it "just works" — the two code paths are separate switches
in `MapManager.cs` (`SpawnGroup` and `ApplyOverlay`).

### `modifyObject` has different semantics per mode — read this before using it

`modifyObject` finds a real, already-existing GameObject by exact name
(`Resources.FindObjectsOfTypeAll<GameObject>()`, matched by `.name`).

- **Pocket mode** (`SpawnModifyObject`): clones the found object and
  positions the *clone* — safe, since the pocket is isolated. Has a
  deny-list (`ModifyDenyKeywords`) blocking economy-sensitive types
  (prestige, global cash multipliers, etc.) unless the name is on the
  explicit allow-list (`ModifyAllowedUpgradeNames`: `dashunlock`,
  `double jump`, `wall jump`, `air jump`, `end demo`). Upgrade-box clones get
  reparented under a real `localUpgrades` container (creating one if
  missing) — see "upgradeBox NullReferenceException" below for why.
- **Overlay mode** (`ApplyOverlayModify`): moves the **real, live object
  itself** to the new position. No clone, no deny-list beyond rejecting
  `"player"`. This is correct for leveledit-style level edits (you're
  editing the real scene on purpose) but means placing a `modifyObject`
  entry for, say, the real "Double jump" upgrade box in a Base Game overlay
  **relocates the only copy of it in the whole game**, it does not duplicate
  it. There is normally exactly one real GameObject per upgrade name across
  the whole difficulty, so this is a real, user-visible move, not a
  cosmetic preview.

## `RealAssetPalette` — how "real" assets get found

Nothing here is a static asset reference baked at build time — everything is
found live at runtime from whatever scene happens to be loaded, then cloned.

- `ScanCurrentScene()` runs on every scene load (`MapManager`'s
  `SceneManager.sceneLoaded` hook) and once at mod startup. For each type in
  `ScanTypes` (`spikeScript`, `checkpointScript`, `startGate`, `endGate`,
  `PlatformMover`, `SpringScript`, `courseScript`), it finds the first
  scene-valid live instance (`FindLiveInstance`) and clones it (inactive)
  into a persistent `DontDestroyOnLoad` holder (`RechargeMaps_AssetTemplates`).
  The cache is cumulative across the whole play session — once found, a
  type's template is reused forever, even after the scene that had it
  unloads.
- `FindLiveInstance(Type)` has two real-world exclusion rules baked in,
  both discovered by hitting real bugs:
  - Skip anything that also has a `Tilemap` component. Some real hazard
    scripts (confirmed: `spikeScript`) also live on a whole-level Tilemap
    GameObject (`Grid/hiddenSpikes`, 600+ cells) used for an unrelated
    hidden-hazard mechanic. Cloning that as "the" spike template would
    instantiate a giant duplicate hazard tilemap per placement.
  - Prefer a normally-sized instance over an oversized one. A `spikeScript`
    living under "Secret area/Diagonal platform/Spike" has an intrinsically
    larger sprite (not a scale issue — the sprite itself is bigger). Several
    placed on the normal 32-unit grid would visually merge into one mass.
- `ScanTilemaps()` finds `ground`/`blueBlocks`/`orangeBlocks` Tilemaps by
  exact name, caches a cleared clone (for pocket-mode `ground`/`coloredGround`
  painting via `Tilemap.SetTile`), records `GroundCellSize` from the real
  `Grid.cellSize`, and exports every distinct real `TileBase` as a PNG +
  RuleTile rule data (see "texture export" below).
  - **The real terrain layer is not consistently named "ground" across
    scenes.** Confirmed real names: `"ground"` in MainMenu, `"new awesome
    nikki ground"` in Overworld. `FindGroundTilemap` tries known aliases
    first, then falls back to scanning every active, `Ground`-tagged,
    collider-backed Tilemap (excluding known non-terrain ones —
    `blueBlocks`/`orangeBlocks`/`InvisibleWall`/`OOB areas`/`Oldground`) and
    picking whichever has the most occupied cells. If a *third* scene ever
    turns up with yet another name, extend `GroundAliases` rather than
    relying on the fallback alone (the fallback works but is slower and
    logs when it fires).
- `Spawn<T>(worldPos, rotation, parent)` instantiates from the cached
  template and **always resets `localScale` to `Vector3.one`** — the cached
  template can carry a donor's special-purpose scale (confirmed: the
  oversized secret-area spike above), which must not propagate to normal
  placements.

## Texture / sprite export (for external tools)

`RealAssetPalette` also writes PNGs to `MapPaths.TexturesDir` so a
process with no live connection to the game (an editor, a web tool, anything)
can show real art. This is all one-time-per-real-name — every export
function checks `if (File.Exists(...)) return;`/skip before writing, so it's
safe to call every scene load forever without re-exporting.

- `ExportTileTextures`/`ExportTileRules` — every distinct real ground/blue/
  orange tile, plus RuleTile neighbor-matching data (`Unity.2D.Tilemap.Extras`
  ships with the game — the real art is authored as RuleTiles, not flat
  tiles).
- `ScanDecoProps` — up to 8 representative tree-decoration sprites.
- `CaptureSpringAnimation` — plays a spring's real activation animation on a
  spare far-away clone and records every distinct frame (`AnimationUtility`,
  the normal way to read clip keyframes, is Editor-only and unavailable in a
  built game — this is a real recording, not static analysis). Needed
  `AnimatorCullingMode.AlwaysAnimate` since a default Animator stops
  advancing when nothing renders it, which otherwise froze the capture at
  frame 0 forever.
- `ExportComponentSprites` — one representative sprite each for `spike`,
  `startGate`, `endGate`, `upgradeBox` (whatever's cached in `Templates`, or
  found fresh via `FindLiveInstance` for `upgradeBox`, which isn't in
  `ScanTypes`).
- `ExportCourseSnapshot(sceneName)` — a **read-only** dump of everything
  already in a real "Overworld"/"OverworldHard" scene: every occupied ground/
  blue/orange cell (world position), every non-Tilemap-backed spike, every
  start gate, end gate, and upgrade box (with its real name). One-time per
  scene name (skipped if the JSON file exists). The cell/position loops
  yield every 200–500 items across frames — a real scene's ground tilemap
  can be tens of thousands of cells, and this exact kind of full-tilemap
  walk caused a measured, reproducible frame hitch elsewhere in this mod
  (see `LogFullDiagnostics` below) when done in one shot.
  - **This never writes back into the real scene.** It's purely for showing
    "what does this course actually look like" to an external tool. Nothing
    reads it at runtime inside the game itself.

## Known real-game gotchas (all confirmed via real logs/crashes, not guesses)

These cost real debugging time to find. If future behavior looks wrong,
check whether one of these has resurfaced before re-deriving it:

- **Ground/Tilemap needs a `Grid` ancestor.** `Tilemap.CellToWorld`/collision
  alignment silently collapse every cell to the same position without one.
  `EnsureTilemapChild` always creates/reuses a `Grid` parent with the real
  `cellSize` before instantiating a tile clone under it.
- **Spawned hazard colliders must have `isTrigger` force-enabled**
  (`ForceTriggerColliders`) — a cloned real component's collider can come
  across as solid depending on the donor.
- **End gate co-located with spawn crashes the real game.** Imported
  leveledit maps with no real "end" concept default `endX/endY` to
  `startX/startY`. A co-located end gate's trigger fires the instant the
  player spawns, and the real `endGate.OnTriggerEnter2D` was never written
  to handle that (confirmed NullReferenceException). `SpawnGates` disables
  the end gate's colliders entirely if `Distance(start, end) < 5f`.
- **A real Rigidbody2D at the exact same position as a non-trigger gate
  launches the player.** Unity's overlap-separation solver resolves
  interpenetration by launching the dynamic body — confirmed ~350-unit
  instant horizontal launch. Gates get forced `Kinematic` + `isTrigger` on
  every collider (`SpawnGates`).
- **`startGate.resetPoint` comes across null on a clone**, since the source
  scene wired it to an external marker outside the cloned subtree — set to
  the gate's own GameObject if null, or `OnTriggerStay2D` NullRefs on touch.
- **`endGate.isEndOfCourse` must be forced false**, or the real gate calls
  `courseScript.stopTracking(player, true)` and grants the real tier-
  multiplier reward automatically. Custom-map rewards are author-configured
  (`MapReward`/`MapRewardTrigger`), applied separately — this flag only
  suppresses the automatic vanilla grant, tracking-stop/reset side effects
  stay intact.
- **`upgradeBox.Start()` NullReferenceExceptions regardless of upgrade
  type.** It unconditionally does
  `localUpgradeScript = GetComponentInParent<localUpgrades>()`, and several
  code paths dereference it without a null check — confirmed via a real
  crash on DashUnlock/Double Jump/Wall Jump (allowed types), not just denied
  ones. Fix: reparent any cloned `upgradeBox` under a real `localUpgrades`
  child (every course template has one) instead of directly under the
  course root.
- **A cloned course inherits `isOnPauseMenu = true`** from its donor (the
  decorative "course 1" behind the main menu), which makes `load()` read a
  bundled canned demo ghost-path instead of a real per-course save file.
  Forced false via reflection before `course.load(SaveFolder)`.
- **The cloned course template's own hazards must be stripped explicitly**:
  `Destroy(clone.transform.Find("DisableBits").gameObject)`. A real course
  root has exactly 3 children — `DisableBits` (the donor's own real
  hazards), `localUpgrades`, `Clones` (ghost-replay system) — confirmed via
  a real runtime scan, not assumed.
- **A dash (or other in-flight impulse) active on the exact load frame
  carries the player away from the intended spawn** before that frame's
  position-set takes visible effect. `ReassertSpawnAfterDash` re-applies
  position + camera once `movement.dashActive` actually clears.
- **The camera never automatically follows into the pocket.** Nothing about
  `changeScene()`/`changeSceneHard()` knows about the pocket trick.
  `SnapCameraToRealPlayerWhenReady` re-snaps the camera to wherever the real
  player ends up, and separately rescues a player found still stuck in the
  pocket (`Distance(pos, PocketOrigin) < 20000f`) back to the real cached
  start-gate position — this handles returning to Base Game/B-side after a
  custom map without a manual re-teleport.
- **`Tilemap.GetTilesBlock()` over a full `cellBounds` is a real,
  reproducible frame hitch** if called repeatedly (confirmed: a heartbeat
  logger doing this every 3s caused a visible lag spike while falling). The
  ongoing diagnostic heartbeat (`LogFullDiagnostics`) deliberately avoids any
  full-tilemap enumeration; `ExportCourseSnapshot`'s one-time cell walk
  avoids the same problem by yielding across frames instead of skipping the
  work outright, since it only ever runs once per scene name.
- **A stale course/overlay GameObject can survive a scene change untouched**
  — a dynamically-`Instantiate()`'d root sitting at extreme pocket
  coordinates isn't part of whatever scene asset Unity is actually
  unloading. Confirmed: loading a second custom map after returning to
  MainMenu left the first map's 500+ spikes still alive, overlapping the new
  map. `_currentCourseGo`/`_currentOverlayGo` are explicitly `Destroy()`d in
  the scene-loaded handler before being nulled, not just dropped.
- **Custom-map save files land in the shared real save folder.** A finished
  custom map calls the real `courseScript.stopTracking(player, true)`,
  which writes `course<N>data.txt` into the same `Savedata`/`Savedatahard`
  folder Base Game/B-side use — by design (`StableCourseNumber` hashes the
  map id into the `900000–999999` range specifically so it can never collide
  with real courses 1–5). This is intentional and harmless, but if you ever
  see stray `course9xxxxxdata.txt` files in a real save folder, that's why —
  it's not corruption.

## Map JSON schema

```json
{
  "formatVersion": 1,
  "isOverlay": false,
  "name": "Display Name",
  "description": "Shown wherever the map is listed",
  "images": ["gallery/01-overview.png"],
  "customImages": [
    { "assetId": "my_texture", "path": "assets/my_texture.png", "pixelsPerUnit": 2.0 }
  ],
  "groups": [
    {
      "startX": 0, "startY": 0,
      "endX": 800, "endY": 0,
      "reward": { "currency": "Cash", "amount": 1000 },
      "objects": [
        { "type": "ground", "cellX": 0, "cellY": -1, "tileName": "TILE V2 Tileset_3" },
        { "type": "coloredGround", "color": "blue", "cellX": 5, "cellY": -1 },
        { "type": "block", "x": 100, "y": 0, "rotation": 0, "assetId": "my_texture", "scaleX": 1, "scaleY": 1 },
        { "type": "blueBlock", "x": 132, "y": 0, "rotation": 0 },
        { "type": "orangeBlock", "x": 164, "y": 0, "rotation": 0 },
        { "type": "spike", "x": 200, "y": 0, "rotation": 90 },
        { "type": "checkpoint", "x": 400, "y": 0 },
        { "type": "spring", "x": 500, "y": 0, "rotation": 90, "strength": 1.0, "upForce": 1.0 },
        { "type": "platform", "rotation": 0, "positions": [
            { "x": 600, "y": 0, "timeToReachFromPrevious": 0, "tween": "linear" },
            { "x": 650, "y": 50, "timeToReachFromPrevious": 2.0, "tween": "easeInOutBack", "nextPhaseOnEnter": true }
        ]},
        { "type": "deco", "decoName": "<real tree part name>", "x": 300, "y": 0, "scale": 1 },
        { "type": "customImage", "assetId": "my_texture", "x": 700, "y": 0, "scale": 1 },
        { "type": "wattTile", "x": 750, "y": 0, "assetId": "my_texture", "amount": 1e25 },
        { "type": "modifyObject", "objectName": "Double jump", "x": 50, "y": 100, "rotation": 0 }
      ]
    }
  ]
}
```

Notes:
- `objects[].type` is a plain string discriminator switched on directly —
  no polymorphic `$type`. Unknown types are skipped with a log warning at
  load time, so schema can grow without breaking old maps.
- Coordinates are group-local float world units, except `ground`/
  `coloredGround` which use integer `cellX`/`cellY` (painted via
  `Tilemap.SetTile`, not a world-position transform).
- `reward` is optional; omitted or zero amount means no automatic grant on
  finishing that group. Real currency enum values: `Cash`, `GreenPower`,
  `AtomicPower`, `regularNumber`, `CloneDust` (`globalStats.Currencies`) —
  `regularNumber` looks internal/unused, avoid unless proven otherwise.
- `tileName` (on `ground`/`coloredGround`) is matched against the real
  distinct tile names cached by `ScanTilemaps` (see
  `textures/<tilemap>/manifest.json` for the list); `tileIndex` is a
  fallback if no name is given.
- The map's **folder name** is its stable id; `name` is just the display
  string, editable independently.

## Orphaned pieces (built for the removed editor, safe to delete or repurpose)

These exist purely to feed an out-of-process visual editor. Nothing at
runtime inside the game reads them back. If a new editor gets built, they're
a reasonable starting point; if not, they're dead weight:

- `RealAssetPalette.ExportComponentSprites()` and its 4 texture folders
  (`spike`/`startGate`/`endGate`/`upgradeBox` under `textures/`).
- `RealAssetPalette.ExportCourseSnapshot()` and everything under
  `course-snapshots/` — including `MapPaths.SnapshotsDir`.
- `app/src-tauri/src/commands/maps.rs`: `get_course_snapshot` +
  `snapshots_dir` (the Tauri command that read the snapshot files — the
  older `list_maps`/`get_map`/`save_map`/`delete_map`/`save_map_image`/
  `list_tile_textures`/`read_tile_texture`/`read_tile_rules` commands
  predate the editor and are still meaningful as a general maps backend even
  without it).
- `MapManager.SpawnColoredBlock` and the `blueBlock`/`orangeBlock` object
  types are **not** orphaned in the same sense — they're real schema/loader
  capability usable by hand-written `map.json` files even with no editor UI.
  They were *added* to support the editor's palette, but they don't depend
  on it existing.
- `app/src/maps/script.js`'s `.filter((m) => !m.id.startsWith('_'))` in
  `renderInstalled` — keeps `_BaseGameEdits`/`_BSideEdits` out of the public
  Maps tab browsing list. Harmless and still correct to keep even with no
  editor, in case those folders ever get created by hand or by a future tool.

## What's genuinely unfinished

- **No way to author `_BaseGameEdits`/`_BSideEdits` overlays anymore.** The
  removed editor was the only thing that ever wrote to them. The runtime
  auto-apply logic (`SnapCameraToRealPlayerWhenReady`'s `autoApplyMapId`)
  still works if such a folder exists — nothing stops a human (or a future
  tool) from hand-writing one.
- **The last known editor bug was never root-caused**: real extracted
  sprite PNGs (verified correct on disk — real ground panel art, a real
  3-spike hazard sprite, a real upgrade-box icon) were not rendering in the
  editor's canvas; flat fallback shapes rendered instead. Suspected but
  unconfirmed: an image-loading failure specific to the packaged release
  build (blob URL / CSP / timing) that didn't reproduce in the `tauri dev`
  session used for most of this feature's development. If reviving the
  editor, start by checking whether `read_tile_texture` actually returns
  bytes and whether the resulting `Image` fires `onload` in that exact
  build context before assuming the C#/export side is at fault — every
  exported PNG was independently verified to be correct real game art.
- **`PlatformMover` templates have never been confirmed reachable** via
  passive scene scanning in current testing (`LogPlatformMoverCount` logs
  `0 (scene-valid: 0)` in every session's log). The spawn code path exists
  and degrades gracefully (logs a warning, spawns nothing) if no template is
  cached — just untested end-to-end.
- **No upgrade-box "add a genuinely new one" story.** `modifyObject` only
  ever references a real, already-existing named object (see the
  pocket-clones-vs-overlay-moves distinction above) — there's no way to
  place a brand-new upgrade with author-chosen cost/effect.

## Build/deploy (manual, no CI)

```
# 1. The native game assembly must be the RECHARGE-patched build to compile against
#    (compare hashes; restore if it's reverted back to vanilla by a "Vanilla" launch):
cp -f "<GameDir>\IGTAPsnfDemo_Data\Managed\Assembly-CSharp.RECHARGE.dll" \
      "<GameDir>\IGTAPsnfDemo_Data\Managed\Assembly-CSharp.dll"

# 2. Build
dotnet build RechargeMaps.csproj -p:ManagedDir="<GameDir>\IGTAPsnfDemo_Data\Managed" -c Debug

# 3. Deploy (copy into the *game's* mod folder, not the repo)
cp bin/Debug/netstandard2.1/RechargeMaps.dll \
   "<GameDir>\Recharge\Mods\recharge.maps\RechargeMaps.dll"
```

There's no automated test suite. Verification has always meant: relaunch the
real game (Modded), read `Player.log` for the `[RechargeMaps]`-prefixed
lines, and/or get a screenshot. `RealAssetPalette.LogFullDiagnostics()` runs
every 10s specifically to give a continuous timeline to diff against for
exactly this kind of manual verification.
