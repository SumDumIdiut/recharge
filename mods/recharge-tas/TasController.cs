using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using Recharge.ModApi;
using UnityEngine;
using UnityEngine.InputSystem;

// DefaultExecutionOrder pushes this after every other script's FixedUpdate
// (Movement's included), so during replay Apply() always has the last word
// for the frame.
[DefaultExecutionOrder(10000)]
internal class TasController : MonoBehaviour
{
    public IRechargeHost Host;

    private const string ModId = "recharge.tas";
    private const int MaxBufferFrames = 36000;
    private const int MaxHistoryFrames = 3600;
    private const string ExportHeader = "RECHARGE_TAS_V1";
    private static readonly float[] SpeedPresets = { 0.1f, 0.25f, 0.5f, 1f, 2f, 4f };

    private struct Frame
    {
        public Vector3 Position;
        public float RotationZ;
        public Vector2 Velocity;
        public float AngularVelocity;
        public int AirJumpsLeft;
        public int AirDashesLeft;
        public int WallJumpsLeft;
        public bool DashActive;
        public bool FacingRight;
    }

    private GameObject _player;
    private Transform _playerT;
    private Rigidbody2D _body;
    private Movement _movement;
    private Collider2D _collider;

    private bool _menuOpen;
    private Rect _windowRect = new Rect(20, 20, 320, 640);
    private Vector2 _scrollPos;

    private bool _paused;
    private float _speed = 1f;
    private bool _advancing;
    private long _frameCount;

    private bool _recording;
    private bool _replaying;
    private bool _loopReplay;
    private int _replayIndex;
    private readonly List<Frame> _buffer = new List<Frame>();
    private Frame? _quicksave;
    private int _recordingSegmentStart; // buffer index of the last checkpoint - a retry rolls back to here

    private readonly Frame[] _history = new Frame[MaxHistoryFrames];
    private int _historyHead;
    private int _historyCount;
    private int _rewindOffset;

    private readonly List<Frame> _checkpoints = new List<Frame>();
    private Movement.cutsceneModes _lastCutsceneMode = Movement.cutsceneModes.none;

    private bool _showHitbox;
    private bool _showHitboxTrail;
    private Texture2D _solidTex;
    private GUIStyle _hudStyle;
    private GUIStyle _sectionStyle;
    private GUIStyle _dimStyle;
    private string _statusMessage = "";

    private string _saveFileName = "recording";
    private readonly List<string> _savedFiles = new List<string>();

    private CursorLockMode _prevLockState;
    private bool _prevCursorVisible;

    private void Start()
    {
        RefreshSavedFiles();
    }

    public void BindPlayer(GameObject player)
    {
        if (player == null) return;
        _player = player;
        _playerT = player.transform;
        _body = player.GetComponent<Rigidbody2D>();
        _movement = player.GetComponent<Movement>();
        _collider = player.GetComponent<Collider2D>();
        _replaying = false;
        _recording = false;
        _historyHead = 0;
        _historyCount = 0;
        _rewindOffset = 0;
        _checkpoints.Clear();
        _lastCutsceneMode = Movement.cutsceneModes.none;
    }

    private bool PlayerReady => _playerT != null && _body != null && _movement != null;

    private void Update()
    {
        CheckForDeath();

        var kb = Keyboard.current;
        if (kb == null) return;
        if (kb.tabKey.wasPressedThisFrame) ToggleMenu();
        if (kb.f5Key.wasPressedThisFrame) QuickSave();
        if (kb.f9Key.wasPressedThisFrame) QuickLoad();
        if (kb.commaKey.wasPressedThisFrame) StepBack();
        if (kb.periodKey.wasPressedThisFrame) StepForward();
        if (kb.zKey.wasPressedThisFrame) PlaceCheckpoint();
        if (kb.xKey.wasPressedThisFrame) DeleteLastCheckpoint();
        if (kb.rKey.wasPressedThisFrame) GoToLatestCheckpoint();
    }

    private void PlaceCheckpoint()
    {
        if (!PlayerReady) return;
        _checkpoints.Add(Capture());
        if (_recording) _recordingSegmentStart = _buffer.Count;
        _statusMessage = "Checkpoint placed (" + _checkpoints.Count + " total)";
        Host.Log("TAS: checkpoint placed at " + _playerT.position + " (" + _checkpoints.Count + " total)");
    }

    private void DeleteLastCheckpoint()
    {
        if (_checkpoints.Count == 0) return;
        _checkpoints.RemoveAt(_checkpoints.Count - 1);
        _statusMessage = "Checkpoint removed (" + _checkpoints.Count + " left)";
        Host.Log("TAS: checkpoint removed (" + _checkpoints.Count + " left)");
    }

    private void GoToLatestCheckpoint()
    {
        if (!PlayerReady || _checkpoints.Count == 0) return;
        Apply(_checkpoints[_checkpoints.Count - 1]);
        TrimFailedRecordingSegment();
    }

    private void TrimFailedRecordingSegment()
    {
        if (!_recording) return;
        if (_buffer.Count > _recordingSegmentStart) _buffer.RemoveRange(_recordingSegmentStart, _buffer.Count - _recordingSegmentStart);
    }

    // Polls Movement's own public cutsceneMode for the death transition and
    // cancels its pending Invoke("deathRespawn", 0.6f) so it doesn't fight
    // this teleport over where the player ends up.
    private void CheckForDeath()
    {
        if (!PlayerReady) return;
        var mode = _movement.cutsceneMode;
        if (mode == Movement.cutsceneModes.deathFreeze && _lastCutsceneMode != Movement.cutsceneModes.deathFreeze && _checkpoints.Count > 0)
        {
            _movement.CancelInvoke("deathRespawn");
            _movement.cutsceneMode = Movement.cutsceneModes.none;
            Apply(_checkpoints[_checkpoints.Count - 1]);
            TrimFailedRecordingSegment();
            Host.Log("TAS: death -> latest checkpoint");
        }
        _lastCutsceneMode = mode;
    }

    // Gameplay locks/hides the cursor, which defeats clicks on an OnGUI
    // panel - force it visible while open and restore whatever it was after.
    private void ToggleMenu()
    {
        _menuOpen = !_menuOpen;
        if (_menuOpen)
        {
            _prevLockState = Cursor.lockState;
            _prevCursorVisible = Cursor.visible;
            Cursor.lockState = CursorLockMode.None;
            Cursor.visible = true;
        }
        else
        {
            Cursor.lockState = _prevLockState;
            Cursor.visible = _prevCursorVisible;
        }
    }

    private void FixedUpdate()
    {
        _frameCount++;
        if (!PlayerReady) return;

        if (_recording)
        {
            if (_buffer.Count < MaxBufferFrames) _buffer.Add(Capture());
            else _recording = false;
        }

        if (_replaying)
        {
            if (_replayIndex < _buffer.Count)
            {
                Apply(_buffer[_replayIndex]);
                _replayIndex++;
            }
            else if (_loopReplay && _buffer.Count > 0)
            {
                _replayIndex = 0;
            }
            else
            {
                _replaying = false;
            }
        }

        _history[_historyHead] = Capture();
        _historyHead = (_historyHead + 1) % MaxHistoryFrames;
        if (_historyCount < MaxHistoryFrames) _historyCount++;
        _rewindOffset = 0;
    }

    private Frame Capture()
    {
        return new Frame
        {
            Position = _playerT.position,
            RotationZ = _playerT.eulerAngles.z,
            Velocity = _body.linearVelocity,
            AngularVelocity = _body.angularVelocity,
            AirJumpsLeft = _movement.airJumpsLeft,
            AirDashesLeft = _movement.airDashesLeft,
            WallJumpsLeft = _movement.wallJumpsLeft,
            DashActive = _movement.dashActive,
            FacingRight = _movement.facingRight,
        };
    }

    private void Apply(Frame f)
    {
        _playerT.position = f.Position;
        var euler = _playerT.eulerAngles;
        euler.z = f.RotationZ;
        _playerT.eulerAngles = euler;
        // Rigidbody2D caches its own position and can snap transform.position
        // back next physics step unless the body itself is told too.
        _body.position = f.Position;
        _body.linearVelocity = f.Velocity;
        _body.angularVelocity = f.AngularVelocity;
        // Facing is a sprite flip (localScale.x sign) here, not rotation.
        _movement.facingRight = f.FacingRight;
        var scale = _playerT.localScale;
        scale.x = Mathf.Abs(scale.x) * (f.FacingRight ? 1f : -1f);
        _playerT.localScale = scale;
        _movement.airJumpsLeft = f.AirJumpsLeft;
        _movement.airDashesLeft = f.AirDashesLeft;
        _movement.wallJumpsLeft = f.WallJumpsLeft;
        _movement.dashActive = f.DashActive;
    }

    private void TogglePause()
    {
        _paused = !_paused;
        Time.timeScale = _paused ? 0f : _speed;
    }

    private void SetSpeed(float speed)
    {
        _speed = speed;
        if (!_paused) Time.timeScale = _speed;
    }

    private void FrameAdvance()
    {
        if (_advancing) return;
        StartCoroutine(AdvanceFrameCoroutine());
    }

    // timeScale=0 stops FixedUpdate from being called at all, so briefly
    // un-pausing for exactly one WaitForFixedUpdate lets one physics tick
    // run before re-pausing.
    private IEnumerator AdvanceFrameCoroutine()
    {
        _advancing = true;
        Time.timeScale = 1f;
        yield return new WaitForFixedUpdate();
        Time.timeScale = _paused ? 0f : _speed;
        _advancing = false;
    }

    private void StepBack()
    {
        if (!_paused || _historyCount == 0) return;
        _rewindOffset = Mathf.Min(_rewindOffset + 1, _historyCount - 1);
        ApplyHistoryAtOffset(_rewindOffset);
    }

    private void StepForward()
    {
        if (!_paused || _rewindOffset == 0) return;
        _rewindOffset--;
        ApplyHistoryAtOffset(_rewindOffset);
    }

    private void ApplyHistoryAtOffset(int offset)
    {
        int idx = ((_historyHead - 1 - offset) % MaxHistoryFrames + MaxHistoryFrames) % MaxHistoryFrames;
        Apply(_history[idx]);
    }

    private void ResetToRespawn()
    {
        if (!PlayerReady) return;
        Vector3 pos = _movement.respawnPoint;
        _playerT.position = pos;
        _body.position = pos;
        _body.linearVelocity = Vector2.zero;
        _body.angularVelocity = 0f;
        Host.Log("TAS: reset to respawn point");
    }

    private void NewRecording()
    {
        _buffer.Clear();
        _replaying = false;
        _recording = false;
        _replayIndex = 0;
        _recordingSegmentStart = 0;
        _statusMessage = "";
    }

    private void ToggleRecording()
    {
        if (_recording) { _recording = false; return; }
        _buffer.Clear();
        _replaying = false;
        _recording = true;
        _recordingSegmentStart = 0;
    }

    private void ToggleReplay()
    {
        if (_replaying) { _replaying = false; return; }
        if (_buffer.Count == 0) return;
        _recording = false;
        _replayIndex = 0;
        _replaying = true;
    }

    private string SerializeBuffer()
    {
        var sb = new StringBuilder();
        sb.AppendLine(ExportHeader);
        foreach (var f in _buffer)
        {
            sb.Append(F(f.Position.x)).Append(',').Append(F(f.Position.y)).Append(',').Append(F(f.Position.z)).Append(',')
              .Append(F(f.RotationZ)).Append(',')
              .Append(F(f.Velocity.x)).Append(',').Append(F(f.Velocity.y)).Append(',')
              .Append(F(f.AngularVelocity)).Append(',')
              .Append(f.AirJumpsLeft).Append(',').Append(f.AirDashesLeft).Append(',').Append(f.WallJumpsLeft).Append(',')
              .Append(f.DashActive ? 1 : 0)
              .AppendLine();
        }
        return sb.ToString();
    }

    private static bool TryParseBuffer(string text, out List<Frame> frames, out string error)
    {
        frames = null;
        error = null;
        if (string.IsNullOrEmpty(text)) { error = "empty"; return false; }

        var lines = text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        if (lines.Length == 0 || lines[0].Trim() != ExportHeader) { error = "not a TAS recording (missing header)"; return false; }

        var loaded = new List<Frame>(lines.Length - 1);
        for (int i = 1; i < lines.Length; i++)
        {
            var parts = lines[i].Split(',');
            if (parts.Length != 11) { error = "malformed data on line " + (i + 1); return false; }
            try
            {
                loaded.Add(new Frame
                {
                    Position = new Vector3(P(parts[0]), P(parts[1]), P(parts[2])),
                    RotationZ = P(parts[3]),
                    Velocity = new Vector2(P(parts[4]), P(parts[5])),
                    AngularVelocity = P(parts[6]),
                    AirJumpsLeft = int.Parse(parts[7], CultureInfo.InvariantCulture),
                    AirDashesLeft = int.Parse(parts[8], CultureInfo.InvariantCulture),
                    WallJumpsLeft = int.Parse(parts[9], CultureInfo.InvariantCulture),
                    DashActive = parts[10] == "1",
                });
            }
            catch
            {
                error = "malformed data on line " + (i + 1);
                return false;
            }
        }

        frames = loaded;
        return true;
    }

    private void AdoptBuffer(List<Frame> frames)
    {
        _buffer.Clear();
        _buffer.AddRange(frames);
        _replaying = false;
        _recording = false;
        _replayIndex = 0;
    }

    private static string F(float v) => v.ToString(CultureInfo.InvariantCulture);
    private static float P(string s) => float.Parse(s, CultureInfo.InvariantCulture);

    private void CopyBufferToClipboard()
    {
        GUIUtility.systemCopyBuffer = SerializeBuffer();
        _statusMessage = "Copied " + _buffer.Count + " frames to clipboard";
        Host.Log("TAS: copied " + _buffer.Count + " frames to clipboard");
    }

    private void PasteBufferFromClipboard()
    {
        if (TryParseBuffer(GUIUtility.systemCopyBuffer, out var loaded, out var error))
        {
            AdoptBuffer(loaded);
            _statusMessage = "Loaded " + loaded.Count + " frames from clipboard";
            Host.Log("TAS: loaded " + loaded.Count + " frames from clipboard");
        }
        else
        {
            _statusMessage = "Paste failed: " + error;
        }
    }

    private string RecordingsDir()
    {
        var dir = Path.Combine(Host.ModDataDir(ModId), "recordings");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string SanitizeFileName(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        var invalid = Path.GetInvalidFileNameChars();
        var sb = new StringBuilder();
        foreach (var c in name.Trim())
        {
            if (Array.IndexOf(invalid, c) < 0) sb.Append(c);
        }
        return sb.Length > 0 ? sb.ToString() : null;
    }

    private void RefreshSavedFiles()
    {
        _savedFiles.Clear();
        foreach (var path in Directory.GetFiles(RecordingsDir(), "*.tas"))
        {
            _savedFiles.Add(Path.GetFileNameWithoutExtension(path));
        }
        _savedFiles.Sort(StringComparer.OrdinalIgnoreCase);
    }

    private void SaveToFile(string name)
    {
        if (_buffer.Count == 0) { _statusMessage = "Nothing to save - buffer is empty"; return; }
        var safeName = SanitizeFileName(name);
        if (safeName == null) { _statusMessage = "Enter a name first"; return; }

        File.WriteAllText(Path.Combine(RecordingsDir(), safeName + ".tas"), SerializeBuffer());
        _statusMessage = "Saved " + _buffer.Count + " frames as \"" + safeName + "\"";
        Host.Log("TAS: saved " + _buffer.Count + " frames as \"" + safeName + "\"");
        RefreshSavedFiles();
    }

    private void LoadFromFile(string name)
    {
        var safeName = SanitizeFileName(name);
        if (safeName == null) { _statusMessage = "Enter a name first"; return; }
        var path = Path.Combine(RecordingsDir(), safeName + ".tas");
        if (!File.Exists(path)) { _statusMessage = "No recording named \"" + safeName + "\""; return; }

        if (TryParseBuffer(File.ReadAllText(path), out var loaded, out var error))
        {
            AdoptBuffer(loaded);
            _statusMessage = "Loaded " + loaded.Count + " frames from \"" + safeName + "\"";
            Host.Log("TAS: loaded " + loaded.Count + " frames from \"" + safeName + "\"");
        }
        else
        {
            _statusMessage = "Load failed: " + error;
        }
    }

    private void QuickSave()
    {
        if (!PlayerReady) return;
        _quicksave = Capture();
        Host.Log("TAS: quicksaved at frame " + _frameCount);
    }

    private void QuickLoad()
    {
        if (_quicksave == null || !PlayerReady) return;
        Apply(_quicksave.Value);
        Host.Log("TAS: quickloaded");
    }

    private void OnGUI()
    {
        DrawHud();
        if (_showHitbox) DrawHitbox();
        if (_showHitboxTrail) DrawHitboxTrail();
        if (_checkpoints.Count > 0) DrawCheckpointMarkers();

        if (_menuOpen)
        {
            // Tint the default skin instead of swapping in a custom GUISkin -
            // a full swap rendered broken in a real gameplay scene (likely
            // GUI.skin left in a different state by another mod's own OnGUI
            // call earlier the same frame). Color multiplication doesn't
            // depend on capturing a "clean" base.
            var prevBg = GUI.backgroundColor;
            var prevContent = GUI.contentColor;
            GUI.backgroundColor = new Color(0.25f, 0.55f, 0.38f);
            GUI.contentColor = new Color(0.85f, 0.96f, 0.89f);

            _windowRect = GUI.Window(834213, _windowRect, DrawWindow, "TAS Tool");

            GUI.backgroundColor = prevBg;
            GUI.contentColor = prevContent;
        }
    }

    private void Section(string title)
    {
        GUILayout.Space(10);
        GUILayout.Label(title, SectionStyle());
    }

    private GUIStyle SectionStyle()
    {
        if (_sectionStyle == null)
        {
            _sectionStyle = new GUIStyle(GUI.skin.label)
            {
                fontStyle = FontStyle.Bold,
                fontSize = 14,
                normal = { textColor = new Color(0.42f, 0.93f, 0.6f) },
            };
        }
        return _sectionStyle;
    }

    private GUIStyle DimStyle()
    {
        if (_dimStyle == null)
        {
            _dimStyle = new GUIStyle(GUI.skin.label)
            {
                fontSize = 11,
                normal = { textColor = new Color(0.6f, 0.75f, 0.68f) },
            };
        }
        return _dimStyle;
    }

    private void DrawHud()
    {
        string status = _paused ? "PAUSED" : (!Mathf.Approximately(_speed, 1f) ? _speed + "x" : "");
        string text = "Frame " + _frameCount + (status.Length > 0 ? "  [" + status + "]" : "") + (_recording ? "  REC" : "") + (_replaying ? "  REPLAY " + _replayIndex + "/" + _buffer.Count : "") + (_checkpoints.Count > 0 ? "  CP:" + _checkpoints.Count : "");
        var size = HudStyle().CalcSize(new GUIContent(text));
        var prevColor = GUI.color;
        GUI.color = new Color(0f, 0f, 0f, 0.5f);
        GUI.DrawTexture(new Rect(6, 6, size.x + 8, size.y + 4), SolidTexture());
        GUI.color = prevColor;
        GUI.Label(new Rect(10, 8, size.x + 20, 24), text, HudStyle());
    }

    private void DrawWindow(int id)
    {
        // Backing rect drawn manually since the default window skin isn't
        // fully opaque and backgroundColor tinting can't add opacity it
        // doesn't have.
        var prevColor = GUI.color;
        GUI.color = new Color(0.04f, 0.09f, 0.06f, 0.96f);
        GUI.DrawTexture(new Rect(0, 0, _windowRect.width, _windowRect.height), SolidTexture());
        GUI.color = prevColor;

        _scrollPos = GUILayout.BeginScrollView(_scrollPos, GUILayout.Height(580));
        GUILayout.BeginVertical();

        GUILayout.Label("Tab menu · Z/X/R checkpoints · , . step · F5/F9 quicksave", DimStyle());
        if (PlayerReady)
        {
            GUILayout.Label(string.Format("Pos {0:0.0}, {1:0.0}   Vel {2:0.0}, {3:0.0}",
                _playerT.position.x, _playerT.position.y, _body.linearVelocity.x, _body.linearVelocity.y));
        }
        else
        {
            GUILayout.Label("No player bound yet");
        }

        Section("Time");
        GUILayout.BeginHorizontal();
        if (GUILayout.Button(_paused ? "Resume" : "Pause")) TogglePause();
        GUI.enabled = _paused;
        if (GUILayout.Button("<< Back")) StepBack();
        GUI.enabled = _paused && !_advancing;
        if (GUILayout.Button("Frame Adv.")) FrameAdvance();
        GUI.enabled = _paused && _rewindOffset > 0;
        if (GUILayout.Button("Fwd >>")) StepForward();
        GUI.enabled = true;
        GUILayout.EndHorizontal();
        if (_rewindOffset > 0) GUILayout.Label("Rewound " + _rewindOffset + " frame(s)", DimStyle());
        GUILayout.BeginHorizontal();
        foreach (var s in SpeedPresets)
        {
            GUI.enabled = !Mathf.Approximately(_speed, s);
            if (GUILayout.Button(s + "x")) SetSpeed(s);
            GUI.enabled = true;
        }
        GUILayout.EndHorizontal();

        Section("Session");
        GUILayout.BeginHorizontal();
        GUI.enabled = PlayerReady;
        if (GUILayout.Button("Reset")) ResetToRespawn();
        GUI.enabled = true;
        if (GUILayout.Button("New")) NewRecording();
        GUILayout.EndHorizontal();

        Section("Checkpoints (" + _checkpoints.Count + ")");
        GUILayout.BeginHorizontal();
        GUI.enabled = PlayerReady;
        if (GUILayout.Button("Place (Z)")) PlaceCheckpoint();
        GUI.enabled = _checkpoints.Count > 0;
        if (GUILayout.Button("Delete last (X)")) DeleteLastCheckpoint();
        if (GUILayout.Button("Go to latest (R)")) GoToLatestCheckpoint();
        GUI.enabled = true;
        GUILayout.EndHorizontal();
        for (int i = 0; i < _checkpoints.Count; i++)
        {
            GUILayout.BeginHorizontal();
            GUILayout.Label("#" + (i + 1) + (i == _checkpoints.Count - 1 ? " (latest)" : ""), GUILayout.Width(110));
            if (GUILayout.Button("Go", GUILayout.Width(40)))
            {
                Apply(_checkpoints[i]);
                TrimFailedRecordingSegment();
            }
            if (GUILayout.Button("Del", GUILayout.Width(40)))
            {
                _checkpoints.RemoveAt(i);
                GUILayout.EndHorizontal();
                break;
            }
            GUILayout.EndHorizontal();
        }

        Section("Record / Replay (" + _buffer.Count + " frames)");
        if (_recording) GUILayout.Label("Retries (death/R) auto-trim back to the last checkpoint", DimStyle());
        GUILayout.BeginHorizontal();
        if (GUILayout.Button(_recording ? "Stop Recording" : "Record")) ToggleRecording();
        GUI.enabled = _buffer.Count > 0;
        if (GUILayout.Button(_replaying ? "Stop Replay" : "Play")) ToggleReplay();
        GUI.enabled = true;
        GUILayout.EndHorizontal();
        _loopReplay = GUILayout.Toggle(_loopReplay, "Loop replay");
        GUI.enabled = _buffer.Count > 0 && !_recording;
        if (GUILayout.Button("Clear buffer")) NewRecording();
        GUI.enabled = true;

        GUILayout.BeginHorizontal();
        GUI.enabled = _buffer.Count > 0;
        if (GUILayout.Button("Copy")) CopyBufferToClipboard();
        GUI.enabled = true;
        if (GUILayout.Button("Paste")) PasteBufferFromClipboard();
        GUILayout.EndHorizontal();

        Section("Save / Load (file)");
        _saveFileName = GUILayout.TextField(_saveFileName);
        GUILayout.BeginHorizontal();
        GUI.enabled = _buffer.Count > 0;
        if (GUILayout.Button("Save")) SaveToFile(_saveFileName);
        GUI.enabled = true;
        if (GUILayout.Button("Load")) LoadFromFile(_saveFileName);
        GUILayout.EndHorizontal();
        foreach (var name in _savedFiles)
        {
            GUILayout.BeginHorizontal();
            GUILayout.Label(name);
            if (GUILayout.Button("Load", GUILayout.Width(60))) { _saveFileName = name; LoadFromFile(name); }
            GUILayout.EndHorizontal();
        }

        if (!string.IsNullOrEmpty(_statusMessage)) GUILayout.Label(_statusMessage, DimStyle());

        Section("Quicksave (F5 save, F9 load)");
        GUILayout.BeginHorizontal();
        if (GUILayout.Button("Save State")) QuickSave();
        GUI.enabled = _quicksave.HasValue;
        if (GUILayout.Button("Load State")) QuickLoad();
        GUI.enabled = true;
        GUILayout.EndHorizontal();

        Section("Display");
        _showHitbox = GUILayout.Toggle(_showHitbox, "Show hitbox");
        _showHitboxTrail = GUILayout.Toggle(_showHitboxTrail, "Show hitbox trail");

        GUILayout.Space(10);
        if (GUILayout.Button("Close (Tab)")) ToggleMenu();

        GUILayout.EndVertical();
        GUILayout.EndScrollView();
        GUI.DragWindow(new Rect(0, 0, 10000, 20));
    }

    private void DrawHitbox()
    {
        if (_collider == null || Camera.main == null) return;
        var b = _collider.bounds;
        DrawWorldRect(b.min, b.max, new Color(1f, 0f, 0f, 0.35f));
    }

    // Shifts the collider's current-position bounds by how far the player
    // has moved since, rather than moving the collider back to sample it.
    private void DrawHitboxTrail()
    {
        if (_collider == null || Camera.main == null || _historyCount == 0) return;
        var b = _collider.bounds;
        Vector3 currentPos = _playerT.position;

        const int step = 3;
        const int maxSamples = 40;
        int shown = 0;
        for (int offset = step; offset <= _historyCount - 1 && shown < maxSamples; offset += step, shown++)
        {
            int idx = ((_historyHead - 1 - offset) % MaxHistoryFrames + MaxHistoryFrames) % MaxHistoryFrames;
            Vector3 delta = _history[idx].Position - currentPos;
            float alpha = Mathf.Lerp(0.28f, 0.04f, shown / (float)maxSamples);
            DrawWorldRect(b.min + delta, b.max + delta, new Color(0f, 1f, 1f, alpha));
        }
    }

    private void DrawCheckpointMarkers()
    {
        if (Camera.main == null) return;
        for (int i = 0; i < _checkpoints.Count; i++)
        {
            Vector3 screen = Camera.main.WorldToScreenPoint(_checkpoints[i].Position);
            if (screen.z < 0) continue;
            bool latest = i == _checkpoints.Count - 1;
            float size = latest ? 14f : 10f;
            var rect = new Rect(screen.x - size / 2f, Screen.height - screen.y - size / 2f, size, size);
            GUI.color = latest ? new Color(1f, 1f, 0f, 0.9f) : new Color(1f, 1f, 0f, 0.5f);
            GUI.DrawTexture(rect, SolidTexture());
        }
        GUI.color = Color.white;
    }

    private void DrawWorldRect(Vector3 worldMin, Vector3 worldMax, Color color)
    {
        Vector3 min = Camera.main.WorldToScreenPoint(worldMin);
        Vector3 max = Camera.main.WorldToScreenPoint(worldMax);
        float x = Mathf.Min(min.x, max.x);
        float yTop = Screen.height - Mathf.Max(min.y, max.y);
        float w = Mathf.Abs(max.x - min.x);
        float h = Mathf.Abs(max.y - min.y);

        var prevColor = GUI.color;
        GUI.color = color;
        GUI.DrawTexture(new Rect(x, yTop, w, h), SolidTexture());
        GUI.color = prevColor;
    }

    private Texture2D SolidTexture()
    {
        if (_solidTex == null)
        {
            _solidTex = new Texture2D(1, 1);
            _solidTex.SetPixel(0, 0, Color.white);
            _solidTex.Apply();
        }
        return _solidTex;
    }

    private GUIStyle HudStyle()
    {
        if (_hudStyle == null) _hudStyle = new GUIStyle(GUI.skin.label) { fontSize = 16, normal = { textColor = Color.cyan } };
        return _hudStyle;
    }
}
