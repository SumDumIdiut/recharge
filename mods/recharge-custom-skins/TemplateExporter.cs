using System.Collections.Generic;
using System.IO;
using System.Linq;
using Recharge.ModApi;
using UnityEngine;

namespace RechargeCustomSkins
{
    internal struct SkinGridLayout
    {
        public int Gutter;
        public int CellW;
        public int CellH;
        public int Cols;
        public int Rows;
        public int TexW;
        public int TexH;
        public List<(string name, int frameCount)> RowClips;
        public List<List<Sprite>> RowFrameSprites;
        public List<List<bool>> RowFrameFlipY;
    }

    internal static class TemplateExporter
    {
        public static string Export(GameObject spriteChildTemplate, string outputDir, IRechargeHost host)
        {
            var perClip = CapturePerClipFrames(spriteChildTemplate, host);
            if (perClip == null) return null;
            return ComposeTemplate(perClip, outputDir, host);
        }

        private static List<(string name, List<Sprite> frames, List<bool> flips)> CapturePerClipFrames(GameObject spriteChildTemplate, IRechargeHost host)
        {
            var templateAnimator = spriteChildTemplate.GetComponent<Animator>();
            if (templateAnimator == null || templateAnimator.runtimeAnimatorController == null)
            {
                host.LogError("[CustomSkins] template export: no Animator/controller on the player's Sprite child");
                return null;
            }

            var clips = templateAnimator.runtimeAnimatorController.animationClips
                .Where(c => c != null)
                .GroupBy(c => c.name)
                .Select(g => g.First())
                .ToList();
            if (clips.Count == 0)
            {
                host.LogError("[CustomSkins] template export: controller has no animation clips");
                return null;
            }

            var farPos = new Vector3(70000f, 70000f, 0f);
            var clone = Object.Instantiate(spriteChildTemplate, farPos, Quaternion.identity);
            clone.SetActive(true);
            var cloneAnimator = clone.GetComponent<Animator>();
            var cloneRenderer = clone.GetComponent<SpriteRenderer>();

            var perClip = new List<(string name, List<Sprite> frames, List<bool> flips)>();
            foreach (var clip in clips)
            {
                var frames = new List<Sprite>();
                var flips = new List<bool>();
                int steps = Mathf.Max(1, Mathf.RoundToInt(clip.length * clip.frameRate));
                for (int i = 0; i <= steps; i++)
                {
                    float t = steps == 0 ? 0f : (float)i / steps;
                    cloneAnimator.Play(clip.name, 0, t);
                    cloneAnimator.Update(0f);
                    var s = cloneRenderer.sprite;
                    bool flip = cloneRenderer.flipY;
                    if (s != null && (frames.Count == 0 || frames[frames.Count - 1] != s || flips[flips.Count - 1] != flip))
                    {
                        frames.Add(s);
                        flips.Add(flip);
                    }
                }
                if (frames.Count > 0) perClip.Add((clip.name, frames, flips));
            }

            Object.Destroy(clone);

            if (perClip.Count == 0)
            {
                host.LogError("[CustomSkins] template export: captured zero frames across all clips");
                return null;
            }

            return perClip;
        }

        private struct CellLayoutInfo
        {
            public int CellW, CellH;
            public float AnchorX, AnchorY;
        }

        private static CellLayoutInfo ComputeCellLayout(List<(string name, List<Sprite> frames, List<bool> flips)> perClip)
        {
            float maxLeft = 0f, maxRight = 0f, maxBottom = 0f, maxTop = 0f;
            foreach (var (_, frames, flips) in perClip)
            {
                for (int i = 0; i < frames.Count; i++)
                {
                    var s = frames[i];
                    float w = s.textureRect.width;
                    float h = s.textureRect.height;
                    float pivotX = s.pivot.x;
                    float pivotY = flips[i] ? (h - s.pivot.y) : s.pivot.y;
                    maxLeft = Mathf.Max(maxLeft, pivotX);
                    maxRight = Mathf.Max(maxRight, w - pivotX);
                    maxBottom = Mathf.Max(maxBottom, pivotY);
                    maxTop = Mathf.Max(maxTop, h - pivotY);
                }
            }
            float halfW = Mathf.Max(maxLeft, maxRight);
            float halfH = Mathf.Max(maxBottom, maxTop);
            return new CellLayoutInfo
            {
                CellW = Mathf.Max(1, Mathf.CeilToInt(halfW * 2f)),
                CellH = Mathf.Max(1, Mathf.CeilToInt(halfH * 2f)),
                AnchorX = halfW,
                AnchorY = halfH,
            };
        }

        public static SkinGridLayout? ComputeGridLayout(GameObject spriteChildTemplate, IRechargeHost host)
        {
            var perClip = CapturePerClipFrames(spriteChildTemplate, host);
            if (perClip == null) return null;

            var cell = ComputeCellLayout(perClip);
            int cols = perClip.Max(p => p.frames.Count);
            int rows = perClip.Count;
            int strideW = cell.CellW + Gutter;
            int strideH = cell.CellH + Gutter;

            return new SkinGridLayout
            {
                Gutter = Gutter,
                CellW = cell.CellW,
                CellH = cell.CellH,
                Cols = cols,
                Rows = rows,
                TexW = Gutter + cols * strideW,
                TexH = Gutter + rows * strideH,
                RowClips = perClip.Select(p => (p.name, p.frames.Count)).ToList(),
                RowFrameSprites = perClip.Select(p => p.frames).ToList(),
                RowFrameFlipY = perClip.Select(p => p.flips).ToList(),
            };
        }

        private const int Gutter = 2;

        private static string ComposeTemplate(List<(string name, List<Sprite> frames, List<bool> flips)> perClip, string outputDir, IRechargeHost host)
        {
            var cell = ComputeCellLayout(perClip);
            int cellW = cell.CellW, cellH = cell.CellH;

            int cols = perClip.Max(p => p.frames.Count);
            int rows = perClip.Count;
            int strideW = cellW + Gutter;
            int strideH = cellH + Gutter;
            int texW = Gutter + cols * strideW;
            int texH = Gutter + rows * strideH;

            var buf = new Color32[texW * texH];
            var transparent = new Color32(0, 0, 0, 0);
            for (int i = 0; i < buf.Length; i++) buf[i] = transparent;

            var lineColor = new Color32(255, 0, 220, 255);
            for (int c = 0; c <= cols; c++)
                DrawVerticalBand(buf, texW, texH, c * strideW, Gutter, lineColor);
            for (int r = 0; r <= rows; r++)
                DrawHorizontalBand(buf, texW, texH, r * strideH, Gutter, lineColor);

            for (int r = 0; r < perClip.Count; r++)
            {
                var (_, frames, flips) = perClip[r];
                int rowFromBottom = rows - 1 - r;
                int cellOriginY = Gutter + rowFromBottom * strideH;
                for (int c = 0; c < frames.Count; c++)
                {
                    var sprite = frames[c];
                    bool flip = flips[c];
                    int w = (int)sprite.textureRect.width;
                    int h = (int)sprite.textureRect.height;
                    var pixels = ReadSpritePixels(sprite);
                    float pivotY = flip ? (h - sprite.pivot.y) : sprite.pivot.y;
                    int cellOriginX = Gutter + c * strideW + Mathf.RoundToInt(cell.AnchorX - sprite.pivot.x);
                    int originY = cellOriginY + Mathf.RoundToInt(cell.AnchorY - pivotY);
                    for (int py = 0; py < h; py++)
                    {
                        int srcPy = flip ? (h - 1 - py) : py;
                        int srcRow = srcPy * w;
                        int destRow = (originY + py) * texW + cellOriginX;
                        for (int px = 0; px < w; px++) buf[destRow + px] = pixels[srcRow + px];
                    }
                }
            }

            var tex = new Texture2D(texW, texH, TextureFormat.RGBA32, false);
            tex.SetPixels32(buf);
            tex.Apply();
            var png = tex.EncodeToPNG();
            Object.Destroy(tex);

            Directory.CreateDirectory(outputDir);
            var pngPath = Path.Combine(outputDir, "skin-template.png");
            File.WriteAllBytes(pngPath, png);

            var legend = new System.Text.StringBuilder();
            legend.AppendLine("Recharge Custom Skins - template layout");
            legend.AppendLine($"Grid: {rows} row(s) x {cols} column(s), cell size {cellW}x{cellH}px, {Gutter}px magenta guide lines between cells.");
            legend.AppendLine("Row order (top to bottom):");
            for (int r = 0; r < perClip.Count; r++)
                legend.AppendLine($"  {r + 1}. {perClip[r].name} - {perClip[r].frames.Count} frame(s)");
            legend.AppendLine();
            legend.AppendLine("Edit any cell's artwork, keep the same cell grid, then import the whole");
            legend.AppendLine("sheet back as a skin - the mod slices it back out along these same lines.");
            var legendPath = Path.Combine(outputDir, "skin-template-README.txt");
            File.WriteAllText(legendPath, legend.ToString());

            host.LogError($"[CustomSkins] exported skin template: {rows} clips, {cols} max frames, {texW}x{texH}px -> {pngPath}");
            return pngPath;
        }

        private static void DrawVerticalBand(Color32[] buf, int texW, int texH, int startX, int width, Color32 color)
        {
            for (int x = startX; x < startX + width && x < texW; x++)
                for (int y = 0; y < texH; y++)
                    buf[y * texW + x] = color;
        }

        private static void DrawHorizontalBand(Color32[] buf, int texW, int texH, int startY, int height, Color32 color)
        {
            for (int y = startY; y < startY + height && y < texH; y++)
                for (int x = 0; x < texW; x++)
                    buf[y * texW + x] = color;
        }

        private static Color32[] ReadSpritePixels(Sprite sprite)
        {
            var srcTex = sprite.texture;
            var rect = sprite.textureRect;
            var rt = RenderTexture.GetTemporary(srcTex.width, srcTex.height, 0, RenderTextureFormat.ARGB32);
            var prevActive = RenderTexture.active;
            Graphics.Blit(srcTex, rt);
            RenderTexture.active = rt;
            var readable = new Texture2D((int)rect.width, (int)rect.height, TextureFormat.RGBA32, false);
            readable.ReadPixels(rect, 0, 0);
            readable.Apply();
            RenderTexture.active = prevActive;
            RenderTexture.ReleaseTemporary(rt);
            var pixels = readable.GetPixels32();
            Object.Destroy(readable);
            return pixels;
        }
    }
}
