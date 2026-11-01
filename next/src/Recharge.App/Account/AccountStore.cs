using System;
using System.IO;
using Recharge.Core.Json;

namespace Recharge.App.Account
{
    /// <summary>Where Recharge Next keeps its account session, and how to read it safely.</summary>
    public static class AccountPaths
    {
        public const string DataVariable = "RECHARGE_NEXT_DATA";

        /// <summary>The app-data folder (RECHARGE_NEXT_DATA when set), shared with the Library.</summary>
        public static string DataDir()
        {
            string? forced = Environment.GetEnvironmentVariable(DataVariable);
            return !string.IsNullOrEmpty(forced)
                ? forced!
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "recharge-next");
        }

        public static string SessionFile() => Path.Combine(DataDir(), "account.json");
    }

    /// <summary>A remembered hub session. The token never leaves this process.</summary>
    public sealed class AccountSession
    {
        public AccountSession(string token, string username, bool admin)
        {
            Token = token;
            Username = username;
            Admin = admin;
        }

        public string Token { get; }
        public string Username { get; }
        public bool Admin { get; }
    }

    /// <summary>Reads and writes ~/.local/share/recharge-next/account.json, owner read/write only.</summary>
    public static class AccountStore
    {
        public static AccountSession? Load()
        {
            string file = AccountPaths.SessionFile();
            string text;
            try
            {
                if (!File.Exists(file)) return null;
                text = File.ReadAllText(file);
            }
            catch (IOException) { return null; }
            catch (UnauthorizedAccessException) { return null; }

            try
            {
                if (JsonReader.Parse(text) is not JsonObject root) return null;
                if (!root.TryGetValue("token", out JsonNode tokenNode) || tokenNode is not JsonString token ||
                    string.IsNullOrEmpty(token.Value))
                {
                    return null;
                }
                string username = root.TryGetValue("username", out JsonNode nameNode) && nameNode is JsonString name
                    ? name.Value : string.Empty;
                bool admin = root.TryGetValue("admin", out JsonNode adminNode) && adminNode is JsonBool flag && flag.Value;
                return new AccountSession(token.Value, username, admin);
            }
            catch (Exception)
            {
                // A damaged session file is the same as no session; never echo its contents.
                return null;
            }
        }

        public static void Save(string token, string username, bool admin)
        {
            if (string.IsNullOrEmpty(token))
            {
                throw new ArgumentException("a token is required", nameof(token));
            }

            string dir = AccountPaths.DataDir();
            Directory.CreateDirectory(dir);
            string file = Path.Combine(dir, "account.json");
            string temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";

            var root = new JsonObject();
            root["token"] = new JsonString(token);
            root["username"] = new JsonString(username ?? string.Empty);
            root["admin"] = admin ? JsonBool.True : JsonBool.False;

            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                using (var writer = new StreamWriter(stream))
                {
                    writer.Write(JsonWriter.Write(root, 2));
                    writer.Write("\n");
                }
                RestrictPermissions(temporary);
                File.Move(temporary, file, overwrite: true);
            }
            finally
            {
                try { if (File.Exists(temporary)) File.Delete(temporary); }
                catch (IOException) { /* best effort */ }
            }
        }

        public static void Clear()
        {
            try
            {
                string file = AccountPaths.SessionFile();
                if (File.Exists(file)) File.Delete(file);
            }
            catch (IOException) { /* the next load simply finds a stale token */ }
            catch (UnauthorizedAccessException) { /* same */ }
        }

        private static void RestrictPermissions(string path)
        {
            if (OperatingSystem.IsWindows()) return;
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }
}
