using System;
using System.Linq;
using Mono.Cecil;
using Mono.Cecil.Cil;

namespace Recharge.Patcher
{
    public static partial class Patcher
    {
        private static readonly string[] ProgressKeys = { "OpenA2Door", "snfDemoCompleted", "UsingCheckpoints" };

        // Saveloader passes a relative folder to the native saveable objects.
        // Change that argument at its source so each object keeps its original
        // serialization, backup conventions and error handling.
        private static void PatchSaveHooks(ModuleDefinition module, TypeReference bootstrap)
        {
            var path = Hook(module, bootstrap, "ResolveSavePath", module.TypeSystem.String);
            var key = Hook(module, bootstrap, "ResolveSavePreference", module.TypeSystem.String);
            var commit = Hook(module, bootstrap, "NativeSaveComplete", module.TypeSystem.Void);
            var loader = module.GetType("Saveloader") ?? throw new PatcherException("shape: Saveloader missing");
            foreach (string name in new[] { "Awake", "autosave", "manualSave" })
            {
                var method = loader.Methods.FirstOrDefault(m => m.Name == name && m.HasBody && !m.HasParameters);
                if (method == null || !PatchStrings(method, path, s => s == "/Savedata"))
                    throw new PatcherException("shape: can't find the native save path in Saveloader." + name);
                if (name == "Awake") continue;

                // Both save methods catch write errors and share a return with
                // skipped saves. Notify only at the successful end of the loop.
                var handler = method.Body.ExceptionHandlers.SingleOrDefault(h => h.HandlerType == ExceptionHandlerType.Catch);
                var success = handler?.TryEnd?.Previous;
                if (success == null || (success.OpCode != OpCodes.Leave && success.OpCode != OpCodes.Leave_S))
                    throw new PatcherException("shape: can't find the completed save in Saveloader." + name);
                method.Body.GetILProcessor().InsertBefore(success, Instruction.Create(OpCodes.Call, commit));
            }

            foreach (var type in module.Types)
            foreach (var method in type.Methods.Where(m => m.HasBody))
            {
                if (type.Name == "pauseMenuScript" || type.Name == "JumpToStateButton")
                    PatchStrings(method, path, s => s == "/Savedata" || s == "/Savedata/playerdata.txt"
                        || s == "/Savedatabackup/playerdata.txt");
                PatchStrings(method, key, s => ProgressKeys.Contains(s, StringComparer.Ordinal));
            }
        }

        private static MethodReference Hook(ModuleDefinition module, TypeReference bootstrap, string name, TypeReference result)
        {
            var method = new MethodReference(name, result, bootstrap);
            if (result == module.TypeSystem.String) method.Parameters.Add(new ParameterDefinition(module.TypeSystem.String));
            return method;
        }

        private static bool PatchStrings(MethodDefinition method, MethodReference hook, Func<string, bool> match)
        {
            var sites = method.Body.Instructions.Where(i => i.OpCode == OpCodes.Ldstr && i.Operand is string s && match(s)).ToArray();
            if (sites.Length == 0) return false;
            // Inserting calls can put a native short jump out of range.
            foreach (var instruction in method.Body.Instructions)
                instruction.OpCode = instruction.OpCode.Code switch
                {
                    Code.Br_S => OpCodes.Br,
                    Code.Brtrue_S => OpCodes.Brtrue,
                    Code.Brfalse_S => OpCodes.Brfalse,
                    Code.Beq_S => OpCodes.Beq,
                    Code.Bge_S => OpCodes.Bge,
                    Code.Bgt_S => OpCodes.Bgt,
                    Code.Ble_S => OpCodes.Ble,
                    Code.Blt_S => OpCodes.Blt,
                    Code.Bne_Un_S => OpCodes.Bne_Un,
                    Code.Bge_Un_S => OpCodes.Bge_Un,
                    Code.Bgt_Un_S => OpCodes.Bgt_Un,
                    Code.Ble_Un_S => OpCodes.Ble_Un,
                    Code.Blt_Un_S => OpCodes.Blt_Un,
                    Code.Leave_S => OpCodes.Leave,
                    _ => instruction.OpCode,
                };
            var il = method.Body.GetILProcessor();
            foreach (var site in sites) il.InsertAfter(site, Instruction.Create(OpCodes.Call, hook));
            return true;
        }

        private static bool LoaderHasSaveHooks(string loaderPath)
        {
            using var loader = ModuleDefinition.ReadModule(loaderPath);
            var bootstrap = loader.GetType(BootstrapType);
            return bootstrap != null && new[] { "ResolveSavePath", "ResolveSavePreference", "NativeSaveComplete" }
                .All(name => bootstrap.Methods.Any(m => m.Name == name && m.IsPublic && m.IsStatic));
        }
    }
}
