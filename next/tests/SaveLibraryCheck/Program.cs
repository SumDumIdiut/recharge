using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using Newtonsoft.Json;
using Recharge.Module.Maps;

// Exercises the actual save library without starting Unity or touching IGTAP's saves.
internal static class Program
{
    private const string OldPlayer = "{\"_respawnPoint\":{\"x\":8.0,\"y\":2.0},\"_currencies\":[{\"_Key\":0,\"_Value\":25.0}]}";
    private const string NewPlayer = "{\"_respawnPoint\":{\"x\":19.5,\"y\":1.0},\"_visitedTeleporters\":[2]}";
    private const string TruncatedPlayer = "{\"_respawnPoint\":{\"x\":19.5,";
    private const string PlayerFile = "playerdata.txt";

    private static void Main()
    {
        var temp = Path.GetFullPath(Path.GetTempPath());
        var root = Path.Combine(temp, "RechargeSaveCheck-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            RejectsCorruptUpdates(Path.Combine(root, "publish"));
            CarriesForwardGoodBackup(Path.Combine(root, "backup"));
            Recovery(Path.Combine(root, "missing-data"), save => File.Delete(PlayerPath(save, SaveLibrary.Primary)), restore: true);
            Recovery(Path.Combine(root, "checksum"), save => File.WriteAllText(PlayerPath(save, SaveLibrary.Primary), OldPlayer), restore: true);
            Recovery(Path.Combine(root, "verified"), _ => { }, restore: false);
            PreservesBothDamagedCopies(Path.Combine(root, "manual-recovery"));
            Console.WriteLine("Save library checks passed.");
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    private static void RejectsCorruptUpdates(string root)
    {
        using var library = new SaveLibrary(root);
        var saved = WritePlayer(Path.Combine(root, "Original"), OldPlayer);
        var slot = Create(library, saved);
        foreach (var contents in new[] { TruncatedPlayer, "{}" })
        {
            var working = WritePlayer(Path.Combine(root, "Working"), contents);
            try
            {
                library.Update(slot, working, saved);
                throw new InvalidOperationException("A valid backup must not make a corrupt primary publishable.");
            }
            catch (IOException) { }
            Require(File.ReadAllText(PlayerPath(slot.Path, SaveLibrary.Primary)) == OldPlayer, "Original primary was lost.");
            Require(File.ReadAllText(PlayerPath(slot.Path, SaveLibrary.Backup)) == OldPlayer, "Original backup was lost.");
        }
    }

    private static void CarriesForwardGoodBackup(string root)
    {
        using var library = new SaveLibrary(root);
        var slot = Create(library, WritePlayer(Path.Combine(root, "Original"), OldPlayer));
        var working = WritePlayer(Path.Combine(root, "Working"), NewPlayer);
        var badBackup = WritePlayer(Path.Combine(root, "Backup"), TruncatedPlayer);
        foreach (var backup in new[] { badBackup, null })
        {
            library.Update(slot, working, backup);
            Require(File.ReadAllText(PlayerPath(slot.Path, SaveLibrary.Primary)) == NewPlayer, "New primary was not published.");
            Require(File.ReadAllText(PlayerPath(slot.Path, SaveLibrary.Backup)) == OldPlayer, "Last good backup was not carried forward.");
        }
    }

    private static void Recovery(string root, Action<string> interrupt, bool restore)
    {
        var slot = InterruptedPublish(root);
        interrupt(slot);
        for (int i = 0; i < 2; i++)
        {
            using var library = new SaveLibrary(root);
            Require(library.Scan().Single().Path == slot, "Recovery did not leave exactly one slot.");
            Require(File.ReadAllText(PlayerPath(slot, SaveLibrary.Primary)) == (restore ? OldPlayer : NewPlayer),
                "Recovery picked the wrong snapshot.");
            Require(File.ReadAllText(PlayerPath(slot, SaveLibrary.Backup)) == OldPlayer, "Recovery lost the backup.");
        }
    }

    private static void PreservesBothDamagedCopies(string root)
    {
        var slot = InterruptedPublish(root);
        var previous = Path.Combine(root, "Recharge", "SaveLibrary", "Transactions", "Simulated", "Previous");
        File.WriteAllText(PlayerPath(previous, SaveLibrary.Primary), TruncatedPlayer);
        File.WriteAllText(PlayerPath(previous, SaveLibrary.Backup), TruncatedPlayer);
        File.WriteAllText(PlayerPath(slot, SaveLibrary.Primary), TruncatedPlayer);
        using var library = new SaveLibrary(root);
        Require(library.RecoveryMessage.Contains("manual recovery"), "The user needs a recovery message.");
        Require(Directory.GetDirectories(library.Recovery, "Previous", SearchOption.AllDirectories).Length == 1,
            "The damaged previous copy was lost.");
        Require(Directory.GetDirectories(library.Recovery, "Incomplete", SearchOption.AllDirectories).Length == 1,
            "The damaged replacement was lost.");
    }

    // Model the process stopping immediately after the second rename.
    private static string InterruptedPublish(string root)
    {
        using var library = new SaveLibrary(root);
        var slot = Create(library, WritePlayer(Path.Combine(root, "Original"), OldPlayer));
        var transaction = Path.Combine(root, "Recharge", "SaveLibrary", "Transactions", "Simulated");
        var next = Path.Combine(transaction, "Next");
        SaveLibrary.Copy(slot.Path, next);
        File.WriteAllText(PlayerPath(next, SaveLibrary.Primary), NewPlayer);
        var files = Directory.GetFiles(next, "*", SearchOption.AllDirectories).ToDictionary(
            file => Path.GetRelativePath(next, file).Replace('\\', '/'),
            file => Convert.ToBase64String(SHA256.HashData(File.ReadAllBytes(file))));
        File.WriteAllText(Path.Combine(transaction, "Journal"), JsonConvert.SerializeObject(new
        {
            Name = slot.Label, SaveId = slot.Metadata.Id, RequiresPlayer = true, RequiresPrimary = true, Files = files,
        }));
        Directory.Move(slot.Path, Path.Combine(transaction, "Previous"));
        Directory.Move(next, slot.Path);
        return slot.Path;
    }

    private static SaveEntry Create(SaveLibrary library, string payload) =>
        library.Create(SaveLibrary.Vanilla, SaveLibrary.BaseGame, "Base Game", null, payload, payload);

    private static string WritePlayer(string path, string contents)
    {
        Directory.CreateDirectory(path);
        File.WriteAllText(Path.Combine(path, PlayerFile), contents);
        return path;
    }

    private static string PlayerPath(string slot, string folder) => Path.Combine(slot, folder, PlayerFile);

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
