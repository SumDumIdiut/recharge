using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json;
using Recharge.ModApi;

// host.LoadConfig/SaveConfig cover the common "one JSON file" case. Anything
// more custom - a different format, atomic writes, or files that aren't
// config at all - goes straight through host.ModDataDir(modId) and System.IO.
internal static class DataFolderDemo
{
    internal class ScoreRecord
    {
        public string PlayerName;
        public int Score;
        public DateTime AchievedAt;
    }

    public static void WriteScoresAtomically(IRechargeHost host, string modId, List<ScoreRecord> scores)
    {
        var dir = host.ModDataDir(modId);
        var finalPath = Path.Combine(dir, "scores.json");
        var tempPath = finalPath + ".tmp";

        File.WriteAllText(tempPath, JsonConvert.SerializeObject(scores, Formatting.Indented));

        // A crash or power loss mid-write leaves scores.json untouched and the
        // half-written data sitting in .tmp instead of corrupting the real
        // file - File.Replace is atomic on the same volume, a direct
        // File.WriteAllText(finalPath, ...) is not.
        if (File.Exists(finalPath)) File.Replace(tempPath, finalPath, null);
        else File.Move(tempPath, finalPath);
    }

    public static List<ScoreRecord> ReadScores(IRechargeHost host, string modId)
    {
        var path = Path.Combine(host.ModDataDir(modId), "scores.json");
        if (!File.Exists(path)) return new List<ScoreRecord>();
        try
        {
            return JsonConvert.DeserializeObject<List<ScoreRecord>>(File.ReadAllText(path)) ?? new List<ScoreRecord>();
        }
        catch (Exception e)
        {
            host.LogWarning($"scores.json was corrupt, starting fresh: {e.Message}");
            return new List<ScoreRecord>();
        }
    }

    public static void AppendDemoScore(IRechargeHost host, string modId)
    {
        var scores = ReadScores(host, modId);
        scores.Add(new ScoreRecord { PlayerName = "Demo Player", Score = scores.Count * 10, AchievedAt = DateTime.Now });
        WriteScoresAtomically(host, modId, scores);
        host.Log($"Wrote scores.json - {scores.Count} record(s) total.");
    }

    public static void WriteBinaryBlob(IRechargeHost host, string modId, byte[] data)
    {
        var path = Path.Combine(host.ModDataDir(modId), "blob.bin");
        using var stream = File.Create(path);
        using var writer = new BinaryWriter(stream);
        writer.Write(data.Length);
        writer.Write(data);
    }

    public static byte[] ReadBinaryBlob(IRechargeHost host, string modId)
    {
        var path = Path.Combine(host.ModDataDir(modId), "blob.bin");
        if (!File.Exists(path)) return Array.Empty<byte>();
        using var stream = File.OpenRead(path);
        using var reader = new BinaryReader(stream);
        var length = reader.ReadInt32();
        return reader.ReadBytes(length);
    }

    public static void RoundTripBinaryBlob(IRechargeHost host, string modId)
    {
        var written = new byte[16];
        new Random().NextBytes(written);
        WriteBinaryBlob(host, modId, written);
        var read = ReadBinaryBlob(host, modId);
        var matches = written.Length == read.Length;
        for (int i = 0; matches && i < written.Length; i++) matches &= written[i] == read[i];
        host.Log($"Binary blob round trip ({written.Length} bytes): {(matches ? "matched" : "MISMATCH")}.");
    }

    public static void ListDataFiles(IRechargeHost host, string modId)
    {
        var dir = host.ModDataDir(modId);
        var files = Directory.Exists(dir) ? Directory.GetFiles(dir) : Array.Empty<string>();
        host.Log($"Files under this mod's data folder: {string.Join(", ", Array.ConvertAll(files, Path.GetFileName))}");
    }
}
