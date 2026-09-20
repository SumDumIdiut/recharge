using System;
using System.IO;
using UnityEngine;

namespace RechargeCustomSkins
{
    // Shared by SkinAudioApplier and GlobalAudioApplier - resolves a slot
    // name to a matching audio file inside a skin's sfx folder.
    internal static class SfxFileResolver
    {
        private static readonly string[] Extensions = { ".wav", ".ogg", ".mp3" };

        public static string FindSlotFile(string sfxDir, string slotName)
        {
            if (string.IsNullOrEmpty(sfxDir) || !Directory.Exists(sfxDir)) return null;
            foreach (var file in Directory.EnumerateFiles(sfxDir))
            {
                var name = Path.GetFileNameWithoutExtension(file);
                var ext = Path.GetExtension(file).ToLowerInvariant();
                if (string.Equals(name, slotName, StringComparison.OrdinalIgnoreCase) && Array.IndexOf(Extensions, ext) >= 0)
                    return file;
            }
            return null;
        }

        public static AudioType AudioTypeFor(string path)
        {
            switch (Path.GetExtension(path).ToLowerInvariant())
            {
                case ".ogg": return AudioType.OGGVORBIS;
                case ".mp3": return AudioType.MPEG;
                default: return AudioType.WAV;
            }
        }
    }
}
