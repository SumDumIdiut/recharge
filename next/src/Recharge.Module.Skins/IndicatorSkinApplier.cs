using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;
using Recharge.Loader.Core.Skins;
using Recharge.ModApi;
using UnityEngine;

namespace Recharge.Module.Skins
{
    // Skins the dash / double-jump indicators floating by the player from an
    // optional dash.png / doublejump.png in the skin folder.
    //
    // The vanilla indicator code keeps running untouched - it still positions,
    // scales, bobs and animates the vanilla renderers. A custom sprite is just
    // drawn on an overlay renderer parented to each vanilla one (so it inherits
    // all of that motion), while the vanilla renderer itself is made invisible.
    //
    // Each dash indicator is a dot orbiting the player's head, drawn as sprite
    // frames: 7 "Front" frames (dash_indicator_front_0000..0006, the dot passing
    // in front) then 5 "Back" frames (dash_indicator_back_0000..0004, passing
    // behind) - 12 frames for one full orbit. dash.png can be a 12x1 grid
    // sheet of those frames in that order. A plain (non-grid) dash.png is drawn
    // as a static Front dot and the Back one is hidden.
    internal static class IndicatorSkinApplier
    {
        private const int DashCols = SkinGrid.DashCols;
        private const int DashRows = SkinGrid.DashRows;
        private static readonly Regex DashSpriteName = new Regex("^dash_indicator_(front|back)_(\\d+)$");

        private static readonly FieldInfo DashField = Reflect.FieldOf<PlayerAbilityIndicatorController>("dashIndicators");
        private static readonly FieldInfo JumpField = Reflect.FieldOf<PlayerAbilityIndicatorController>("jumpIndicators");

        private class Target
        {
            public SpriteRenderer Vanilla;
            public SpriteRenderer Overlay;
            public bool IsBack;
            public bool LoggedFirstDraw;
        }

        private class Art
        {
            public Texture2D Texture;
            public bool IsSheet;
            public int CellW, CellH;
            public Sprite Flat;
            public readonly Dictionary<(int row, int frame), Sprite> Cells = new Dictionary<(int, int), Sprite>();
        }

        private static PlayerAbilityIndicatorController _controller;
        private static List<Target> _dash, _jump;
        private static int _nextFindFrame;

        private static string _loadedFolder;
        private static Art _dashArt, _jumpArt;

        public static void Apply(IRechargeHost host, string skinFolder)
        {
            if (!EnsureController(host)) return;
            if (_loadedFolder != skinFolder) LoadArt(host, skinFolder);

            foreach (var t in _dash) ApplyTarget(t, _dashArt, isDash: true);
            foreach (var t in _jump) ApplyTarget(t, _jumpArt, isDash: false);
        }

        public static void RestoreVanilla()
        {
            if (_loadedFolder != null) LoadArt(null, null);
            if (_dash == null) return;
            foreach (var t in _dash) Restore(t);
            foreach (var t in _jump) Restore(t);
        }

        private static bool EnsureController(IRechargeHost host)
        {
            if (_controller != null) return true;
            if (Time.frameCount < _nextFindFrame) return false;
            _nextFindFrame = Time.frameCount + 60;

            var found = Object.FindFirstObjectByType<PlayerAbilityIndicatorController>();
            if (found == null || DashField == null || JumpField == null) return false;

            _controller = found;
            _dash = BuildTargets(DashField.GetValue(found) as Transform[]);
            _jump = BuildTargets(JumpField.GetValue(found) as Transform[]);
            host?.Log($"[CustomSkins] indicators found: {_dash.Count} dash renderer(s), {_jump.Count} double-jump renderer(s)");
            return true;
        }

        private static List<Target> BuildTargets(Transform[] roots)
        {
            var targets = new List<Target>();
            if (roots == null) return targets;
            foreach (var root in roots)
            {
                if (root == null) continue;
                foreach (var r in root.GetComponentsInChildren<SpriteRenderer>(true))
                {
                    targets.Add(new Target { Vanilla = r, IsBack = r.name.ToLowerInvariant().Contains("back") });
                }
            }
            return targets;
        }

        private static void LoadArt(IRechargeHost host, string folder)
        {
            DisposeArt(_dashArt);
            DisposeArt(_jumpArt);
            _dashArt = _jumpArt = null;
            _loadedFolder = folder;
            if (folder == null) return;

            _dashArt = ReadArt(host, SkinFiles.FindIndicatorImage(folder, IndicatorKind.Dash), dash: true);
            _jumpArt = ReadArt(host, SkinFiles.FindIndicatorImage(folder, IndicatorKind.DoubleJump), dash: false);
        }

        private static Art ReadArt(IRechargeHost host, string path, bool dash)
        {
            if (path == null) return null;
            byte[] bytes;
            try { bytes = File.ReadAllBytes(path); }
            catch (System.Exception e)
            {
                host?.LogWarning($"[CustomSkins] couldn't read indicator image '{path}': {e.Message}");
                return null;
            }
            var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            if (!ImageConversion.LoadImage(tex, bytes))
            {
                host?.LogWarning($"[CustomSkins] couldn't decode indicator image '{path}'");
                Object.Destroy(tex);
                return null;
            }
            var art = new Art { Texture = tex };
            if (dash && GridSheet.LooksLikeGrid(tex, DashCols, DashRows, out int cellW, out int cellH))
            {
                art.IsSheet = true;
                art.CellW = cellW;
                art.CellH = cellH;
                host?.Log($"[CustomSkins] '{Path.GetFileName(path)}' recognized as a {DashRows}x{DashCols} indicator sheet (cell {cellW}x{cellH})");
            }
            return art;
        }

        private static void DisposeArt(Art art)
        {
            if (art == null) return;
            if (art.Flat != null) Object.Destroy(art.Flat);
            foreach (var sprite in art.Cells.Values) Object.Destroy(sprite);
            if (art.Texture != null) Object.Destroy(art.Texture);
        }

        private static void ApplyTarget(Target t, Art art, bool isDash)
        {
            if (t.Vanilla == null) return;
            var custom = art == null ? null : PickSprite(art, t, isDash);
            if (custom == null)
            {
                // A flat dash image has no Back frame: hide that layer entirely.
                if (isDash && art != null && !art.IsSheet && t.IsBack) Hide(t);
                else Restore(t);
                return;
            }

            EnsureOverlay(t);
            t.Overlay.sprite = custom;
            t.Overlay.enabled = t.Vanilla.enabled;
            t.Vanilla.forceRenderingOff = true;

            if (!t.LoggedFirstDraw)
            {
                t.LoggedFirstDraw = true;
                Debug.Log($"[CustomSkins] indicator overlay on '{t.Vanilla.transform.parent?.name}/{t.Vanilla.name}': layer={t.Overlay.gameObject.layer} order={t.Overlay.sortingOrder} " +
                    $"material={(t.Overlay.sharedMaterial != null ? t.Overlay.sharedMaterial.name : "null")} sprite={custom.rect.width}x{custom.rect.height}@{custom.pixelsPerUnit}ppu " +
                    $"overlayWorldSize={t.Overlay.bounds.size} vanillaWorldSize={t.Vanilla.bounds.size} lossyScale={t.Vanilla.transform.lossyScale}");
            }
        }

        private static Sprite PickSprite(Art art, Target t, bool isDash)
        {
            var vanilla = t.Vanilla.sprite;
            if (vanilla == null) return null;

            if (art.IsSheet)
            {
                var m = DashSpriteName.Match(vanilla.name);
                if (!m.Success) return null;
                int frame = int.Parse(m.Groups[2].Value);
                int col = SkinGrid.DashColumn(m.Groups[1].Value == "back", frame);
                return col >= 0 ? CellSprite(art, col, vanilla) : null;
            }

            if (isDash && t.IsBack) return null;
            if (art.Flat == null) art.Flat = MakeSprite(art.Texture, new Rect(0, 0, art.Texture.width, art.Texture.height), art.Texture.width, vanilla);
            return art.Flat;
        }

        private static Sprite CellSprite(Art art, int col, Sprite vanilla)
        {
            if (art.Cells.TryGetValue((0, col), out var cached)) return cached;

            SkinGrid.CellOrigin(0, col, SkinGrid.DashRows, art.CellW, art.CellH, out int x, out int yFromBottom);
            var cell = new Texture2D(art.CellW, art.CellH, TextureFormat.RGBA32, false);
            cell.SetPixels(art.Texture.GetPixels(x, yFromBottom, art.CellW, art.CellH));
            cell.Apply();

            var sprite = MakeSprite(cell, new Rect(0, 0, art.CellW, art.CellH), art.CellW, vanilla);
            art.Cells[(0, col)] = sprite;
            return sprite;
        }

        // Sized so it covers exactly the same world area as the vanilla sprite.
        private static Sprite MakeSprite(Texture2D tex, Rect rect, int pixelWidth, Sprite vanilla)
        {
            float ppu = pixelWidth * vanilla.pixelsPerUnit / vanilla.rect.width;
            return Sprite.Create(tex, rect, new Vector2(0.5f, 0.5f), ppu, 0, SpriteMeshType.FullRect);
        }

        private static void EnsureOverlay(Target t)
        {
            if (t.Overlay != null) return;
            var go = new GameObject("CustomSkinIndicator");
            go.layer = t.Vanilla.gameObject.layer;
            go.transform.SetParent(t.Vanilla.transform, false);
            t.Overlay = go.AddComponent<SpriteRenderer>();
            t.Overlay.sharedMaterial = t.Vanilla.sharedMaterial;
            t.Overlay.sortingLayerID = t.Vanilla.sortingLayerID;
            t.Overlay.sortingOrder = t.Vanilla.sortingOrder + 1;
            t.Overlay.renderingLayerMask = t.Vanilla.renderingLayerMask;
            t.Overlay.maskInteraction = t.Vanilla.maskInteraction;
            t.Overlay.flipX = t.Vanilla.flipX;
            t.Overlay.flipY = t.Vanilla.flipY;
        }

        private static void Hide(Target t)
        {
            if (t.Overlay != null) t.Overlay.enabled = false;
            t.Vanilla.forceRenderingOff = true;
        }

        private static void Restore(Target t)
        {
            if (t.Vanilla == null) return;
            if (t.Overlay != null) t.Overlay.enabled = false;
            t.Vanilla.forceRenderingOff = false;
        }
    }
}
