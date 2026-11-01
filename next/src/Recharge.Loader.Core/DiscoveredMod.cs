using System;
using System.Collections.Generic;
using Recharge.Core.Models;

namespace Recharge.Loader.Core
{
    public sealed class DiscoveredMod
    {
        public DiscoveredMod(
            string id,
            string directory,
            ModManifest manifest,
            string entryAssembly,
            IReadOnlyList<string> dependencies,
            bool enabled,
            RechargeVersion? minLoaderVersion)
        {
            Id = id ?? throw new ArgumentNullException(nameof(id));
            Directory = directory ?? throw new ArgumentNullException(nameof(directory));
            Manifest = manifest ?? throw new ArgumentNullException(nameof(manifest));
            EntryAssembly = entryAssembly ?? string.Empty;
            Dependencies = dependencies ?? Array.Empty<string>();
            Enabled = enabled;
            MinLoaderVersion = minLoaderVersion;
            EntryAssemblyPath = string.IsNullOrEmpty(directory) || string.IsNullOrEmpty(entryAssembly)
                ? string.Empty
                : System.IO.Path.Combine(directory, entryAssembly);
        }

        public string Id { get; }
        public string Directory { get; }
        public string ModDir => Directory;
        public string Folder => Directory;
        public ModManifest Manifest { get; }
        public string EntryAssembly { get; }
        public string EntryAssemblyPath { get; }
        public IReadOnlyList<string> Dependencies { get; }
        public bool Enabled { get; }
        public RechargeVersion? MinLoaderVersion { get; }

        public string DisplayName => SafeGet(() => Manifest.DisplayName);
        public string Version => SafeGet(() => Manifest.Version);

        private static string SafeGet(Func<string> getter)
        {
            try { return getter(); } catch { return string.Empty; }
        }
    }
}