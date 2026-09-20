using UnityEngine;
using Recharge.ModApi;

// A beep synthesized entirely in memory - no bundled .wav/.ogg needed.
internal static class AudioDemo
{
    public static void PlayBeep(IRechargeHost host, float frequencyHz = 440f, float durationSeconds = 0.25f)
    {
        const int sampleRate = 44100;
        var sampleCount = Mathf.CeilToInt(sampleRate * durationSeconds);
        var clip = AudioClip.Create("ExampleModBeep", sampleCount, 1, sampleRate, false);

        var samples = new float[sampleCount];
        for (int i = 0; i < sampleCount; i++)
        {
            var t = (float)i / sampleRate;
            // A short fade in/out envelope so the beep doesn't click at its edges.
            var envelope = Mathf.Min(1f, Mathf.Min(t, durationSeconds - t) * 40f);
            samples[i] = Mathf.Sin(2f * Mathf.PI * frequencyHz * t) * 0.4f * envelope;
        }
        clip.SetData(samples, 0);

        var go = new GameObject("ExampleModBeepSource");
        var source = go.AddComponent<AudioSource>();
        source.clip = clip;
        source.spatialBlend = 0f;
        source.Play();
        Object.Destroy(go, durationSeconds + 0.1f);

        host.Log($"Playing a {frequencyHz:0}Hz beep synthesized at runtime.");
    }
}
