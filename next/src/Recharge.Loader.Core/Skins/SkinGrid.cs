using System;

namespace Recharge.Loader.Core.Skins
{
    /// <summary>
    /// The Unity-free maths behind skin sheets, ported from SkinMod's GridSheet / SkinController.
    /// A sheet has a 2px gutter around and between cells and magenta guide lines in the gutters.
    /// Pixel buffers are RGBA, 4 bytes per pixel, rows bottom-up (the order of Unity's Texture2D.GetPixels32).
    /// </summary>
    public static class SkinGrid
    {
        public const int Gutter = 2;
        public const int GridLineSearchRadius = 3;
        public const int GridLineColorTolerance = 60;

        /// <summary>Downloads/Character frames are 256x256; a sheet's cells scale against this.</summary>
        public const float ReferenceCellSize = 256f;

        /// <summary>Rows of the player sheet, in order (it must match the static template).</summary>
        public static readonly string[] SupportedRowClipNames = { "Idle", "run", "Fall", "Jump", "wallPose", "Dash" };

        /// <summary>The dash indicator sheet: 7 front frames and 5 back frames, 12x1.</summary>
        public const int DashCols = 12;
        public const int DashRows = 1;
        public const int DashFrontFrames = 7;

        /// <summary>cell = (size - gutter) / count - gutter, in integer maths. False when a cell would be empty.</summary>
        public static bool TryCellSize(int width, int height, int cols, int rows, out int cellW, out int cellH)
        {
            cellW = 0;
            cellH = 0;
            if (cols <= 0 || rows <= 0) return false;
            cellW = (width - Gutter) / cols - Gutter;
            cellH = (height - Gutter) / rows - Gutter;
            return cellW > 0 && cellH > 0;
        }

        /// <summary>GridSheet.IsGridLineColor: near the magenta (255,0,220) and nearly opaque.</summary>
        public static bool IsGridLineColor(byte r, byte g, byte b, byte a) =>
            Math.Abs(r - 255) + Math.Abs(g - 0) + Math.Abs(b - 220) <= GridLineColorTolerance && a > 200;

        /// <summary>GridSheet.LooksLikeGrid, tolerant of resize and recompress blur (not an exact pixel match).</summary>
        public static bool LooksLikeGrid(byte[] rgba, int width, int height, int cols, int rows, out int cellW, out int cellH)
        {
            if (rgba == null) throw new ArgumentNullException(nameof(rgba));
            cellW = (width - Gutter) / cols - Gutter;
            cellH = (height - Gutter) / rows - Gutter;
            if (cellW <= 0 || cellH <= 0) return false;
            if (rgba.Length < width * height * 4) return false;

            if (!HasGridLineNear(rgba, width, height, 0, 0)) return false;
            if (!HasGridLineNear(rgba, width, height, 0, height - 1)) return false;
            if (cols > 1)
            {
                int xDivider = Gutter + cellW;
                if (xDivider >= width || !HasGridLineNear(rgba, width, height, xDivider, 0)) return false;
            }
            return true;
        }

        private static bool HasGridLineNear(byte[] px, int w, int h, int x, int y)
        {
            for (int dy = -GridLineSearchRadius; dy <= GridLineSearchRadius; dy++)
            {
                int sy = y + dy;
                if (sy < 0 || sy >= h) continue;
                for (int dx = -GridLineSearchRadius; dx <= GridLineSearchRadius; dx++)
                {
                    int sx = x + dx;
                    if (sx < 0 || sx >= w) continue;
                    int i = (sy * w + sx) * 4;
                    if (IsGridLineColor(px[i], px[i + 1], px[i + 2], px[i + 3])) return true;
                }
            }
            return false;
        }

        /// <summary>
        /// Lower-left pixel of a cell. Rows are numbered from the top of the sheet but pixels are bottom-up,
        /// hence the flip (SkinController.GetCustomCellSprite).
        /// </summary>
        public static void CellOrigin(int row, int frame, int sheetRows, int cellW, int cellH, out int x, out int y)
        {
            int rowFromBottom = sheetRows - 1 - row;
            x = Gutter + frame * (cellW + Gutter);
            y = Gutter + rowFromBottom * (cellH + Gutter);
        }

        /// <summary>The scale of a sheet's cells against the 256px reference frame.</summary>
        public static float CellScale(int cellW) => cellW / ReferenceCellSize;

        /// <summary>Clamps a row index into [0, rowCount-1].</summary>
        public static int ClampRow(int row, int rowCount) => Math.Max(0, Math.Min(row, Math.Max(0, rowCount - 1)));

        /// <summary>Clamps a frame index into [0, frameCount-1] (a row always has at least one frame).</summary>
        public static int ClampFrame(int frame, int frameCount) => Math.Max(0, Math.Min(frame, Math.Max(1, frameCount) - 1));

        /// <summary>The frame of a looping clip: floor(frac * count), where frac is the repeated normalized time.</summary>
        public static int FrameAt(float normalizedTime, int frameCount)
        {
            int count = Math.Max(1, frameCount);
            double frac = normalizedTime - Math.Floor(normalizedTime);
            return ClampFrame((int)Math.Floor(frac * count), count);
        }

        /// <summary>
        /// The average opaque, non-guide-line colour (0..1 per channel), used to tint clips with no row; null when there is none.
        /// </summary>
        public static bool TryAverageColor(byte[] rgba, out float r, out float g, out float b)
        {
            long sr = 0, sg = 0, sb = 0;
            int count = 0;
            for (int i = 0; i + 3 < rgba.Length; i += 4)
            {
                if (rgba[i + 3] < 200) continue;
                if (IsGridLineColor(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3])) continue;
                sr += rgba[i];
                sg += rgba[i + 1];
                sb += rgba[i + 2];
                count++;
            }
            if (count == 0)
            {
                r = g = b = 1f;
                return false;
            }
            r = sr / 255f / count;
            g = sg / 255f / count;
            b = sb / 255f / count;
            return true;
        }

        /// <summary>The column of a dash indicator frame: front frames 0..6, then back frames 0..4, on one row. -1 past the sheet.</summary>
        public static int DashColumn(bool back, int frame)
        {
            if (frame < 0) return -1;
            int col = back ? DashFrontFrames + frame : frame;
            return col < DashCols ? col : -1;
        }
    }
}
