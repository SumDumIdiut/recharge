using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Recharge.Module.Maps;

// Metadata is Recharge's index. The two payload directories keep the names and
// bytes expected by the game. A directory name is a label and can be changed.
internal sealed class SaveMetadata
{
    [JsonProperty("formatVersion")] public int Version;
    [JsonProperty("saveId")] public string Id;
    [JsonProperty("mapKind")] public string Kind;
    [JsonProperty("mapId")] public string MapId;
    [JsonProperty("mapName")] public string MapName;
    [JsonProperty("mapRevision")] public string Revision;
    [JsonProperty("createdUtc")] public DateTime Created;
    [JsonProperty("lastSavedUtc")] public DateTime? Saved;
    [JsonProperty("progressFlags")] public Dictionary<string, int> Flags;
    [JsonProperty("legacyFolder")] public string LegacyFolder;

    public bool Matches(string kind, string mapId) => Kind == kind && MapId == mapId;
}

internal sealed class SaveEntry
{
    public string Path;
    public SaveMetadata Metadata;
    public string Label => System.IO.Path.GetFileName(Path);
}

/// <summary>On-disk save catalog and recoverable directory replacement. No Unity dependencies.</summary>
internal sealed class SaveLibrary : IDisposable
{
    public const string BaseGame = "base-game";
    public const string Vanilla = "vanilla";
    public const string Custom = "custom";
    public const string Primary = "Savedata";
    public const string Backup = "Savedatabackup";
    private const string MetadataFile = "Metadata";
    private const string JournalFile = "Journal";
    private const string Next = "Next";
    private const string Previous = "Previous";

    private sealed class SaveJournal
    {
        public string Name;
        public string SaveId;
        public bool RequiresPlayer;
        public bool RequiresPrimary;
        public Dictionary<string, string> Files;
    }

    private readonly string _root;
    private readonly string _transactions;
    private readonly FileStream _lock;
    public string Recovery { get; }
    public string RecoveryMessage { get; private set; }

    public SaveLibrary(string gameDir)
    {
        _root = Path.Combine(gameDir, "SaveFiles");
        var state = Path.Combine(gameDir, "Recharge", "SaveLibrary");
        _transactions = Path.Combine(state, "Transactions");
        Recovery = Path.Combine(state, "Recovery");
        Directory.CreateDirectory(_root);
        Directory.CreateDirectory(_transactions);
        RequireDirectory(_root);
        RequireDirectory(Path.GetDirectoryName(state));
        RequireDirectory(state);
        RequireDirectory(_transactions);
        _lock = File.Open(Path.Combine(state, "Library.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        try { RecoverTransactions(); }
        catch { _lock.Dispose(); throw; }
    }

    public void Dispose() => _lock.Dispose();

    public List<SaveEntry> Scan()
    {
        var entries = new List<SaveEntry>();
        foreach (var path in Directory.GetDirectories(_root).OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
        {
            // Links can escape the save library, including during a later archive.
            if (IsLink(path)) continue;
            entries.Add(new SaveEntry { Path = path, Metadata = ReadMetadata(path) });
        }
        // A copied folder may carry the same Metadata ID. We can't tell which
        // folder was the original, so ask the player to assign one of them.
        foreach (var copies in entries.Where(e => e.Metadata != null).GroupBy(e => e.Metadata.Id).Where(g => g.Count() > 1).ToList())
            foreach (var copy in copies) copy.Metadata = null;
        return entries;
    }

    public SaveEntry Create(string kind, string mapId, string name, string revision, string primary = null,
        string backup = null, Dictionary<string, int> flags = null, string legacy = null)
    {
        var entry = new SaveEntry { Path = NextFolder(), Metadata = NewMetadata(kind, mapId, name, revision, flags) };
        entry.Metadata.LegacyFolder = legacy;
        WriteSnapshot(entry, primary, backup);
        return entry;
    }

    public void Assign(SaveEntry entry, string kind, string mapId, string name, string revision)
    {
        RequireEntry(entry);
        if (ReadMetadata(entry.Path) != null && !Scan().Any(e => e.Path == entry.Path && e.Metadata == null))
            throw new IOException("This save already belongs to a map.");
        if (!HasPlayer(Path.Combine(entry.Path, Primary), Path.Combine(entry.Path, Backup)))
            throw new IOException("This folder has no playerdata.txt in Savedata or Savedatabackup.");
        CheckTree(entry.Path);
        var file = Path.Combine(entry.Path, MetadataFile);
        if (File.Exists(file))
        {
            try
            {
                if (JObject.Parse(File.ReadAllText(file))["formatVersion"]?.Value<int>() > 1)
                    throw new IOException("This save needs a newer version of Recharge.");
            }
            catch (JsonException) { }
        }
        entry.Metadata = NewMetadata(kind, mapId, name, revision, null);
        WriteSnapshot(entry, Path.Combine(entry.Path, Primary), Path.Combine(entry.Path, Backup));
    }

    private static SaveMetadata NewMetadata(string kind, string mapId, string name, string revision,
        Dictionary<string, int> flags) => new SaveMetadata
    {
        Version = 1, Id = Guid.NewGuid().ToString("N"), Kind = kind, MapId = mapId, MapName = name,
        Revision = revision, Created = DateTime.UtcNow, Flags = flags,
    };

    public void LoadInto(SaveEntry entry, string primary, string backup)
    {
        RequireCurrent(entry);
        var source = Path.Combine(entry.Path, Primary);
        var sourceBackup = Path.Combine(entry.Path, Backup);
        if (!CanLoad(entry.Metadata, source, sourceBackup))
            throw new IOException("This save has no valid player data in its primary or backup folder.");
        Copy(source, primary);
        Copy(sourceBackup, backup);
    }

    // Publish only after the complete snapshot is staged on the same volume.
    // The previous directory stays next to the journal until the rename succeeds.
    public void Update(SaveEntry entry, string primary, string backup)
    {
        RequireCurrent(entry);
        // A backup can recover an existing slot, but an invalid primary is
        // not a completed save. Carry over the slot's last good backup.
        var savedBackup = Path.Combine(entry.Path, Backup);
        if (!HasPlayer(backup)) backup = HasPlayer(savedBackup) ? savedBackup : null;
        WriteSnapshot(entry, primary, backup, requiresPrimary: true);
    }

    private void WriteSnapshot(SaveEntry entry, string primary, string backup, bool requiresPrimary = false)
    {
        RequireEntry(entry);
        if (Directory.Exists(entry.Path))
        {
            var current = ReadMetadata(entry.Path);
            if (current != null && current.Id != entry.Metadata.Id && Scan().Any(e => e.Path == entry.Path && e.Metadata != null))
                throw new IOException("The save folder now belongs to another save.");
        }
        var transaction = Path.Combine(_transactions, Guid.NewGuid().ToString("N"));
        var staged = Path.Combine(transaction, Next);
        var previous = Path.Combine(transaction, Previous);
        Directory.CreateDirectory(staged);
        var savedAt = entry.Metadata.Saved;
        try
        {
            if (Directory.Exists(entry.Path))
            {
                foreach (var path in Directory.EnumerateFileSystemEntries(entry.Path))
                {
                    var name = Path.GetFileName(path);
                    if (string.Equals(name, Primary, StringComparison.OrdinalIgnoreCase)
                        || string.Equals(name, Backup, StringComparison.OrdinalIgnoreCase)
                        || string.Equals(name, MetadataFile, StringComparison.OrdinalIgnoreCase)) continue;
                    RequireUnlinked(path);
                    var destination = Path.Combine(staged, name);
                    if (Directory.Exists(path)) Copy(path, destination);
                    else File.Copy(path, destination);
                }
            }
            var stagedPrimary = Path.Combine(staged, Primary);
            var stagedBackup = Path.Combine(staged, Backup);
            Copy(primary, stagedPrimary);
            Copy(backup, stagedBackup);
            var hasPrimary = HasPlayer(stagedPrimary);
            var hasBackup = HasPlayer(stagedBackup);
            var requiresPlayer = requiresPrimary || primary != null || backup != null;
            if ((requiresPrimary && !hasPrimary) || (requiresPlayer && !hasPrimary && !hasBackup))
                throw new IOException("The replacement save has no valid player data. The previous save was kept.");
            if (requiresPrimary && backup != null && !hasBackup)
                throw new IOException("The backup changed during the copy. The previous save was kept.");
            if (hasPrimary || hasBackup) entry.Metadata.Saved = DateTime.UtcNow;
            WriteJson(Path.Combine(staged, MetadataFile), entry.Metadata);
            var journal = new SaveJournal
            {
                Name = entry.Label, SaveId = entry.Metadata.Id, RequiresPlayer = requiresPlayer,
                RequiresPrimary = requiresPrimary, Files = Fingerprint(staged),
            };
            // The journal must be durable before the first rename. A restart
            // can verify a published directory even when Next no longer exists.
            WriteJson(Path.Combine(transaction, JournalFile), journal);
            if (Directory.Exists(entry.Path)) Directory.Move(entry.Path, previous);
            Directory.Move(staged, entry.Path);
            if (!MatchesPublished(entry.Path, journal))
                throw new IOException("The published save did not match the validated files.");
        }
        catch
        {
            entry.Metadata.Saved = savedAt;
            RecoverTransaction(transaction);
            throw;
        }
        Directory.Delete(transaction, true);
    }

    public void Archive(SaveEntry entry)
    {
        RequireCurrent(entry);
        var archive = NewRecoveryFolder(Recovery, entry.Label);
        Directory.Move(entry.Path, Path.Combine(archive, "Save"));
    }

    public static string NewRecoveryFolder(string root, string label)
    {
        Directory.CreateDirectory(root);
        RequireDirectory(root);
        var dir = Path.Combine(root, label + "-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private void RecoverTransactions()
    {
        foreach (var transaction in Directory.GetDirectories(_transactions)) RecoverTransaction(transaction);
    }

    private void RecoverTransaction(string transaction)
    {
        RequireUnlinked(transaction);
        var journalFile = Path.Combine(transaction, JournalFile);
        var previous = Path.Combine(transaction, Previous);
        var staged = Path.Combine(transaction, Next);
        var journal = ReadJson<SaveJournal>(journalFile);
        var hasPrevious = Directory.Exists(previous);
        // An incomplete draft cannot have touched a slot. The journal is
        // flushed first, and a staged directory is renamed as a unit.
        if (!hasPrevious && (Directory.Exists(staged) || !File.Exists(journalFile)))
        {
            Directory.Delete(transaction, true);
            return;
        }
        // Preview builds before the manifest used a plain folder name.
        // Recover them conservatively and keep any unverified replacement.
        var name = journal?.Name ?? ReadLegacyDestination(transaction);
        if (!IsName(name))
        {
            PreserveTransaction(transaction);
            return;
        }
        var destination = Path.Combine(_root, name);
        if (!Directory.Exists(staged) && MatchesPublished(destination, journal))
        {
            Directory.Delete(transaction, true);
            return;
        }

        var destinationInfo = ReadMetadata(destination);
        if (File.Exists(destination) || (Directory.Exists(destination) && IsLink(destination))
            || (destinationInfo != null && journal != null && destinationInfo.Id != journal.SaveId))
        {
            PreserveTransaction(transaction);
            return;
        }
        if (Directory.Exists(destination))
        {
            var archive = NewRecoveryFolder(Recovery, name);
            Directory.Move(destination, Path.Combine(archive, "Incomplete"));
            RecoveryMessage = "An incomplete save was moved to recovery.";
        }
        if (hasPrevious && CanRestorePrevious(previous))
        {
            Directory.Move(previous, destination);
            RecoveryMessage = "Recovered the previous save for " + name + ".";
            Directory.Delete(transaction, true);
            return;
        }
        if (hasPrevious) { PreserveTransaction(transaction); return; }
        Directory.Delete(transaction, true);
    }

    private void PreserveTransaction(string transaction)
    {
        var archive = NewRecoveryFolder(Recovery, "Unverified");
        Directory.Move(transaction, Path.Combine(archive, "Transaction"));
        RecoveryMessage = "A save needs manual recovery. Its files are in Recharge/SaveLibrary/Recovery.";
    }

    private static string ReadLegacyDestination(string transaction)
    {
        var path = Path.Combine(transaction, "Destination");
        return File.Exists(path) && !IsLink(path) ? File.ReadAllText(path) : null;
    }

    private static bool MatchesPublished(string folder, SaveJournal journal)
    {
        if (journal?.Files == null || !Directory.Exists(folder) || IsLink(folder)) return false;
        var metadata = ReadMetadata(folder);
        if (metadata == null || metadata.Id != journal.SaveId) return false;
        var primary = Path.Combine(folder, Primary);
        var backup = Path.Combine(folder, Backup);
        if (journal.RequiresPrimary ? !HasPlayer(primary) : journal.RequiresPlayer && !HasPlayer(primary, backup))
            return false;
        try
        {
            var actual = Fingerprint(folder);
            return actual.Count == journal.Files.Count
                && actual.All(file => journal.Files.TryGetValue(file.Key, out var hash) && hash == file.Value);
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    private static bool CanRestorePrevious(string folder)
    {
        try { CheckTree(folder); }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
        return CanLoad(ReadMetadata(folder), Path.Combine(folder, Primary), Path.Combine(folder, Backup));
    }

    private static bool CanLoad(SaveMetadata metadata, string primary, string backup) =>
        HasPlayer(primary, backup) || (metadata != null && metadata.Saved == null
            && !Directory.Exists(primary) && !Directory.Exists(backup));

    private string NextFolder()
    {
        long last = 0;
        foreach (string path in Directory.EnumerateFileSystemEntries(_root))
        {
            var name = Path.GetFileName(path);
            if (name.StartsWith("Savegame-", StringComparison.OrdinalIgnoreCase) && long.TryParse(name.Substring(9), out long n))
                last = Math.Max(last, n);
        }
        if (last == long.MaxValue) throw new IOException("Rename the highest-numbered save to create another one.");
        return Path.Combine(_root, "Savegame-" + (last + 1));
    }

    private static SaveMetadata ReadMetadata(string path)
    {
        var data = ReadJson<SaveMetadata>(Path.Combine(path, MetadataFile));
        return data != null && data.Version == 1 && Guid.TryParseExact(data.Id, "N", out _)
            && (data.Matches(Vanilla, BaseGame) || data.Kind == Custom && !string.IsNullOrWhiteSpace(data.MapId)) ? data : null;
    }

    private void RequireCurrent(SaveEntry entry)
    {
        RequireEntry(entry);
        var current = ReadMetadata(entry.Path);
        if (entry.Metadata == null || current?.Id != entry.Metadata.Id || !current.Matches(entry.Metadata.Kind, entry.Metadata.MapId))
            throw new IOException("The save changed on disk. Open the list again.");
        CheckTree(entry.Path);
    }

    private void RequireEntry(SaveEntry entry)
    {
        if (!IsName(entry.Label) || !string.Equals(Path.GetDirectoryName(entry.Path), _root, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Invalid save folder.");
        if (Directory.Exists(entry.Path)) RequireDirectory(entry.Path);
    }

    private static bool IsName(string name) => !string.IsNullOrWhiteSpace(name) && name != "." && name != ".."
        && name.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 && Path.GetFileName(name) == name;

    public static bool HasPlayer(string primary, string backup) => HasPlayer(primary) || HasPlayer(backup);

    private static bool HasPlayer(string folder)
    {
        if (folder == null) return false;
        var data = ReadJson<JObject>(Path.Combine(folder, "playerdata.txt"));
        // Movement.load reads this Vector2 and uses it to resume the run.
        // Older saves may omit later fields such as visited teleporters.
        return data?["_respawnPoint"] is JObject checkpoint && IsNumber(checkpoint["x"]) && IsNumber(checkpoint["y"])
            && IsProgressList(data["_currencies"]) && IsProgressList(data["_globalUpgradeDict"]);
    }

    private static bool IsProgressList(JToken list) => list == null || list.Type == JTokenType.Null ||
        (list is JArray entries && entries.All(entry => entry is JObject item
            && item["_Key"]?.Type == JTokenType.Integer && IsNumber(item["_Value"])));

    private static bool IsNumber(JToken value) => (value?.Type == JTokenType.Integer || value?.Type == JTokenType.Float)
        && !double.IsNaN(value.Value<double>()) && !double.IsInfinity(value.Value<double>());

    private static T ReadJson<T>(string path) where T : class
    {
        try
        {
            if (!File.Exists(path) || IsLink(path)) return null;
            return JsonConvert.DeserializeObject<T>(File.ReadAllText(path));
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
        catch (JsonException) { return null; }
    }

    private static void WriteJson(string path, object value)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(value, Formatting.Indented));
        using var file = File.Open(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        file.Write(bytes, 0, bytes.Length);
        file.Flush(true);
    }

    // Read through a stream so verifying a migrated map never allocates two
    // whole copies of a large save file in memory.
    public static bool ContainsCopy(string source, string destination)
    {
        if (!Directory.Exists(source)) return true;
        if (!Directory.Exists(destination)) return false;
        var files = Fingerprint(source, skipSwapMarker: true);
        var copies = Fingerprint(destination);
        return files.All(file => copies.TryGetValue(file.Key, out var hash) && hash == file.Value);
    }

    private static Dictionary<string, string> Fingerprint(string root, bool skipSwapMarker = false)
    {
        var files = new Dictionary<string, string>(StringComparer.Ordinal);
        using var sha = SHA256.Create();
        void Visit(string folder)
        {
            RequireUnlinked(folder);
            foreach (var path in Directory.EnumerateFileSystemEntries(folder))
            {
                RequireUnlinked(path);
                if (Directory.Exists(path)) Visit(path);
                else if (!skipSwapMarker || Path.GetFileName(path) != "navigator-swapped")
                {
                    using var file = File.OpenRead(path);
                    files.Add(Path.GetRelativePath(root, path).Replace('\\', '/'), Convert.ToBase64String(sha.ComputeHash(file)));
                }
            }
        }
        Visit(root);
        return files;
    }

    public static void Copy(string source, string target)
    {
        if (source == null || !Directory.Exists(source)) return;
        RequireDirectory(source);
        Directory.CreateDirectory(target);
        foreach (var path in Directory.EnumerateFileSystemEntries(source))
        {
            if (IsLink(path)) throw new IOException("Save contains a link: " + path);
            var name = Path.GetFileName(path);
            if (name == "navigator-swapped") continue;
            var destination = Path.Combine(target, name);
            if (Directory.Exists(path)) Copy(path, destination);
            else File.Copy(path, destination);
        }
    }

    public static void CheckTree(string path)
    {
        RequireDirectory(path);
        foreach (var entry in Directory.EnumerateFileSystemEntries(path))
        {
            if (IsLink(entry)) throw new IOException("Save contains a link: " + entry);
            if (Directory.Exists(entry)) CheckTree(entry);
        }
    }

    private static void RequireDirectory(string path)
    {
        if (IsLink(path)) throw new IOException("Save directory is a link: " + path);
    }

    private static void RequireUnlinked(string path)
    {
        if (IsLink(path)) throw new IOException("Save contains a link: " + path);
    }

    private static bool IsLink(string path) => (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
}
