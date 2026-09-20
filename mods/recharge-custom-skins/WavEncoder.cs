using System.IO;
using System.Text;
using UnityEngine;

namespace RechargeCustomSkins
{
    // Unity has no AudioClip -> file encoder built in (ImageConversion has no
    // audio equivalent), so this writes a plain 16-bit PCM WAV by hand - a
    // fixed, well-known header format, not anything clip-specific.
    internal static class WavEncoder
    {
        public static byte[] Encode(AudioClip clip)
        {
            var samples = new float[clip.samples * clip.channels];
            clip.GetData(samples, 0);

            int channels = clip.channels;
            int sampleRate = clip.frequency;
            const short bitsPerSample = 16;
            var pcm = new byte[samples.Length * 2];
            for (int i = 0; i < samples.Length; i++)
            {
                short s = (short)Mathf.Clamp(Mathf.RoundToInt(samples[i] * short.MaxValue), short.MinValue, short.MaxValue);
                pcm[i * 2] = (byte)(s & 0xff);
                pcm[i * 2 + 1] = (byte)((s >> 8) & 0xff);
            }

            using var ms = new MemoryStream();
            using (var w = new BinaryWriter(ms))
            {
                int byteRate = sampleRate * channels * bitsPerSample / 8;
                short blockAlign = (short)(channels * bitsPerSample / 8);

                w.Write(Encoding.ASCII.GetBytes("RIFF"));
                w.Write(36 + pcm.Length);
                w.Write(Encoding.ASCII.GetBytes("WAVE"));
                w.Write(Encoding.ASCII.GetBytes("fmt "));
                w.Write(16);
                w.Write((short)1); // PCM
                w.Write((short)channels);
                w.Write(sampleRate);
                w.Write(byteRate);
                w.Write(blockAlign);
                w.Write(bitsPerSample);
                w.Write(Encoding.ASCII.GetBytes("data"));
                w.Write(pcm.Length);
                w.Write(pcm);
            }
            return ms.ToArray();
        }
    }
}
