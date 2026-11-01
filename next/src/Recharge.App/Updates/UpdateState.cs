using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Recharge.App.Updates
{
    /// <summary>A build swapped in but not yet confirmed as started.</summary>
    public sealed class PendingBuild
    {
        public string Version { get; set; } = "";
        public int Build { get; set; }
        /// <summary>How many starts of the new build have begun. One start without a confirmation means it failed.</summary>
        public int Launches { get; set; }
    }

    /// <summary>A fully downloaded and verified copy of the next version, waiting for the next start.</summary>
    public sealed class StagedBuild
    {
        public string Version { get; set; } = "";
        public int Build { get; set; }
        public string Channel { get; set; } = "";
        public string Dir { get; set; } = "";
        public string Launch { get; set; } = "";
    }

    /// <summary>updates/state.json in the app-data folder: what is installed, the rollback bookkeeping, what is staged.</summary>
    public sealed class UpdateState
    {
        public string InstalledVersion { get; set; } = "";
        public int InstalledBuild { get; set; }
        public string PreviousVersion { get; set; } = "";
        public int PreviousBuild { get; set; }
        public PendingBuild? Pending { get; set; }
        public StagedBuild? Staged { get; set; }
        /// <summary>Builds that failed to start; they are never staged again.</summary>
        public List<int> Bad { get; set; } = new List<int>();
        public string LastRollback { get; set; } = "";
        /// <summary>When the last update check finished (UTC, ISO 8601), empty if never.</summary>
        public string LastCheckUtc { get; set; } = "";
        /// <summary>none-yet, up-to-date, available, ready or error.</summary>
        public string LastCheckState { get; set; } = "";
        public string LastCheckError { get; set; } = "";

        private static readonly JsonSerializerOptions Options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        };

        public static string UpdatesDir(string dataDir) => Path.Combine(dataDir, "updates");
        public static string FilePath(string dataDir) => Path.Combine(UpdatesDir(dataDir), "state.json");

        public static UpdateState Load(string dataDir)
        {
            try
            {
                string file = FilePath(dataDir);
                if (!File.Exists(file)) return new UpdateState();
                return JsonSerializer.Deserialize<UpdateState>(File.ReadAllText(file), Options) ?? new UpdateState();
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is JsonException)
            {
                return new UpdateState();
            }
        }

        public void Save(string dataDir)
        {
            Directory.CreateDirectory(UpdatesDir(dataDir));
            string file = FilePath(dataDir);
            string temp = file + "." + Environment.ProcessId + ".tmp";
            try
            {
                File.WriteAllText(temp, JsonSerializer.Serialize(this, Options));
                File.Move(temp, file, overwrite: true);
            }
            finally
            {
                try { if (File.Exists(temp)) File.Delete(temp); } catch (IOException) { }
            }
        }
    }
}
