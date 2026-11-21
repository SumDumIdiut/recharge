# Save files

Open **Start Game**, choose Base Game or a custom map, and pick a save in the right-hand panel. **New Game** creates the next `Savegame-x` folder. Each page has six places for saves and related actions, with **Page** in the bottom row. Use **Back** on Level Select to close the save panel or return from **Needs Import**. Messages appear in a separate panel when needed. **Delete save data** opens the same panel in delete mode and asks for a second click before moving a save to recovery. B-side uses its existing menu and storage.

## On disk

```text
<game install>/SaveFiles/
  Savegame-1/
    Metadata
    Savedata/
      playerdata.txt
      ...
    Savedatabackup/
      ...
```

`Metadata` is JSON without a filename extension. Its `formatVersion` is the Recharge metadata schema version. `saveId` identifies a save independently of its folder name. `mapKind` and `mapId` determine where the save can load. Base Game uses `vanilla` and `base-game`. Hub maps use `hub:<id>`, while local maps use `local:<installed folder>`. `mapName` is a display label. `mapRevision` records the Hub revision when available and triggers a confirmation on mismatch. Other fields record the creation date, snapshot date, per-save progression preferences, and legacy origin for migrated saves.

Rename a save directory with the game closed to change its label. When copying an existing slot, use **Needs Import** to give the copy its own identity. Both copies appear there while their IDs are identical. The picker leaves unsupported metadata versions unassigned. If you rename an installed local *map* folder, use its old name again or import a copy of its saves without the old metadata. Hub map saves keep their identity across folder renames.

The native payload stays in its original format. `Savedatabackup` may be absent if a run has never written a backup. Custom-map payloads also carry Navigator files such as `navigator-start.json` and `navigator-boxes.json`.

**Import Existing Save** copies the original vanilla save and its known progression preferences into an independent slot.

## Copy a Base Game save to vanilla

1. Close IGTAP and open the Base Game slot under `<game install>/SaveFiles/<slot name>`.
2. On the destination computer, open `%USERPROFILE%\AppData\LocalLow\Pepper tango games\IGTAPfullGame`. Move any existing `Savedata` and `Savedatabackup` folders somewhere safe.
3. Copy the slot's `Savedata` and, if present, `Savedatabackup` directly into that directory. Keep their names and leave `Metadata` with the slot.
4. Launch unmodded IGTAP and choose **Start Game**.

Progress that the game stores in PlayerPrefs is separate from these folders. The slot's `Metadata` records the progression keys Recharge manages. Custom-map saves require Recharge and the matching map.

## Responsibilities

- `SaveLibrary.cs` scans the catalog, assigns IDs, and publishes snapshots. The library lock serializes writes by Recharge. Updates require readable native player JSON and a valid checkpoint. When the working backup is missing or damaged, Recharge carries forward the slot's last valid backup.
- Publication stages the complete slot under `Recharge/SaveLibrary/Transactions`. It records and flushes the slot ID and SHA-256 file checksums before either directory rename. Recovery keeps the replacement only when it matches that record. Otherwise it restores a valid `Previous` copy and archives the incomplete replacement. When both copies need attention, their files are kept in `Recharge/SaveLibrary/Recovery` and the picker shows a recovery message. Delete also moves the whole slot to recovery.
- `SaveHooks.cs` in the patcher changes the folder argument passed by the native loader and saver. With no named session it returns the original path. For a named session it points at `RechargeSaveWork/<session-id>/Savedata` under the persistent data directory. The game continues adding its normal backup suffix and invoking its own player and course serializers. The commit callback runs after the native save loop succeeds, inside the try block. The skipped-save and caught-error paths bypass it. Check this IL shape when updating support for a new game build.
- `SaveSlots.cs` owns the selected working copy and progression scope. It restores the selected run's preferences and prefixes the audited progression keys with its save ID. Display, control and audio preferences stay shared. It publishes Base Game snapshots after native saves and keeps the previous snapshot if publishing fails. Successful sessions are cleaned up on return to the title screen. A crash or failed publication can leave the working files under `RechargeSaveWork` for recovery. In that case copy them aside before attempting a manual recovery.
- `MapManager.cs` selects the session before the gameplay scenes load. `MapSaves.cs` retains its existing custom-map save rules, including checkpoint and course saves and using the map's serializer with native-format files. Map entries received directly from the app resume the newest matching save. The editor's **Test in game** uses an isolated temporary session when the hooks are available.
- `SavePicker.cs` handles the list, confirmation, and import flow. It uses the folder name for display and the metadata map identity for filtering. `MapMenuBuilder.cs` continues to own Level Select and the Back button.

## Legacy migration

After the original Navigator swap is recovered, Recharge matches folders under the persistent `SavedataMaps` directory to installed map IDs using the old folder rule. It copies the primary and backup directories, compares their files with the new copy, then archives the sources under `RechargeLegacySaveRecovery` on the original drive. The save's `legacyFolder` value identifies the already published copy when a restart interrupts the archive. Ambiguous or uninstalled maps remain at the old location for manual assignment. For unresolved legacy entries, **Needs Import** imports the individually chosen directory and archives it. Any uncertain backup directory stays available in the old location.

## Verification

Build `Recharge.Loader.csproj` with `GameManagedDir` pointing to IGTAP's managed assemblies and build `Recharge.Patcher.csproj`. Redeploy both the patcher and loader through **Update/Repair**. A loader-only refresh cannot install the new native save hooks.

Run the disposable save-library checks from the repository root. They cover damaged player data, backup retention, and reopening interrupted transactions.

```powershell
dotnet run --project next/tests/SaveLibraryCheck "-p:GameManagedDir=C:/path/to/IGTAPfullGame_Data/Managed"
```

Use a disposable game/save environment for the first in-game pass.

1. Create two Base Game saves and two saves for one custom map. Get a different checkpoint or upgrade on each. Return to the title screen, restart the game, and verify all four runs independently.
2. Import an original vanilla save, copy its native directories as described above, and load them with the unmodified game. Check that the original persistent data stays byte-for-byte intact while named sessions run.
3. Start with a legacy custom save and its backup. Start Recharge twice and check there is one migrated entry, with the same checkpoint and upgrades. Check that a map rename, an ambiguous name and an unsupported metadata version keep the data available.
4. Interrupt a snapshot while copying and between the two directory renames. Check that the last published save or its previous version is still available. Check that a standalone vanilla launch after an interrupted named run still sees its original save.
5. Exercise B-side, editor playtests, Steam Cloud when enabled, and mods that depend on game loading or save paths, including Tas Studio.
