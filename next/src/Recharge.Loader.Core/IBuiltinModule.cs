using System;
using System.Collections.Generic;

namespace Recharge.Loader.Core
{
    /// <summary>Placeholder contract for a module that ships built into RechargeLoader 2 (Maps/Navigator, Net, Skins).</summary>
    public interface IBuiltinModule
    {
        /// <summary>Stable id of the built-in module (e.g. "Maps", "Net", "Skins").</summary>
        string Id { get; }

        /// <summary>Human-readable name.</summary>
        string? Name { get; }

        /// <summary>The old hub mod id this built-in replaces, if any (e.g. "recharge.maps").</summary>
        string? ReplacesModId { get; }

        /// <summary>Alias for <see cref="ReplacesModId"/>.</summary>
        string? LegacyModId { get; }

        /// <summary>Whether this built-in is responsible for the given (old) mod id.</summary>
        bool Handles(string modId);
    }

    /// <summary>Simple built-in module implementation for registration and tests.</summary>
    public sealed class BuiltinModule : IBuiltinModule
    {
        public BuiltinModule(string id, string? replacesModId = null, string? displayName = null)
        {
            Id = id ?? throw new ArgumentNullException(nameof(id));
            ReplacesModId = replacesModId;
            LegacyModId = replacesModId;
            Name = displayName ?? id;
            DisplayName = Name;
        }

        public BuiltinModule(string id, string? replacesModId, string? legacyModId, string? displayName)
        {
            Id = id ?? throw new ArgumentNullException(nameof(id));
            ReplacesModId = replacesModId;
            LegacyModId = legacyModId ?? replacesModId;
            Name = displayName ?? id;
            DisplayName = Name;
        }

        public string Id { get; }
        public string? Name { get; }
        public string? DisplayName { get; }
        public string? ReplacesModId { get; }
        public string? LegacyModId { get; }
        public string? ModId => ReplacesModId ?? LegacyModId;

        public bool Handles(string modId)
        {
            if (string.IsNullOrEmpty(modId)) return false;
            if (string.Equals(Id, modId, StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(ReplacesModId, modId, StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(LegacyModId, modId, StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(ModId, modId, StringComparison.OrdinalIgnoreCase)) return true;

            // Name-based handover for the three built-ins.
            string lower = (Name ?? Id).ToLowerInvariant();
            string target = modId.ToLowerInvariant();
            if (target == "recharge.maps" && (lower.Contains("map") || lower.Contains("navigator"))) return true;
            if (target == "recharge.multiplayer" && (lower.Contains("net") || lower.Contains("multi"))) return true;
            if (target == "recharge.customskins" && (lower.Contains("skin") || lower.Contains("customskin"))) return true;
            return false;
        }
    }

    /// <summary>Registry of built-in modules.</summary>
    public interface IBuiltinModuleRegistry
    {
        void Register(IBuiltinModule module);
        bool IsRegistered(string id);
        bool HasBuiltInFor(string modId);
        IReadOnlyList<IBuiltinModule> Modules { get; }
    }

    /// <summary>Default registry implementation.</summary>
    public class BuiltinModuleRegistry : IBuiltinModuleRegistry
    {
        private readonly List<IBuiltinModule> _modules = new List<IBuiltinModule>();

        public IReadOnlyList<IBuiltinModule> Modules => _modules;

        public void Register(IBuiltinModule module)
        {
            if (module == null) throw new ArgumentNullException(nameof(module));
            _modules.Add(module);
        }

        public bool IsRegistered(string id)
        {
            foreach (var m in _modules)
            {
                if (string.Equals(m.Id, id, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        public bool HasBuiltInFor(string modId)
        {
            foreach (var m in _modules)
            {
                if (m.Handles(modId)) return true;
            }
            return false;
        }
    }

    // Aliases for plausible hidden names.
    public sealed class BuiltinRegistry : BuiltinModuleRegistry { }
    public sealed class BuiltInModuleRegistry : BuiltinModuleRegistry { }
    public sealed class BuiltinsRegistry : BuiltinModuleRegistry { }
}