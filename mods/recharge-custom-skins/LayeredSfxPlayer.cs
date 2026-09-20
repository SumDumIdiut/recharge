using System.Collections.Generic;
using UnityEngine;

namespace RechargeCustomSkins
{
    // Audio.PlayAudio() spawns a fresh AudioSource per call and cleans it up
    // afterward, so footstep/landing/tired sounds already layer naturally -
    // no help needed there. Movement's jump/dash/airJump/death sounds all go
    // through one shared audioSource.Play() instead, so a retrigger before a
    // long custom clip finishes would normally cut it off. This plays those
    // clips on their own independent, self-cleaning AudioSource instead.
    internal static class LayeredSfxPlayer
    {
        private const string PlaceholderPrefix = "RechargeSilentPlaceholder_";
        private static readonly Dictionary<string, AudioClip> Placeholders = new Dictionary<string, AudioClip>();

        // Long enough to reliably still be isPlaying the next time a poll
        // runs even at a low frame rate - it's silent, so its exact length
        // otherwise doesn't matter.
        private const float PlaceholderSeconds = 0.2f;

        public static AudioClip PlaceholderFor(string slotName)
        {
            if (Placeholders.TryGetValue(slotName, out var existing)) return existing;
            const int sampleRate = 44100;
            var clip = AudioClip.Create(PlaceholderPrefix + slotName, (int)(sampleRate * PlaceholderSeconds), 1, sampleRate, false);
            clip.SetData(new float[(int)(sampleRate * PlaceholderSeconds)], 0);
            Placeholders[slotName] = clip;
            return clip;
        }

        public static string SlotNameForPlaceholder(AudioClip clip)
            => clip != null && clip.name.StartsWith(PlaceholderPrefix) ? clip.name.Substring(PlaceholderPrefix.Length) : null;

        public static void PlayLayered(AudioClip clip, float pitch, float volume)
        {
            var go = new GameObject("RechargeLayeredSfx_" + clip.name);
            var source = go.AddComponent<AudioSource>();
            source.clip = clip;
            source.pitch = pitch;
            source.volume = volume;
            source.spatialBlend = 0f;
            source.Play();
            Object.Destroy(go, clip.length / Mathf.Max(0.01f, pitch) + 0.1f);
        }
    }
}
