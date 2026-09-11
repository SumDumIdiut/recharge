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
    }

    internal class SkinController : MonoBehaviour
    {
        private IRechargeHost _host;
        private string _skinsDir;
        private readonly List<(string fileName, byte[] bytes, SkinRuntime runtime)> _skins = new List<(string, byte[], SkinRuntime)>();
        private int _currentIndex = -1;

        private Movement _movement;
        private SpriteRenderer _spriteRenderer;
        private Material _originalMaterial;
        private static Material _fallbackMaterial;

        private float _originalPixelsPerUnit = 100f;
        private string _exportDir;

        public void Init(IRechargeHost host)
        {
            _host = host;
            _skinsDir = Path.Combine(host.ModDataDir(RechargeCustomSkinsMod.ModId), "skins");
            Directory.CreateDirectory(_skinsDir);
            LoadSkinsFromDisk();

            var save = host.LoadConfig<SkinSave>(RechargeCustomSkinsMod.ModId);
            _currentIndex = save.CurrentSkinFile == null
                ? -1
                : _skins.FindIndex(s => s.fileName == save.CurrentSkinFile);
            _exportDir = string.IsNullOrEmpty(save.ExportDir) ? DefaultExportDir : save.ExportDir;
            StartCoroutine(HeartbeatLog());
        }

        // Periodic full-state dump, same rationale as RechargeMaps' own
        // heartbeat: a continuous timeline in Player.log catches silent
        // state drift (player lost, animator missing, wrong material) that
        // one-off event logging would never surface.
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
            var skinName = _currentIndex >= 0 && _currentIndex < _skins.Count ? _skins[_currentIndex].fileName : "Vanilla";
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
                names.AddRange(_skins.Select(s => Path.GetFileNameWithoutExtension(s.fileName)));
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
                CurrentSkinFile = _currentIndex >= 0 ? _skins[_currentIndex].fileName : null,
                ExportDir = _exportDir == DefaultExportDir ? null : _exportDir,
            });
        }

        private void LoadSkinsFromDisk()
        {
            _skins.Clear();
            IEnumerable<string> files;
            try
            {
                files = Directory.EnumerateFiles(_skinsDir)
                    .Where(f => f.EndsWith(".png", System.StringComparison.OrdinalIgnoreCase)
                             || f.EndsWith(".jpg", System.StringComparison.OrdinalIgnoreCase)
                             || f.EndsWith(".jpeg", System.StringComparison.OrdinalIgnoreCase))
                    .OrderBy(f => f, System.StringComparer.OrdinalIgnoreCase);
            }
            catch (System.Exception e)
            {
                _host.LogError("[CustomSkins] couldn't read skins folder: " + e);
                return;
            }

            foreach (var path in files)
            {
                try
                {
                    var bytes = File.ReadAllBytes(path);
                    _skins.Add((Path.GetFileName(path), bytes, null));
                }
                catch (System.Exception e)
                {
                    _host.LogError($"[CustomSkins] couldn't load '{path}': {e}");
                }
            }
        }

        // A skin file can be either a plain flat image (legacy/simple recolor)
        // or a full multi-clip animation sheet exported by ExportTemplate and
        // edited cell-by-cell. Detected by recomputing the exact grid the real
        // game's own clips/frame-counts would produce and checking the file
        // matches it (size + a couple of the magenta gutter pixels) - if it
        // does, cells are sliced from those same live-computed coordinates
        // instead of guessing at the image's layout.
        private SkinRuntime EnsureRuntime(int index)
        {
            var (fileName, bytes, runtime) = _skins[index];
            if (runtime != null) return runtime;

            runtime = new SkinRuntime();
            var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            if (!ImageConversion.LoadImage(tex, bytes))
            {
                _host.LogError("[CustomSkins] couldn't decode '" + fileName + "'");
                _skins[index] = (fileName, bytes, runtime);
                return runtime;
            }
            runtime.Texture = tex;

            if (EnsurePlayer())
            {
                var layout = TemplateExporter.ComputeGridLayout(_spriteRenderer.gameObject, _host);
                if (layout.HasValue)
                {
                    _host.Log("[CustomSkins] '" + fileName + "' live grid layout: " + layout.Value.TexW + "x" + layout.Value.TexH +
                        " (file is " + tex.width + "x" + tex.height + "), rows=[" +
                        string.Join(", ", layout.Value.RowClips.Select((c, i) => i + ":" + c.name + "x" + c.frameCount)) + "]");
                }
                if (layout.HasValue && tex.width == layout.Value.TexW && tex.height == layout.Value.TexH && LooksLikeGrid(tex, layout.Value))
                {
                    runtime.IsSheet = true;
                    runtime.Layout = layout.Value;
                    runtime.RowByClip = new Dictionary<string, int>();
                    for (int r = 0; r < layout.Value.RowClips.Count; r++) runtime.RowByClip[layout.Value.RowClips[r].name] = r;
                }
                else if (layout.HasValue)
                {
                    _host.LogWarning("[CustomSkins] '" + fileName + "' did not match the live grid (size or gutter mismatch) - using flat image");
                }
            }

            if (!runtime.IsSheet)
            {
                runtime.FlatSprite = Sprite.Create(tex, new Rect(0, 0, tex.width, tex.height), new Vector2(0.5f, 0.5f), _originalPixelsPerUnit);
            }

            _skins[index] = (fileName, bytes, runtime);
            return runtime;
        }

        private static readonly Color32 GridLineColor = new Color32(255, 0, 220, 255);

        private static bool LooksLikeGrid(Texture2D tex, SkinGridLayout layout)
        {
            var pixels = tex.GetPixels32();
            int w = tex.width;
            if (!ColorEquals(pixels[0], GridLineColor)) return false;
            if (!ColorEquals(pixels[(tex.height - 1) * w], GridLineColor)) return false;
            if (layout.Cols > 1)
            {
                int xDivider = layout.Gutter + layout.CellW;
                if (!ColorEquals(pixels[xDivider], GridLineColor)) return false;
            }
            return true;
        }

        private static bool ColorEquals(Color32 a, Color32 b) => a.r == b.r && a.g == b.g && a.b == b.b && a.a == b.a;

        private int _loggedRow = -1;
        private Animator _animator;
        private readonly List<AnimatorClipInfo> _clipInfoBuffer = new List<AnimatorClipInfo>();

        private Sprite PickSheetSprite(SkinRuntime runtime)
        {
            // GetCurrentAnimatorClipInfo(layer) allocates a new array every
            // call - this runs every LateUpdate while a sheet skin is active,
            // so reuse a buffer via the List overload instead (a real,
            // reproducible per-frame GC cost otherwise, confirmed as a lag
            // spike source alongside the heartbeat's own tile enumeration).
            if (_animator == null) _animator = _spriteRenderer.GetComponent<Animator>();
            var animator = _animator;
            int row = 0;
            _clipInfoBuffer.Clear();
            if (animator != null) animator.GetCurrentAnimatorClipInfo(0, _clipInfoBuffer);

            // Idle (and similar) can be a blend tree reporting several
            // simultaneously-weighted sub-clips - clipInfos[0] isn't
            // guaranteed to be the dominant one, so pick by weight instead.
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

            var key = (row, frame);
            if (runtime.Cache.TryGetValue(key, out var cached)) return cached;

            var layout = runtime.Layout;
            int rowFromBottom = layout.Rows - 1 - row;
            int cellOriginX = layout.Gutter + frame * (layout.CellW + layout.Gutter);
            int cellOriginY = layout.Gutter + rowFromBottom * (layout.CellH + layout.Gutter);
            var rect = new Rect(cellOriginX, cellOriginY, layout.CellW, layout.CellH);
            var sprite = Sprite.Create(runtime.Texture, rect, new Vector2(0.5f, 0.5f), _originalPixelsPerUnit);
            runtime.Cache[key] = sprite;
            return sprite;
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
            bool skinActive = _currentIndex >= 0 && _currentIndex < _skins.Count;
            if (skinActive)
            {
                var runtime = EnsureRuntime(_currentIndex);
                var sprite = runtime.IsSheet ? PickSheetSprite(runtime) : runtime.FlatSprite;
                if (sprite != null)
                {
                    _spriteRenderer.sprite = sprite;
                    _spriteRenderer.material = GetFallbackMaterial();
                    CloneSkinApplier.Apply(sprite);
                }
            }
            else
            {
                if (_spriteRenderer.sharedMaterial != _originalMaterial) _spriteRenderer.material = _originalMaterial;
                CloneSkinApplier.RestoreVanilla();
            }
        }

        public bool ExportTemplate(out string message)
        {
            if (!EnsurePlayer())
            {
                message = "Get into a course first, then export.";
                return false;
            }
            var result = TemplateExporter.Export(_spriteRenderer.gameObject, _exportDir, _host);
            message = result != null ? $"Exported to {_exportDir}" : "Export failed - see Player.log";
            return result != null;
        }

        public string StatusText()
        {
            if (_skins.Count == 0) return "Skin: none found";
            var current = _currentIndex >= 0 && _currentIndex < _skins.Count
                ? Path.GetFileNameWithoutExtension(_skins[_currentIndex].fileName)
                : "Vanilla";
            return $"Skin: {current}";
        }
    }
}
