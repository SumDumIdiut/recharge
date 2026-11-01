using Recharge.Loader.Core.Skins;
using UnityEngine;

namespace Recharge.Module.Skins
{
    // Unity adapter over the Unity-free grid maths in Recharge.Loader.Core.Skins.SkinGrid
    // (SkinMod's GridSheet): the magenta-guide-line grid every skin sheet template is drawn on.
    internal static class GridSheet
    {
        public const int Gutter = SkinGrid.Gutter;

        // Tolerant of resize/recompress blur - not an exact pixel match.
        public static bool LooksLikeGrid(Texture2D tex, int cols, int rows, out int cellW, out int cellH)
        {
            if (!SkinGrid.TryCellSize(tex.width, tex.height, cols, rows, out cellW, out cellH)) return false;
            return SkinGrid.LooksLikeGrid(ToBytes(tex.GetPixels32()), tex.width, tex.height, cols, rows, out cellW, out cellH);
        }

        public static bool IsGridLineColor(Color32 c) => SkinGrid.IsGridLineColor(c.r, c.g, c.b, c.a);

        public static byte[] ToBytes(Color32[] pixels)
        {
            var bytes = new byte[pixels.Length * 4];
            for (int i = 0; i < pixels.Length; i++)
            {
                bytes[i * 4] = pixels[i].r;
                bytes[i * 4 + 1] = pixels[i].g;
                bytes[i * 4 + 2] = pixels[i].b;
                bytes[i * 4 + 3] = pixels[i].a;
            }
            return bytes;
        }
    }
}
