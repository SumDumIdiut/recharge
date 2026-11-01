using System;
using System.IO;
using System.Linq;

namespace Recharge.Patcher
{
    /// <summary>Which build of Assembly-CSharp a launch uses, and which loader provides the modded one.</summary>
    public sealed class ModeStatus
    {
        /// <summary>True when the deployed Assembly-CSharp.dll is the modded build.</summary>
        public bool Modded { get; set; }
        /// <summary>"next" (RechargeLoader 2), "legacy" (the current app's ORIGINAL/RECHARGE pair) or "none".</summary>
        public string Loader { get; set; } = "none";
        /// <summary>Whether a modded launch is possible right now.</summary>
        public bool CanModded { get; set; }
        public string Detail { get; set; } = "";
    }

    /// <summary>
    /// Switching one game folder between its vanilla and modded builds before a launch, the way the current app's deploy_build does.
    /// RechargeLoader 2 swaps the hook in and out of Assembly-CSharp.dll (the clean copy is the .recharge-original backup; the loader
    /// files stay, unused while vanilla). The previous loader copies Assembly-CSharp.ORIGINAL.dll or .RECHARGE.dll over it and writes
    /// the same deploy stamp the current app writes, so both apps keep agreeing on what is deployed.
    /// </summary>
    public static partial class Patcher
    {
        public const string LegacyOriginal = "Assembly-CSharp.ORIGINAL.dll";
        public const string LegacyModded = "Assembly-CSharp.RECHARGE.dll";
        public const string LegacyStamp = "Assembly-CSharp.deployed.stamp";

        public static ModeStatus Mode(string gameDir)
        {
            string managed = ManagedDir(gameDir);
            string asm = Path.Combine(managed, AssemblyFile);
            Shape shape = Analyze(asm);
            if (shape.Foreign != null) return new ModeStatus { Detail = "another tool patched Assembly-CSharp.dll: " + shape.Foreign };
            if (IsNext(managed, shape))
            {
                LoaderStatus files = CheckFiles(managed, null);
                bool usable = files.State != LoaderState.Broken;
                return new ModeStatus
                {
                    Loader = "next", Modded = shape.HasHook, CanModded = usable,
                    Detail = !usable ? files.Detail : shape.HasHook ? "modded (RechargeLoader 2)" : "vanilla; RechargeLoader 2 is installed",
                };
            }
            if (HasLegacyPair(managed))
            {
                bool updated = !shape.HasAnyHook && !SameBytes(asm, Path.Combine(managed, LegacyOriginal));
                return new ModeStatus
                {
                    Loader = "legacy", Modded = shape.Legacy, CanModded = !updated,
                    Detail = updated ? "the game updated since the previous loader was installed; reinstall it to play modded"
                        : shape.Legacy ? "modded (previous loader)" : "vanilla; the previous loader is installed",
                };
            }
            return new ModeStatus { Modded = false, Detail = shape.HasAnyHook ? "the loader's files are incomplete" : "vanilla; no loader installed" };
        }

        /// <summary>Deploys the vanilla or the modded build. Does nothing when it is already deployed; refuses while the game runs when it would write.</summary>
        public static ModeStatus SetMode(string gameDir, bool modded, Func<string, bool>? isRunning = null)
        {
            ModeStatus now = Mode(gameDir);
            if (now.Modded == modded) return now;
            if (modded && !now.CanModded)
                throw new PatcherException(now.Loader == "none" ? "loader: Recharge isn't installed in this game; install it in Settings first" : "loader: " + now.Detail);
            Guard(gameDir, isRunning);
            string managed = ManagedDir(gameDir);
            string asm = Path.Combine(managed, AssemblyFile);
            if (now.Loader == "next")
            {
                string backup = asm + BackupSuffix;
                if (modded)
                {
                    // The game's file is the clean original; one that differs from the backup means Steam updated it, so it becomes the backup.
                    byte[] original = File.ReadAllBytes(asm);
                    if (!File.ReadAllBytes(backup).AsSpan().SequenceEqual(original)) AtomicWrite(backup, original);
                    AtomicWrite(asm, BuildPatched(original));
                    Shape after = Analyze(asm);
                    if (!after.HasHook || !after.WellFormed) throw new PatcherException("io: the modded build didn't verify");
                }
                else
                {
                    if (!Analyze(backup).IsVanilla) throw new PatcherException("io: no clean copy of Assembly-CSharp.dll to restore; verify the game files in Steam");
                    byte[] original = File.ReadAllBytes(backup);
                    AtomicWrite(asm, original);
                    if (!File.ReadAllBytes(asm).AsSpan().SequenceEqual(original)) throw new PatcherException("io: the vanilla build didn't verify");
                }
            }
            else
            {
                string source = Path.Combine(managed, modded ? LegacyModded : LegacyOriginal);
                byte[] data = File.ReadAllBytes(source);
                AtomicWrite(asm, data);
                if (!File.ReadAllBytes(asm).AsSpan().SequenceEqual(data)) throw new PatcherException("io: the " + (modded ? "modded" : "vanilla") + " build didn't verify");
                File.WriteAllText(Path.Combine(managed, LegacyStamp), Fnv1a(data));
            }
            ModeStatus result = Mode(gameDir);
            if (result.Modded != modded) throw new PatcherException("io: switching builds didn't verify: " + result.Detail);
            return result;
        }

        /// <summary>RechargeLoader 2 owns the folder: its install record and backup are there, and the previous loader's hook isn't deployed.</summary>
        private static bool IsNext(string managed, Shape shape) =>
            !shape.Legacy && File.Exists(StatePath(managed)) && File.Exists(Path.Combine(managed, AssemblyFile) + BackupSuffix);

        private static bool HasLegacyPair(string managed)
        {
            string original = Path.Combine(managed, LegacyOriginal);
            string modded = Path.Combine(managed, LegacyModded);
            return File.Exists(original) && File.Exists(modded) && Analyze(original).IsVanilla && Analyze(modded).Legacy;
        }

        private static bool SameBytes(string a, string b) =>
            File.Exists(a) && File.Exists(b) && new FileInfo(a).Length == new FileInfo(b).Length && File.ReadAllBytes(a).AsSpan().SequenceEqual(File.ReadAllBytes(b));

        /// <summary>The current app's deploy stamp: FNV-1a 64 of the bytes as 16 lower-case hex digits.</summary>
        public static string Fnv1a(byte[] data)
        {
            ulong hash = 0xcbf29ce484222325;
            foreach (byte b in data) { hash ^= b; hash *= 0x100000001b3; }
            return hash.ToString("x16");
        }
    }
}
