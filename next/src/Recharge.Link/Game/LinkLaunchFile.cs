using System;
using System.IO;

namespace Recharge.Link.Game;

/// <summary>
/// The fallback for handing <c>RECHARGE_LINK</c> to a game that Steam launches: Steam starts the game itself, so the app's own environment
/// never reaches it. The app writes <c>&lt;game&gt;/Recharge/link.txt</c> (one line, <c>port:token</c>) just before launching and the game's
/// Net module reads it, then deletes it.
/// </summary>
public static class LinkLaunchFile
{
    public const string FileName = "link.txt";

    public static string PathFor(string gameDir) => System.IO.Path.Combine(gameDir, "Recharge", FileName);

    public static void Write(string gameDir, string environmentValue)
    {
        string path = PathFor(gameDir);
        string? dir = System.IO.Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        File.WriteAllText(path, environmentValue + "\n");
    }

    public static void Delete(string gameDir)
    {
        try { File.Delete(PathFor(gameDir)); } catch (Exception) { }
    }

    /// <summary>The client for the file's endpoint, or null when there is no file or it is malformed. The file is deleted either way so it works once.</summary>
    public static LinkClient? Consume(string gameDir, LinkOptions? options = null)
    {
        string path = PathFor(gameDir);
        string text;
        try
        {
            if (!File.Exists(path)) return null;
            text = File.ReadAllText(path).Trim();
        }
        catch (Exception) { return null; }
        Delete(gameDir);
        return LinkClient.Parse(text, options);
    }
}
