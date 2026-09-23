using System.Collections.Generic;
using System.IO;
using System.Linq;
using Recharge.ModApi;
using UnityEngine;

namespace RechargeCustomSkins
{
    internal class SkinSave
    {
        public string CurrentSkinFile { get; set; }
    }

    internal class SkinRuntime
    {
        public Texture2D Texture;
        public Sprite FlatSprite;
        public Color TintColor = Color.white;

        public bool IsSheet;
        public SkinGridLayout Layout;
        public Dictionary<string, int> RowByClip;
        public int CellW, CellH;
        public readonly Dictionary<(int row, int frame), Sprite> Cache = new Dictionary<(int, int), Sprite>();
    }

    internal class SkinController : MonoBehaviour
    {
        private IRechargeHost _host;
        private string _skinsDir;
        private readonly List<(string folderName, byte[] imageBytes, SkinRuntime runtime)> _skins = new List<(string, byte[], SkinRuntime)>();
        private int _currentIndex = -1;

        private Movement _movement;
        private SpriteRenderer _spriteRenderer;
        private Material _originalMaterial;
        private static Material _fallbackMaterial;

        private float _originalPixelsPerUnit = 100f;

        private SkinGridLayout? _canonicalLayout;
        private readonly HashSet<(int, int)> _loggedCropKeys = new HashSet<(int, int)>();
        private readonly HashSet<(int, int)> _debugDumpKeys = new HashSet<(int, int)>();
        private Dictionary<Sprite, List<(int row, int frame)>> _vanillaSpriteEntries;

        private Movement _audioForMovement;
        private int _audioForIndex = int.MinValue;
        private int _globalAudioForIndex = int.MinValue;

        public void Init(IRechargeHost host)
        {
            _host = host;
            _skinsDir = Path.Combine(host.ModDataDir(RechargeCustomSkinsMod.ModId), "skins");
            Directory.CreateDirectory(_skinsDir);
            LoadSkinsFromDisk();

            var save = host.LoadConfig<SkinSave>(RechargeCustomSkinsMod.ModId);
            _currentIndex = save.CurrentSkinFile == null
                ? -1
                : _skins.FindIndex(s => s.folderName == save.CurrentSkinFile);
        }

        public int CurrentIndex => _currentIndex;

        public IReadOnlyList<string> SkinDisplayNames
        {
            get
            {
                var names = new List<string> { "Vanilla" };
                names.AddRange(_skins.Select(s => s.folderName));
                return names;
            }
        }

        public void SelectDisplayIndex(int displayIndex)
        {
            _currentIndex = displayIndex - 1;
            if (_currentIndex < -1 || _currentIndex >= _skins.Count) _currentIndex = -1;
            SaveState();
        }

        private void SaveState()
        {
            _host.SaveConfig(RechargeCustomSkinsMod.ModId, new SkinSave
            {
                CurrentSkinFile = _currentIndex >= 0 ? _skins[_currentIndex].folderName : null,
            });
        }

        private static readonly string[] ImageExtensions = { ".png", ".jpg", ".jpeg" };

        private void LoadSkinsFromDisk()
        {
            _skins.Clear();
            IEnumerable<string> folders;
            try
            {
                folders = Directory.EnumerateDirectories(_skinsDir)
                    .OrderBy(f => f, System.StringComparer.OrdinalIgnoreCase);
            }
            catch (System.Exception e)
            {
                _host.LogError("[CustomSkins] couldn't read skins folder: " + e);
                return;
            }

            foreach (var folder in folders)
            {
                var folderName = Path.GetFileName(folder);
                var imagePath = FindImageFile(folder);
                if (imagePath == null)
                {
                    _host.LogWarning($"[CustomSkins] '{folderName}' has no image file (png/jpg/jpeg) in it - skipping");
                    continue;
                }
                try
                {
                    var bytes = File.ReadAllBytes(imagePath);
                    _skins.Add((folderName, bytes, null));
                }
                catch (System.Exception e)
                {
                    _host.LogError($"[CustomSkins] couldn't load '{imagePath}': {e}");
                }
            }
        }

        private static string FindImageFile(string folder)
        {
            return Directory.EnumerateFiles(folder)
                .FirstOrDefault(f => ImageExtensions.Contains(Path.GetExtension(f), System.StringComparer.OrdinalIgnoreCase));
        }

        private string SoundsDir(int index) => Path.Combine(_skinsDir, _skins[index].folderName, "sounds");

        private const int Gutter = 2;
        private const float ReferenceCellSize = 256f; // Downloads/Character frames are 256x256

        // Sheet classification needs the live grid layout, which is computed
        // asynchronously (see EnsureLayoutComputing) to avoid a synchronous
        // allocation burst. Until it resolves, a skin's runtime is left
        // uncached so it's re-evaluated next frame instead of being
        // permanently misclassified as flat.
        private SkinRuntime EnsureRuntime(int index)
        {
            var (folderName, bytes, runtime) = _skins[index];
            if (runtime != null) return runtime;

            EnsureLayoutComputing();
            if (_layoutState == LayoutState.Computing) return null;

            runtime = new SkinRuntime();
            var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            if (!ImageConversion.LoadImage(tex, bytes))
            {
                _host.LogError("[CustomSkins] couldn't decode '" + folderName + "'");
                _skins[index] = (folderName, bytes, runtime);
                return runtime;
            }
            runtime.Texture = tex;
            runtime.TintColor = ComputeTintColor(tex);

            if (_layoutState == LayoutState.Ready && LooksLikeGrid(tex, _canonicalLayout.Value, out int cellW, out int cellH))
            {
                var layout = _canonicalLayout.Value;
                runtime.IsSheet = true;
                runtime.Layout = layout;
                runtime.CellW = cellW;
                runtime.CellH = cellH;
                runtime.RowByClip = new Dictionary<string, int>();
                for (int r = 0; r < layout.RowClips.Count; r++) runtime.RowByClip[layout.RowClips[r].name] = r;
                _host.Log($"[CustomSkins] '{folderName}' recognized as a {layout.Rows}x{layout.Cols} sheet (cell {cellW}x{cellH})");
            }

            if (!runtime.IsSheet)
            {
                runtime.FlatSprite = Sprite.Create(tex, new Rect(0, 0, tex.width, tex.height), new Vector2(0.5f, 0.5f), _originalPixelsPerUnit);
            }

            _skins[index] = (folderName, bytes, runtime);
            return runtime;
        }

        private static readonly Color32 GridLineColor = new Color32(255, 0, 220, 255);
        private const int GridLineSearchRadius = 3;
        private const int GridLineColorTolerance = 60;

        // Tolerant of resize/recompress blur - not an exact pixel match.
        private static bool LooksLikeGrid(Texture2D tex, SkinGridLayout layout, out int cellW, out int cellH)
        {
            cellW = (tex.width - Gutter) / layout.Cols - Gutter;
            cellH = (tex.height - Gutter) / layout.Rows - Gutter;
            if (cellW <= 0 || cellH <= 0) return false;

            var pixels = tex.GetPixels32();
            int w = tex.width, h = tex.height;
            if (!HasGridLineNear(pixels, w, h, 0, 0)) return false;
            if (!HasGridLineNear(pixels, w, h, 0, h - 1)) return false;
            if (layout.Cols > 1)
            {
                int xDivider = Gutter + cellW;
                if (xDivider >= w || !HasGridLineNear(pixels, w, h, xDivider, 0)) return false;
            }
            return true;
        }

        private static bool HasGridLineNear(Color32[] pixels, int w, int h, int x, int y)
        {
            for (int dy = -GridLineSearchRadius; dy <= GridLineSearchRadius; dy++)
            {
                int sy = y + dy;
                if (sy < 0 || sy >= h) continue;
                for (int dx = -GridLineSearchRadius; dx <= GridLineSearchRadius; dx++)
                {
                    int sx = x + dx;
                    if (sx < 0 || sx >= w) continue;
                    if (IsGridLineColor(pixels[sy * w + sx])) return true;
                }
            }
            return false;
        }

        private static bool IsGridLineColor(Color32 c) =>
            System.Math.Abs(c.r - GridLineColor.r) + System.Math.Abs(c.g - GridLineColor.g) + System.Math.Abs(c.b - GridLineColor.b) <= GridLineColorTolerance
            && c.a > 200;

        // A skin's average opaque, non-guide-line color - used as a stand-in
        // tint for clips that have no custom row (e.g. Die, which has no
        // source art to build a row from at all). Not exact for a
        // multi-hue skin, but far closer than showing fully vanilla colors.
        private static Color ComputeTintColor(Texture2D tex)
        {
            var pixels = tex.GetPixels32();
            long r = 0, g = 0, b = 0;
            int count = 0;
            foreach (var p in pixels)
            {
                if (p.a < 200) continue;
                if (IsGridLineColor(p)) continue;
                r += p.r; g += p.g; b += p.b;
                count++;
            }
            if (count == 0) return Color.white;
            return new Color(r / 255f / count, g / 255f / count, b / 255f / count, 1f);
        }

        private enum LayoutState { NotStarted, Computing, Ready, Failed }
        private LayoutState _layoutState = LayoutState.NotStarted;

        private void EnsureLayoutComputing()
        {
            if (_layoutState != LayoutState.NotStarted) return;
            if (!EnsurePlayer()) return;
            _layoutState = LayoutState.Computing;
            StartCoroutine(TemplateGrid.ComputeLayoutCoroutine(_spriteRenderer.gameObject, _host, OnLayoutComputed));
        }

        private void OnLayoutComputed(SkinGridLayout? layout)
        {
            _canonicalLayout = layout;
            if (!layout.HasValue)
            {
                _layoutState = LayoutState.Failed;
                return;
            }

            _vanillaSpriteEntries = new Dictionary<Sprite, List<(int, int)>>();
            for (int r = 0; r < layout.Value.RowFrameSprites.Count; r++)
            {
                var frames = layout.Value.RowFrameSprites[r];
                for (int f = 0; f < frames.Count; f++)
                {
                    if (frames[f] == null) continue;
                    if (!_vanillaSpriteEntries.TryGetValue(frames[f], out var list))
                    {
                        list = new List<(int, int)>();
                        _vanillaSpriteEntries[frames[f]] = list;
                    }
                    list.Add((r, f));
                }
            }
            _layoutState = LayoutState.Ready;
        }

        public bool TryGetVanillaRowFrame(Sprite vanillaSprite, out (int row, int frame) match)
        {
            match = default;
            if (vanillaSprite == null || _vanillaSpriteEntries == null) return false;
            if (!_vanillaSpriteEntries.TryGetValue(vanillaSprite, out var list) || list.Count == 0) return false;
            match = list[0];
            return true;
        }

        public Sprite GetCustomCellSprite(SkinRuntime runtime, int row, int frame)
        {
            row = Mathf.Clamp(row, 0, runtime.Layout.RowClips.Count - 1);
            int frameCount = Mathf.Max(1, runtime.Layout.RowClips[row].frameCount);
            frame = Mathf.Clamp(frame, 0, frameCount - 1);

            var key = (row, frame);
            if (runtime.Cache.TryGetValue(key, out var cached)) return cached;

            var layout = runtime.Layout;
            Sprite vanillaSprite = row < layout.RowFrameSprites.Count && frame < layout.RowFrameSprites[row].Count
                ? layout.RowFrameSprites[row][frame] : null;
            if (vanillaSprite == null) return null;

            int canvasW = Mathf.Max(1, Mathf.RoundToInt(vanillaSprite.textureRect.width));
            int canvasH = Mathf.Max(1, Mathf.RoundToInt(vanillaSprite.textureRect.height));

            if (_loggedCropKeys.Add(key))
            {
                _host.Log($"[CustomSkins] crop diag row={row} frame={frame} vanillaSprite.rect={vanillaSprite.rect} " +
                    $"textureRect={vanillaSprite.textureRect} textureRectOffset={vanillaSprite.textureRectOffset} " +
                    $"pivot={vanillaSprite.pivot} pixelsPerUnit={vanillaSprite.pixelsPerUnit} " +
                    $"cellW={runtime.CellW} cellH={runtime.CellH} canvasW={canvasW} canvasH={canvasH}");
            }

            // A cell holds the FULL, untrimmed sprite bounds (same coordinate
            // space as vanilla's own sprite.rect - a raw 256x256 source frame
            // dropped into a cell unmodified already has its content at the
            // right place). Crop to exactly the trimmed sub-region vanilla
            // itself uses (textureRectOffset/textureRect) so alignment
            // matches vanilla exactly instead of being guessed. (An earlier
            // ad-hoc template used its own bottom-anchored+centered
            // convention instead, which is why it produced blank/jittery
            // output here - fix is to build skins that match this
            // convention, not to keep guessing the template's layout.)
            int rowFromBottom = layout.Rows - 1 - row;
            int cellOriginX = Gutter + frame * (runtime.CellW + Gutter);
            int cellOriginY = Gutter + rowFromBottom * (runtime.CellH + Gutter);
            var cellColors = runtime.Texture.GetPixels(cellOriginX, cellOriginY, runtime.CellW, runtime.CellH);

            float scale = runtime.CellW / ReferenceCellSize;
            var outPixels = new Color32[canvasW * canvasH];
            for (int y = 0; y < canvasH; y++)
            {
                int srcY = Mathf.RoundToInt((vanillaSprite.textureRectOffset.y + y) * scale);
                if (srcY < 0 || srcY >= runtime.CellH) continue;
                int rowBase = srcY * runtime.CellW;
                for (int x = 0; x < canvasW; x++)
                {
                    int srcX = Mathf.RoundToInt((vanillaSprite.textureRectOffset.x + x) * scale);
                    if (srcX < 0 || srcX >= runtime.CellW) continue;
                    outPixels[y * canvasW + x] = cellColors[rowBase + srcX];
                }
            }
            var canvas = new Texture2D(canvasW, canvasH, TextureFormat.RGBA32, false);
            canvas.SetPixels32(outPixels);
            canvas.Apply();

            if (_debugDumpKeys.Add(key))
            {
                try
                {
                    var dumpDir = Path.Combine(_host.ModDataDir(RechargeCustomSkinsMod.ModId), "debug-dump");
                    Directory.CreateDirectory(dumpDir);
                    File.WriteAllBytes(Path.Combine(dumpDir, $"cropped_r{row}_f{frame}.png"), canvas.EncodeToPNG());
                    var fullCellTex = new Texture2D(runtime.CellW, runtime.CellH, TextureFormat.RGBA32, false);
                    fullCellTex.SetPixels(cellColors);
                    fullCellTex.Apply();
                    File.WriteAllBytes(Path.Combine(dumpDir, $"fullcell_r{row}_f{frame}.png"), fullCellTex.EncodeToPNG());
                    _host.Log($"[CustomSkins] dumped debug PNGs for row={row} frame={frame} to {dumpDir}");
                }
                catch (System.Exception e) { _host.LogWarning("[CustomSkins] debug dump failed: " + e); }
            }

            float pivotX = vanillaSprite.pivot.x - vanillaSprite.textureRectOffset.x;
            float pivotY = vanillaSprite.pivot.y - vanillaSprite.textureRectOffset.y;
            var sprite = Sprite.Create(canvas, new Rect(0, 0, canvasW, canvasH),
                new Vector2(pivotX / canvasW, pivotY / canvasH), vanillaSprite.pixelsPerUnit);
            runtime.Cache[key] = sprite;
            return sprite;
        }

        private int _loggedRow = -1;
        private Animator _animator;
        private readonly List<AnimatorClipInfo> _clipInfoBuffer = new List<AnimatorClipInfo>();

        private Sprite PickSheetSprite(SkinRuntime runtime)
        {
            if (_animator == null) _animator = _spriteRenderer.GetComponent<Animator>();
            var animator = _animator;
            _clipInfoBuffer.Clear();
            if (animator != null) animator.GetCurrentAnimatorClipInfo(0, _clipInfoBuffer);

            AnimatorClipInfo? dominant = null;
            foreach (var ci in _clipInfoBuffer)
            {
                if (dominant == null || ci.weight > dominant.Value.weight) dominant = ci;
            }
            if (!dominant.HasValue) return null;

            // Vanilla's "Die" clip isn't a real animation - it has exactly one
            // sprite keyframe, and that sprite is literally Dash_0001 (verified
            // against the game's own AnimationClip data: same textureRectOffset
            // and size as Dash row/frame 1). There's no dedicated death artwork
            // to paint, so every skin's existing Dash row already has the right
            // cell - just reuse it instead of needing a new row.
            if (dominant.Value.clip.name == "Die")
            {
                return runtime.RowByClip.TryGetValue("Dash", out var dashRow)
                    ? GetCustomCellSprite(runtime, dashRow, 1)
                    : null;
            }

            // A clip outside SupportedRowClipNames has no row to draw from -
            // returning null here lets the vanilla Animator-driven
            // sprite/material show through untouched instead of freezing on
            // a stale/wrong row (previously defaulted to row 0/Idle, which
            // silently ate clips like the death animation).
            if (!runtime.RowByClip.TryGetValue(dominant.Value.clip.name, out var row))
            {
                return null;
            }

            if (row != _loggedRow)
            {
                _loggedRow = row;
                _host.Log("[CustomSkins] sheet row switched to " + row + " (" + runtime.Layout.RowClips[row].name + "), clipInfos=" +
                    string.Join(",", _clipInfoBuffer.Select(c => c.clip.name + ":" + c.weight.ToString("F2"))));
            }

            int frameCount = Mathf.Max(1, runtime.Layout.RowClips[row].frameCount);
            var stateInfo = animator != null ? animator.GetCurrentAnimatorStateInfo(0) : default;
            float frac = animator != null ? Mathf.Repeat(stateInfo.normalizedTime, 1f) : 0f;
            int frame = Mathf.Clamp(Mathf.FloorToInt(frac * frameCount), 0, frameCount - 1);

            return GetCustomCellSprite(runtime, row, frame);
        }

        private bool EnsurePlayer()
        {
            if (_spriteRenderer != null) return true;

            _movement = UnityEngine.Object.FindFirstObjectByType<Movement>();
            if (_movement == null) return false;
            var playerGo = _movement.gameObject;
            var spriteChild = playerGo.transform.Find("Sprite");
            if (spriteChild == null) return false;
            _spriteRenderer = spriteChild.GetComponent<SpriteRenderer>();
            if (_spriteRenderer != null)
            {
                _originalMaterial = _spriteRenderer.sharedMaterial;
                if (_spriteRenderer.sprite != null) _originalPixelsPerUnit = _spriteRenderer.sprite.pixelsPerUnit;
                SkinAudioApplier.CaptureOriginals(_host, _movement);
            }
            return _spriteRenderer != null;
        }

        private static Material GetFallbackMaterial()
        {
            if (_fallbackMaterial != null) return _fallbackMaterial;
            var probeGo = new GameObject("CustomSkinsFallbackMaterialProbe");
            var probeRenderer = probeGo.AddComponent<SpriteRenderer>();
            _fallbackMaterial = new Material(probeRenderer.sharedMaterial);
            Destroy(probeGo);
            return _fallbackMaterial;
        }

        private void LateUpdate()
        {
            if (!EnsurePlayer()) return;
            GlobalAudioApplier.CaptureOriginals();

            bool skinActive = _currentIndex >= 0 && _currentIndex < _skins.Count;
            if (skinActive)
            {
                var runtime = EnsureRuntime(_currentIndex);
                var sprite = runtime == null ? null : (runtime.IsSheet ? PickSheetSprite(runtime) : runtime.FlatSprite);
                if (sprite != null)
                {
                    _spriteRenderer.sprite = sprite;
                    var fallback = GetFallbackMaterial();
                    if (_spriteRenderer.sharedMaterial != fallback) _spriteRenderer.material = fallback;
                    if (_spriteRenderer.color != Color.white) _spriteRenderer.color = Color.white;
                }
                else
                {
                    // No row for the currently playing clip (e.g. Die, which
                    // has no source art at all) - leave the Animator-driven
                    // vanilla sprite/material alone, but multiply-tint it
                    // towards the skin's own color instead of showing fully
                    // vanilla colors during it.
                    if (_spriteRenderer.sharedMaterial != _originalMaterial) _spriteRenderer.material = _originalMaterial;
                    var tint = runtime?.TintColor ?? Color.white;
                    if (_spriteRenderer.color != tint) _spriteRenderer.color = tint;
                }
                CloneSkinApplier.Apply(this, runtime);

                var soundsDir = SoundsDir(_currentIndex);
                if (_movement != _audioForMovement || _currentIndex != _audioForIndex)
                {
                    SkinAudioApplier.Apply(this, _host, _movement, soundsDir);
                    _audioForMovement = _movement;
                    _audioForIndex = _currentIndex;
                }

                if (_currentIndex != _globalAudioForIndex)
                {
                    GlobalAudioApplier.Apply(this, _host, soundsDir);
                    _globalAudioForIndex = _currentIndex;
                }
            }
            else
            {
                if (_spriteRenderer.sharedMaterial != _originalMaterial) _spriteRenderer.material = _originalMaterial;
                if (_spriteRenderer.color != Color.white) _spriteRenderer.color = Color.white;
                CloneSkinApplier.RestoreVanilla();

                if (_movement != _audioForMovement || _audioForIndex != -1)
                {
                    SkinAudioApplier.RestoreVanilla(_movement);
                    _audioForMovement = _movement;
                    _audioForIndex = -1;
                }

                if (_globalAudioForIndex != -1)
                {
                    GlobalAudioApplier.RestoreVanilla();
                    _globalAudioForIndex = -1;
                }
            }
        }
    }
}
