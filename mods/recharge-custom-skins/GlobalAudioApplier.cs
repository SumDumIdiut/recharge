using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using Recharge.ModApi;
using UnityEngine;
using UnityEngine.Networking;

namespace RechargeCustomSkins
{
    // Same idea as SkinAudioApplier, but for the four player sounds that
    // live in the shared Audio singleton's private audioLibrary array (see
    // GlobalSoundSlots) instead of as plain fields on Movement. audioLibrary
    // holds a private AudioRef { id, clips, mixerGroup } struct per entry,
    // so overriding one means finding it by id and mutating its clips field
    // through reflection, then writing the (boxed) struct back into the
    // array - SetField alone doesn't propagate back into an array element.
    internal static class GlobalAudioApplier
    {
        private static readonly Dictionary<Audio.AUDIO_ID, AudioClip[]> Originals = new Dictionary<Audio.AUDIO_ID, AudioClip[]>();
        private static readonly Dictionary<string, AudioClip> ClipCache = new Dictionary<string, AudioClip>();
        private static bool _captured;
        private static string _activeSfxDir;

        private static bool TryGetLibrary(out Array library)
        {
            library = null;
            var instance = Singleton<Audio>.Instance;
            if (instance == null) return false;
            library = Reflect.GetField<Array>(instance, "audioLibrary");
            return library != null;
        }

        public static void CaptureOriginals()
        {
            if (_captured || !TryGetLibrary(out var library)) return;
            for (int i = 0; i < library.Length; i++)
            {
                var entry = library.GetValue(i);
                var id = Reflect.GetField<Audio.AUDIO_ID>(entry, "id");
                Originals[id] = Reflect.GetField<AudioClip[]>(entry, "clips");
            }
            _captured = true;
        }

        // Used by TemplateExporter to bundle a real, playable starting point
        // for each slot rather than leaving the sounds/ folder empty.
        public static AudioClip GetVanillaClip(string slotName)
        {
            var slot = Array.Find(GlobalSoundSlots.All, s => s.Name == slotName);
            if (slot.Name == null || !Originals.TryGetValue(slot.Id, out var clips) || clips == null || clips.Length == 0) return null;
            return clips[0];
        }

        public static void RestoreVanilla()
        {
            _activeSfxDir = null;
            if (!_captured) return;
            foreach (var slot in GlobalSoundSlots.All)
                if (Originals.TryGetValue(slot.Id, out var original))
                    SetClipsFor(slot.Id, original);
        }

        public static void Apply(MonoBehaviour coroutineHost, IRechargeHost host, string sfxDir)
        {
            if (!_captured) return;
            _activeSfxDir = sfxDir;

            foreach (var slot in GlobalSoundSlots.All)
            {
                var path = SfxFileResolver.FindSlotFile(sfxDir, slot.Name);
                if (path == null)
                {
                    if (Originals.TryGetValue(slot.Id, out var original)) SetClipsFor(slot.Id, original);
                    continue;
                }

                if (ClipCache.TryGetValue(path, out var cached))
                {
                    SetClipsFor(slot.Id, new[] { cached });
                    continue;
                }

                coroutineHost.StartCoroutine(LoadAndApply(host, sfxDir, slot, path));
            }
        }

        private static IEnumerator LoadAndApply(IRechargeHost host, string sfxDir, GlobalSoundSlot slot, string path)
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

            if (_activeSfxDir != sfxDir) yield break; // the active skin changed while this loaded
            SetClipsFor(slot.Id, new[] { clip });
            host.Log($"[CustomSkins] applied custom {slot.Name} sound: {clip.name}");
        }

        private static void SetClipsFor(Audio.AUDIO_ID id, AudioClip[] clips)
        {
            if (!TryGetLibrary(out var library)) return;
            for (int i = 0; i < library.Length; i++)
            {
                var entry = library.GetValue(i);
                if (!Reflect.GetField<Audio.AUDIO_ID>(entry, "id").Equals(id)) continue;
                Reflect.SetField(entry, "clips", clips);
                library.SetValue(entry, i);
                return;
            }
        }
    }
}
