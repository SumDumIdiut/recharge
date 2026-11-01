using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using Mono.Cecil;
using Mono.Cecil.Cil;

namespace Recharge.Patcher
{
    public enum LoaderState
    {
        NotInstalled,
        Installed,
        /// <summary>Hooked, but the deployed loader files differ from the ones offered (or the hook is the previous loader's).</summary>
        Outdated,
        /// <summary>Hooked or partly installed, but something is missing or malformed.</summary>
        Broken,
        /// <summary>Another tool patched Assembly-CSharp; we won't touch it.</summary>
        Foreign,
        /// <summary>Installed, but switched to the vanilla build for now (the hook is out; the loader files and the backup stay).</summary>
        Off,
    }

    public sealed class LoaderStatus
    {
        public LoaderState State { get; set; }
        /// <summary>The previous (compile-into-the-assembly) loader's patch is in place.</summary>
        public bool Legacy { get; set; }
        public bool HasBackup { get; set; }
        public string Detail { get; set; } = "";
    }

    public sealed class PatcherException : Exception
    {
        public PatcherException(string message) : base(message) { }
    }

    /// <summary>
    /// Installs RechargeLoader 2 by adding one call, RechargeLoaderBootstrap.Init(this), at the start of
    /// pauseMenuScript.Awake in Assembly-CSharp.dll, and copying the loader DLLs next to it. The original is kept in
    /// Assembly-CSharp.dll.recharge-original. Nothing is compiled; all writes are a temp file then a rename.
    /// </summary>
    public static partial class Patcher
    {
        public const string BackupSuffix = ".recharge-original";
        public const string StateFileName = "Recharge.Loader.install.txt";
        public const string LoaderAssembly = "Recharge.Loader";
        public const string BootstrapType = "RechargeLoaderBootstrap";
        private const string AssemblyFile = "Assembly-CSharp.dll";
        private static readonly string[] RequiredFiles = { "Recharge.Loader.dll", "Recharge.ModApi.dll" };
        private static readonly string[] ForeignMarkers = { "BepInEx", "0Harmony", "HarmonyLib", "MelonLoader", "Doorstop", "UnityModManager" };
        private static readonly string[] ForeignCallTypeHints = { "Loader", "Bootstrap", "Patch", "Inject", "Doorstop" };

        // ---------- public API ----------

        public static LoaderStatus Inspect(string gameDir, string? loaderFilesDir = null)
        {
            string managed = ManagedDir(gameDir);
            string asm = Path.Combine(managed, AssemblyFile);
            string backup = asm + BackupSuffix;
            bool hasBackup = File.Exists(backup);
            Shape shape;
            try { shape = Analyze(asm); }
            catch (Exception e) when (e is not PatcherException)
            {
                return new LoaderStatus { State = LoaderState.Broken, HasBackup = hasBackup, Detail = "Assembly-CSharp.dll can't be read: " + e.Message };
            }

            if (shape.Foreign != null)
                return new LoaderStatus { State = LoaderState.Foreign, HasBackup = hasBackup, Detail = shape.Foreign };
            if (shape.Legacy)
                return new LoaderStatus { State = LoaderState.Outdated, Legacy = true, HasBackup = hasBackup, Detail = "the previous loader is installed; installing replaces it" };
            if (!shape.HasHook)
            {
                if (!File.Exists(StatePath(managed)))
                    return new LoaderStatus { State = LoaderState.NotInstalled, HasBackup = hasBackup, Detail = "not installed" };
                if (!hasBackup)
                    return new LoaderStatus { State = LoaderState.Broken, HasBackup = false, Detail = "install records exist but the hook and the backup are gone" };
                // Switched to vanilla: the same file checks as an active install, then Off.
                LoaderStatus files = CheckFiles(managed, loaderFilesDir);
                return files.State == LoaderState.Installed
                    ? new LoaderStatus { State = LoaderState.Off, HasBackup = true, Detail = "installed, switched off (vanilla build)" }
                    : files;
            }
            if (!shape.WellFormed)
                return new LoaderStatus { State = LoaderState.Broken, HasBackup = hasBackup, Detail = "the hook in pauseMenuScript.Awake is incomplete" };
            if (!hasBackup)
                return new LoaderStatus { State = LoaderState.Broken, HasBackup = false, Detail = "the original Assembly-CSharp backup is missing" };
            return CheckFiles(managed, loaderFilesDir);
        }

        /// <summary>The deployed loader files against the install record (and the bundled files when given): Installed, Outdated or Broken.</summary>
        private static LoaderStatus CheckFiles(string managed, string? loaderFilesDir)
        {
            Dictionary<string, string> recorded = ReadState(managed);
            foreach (string name in RequiredFiles)
            {
                if (!File.Exists(Path.Combine(managed, name)))
                    return new LoaderStatus { State = LoaderState.Broken, HasBackup = true, Detail = "missing " + name };
            }
            foreach (var kv in recorded)
            {
                string p = Path.Combine(managed, kv.Key);
                if (!File.Exists(p)) return new LoaderStatus { State = LoaderState.Broken, HasBackup = true, Detail = "missing " + kv.Key };
            }
            if (recorded.Count == 0)
                return new LoaderStatus { State = LoaderState.Broken, HasBackup = true, Detail = "install record is missing" };
            foreach (var kv in recorded)
            {
                if (Hash(Path.Combine(managed, kv.Key)) != kv.Value.Substring(kv.Value.IndexOf('|') + 1))
                    return new LoaderStatus { State = LoaderState.Broken, HasBackup = true, Detail = kv.Key + " was changed after install" };
            }
            if (loaderFilesDir != null && Directory.Exists(loaderFilesDir))
            {
                foreach (string src in LoaderFiles(loaderFilesDir))
                {
                    string name = Path.GetFileName(src);
                    if (!recorded.TryGetValue(name, out string? h) || h.Substring(0, h.IndexOf('|')) != Hash(src))
                        return new LoaderStatus { State = LoaderState.Outdated, HasBackup = true, Detail = name + " differs from the bundled loader" };
                }
            }
            return new LoaderStatus { State = LoaderState.Installed, HasBackup = true, Detail = "installed" };
        }

        public static LoaderStatus Install(string gameDir, string loaderFilesDir, Func<string, bool>? isRunning = null)
            => Apply(gameDir, loaderFilesDir, isRunning, repair: false);

        public static LoaderStatus Repair(string gameDir, string loaderFilesDir, Func<string, bool>? isRunning = null)
            => Apply(gameDir, loaderFilesDir, isRunning, repair: true);

        public static LoaderStatus Uninstall(string gameDir, Func<string, bool>? isRunning = null)
        {
            Guard(gameDir, isRunning);
            string managed = ManagedDir(gameDir);
            string asm = Path.Combine(managed, AssemblyFile);
            string backup = asm + BackupSuffix;
            Shape shape = Analyze(asm);
            if (shape.Foreign != null) throw new PatcherException("foreign: " + shape.Foreign);

            Dictionary<string, string> recorded = ReadState(managed);
            if (shape.HasAnyHook)
            {
                string legacyOriginal = Path.Combine(managed, "Assembly-CSharp.ORIGINAL.dll");
                string? restoreFrom = File.Exists(backup) && Analyze(backup).IsVanilla ? backup
                    : File.Exists(legacyOriginal) && Analyze(legacyOriginal).IsVanilla ? legacyOriginal
                    : null;
                if (restoreFrom == null) throw new PatcherException("io: no clean copy of Assembly-CSharp.dll to restore; verify the game files in Steam");
                byte[] original = File.ReadAllBytes(restoreFrom);
                AtomicWrite(asm, original);
                if (!File.ReadAllBytes(asm).AsSpan().SequenceEqual(original) || Analyze(asm).HasAnyHook)
                    throw new PatcherException("io: restore didn't verify");
            }
            TryDelete(backup);

            foreach (string name in recorded.Keys)
                TryDelete(Path.Combine(managed, name));
            TryDelete(StatePath(managed));
            if (shape.Legacy)
            {
                TryDelete(Path.Combine(managed, "Assembly-CSharp.RECHARGE.dll"));
                TryDelete(Path.Combine(managed, "Assembly-CSharp.deployed.stamp"));
            }
            return Inspect(gameDir);
        }

        // ---------- install ----------

        private static LoaderStatus Apply(string gameDir, string loaderFilesDir, Func<string, bool>? isRunning, bool repair)
        {
            Guard(gameDir, isRunning);
            string managed = ManagedDir(gameDir);
            string asm = Path.Combine(managed, AssemblyFile);
            string backup = asm + BackupSuffix;

            List<string> files = LoaderFiles(loaderFilesDir).ToList();
            foreach (string need in RequiredFiles)
            {
                if (!files.Any(f => string.Equals(Path.GetFileName(f), need, StringComparison.OrdinalIgnoreCase)))
                    throw new PatcherException("io: the loader files are missing " + need + " in " + loaderFilesDir);
            }
            string loaderSrc = files.First(f => Path.GetFileName(f) == "Recharge.Loader.dll");
            CheckLoaderHasInit(loaderSrc);

            LoaderStatus before = Inspect(gameDir, loaderFilesDir);
            if (before.State == LoaderState.Foreign) throw new PatcherException("foreign: " + before.Detail);
            if (before.State == LoaderState.Installed && !repair) return before;

            Shape shape = Analyze(asm);
            // Pick the clean original.
            byte[] original;
            if (!shape.HasAnyHook)
            {
                // The game's own file. If it differs from an older backup the game was updated; take the new one.
                original = File.ReadAllBytes(asm);
                if (!File.Exists(backup) || !File.ReadAllBytes(backup).AsSpan().SequenceEqual(original)) AtomicWrite(backup, original);
            }
            else if (File.Exists(backup) && Analyze(backup).IsVanilla)
            {
                original = File.ReadAllBytes(backup);
            }
            else
            {
                string legacyOriginal = Path.Combine(managed, "Assembly-CSharp.ORIGINAL.dll");
                if (shape.Legacy && File.Exists(legacyOriginal) && Analyze(legacyOriginal).IsVanilla)
                {
                    original = File.ReadAllBytes(legacyOriginal);
                    AtomicWrite(backup, original);
                }
                else throw new PatcherException("io: no clean copy of Assembly-CSharp.dll to patch; verify the game files in Steam");
            }

            // Loader files first (the hook is harmless without them only if they exist), then the hook.
            var record = new Dictionary<string, string>();
            foreach (string src in files)
            {
                string name = Path.GetFileName(src);
                string dest = Path.Combine(managed, name);
                byte[] data = File.ReadAllBytes(src);
                if (name == "Recharge.Loader.dll") data = MakeBootstrapPublic(data);
                if (!File.Exists(dest) || !File.ReadAllBytes(dest).AsSpan().SequenceEqual(data)) AtomicWrite(dest, data);
                record[name] = Hash(src) + "|" + Hash(dest);
            }

            byte[] patched = BuildPatched(original);
            if (!File.Exists(asm) || !File.ReadAllBytes(asm).AsSpan().SequenceEqual(patched)) AtomicWrite(asm, patched);
            WriteState(managed, record);

            Shape after = Analyze(asm);
            if (!after.HasHook || !after.WellFormed || after.Legacy || after.Foreign != null)
                throw new PatcherException("io: the patched Assembly-CSharp.dll didn't verify");
            LoaderStatus status = Inspect(gameDir, loaderFilesDir);
            if (status.State != LoaderState.Installed) throw new PatcherException("io: install didn't verify: " + status.Detail);
            if (shape.Legacy)
            {
                // The previous loader's leftovers: its patched copy and redeploy stamp would only confuse it if it ever ran again.
                TryDelete(Path.Combine(managed, "Assembly-CSharp.RECHARGE.dll"));
                TryDelete(Path.Combine(managed, "Assembly-CSharp.deployed.stamp"));
            }
            return status;
        }

        private static byte[] BuildPatched(byte[] original)
        {
            using var input = new MemoryStream(original);
            using ModuleDefinition module = ModuleDefinition.ReadModule(input, new ReaderParameters { ReadingMode = ReadingMode.Deferred });
            TypeDefinition menu = module.Types.FirstOrDefault(t => t.Name == "pauseMenuScript" && t.Namespace == "")
                ?? throw new PatcherException("shape: pauseMenuScript not found (the game may have updated)");
            MethodDefinition awake = menu.Methods.FirstOrDefault(m => m.Name == "Awake" && !m.IsStatic && !m.HasParameters && m.HasBody)
                ?? throw new PatcherException("shape: pauseMenuScript.Awake not found (the game may have updated)");

            var loaderRef = module.AssemblyReferences.FirstOrDefault(a => a.Name == LoaderAssembly);
            if (loaderRef == null)
            {
                loaderRef = new AssemblyNameReference(LoaderAssembly, new Version(1, 0, 0, 0));
                module.AssemblyReferences.Add(loaderRef);
            }
            var bootstrap = new TypeReference("", BootstrapType, module, loaderRef);
            var init = new MethodReference("Init", module.TypeSystem.Void, bootstrap);
            init.Parameters.Add(new ParameterDefinition(menu));

            var exception = new TypeReference("System", "Exception", module, module.TypeSystem.CoreLibrary);
            TypeReference? debug = module.GetTypeReferences().FirstOrDefault(t => t.FullName == "UnityEngine.Debug");
            MethodReference? logError = null;
            if (debug != null)
            {
                logError = new MethodReference("LogError", module.TypeSystem.Void, debug);
                logError.Parameters.Add(new ParameterDefinition(module.TypeSystem.Object));
            }

            MethodBody body = awake.Body;
            ILProcessor il = body.GetILProcessor();
            Instruction first = body.Instructions[0];
            Instruction ldarg = il.Create(OpCodes.Ldarg_0);
            Instruction call = il.Create(OpCodes.Call, init);
            Instruction leave1 = il.Create(OpCodes.Leave, first);
            Instruction handlerStart = logError != null ? il.Create(OpCodes.Call, logError) : il.Create(OpCodes.Pop);
            Instruction leave2 = il.Create(OpCodes.Leave, first);
            il.InsertBefore(first, ldarg);
            il.InsertBefore(first, call);
            il.InsertBefore(first, leave1);
            il.InsertBefore(first, handlerStart);
            il.InsertBefore(first, leave2);
            body.ExceptionHandlers.Add(new ExceptionHandler(ExceptionHandlerType.Catch)
            {
                TryStart = ldarg,
                TryEnd = handlerStart,
                HandlerStart = handlerStart,
                HandlerEnd = first,
                CatchType = exception,
            });
            if (body.MaxStackSize < 2) body.MaxStackSize = 2;

            using var output = new MemoryStream();
            module.Write(output);
            return output.ToArray();
        }

        /// <summary>The bootstrap class is internal in the build; Assembly-CSharp calls it from outside, so open it in the deployed copy.</summary>
        private static byte[] MakeBootstrapPublic(byte[] loader)
        {
            using var input = new MemoryStream(loader);
            using ModuleDefinition module = ModuleDefinition.ReadModule(input, new ReaderParameters { ReadingMode = ReadingMode.Deferred });
            TypeDefinition? t = module.GetType(BootstrapType);
            if (t == null || t.IsPublic) return loader;
            t.IsPublic = true;
            using var output = new MemoryStream();
            module.Write(output);
            return output.ToArray();
        }

        private static void CheckLoaderHasInit(string loaderPath)
        {
            using ModuleDefinition module = ModuleDefinition.ReadModule(loaderPath);
            TypeDefinition? t = module.GetType(BootstrapType);
            bool ok = t != null && t.Methods.Any(m => m.Name == "Init" && m.IsStatic && m.Parameters.Count == 1 && m.Parameters[0].ParameterType.Name == "pauseMenuScript");
            if (!ok) throw new PatcherException("io: Recharge.Loader.dll has no RechargeLoaderBootstrap.Init(pauseMenuScript)");
        }

        // ---------- analysis ----------

        private sealed class Shape
        {
            public bool HasHook;      // call to the new loader's Init
            public bool WellFormed;   // ... wrapped in a catch
            public bool Legacy;       // call to an in-module RechargeLoaderBootstrap
            public string? Foreign;
            public bool HasAnyHook => HasHook || Legacy;
            public bool IsVanilla => !HasHook && !Legacy && Foreign == null;
        }

        private static Shape Analyze(string path)
        {
            using ModuleDefinition module = ModuleDefinition.ReadModule(path, new ReaderParameters { ReadingMode = ReadingMode.Deferred });
            var shape = new Shape();
            string? marker = module.AssemblyReferences.Select(a => a.Name)
                .Concat(module.Types.Select(t => t.Namespace.Split('.')[0]))
                .FirstOrDefault(n => ForeignMarkers.Any(m => string.Equals(n, m, StringComparison.OrdinalIgnoreCase)));
            if (marker != null) shape.Foreign = "Assembly-CSharp.dll references " + marker + ", which isn't ours";

            TypeDefinition? menu = module.Types.FirstOrDefault(t => t.Name == "pauseMenuScript" && t.Namespace == "");
            MethodDefinition? awake = menu?.Methods.FirstOrDefault(m => m.Name == "Awake" && !m.IsStatic && !m.HasParameters && m.HasBody);
            if (awake == null) return shape;

            foreach (Instruction ins in awake.Body.Instructions)
            {
                if ((ins.OpCode.Code != Code.Call && ins.OpCode.Code != Code.Callvirt) || ins.Operand is not MethodReference target) continue;
                TypeReference owner = target.DeclaringType;
                if (target.Name == "Init" && owner.Name == BootstrapType)
                {
                    if (owner.Scope is AssemblyNameReference a && a.Name == LoaderAssembly)
                    {
                        shape.HasHook = true;
                        shape.WellFormed = awake.Body.ExceptionHandlers.Any(h =>
                            h.HandlerType == ExceptionHandlerType.Catch && Offset(awake, h.TryStart) <= Offset(awake, ins) && Offset(awake, ins) < Offset(awake, h.TryEnd));
                    }
                    else if (module.GetType(BootstrapType) != null) shape.Legacy = true;
                    continue;
                }
                if (shape.Foreign == null && owner.Scope != module && owner.Scope is AssemblyNameReference r
                    && !r.Name.StartsWith("UnityEngine", StringComparison.Ordinal) && !r.Name.StartsWith("Unity.", StringComparison.Ordinal)
                    && ForeignCallTypeHints.Any(h => owner.Name.Contains(h, StringComparison.OrdinalIgnoreCase)))
                    shape.Foreign = "pauseMenuScript.Awake calls " + owner.FullName + "." + target.Name + ", which isn't ours";
                else if (shape.Foreign == null && owner.Scope == module && owner.Name != BootstrapType
                    && ForeignCallTypeHints.Any(h => owner.Name.Contains(h, StringComparison.OrdinalIgnoreCase)))
                    shape.Foreign = "pauseMenuScript.Awake calls " + owner.FullName + "." + target.Name + ", which isn't ours";
            }
            return shape;
        }

        private static int Offset(MethodDefinition m, Instruction i) => m.Body.Instructions.IndexOf(i);

        // ---------- helpers ----------

        private static void Guard(string gameDir, Func<string, bool>? isRunning)
        {
            if (isRunning != null && isRunning(gameDir)) throw new PatcherException("busy: IGTAP is running; close the game first");
        }

        public static string ManagedDir(string gameDir)
        {
            if (!Directory.Exists(gameDir)) throw new PatcherException("io: game folder not found: " + gameDir);
            foreach (string data in Directory.GetDirectories(gameDir, "*_Data"))
            {
                string managed = Path.Combine(data, "Managed");
                if (File.Exists(Path.Combine(managed, AssemblyFile))) return managed;
            }
            throw new PatcherException("io: no *_Data/Managed/Assembly-CSharp.dll in " + gameDir);
        }

        private static IEnumerable<string> LoaderFiles(string dir)
        {
            if (!Directory.Exists(dir)) throw new PatcherException("io: loader files folder not found: " + dir);
            return Directory.GetFiles(dir, "*.dll").OrderBy(f => f, StringComparer.Ordinal);
        }

        private static string StatePath(string managed) => Path.Combine(managed, StateFileName);

        private static Dictionary<string, string> ReadState(string managed)
        {
            var d = new Dictionary<string, string>();
            string p = StatePath(managed);
            if (!File.Exists(p)) return d;
            foreach (string line in File.ReadAllLines(p))
            {
                int tab = line.IndexOf('\t');
                if (tab > 0) d[line.Substring(0, tab)] = line.Substring(tab + 1);
            }
            return d;
        }

        private static void WriteState(string managed, Dictionary<string, string> record)
        {
            string text = string.Concat(record.OrderBy(k => k.Key, StringComparer.Ordinal).Select(kv => kv.Key + "\t" + kv.Value + "\n"));
            AtomicWrite(StatePath(managed), System.Text.Encoding.UTF8.GetBytes(text));
        }

        private static string Hash(string path)
        {
            using var s = File.OpenRead(path);
            return Convert.ToHexString(SHA256.HashData(s));
        }

        private static void AtomicWrite(string dest, byte[] data)
        {
            string tmp = dest + ".tmp-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            try
            {
                File.WriteAllBytes(tmp, data);
                File.Move(tmp, dest, overwrite: true);
            }
            finally
            {
                if (File.Exists(tmp)) File.Delete(tmp);
            }
        }

        private static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
