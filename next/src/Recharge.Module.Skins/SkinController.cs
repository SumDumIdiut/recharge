using System.Collections.Generic;
using System.IO;
using System.Linq;
using Recharge.Loader.Core.Skins;
using Recharge.ModApi;
using UnityEngine;

namespace Recharge.Module.Skins
{
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
        private readonly Dictionary<string, string> _displayNames = new Dictionary<string, string>();
        private int _currentIndex = -1;

        private Movement _movement;
        private SpriteRenderer _spriteRenderer;
        private Material _originalMaterial;
        private static Material _fallbackMaterial;

        private float _originalPixelsPerUnit = 100f;

        private SkinGridLayout? _canonicalLayout;
        private Dictionary<Sprite, List<(int row, int frame)>> _vanillaSpriteEntries;

        private Movement _audioForMovement;
        private int _audioForIndex = int.MinValue;
        private int _globalAudioForIndex = int.MinValue;

        public void Init(IRechargeHost host)
        {
            _host = host;
            _skinsDir = Path.Combine(host.ModDataDir(SkinPaths.DataModId), "skins");
            Directory.CreateDirectory(_skinsDir);
            LoadSkinsFromDisk();

            var chosen = SkinConfig.Read(Path.Combine(host.ModDataDir(SkinPaths.DataModId), "config.json"));
            _currentIndex = chosen == null
                ? -1
                : _skins.FindIndex(s => s.folderName == chosen);
        }

        public int CurrentIndex => _currentIndex;

        public IReadOnlyList<string> SkinDisplayNames
        {
            get
            {
                var names = new List<string> { "Vanilla" };
                names.AddRange(_skins.Select(s => DisplayName(s.folderName)));
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
            try
            {
                SkinConfig.Write(Path.Combine(_host.ModDataDir(SkinPaths.DataModId), "config.json"), CurrentFolder);
            }
            catch (System.Exception e)
            {
                _host.LogError("[CustomSkins] couldn't save the chosen skin: " + e.Message);
            }
            StateChanged?.Invoke(CurrentFolder, CurrentDisplayName);
        }

        /// <summary>Raised after the chosen skin changed (folder null for vanilla), from the main thread.</summary>
        public event System.Action<string, string> StateChanged;

        public string CurrentFolder => _currentIndex >= 0 && _currentIndex < _skins.Count ? _skins[_currentIndex].folderName : null;
        public string CurrentDisplayName => CurrentFolder == null ? "Vanilla" : DisplayName(CurrentFolder);

        /// <summary>The skin.apply intent: switches live by folder name (null or empty for vanilla). False when there is no such skin.</summary>
        public bool ApplyFolder(string folder)
        {
            if (string.IsNullOrEmpty(folder)) { SelectDisplayIndex(0); return true; }
            Rescan();
            int i = _skins.FindIndex(s => s.folderName == folder);
            if (i < 0) return false;
            SelectDisplayIndex(i + 1);
            return true;
        }

        // Re-reads the skins folder so a skin dropped in (or downloaded by the
        // app) while the game is open shows up without a restart. Skins that
        // are still there keep their decoded textures, and the selected skin
        // stays selected even if its position in the list moved.
        public void Rescan()
        {
            var current = _currentIndex >= 0 && _currentIndex < _skins.Count ? _skins[_currentIndex].folderName : null;
            LoadSkinsFromDisk();
            _currentIndex = current == null ? -1 : _skins.FindIndex(s => s.folderName == current);
        }

        private void LoadSkinsFromDisk()
        {
            var previous = _skins.ToDictionary(s => s.folderName);
            _skins.Clear();
            _displayNames.Clear();
            List<SkinFolder> folders;
            try
            {
                folders = SkinFiles.List(_skinsDir,
                    skipped => _host.LogWarning($"[CustomSkins] '{skipped}' has no image file (png/jpg/jpeg) in it - skipping"));
            }
            catch (System.Exception e)
            {
                _host.LogError("[CustomSkins] couldn't read skins folder: " + e);
                return;
            }

            foreach (var skin in folders)
            {
                _displayNames[skin.FolderName] = skin.DisplayName;
                if (previous.TryGetValue(skin.FolderName, out var existing))
                {
                    _skins.Add(existing);
                    continue;
                }
                try
                {
                    var bytes = File.ReadAllBytes(skin.ImagePath);
                    _skins.Add((skin.FolderName, bytes, null));
                }
                catch (System.Exception e)
                {
                    _host.LogError($"[CustomSkins] couldn't load '{skin.ImagePath}': {e}");
                }
            }
        }

        private string DisplayName(string folderName) =>
            _displayNames.TryGetValue(folderName, out var name) ? name : folderName;

        private string SoundsDir(int index) => Path.Combine(_skinsDir, _skins[index].folderName, "sounds");

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

            if (_layoutState == LayoutState.Ready && GridSheet.LooksLikeGrid(tex, _canonicalLayout.Value.Cols, _canonicalLayout.Value.Rows, out int cellW, out int cellH))
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

        // A skin's average opaque, non-guide-line color - used as a stand-in
        // tint for clips that have no custom row (e.g. Die, which has no
        // source art to build a row from at all). Not exact for a
        // multi-hue skin, but far closer than showing fully vanilla colors.
        private static Color ComputeTintColor(Texture2D tex)
        {
            return SkinGrid.TryAverageColor(GridSheet.ToBytes(tex.GetPixels32()), out float r, out float g, out float b)
                ? new Color(r, g, b, 1f)
                : Color.white;
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
            row = SkinGrid.ClampRow(row, runtime.Layout.RowClips.Count);
            int frameCount = Mathf.Max(1, runtime.Layout.RowClips[row].frameCount);
            frame = SkinGrid.ClampFrame(frame, frameCount);

            var key = (row, frame);
            if (runtime.Cache.TryGetValue(key, out var cached)) return cached;

            var layout = runtime.Layout;
            Sprite vanillaSprite = row < layout.RowFrameSprites.Count && frame < layout.RowFrameSprites[row].Count
                ? layout.RowFrameSprites[row][frame] : null;
            if (vanillaSprite == null) return null;

            // A cell holds the FULL, untrimmed sprite bounds (same coordinate
            // space as vanilla's own sprite.rect - a raw 256x256 source frame
            // dropped into a cell unmodified already has its content at the
            // right place). The whole cell becomes the sprite, with vanilla's
            // pivot scaled into it, so alignment matches vanilla exactly and
            // art outside vanilla's trimmed bounds (hats, capes, ...) is kept
            // rather than cropped to the original player's silhouette.
            SkinGrid.CellOrigin(row, frame, layout.Rows, runtime.CellW, runtime.CellH, out int cellOriginX, out int cellOriginY);

            // Copied into its own texture so bilinear filtering at the cell
            // edges can't bleed in the magenta guide lines around it.
            var canvas = new Texture2D(runtime.CellW, runtime.CellH, TextureFormat.RGBA32, false);
            canvas.SetPixels(runtime.Texture.GetPixels(cellOriginX, cellOriginY, runtime.CellW, runtime.CellH));
            canvas.Apply();

            float scale = SkinGrid.CellScale(runtime.CellW);
            var sprite = Sprite.Create(canvas, new Rect(0, 0, runtime.CellW, runtime.CellH),
                new Vector2(vanillaSprite.pivot.x * scale / runtime.CellW, vanillaSprite.pivot.y * scale / runtime.CellH),
                vanillaSprite.pixelsPerUnit * scale, 0, SpriteMeshType.FullRect);
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
            int frame = animator != null ? SkinGrid.FrameAt(stateInfo.normalizedTime, frameCount) : 0;

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
                IndicatorSkinApplier.Apply(_host, Path.Combine(_skinsDir, _skins[_currentIndex].folderName));

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
                IndicatorSkinApplier.RestoreVanilla();

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
