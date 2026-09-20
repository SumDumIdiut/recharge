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
        public string ExportDir { get; set; }
    }

    internal class SkinRuntime
    {
        public bool IsSheet;
        public Texture2D Texture;
        public Sprite FlatSprite;
        public SkinGridLayout Layout;
        public Dictionary<string, int> RowByClip;
        public readonly Dictionary<(int row, int frame), Sprite> Cache = new Dictionary<(int, int), Sprite>();
        public int FileCellW, FileCellH;
        public int FileYOffset;
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
        private string _exportDir;

        private SkinGridLayout? _canonicalLayout;
        private Dictionary<Sprite, List<(int row, int frame, bool flipY)>> _vanillaSpriteEntries;

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
            _exportDir = string.IsNullOrEmpty(save.ExportDir) ? DefaultExportDir : save.ExportDir;
            StartCoroutine(HeartbeatLog());
        }

        private System.Collections.IEnumerator HeartbeatLog()
        {
            var wait = new WaitForSeconds(10f);
            while (true)
            {
                yield return wait;
                try
                {
                    LogHeartbeat();
                }
                catch (System.Exception e)
                {
                    _host.LogWarning("[CustomSkins] heartbeat log failed: " + e);
                }
            }
        }

        private void LogHeartbeat()
        {
            bool hasPlayer = EnsurePlayer();
            var skinName = _currentIndex >= 0 && _currentIndex < _skins.Count ? _skins[_currentIndex].folderName : "Vanilla";
            var animator = hasPlayer ? _spriteRenderer.GetComponent<Animator>() : null;
            string clipInfo = "n/a";
            if (animator != null)
            {
                var infos = animator.GetCurrentAnimatorClipInfo(0);
                clipInfo = string.Join(",", infos.Select(c => c.clip.name + ":" + c.weight.ToString("F2")));
            }
            string sheetInfo = "n/a";
            if (_currentIndex >= 0 && _currentIndex < _skins.Count && _skins[_currentIndex].runtime != null)
            {
                var rt = _skins[_currentIndex].runtime;
                sheetInfo = rt.IsSheet ? ("sheet rows=" + rt.Layout.Rows + " cols=" + rt.Layout.Cols) : "flat";
            }
            var cloneScripts = UnityEngine.Object.FindObjectsByType<clonesScript>(FindObjectsInactive.Include, FindObjectsSortMode.None);
            _host.Log("[CustomSkins] === heartbeat: skin=" + skinName + " (" + sheetInfo + ") hasPlayer=" + hasPlayer +
                " rendererEnabled=" + (hasPlayer ? _spriteRenderer.enabled.ToString() : "n/a") +
                " material=" + (hasPlayer && _spriteRenderer.sharedMaterial != null ? _spriteRenderer.sharedMaterial.name : "null") +
                " clips=[" + clipInfo + "] clonesScriptCount=" + cloneScripts.Length + " ===");
        }

        public string DefaultExportDir => Path.Combine(_host.ModDataDir(RechargeCustomSkinsMod.ModId), "template");

        public string ExportDir
        {
            get => _exportDir;
            set
            {
                _exportDir = string.IsNullOrEmpty(value) ? DefaultExportDir : value;
                SaveState();
            }
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
                ExportDir = _exportDir == DefaultExportDir ? null : _exportDir,
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

        private SkinRuntime EnsureRuntime(int index)
        {
            var (folderName, bytes, runtime) = _skins[index];
            if (runtime != null) return runtime;

            runtime = new SkinRuntime();
            var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            if (!ImageConversion.LoadImage(tex, bytes))
            {
                _host.LogError("[CustomSkins] couldn't decode '" + folderName + "'");
                _skins[index] = (folderName, bytes, runtime);
                return runtime;
            }
            runtime.Texture = tex;

            if (EnsurePlayer())
            {
                var layout = GetCanonicalLayout();
                if (layout.HasValue)
                {
                    _host.Log("[CustomSkins] '" + folderName + "' live grid layout: " + layout.Value.TexW + "x" + layout.Value.TexH +
                        " (file is " + tex.width + "x" + tex.height + "), rows=[" +
                        string.Join(", ", layout.Value.RowClips.Select((c, i) => i + ":" + c.name + "x" + c.frameCount)) + "]");
                }
                if (layout.HasValue && LooksLikeGrid(tex, layout.Value, out var fileCellW, out var fileCellH))
                {
                    runtime.FileCellW = fileCellW;
                    runtime.FileCellH = fileCellH;
                    int formulaH = layout.Value.Gutter + layout.Value.Rows * (fileCellH + layout.Value.Gutter);
                    runtime.FileYOffset = Mathf.Max(0, tex.height - formulaH);
                    if (tex.width != layout.Value.TexW || tex.height != layout.Value.TexH)
                    {
                        _host.Log("[CustomSkins] '" + folderName + "' is " + tex.width + "x" + tex.height +
                            " (cell " + fileCellW + "x" + fileCellH + "), live grid is " + layout.Value.TexW + "x" + layout.Value.TexH +
                            " (cell " + layout.Value.CellW + "x" + layout.Value.CellH + ") - masking per-cell onto the live sprite");
                    }
                    runtime.IsSheet = true;
                    runtime.Layout = layout.Value;
                    runtime.RowByClip = new Dictionary<string, int>();
                    for (int r = 0; r < layout.Value.RowClips.Count; r++) runtime.RowByClip[layout.Value.RowClips[r].name] = r;
                }
                else if (layout.HasValue)
                {
                    _host.LogWarning("[CustomSkins] '" + folderName + "' did not match the live grid (not a recognizable exported sheet) - using flat image");
                }
            }

            if (!runtime.IsSheet)
            {
                runtime.FlatSprite = Sprite.Create(tex, new Rect(0, 0, tex.width, tex.height), new Vector2(0.5f, 0.5f), _originalPixelsPerUnit);
            }

            _skins[index] = (folderName, bytes, runtime);
            return runtime;
        }

        private static readonly Color32 GridLineColor = new Color32(255, 0, 220, 255);

        private static bool LooksLikeGrid(Texture2D tex, SkinGridLayout layout, out int fileCellW, out int fileCellH)
        {
            int gutter = layout.Gutter;
            fileCellW = layout.Cols > 0 ? (tex.width - gutter) / layout.Cols - gutter : layout.CellW;
            fileCellH = layout.Rows > 0 ? (tex.height - gutter) / layout.Rows - gutter : layout.CellH;
            if (fileCellW <= 0 || fileCellH <= 0) return false;

            var pixels = tex.GetPixels32();
            int w = tex.width;
            if (!ColorEquals(pixels[0], GridLineColor)) return false;
            if (!ColorEquals(pixels[(tex.height - 1) * w], GridLineColor)) return false;
            if (layout.Cols > 1)
            {
                int xDivider = gutter + fileCellW;
                if (xDivider >= w || !ColorEquals(pixels[xDivider], GridLineColor)) return false;
            }
            return true;
        }

        private static bool ColorEquals(Color32 a, Color32 b) => a.r == b.r && a.g == b.g && a.b == b.b && a.a == b.a;

        private SkinGridLayout? GetCanonicalLayout()
        {
            if (_canonicalLayout.HasValue) return _canonicalLayout;
            if (!EnsurePlayer()) return null;

            var layout = TemplateExporter.ComputeGridLayout(_spriteRenderer.gameObject, _host);
            if (!layout.HasValue) return null;
            _canonicalLayout = layout;

            _vanillaSpriteEntries = new Dictionary<Sprite, List<(int, int, bool)>>();
            for (int r = 0; r < layout.Value.RowFrameSprites.Count; r++)
            {
                var frames = layout.Value.RowFrameSprites[r];
                var flips = layout.Value.RowFrameFlipY[r];
                for (int f = 0; f < frames.Count; f++)
                {
                    if (frames[f] == null) continue;
                    if (!_vanillaSpriteEntries.TryGetValue(frames[f], out var list))
                    {
                        list = new List<(int, int, bool)>();
                        _vanillaSpriteEntries[frames[f]] = list;
                    }
                    list.Add((r, f, flips[f]));
                }
            }
            _host.Log("[CustomSkins] built vanilla sprite->(row,frame) map: " + _vanillaSpriteEntries.Count + " distinct sprite(s) across " + layout.Value.RowClips.Count + " clips");
            for (int r = 0; r < layout.Value.RowFrameFlipY.Count; r++)
            {
                for (int f = 0; f < layout.Value.RowFrameFlipY[r].Count; f++)
                {
                    if (layout.Value.RowFrameFlipY[r][f])
                        _host.Log("[CustomSkins] flip cell: row=" + r + " (" + layout.Value.RowClips[r].name + ") frame=" + f);
                }
            }
            return _canonicalLayout;
        }

        public bool TryGetVanillaRowFrame(Sprite vanillaSprite, bool currentFlipY, out (int row, int frame, bool flipY) match)
        {
            GetCanonicalLayout();
            match = default;
            if (vanillaSprite == null || _vanillaSpriteEntries == null) return false;
            if (!_vanillaSpriteEntries.TryGetValue(vanillaSprite, out var list) || list.Count == 0) return false;

            foreach (var entry in list)
            {
                if (entry.Item3 == currentFlipY) { match = entry; return true; }
            }
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
            bool flip = row < layout.RowFrameFlipY.Count && frame < layout.RowFrameFlipY[row].Count && layout.RowFrameFlipY[row][frame];

            int canvasW = Mathf.Max(1, Mathf.RoundToInt(vanillaSprite.textureRect.width));
            int canvasH = Mathf.Max(1, Mathf.RoundToInt(vanillaSprite.textureRect.height));

            int rowFromBottom = layout.Rows - 1 - row;
            int cellOriginX = layout.Gutter + frame * (runtime.FileCellW + layout.Gutter);
            int cellOriginY = runtime.FileYOffset + layout.Gutter + rowFromBottom * (runtime.FileCellH + layout.Gutter);
            var customColors = runtime.Texture.GetPixels(cellOriginX, cellOriginY, runtime.FileCellW, runtime.FileCellH);

            // The exported cell is padded to a shared, worst-case size across
            // every frame in the sheet - this frame's actual art only fills
            // part of it, so find that tight sub-rectangle before mapping it
            // onto the (much smaller) live mask.
            int tightX0 = runtime.FileCellW, tightY0 = runtime.FileCellH, tightX1 = -1, tightY1 = -1;
            for (int y = 0; y < runtime.FileCellH; y++)
            {
                int rowBase = y * runtime.FileCellW;
                for (int x = 0; x < runtime.FileCellW; x++)
                {
                    if (customColors[rowBase + x].a == 0) continue;
                    if (x < tightX0) tightX0 = x;
                    if (x > tightX1) tightX1 = x;
                    if (y < tightY0) tightY0 = y;
                    if (y > tightY1) tightY1 = y;
                }
            }

            var outPixels = new Color32[canvasW * canvasH];
            if (tightX1 >= tightX0 && tightY1 >= tightY0)
            {
                int tightW = tightX1 - tightX0 + 1;
                int tightH = tightY1 - tightY0 + 1;
                for (int y = 0; y < canvasH; y++)
                {
                    int sampleY = flip ? (canvasH - 1 - y) : y;
                    int srcY = tightY0 + (canvasH <= 1 ? 0 : Mathf.Clamp(sampleY * tightH / canvasH, 0, tightH - 1));
                    for (int x = 0; x < canvasW; x++)
                    {
                        int srcX = tightX0 + (canvasW <= 1 ? 0 : Mathf.Clamp(x * tightW / canvasW, 0, tightW - 1));
                        var c = customColors[srcY * runtime.FileCellW + srcX];
                        if (c.a > 0) outPixels[y * canvasW + x] = c;
                    }
                }
            }
            var canvas = new Texture2D(canvasW, canvasH, TextureFormat.RGBA32, false);
            canvas.SetPixels32(outPixels);
            canvas.Apply();

            float rawPivotX = vanillaSprite.pivot.x - vanillaSprite.textureRectOffset.x;
            float rawPivotY = vanillaSprite.pivot.y - vanillaSprite.textureRectOffset.y;
            float pivotX = rawPivotX;
            float pivotY = flip ? (canvasH - rawPivotY) : rawPivotY;
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
            int row = 0;
            _clipInfoBuffer.Clear();
            if (animator != null) animator.GetCurrentAnimatorClipInfo(0, _clipInfoBuffer);

            AnimatorClipInfo? dominant = null;
            foreach (var ci in _clipInfoBuffer)
            {
                if (dominant == null || ci.weight > dominant.Value.weight) dominant = ci;
            }
            if (dominant.HasValue && runtime.RowByClip.TryGetValue(dominant.Value.clip.name, out var matchedRow))
            {
                row = matchedRow;
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

            if (row < runtime.Layout.RowFrameFlipY.Count && frame < runtime.Layout.RowFrameFlipY[row].Count && runtime.Layout.RowFrameFlipY[row][frame])
            {
                _spriteRenderer.flipY = false;
            }

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
                var sprite = runtime.IsSheet ? PickSheetSprite(runtime) : runtime.FlatSprite;
                if (sprite != null)
                {
                    _spriteRenderer.sprite = sprite;
                    var fallback = GetFallbackMaterial();
                    if (_spriteRenderer.sharedMaterial != fallback) _spriteRenderer.material = fallback;
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

        public bool ExportTemplate(out string message)
        {
            if (!EnsurePlayer())
            {
                message = "Get into a course first, then export.";
                return false;
            }
            var result = TemplateExporter.Export(_spriteRenderer.gameObject, _exportDir, _skinsDir, _host);
            message = result != null ? $"Exported to {_exportDir}" : "Export failed - see Player.log";
            return result != null;
        }

        public string StatusText()
        {
            if (_skins.Count == 0) return "Skin: none found";
            var current = _currentIndex >= 0 && _currentIndex < _skins.Count
                ? _skins[_currentIndex].folderName
                : "Vanilla";
            return $"Skin: {current}";
        }
    }
}
