using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Recharge.ModApi;
using UnityEngine;
using UnityEngine.Networking;

namespace RechargeCustomSkins
{
    // Overrides Movement's per-player AudioClip fields (see PlayerSoundSlots)
    // with clips loaded from a skin's own sfx/ folder, one clip per slot,
    // and restores the vanilla clips for any slot the active skin doesn't
    // supply. Decoding runs through UnityWebRequestMultimedia so WAV/OGG/MP3
    // all work without hand-rolling a decoder.
    internal static class SkinAudioApplier
    {
        private static readonly Dictionary<string, object> Originals = new Dictionary<string, object>();
        private static readonly Dictionary<string, AudioClip> ClipCache = new Dictionary<string, AudioClip>();
        private static Movement _capturedFor;

        public static void CaptureOriginals(IRechargeHost host, Movement movement)
        {
            if (_capturedFor == movement) return;
            Originals.Clear();
            ClipCache.Clear();
            foreach (var slot in PlayerSoundSlots.All)
            {
                Originals[slot.FieldName] = slot.IsArray
                    ? (object)Reflect.GetField<AudioClip[]>(movement, slot.FieldName)
                    : Reflect.GetField<AudioClip>(movement, slot.FieldName);
            }
            _capturedFor = movement;
            host.Log("[CustomSkins] captured vanilla player SFX from a fresh Movement instance.");
        }

        // Used by TemplateExporter to bundle a real, playable starting point
        // for each slot rather than leaving the sounds/ folder empty.
        public static AudioClip GetVanillaClip(string slotName)
        {
            var slot = System.Array.Find(PlayerSoundSlots.All, s => s.Name == slotName);
            if (slot.Name == null || !Originals.TryGetValue(slot.FieldName, out var original)) return null;
            return slot.IsArray ? (original as AudioClip[])?.FirstOrDefault() : original as AudioClip;
        }

        public static void RestoreVanilla(Movement movement)
        {
            if (movement == null || _capturedFor != movement) return;
            foreach (var slot in PlayerSoundSlots.All)
            {
                if (Originals.TryGetValue(slot.FieldName, out var original))
                    Reflect.SetField(movement, slot.FieldName, original);
            }
        }

        public static void Apply(MonoBehaviour coroutineHost, IRechargeHost host, Movement movement, string sfxDir)
        {
            if (movement == null || _capturedFor != movement) return;

            foreach (var slot in PlayerSoundSlots.All)
            {
                var path = SfxFileResolver.FindSlotFile(sfxDir, slot.Name);
                if (path == null)
                {
                    if (Originals.TryGetValue(slot.FieldName, out var original))
                        Reflect.SetField(movement, slot.FieldName, original);
                    continue;
                }

                if (ClipCache.TryGetValue(path, out var cached))
                {
                    ApplySlotClip(movement, slot, cached);
                    continue;
                }

                coroutineHost.StartCoroutine(LoadAndApply(host, movement, slot, path));
            }
        }

        private static void ApplySlotClip(Movement movement, PlayerSoundSlot slot, AudioClip clip)
        {
            if (slot.IsArray) Reflect.SetField(movement, slot.FieldName, new[] { clip });
            else Reflect.SetField(movement, slot.FieldName, clip);
        }

        private static IEnumerator LoadAndApply(IRechargeHost host, Movement movement, PlayerSoundSlot slot, string path)
        {
            var type = SfxFileResolver.AudioTypeFor(path);
            using var req = UnityWebRequestMultimedia.GetAudioClip("file://" + path, type);
            yield return req.SendWebRequest();

            if (req.result != UnityWebRequest.Result.Success)
            {
                host.LogWarning($"[CustomSkins] couldn't load custom {slot.Name} sound '{path}': {req.error}");
                yield break;
            }

            var clip = DownloadHandlerAudioClip.GetContent(req);
            clip.name = Path.GetFileName(path);
            ClipCache[path] = clip;

            if (movement == null || _capturedFor != movement) yield break; // moved on while this loaded
            ApplySlotClip(movement, slot, clip);
            host.Log($"[CustomSkins] applied custom {slot.Name} sound: {clip.name}");
        }
    }
}
