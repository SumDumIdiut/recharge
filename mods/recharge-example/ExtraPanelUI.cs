using System.Collections;
using TMPro;
using UnityEngine;
using UnityEngine.UI;
using Recharge.ModApi;

// The third pause-menu panel ExampleMod installs - coroutines, deeper Input
// System usage, world/screen math, flipbook sprite animation, and a physics
// raycast, each wired to a button/label pair and echoed into the same kind
// of scrolling log AdvancedPanelUI uses.
internal class ExtraPanelUI : MonoBehaviour
{
    private IRechargeHost _host;
    private InputDemo _inputDemo;
    private FlipbookSpriteDemo _flipbook;

    private TMP_Text _countdownLabel;
    private TMP_Text _delayedLabel;
    private TMP_Text _waitPlayerLabel;
    private TMP_Text _rebindLabel;
    private TMP_Text _liveInputLabel;
    private TMP_Text _groundLabel;
    private TMP_Text _screenPosLabel;
    private System.Action<string> _appendLog;

    public void Build(GameObject panel, TMP_FontAsset font, IRechargeHost host, string modId, InputDemo inputDemo)
    {
        _host = host;
        _inputDemo = inputDemo;

        var root = panel.transform;
        var panelRt = panel.GetComponent<RectTransform>();
        if (panelRt != null) panelRt.sizeDelta = new Vector2(680f, 680f);

        CreateLabel(root, font, new Vector2(0, 290), new Vector2(620, 30), "Extra Demo - coroutines, input, camera math, physics").fontSize = 20;

        BuildCoroutineRows(root, font);
        BuildInputRows(root, font);
        BuildBezierRow(root, font);
        BuildFlipbookRow(root, font);
        BuildPhysicsAndCameraRows(root, font);
        BuildLog(root, font);

        _flipbook = new FlipbookSpriteDemo(host);
        inputDemo.KeyRebound += key =>
        {
            if (_rebindLabel != null) _rebindLabel.text = $"Current: {key}";
            _appendLog($"Ping key rebound to {key}.");
        };
        _appendLog("Extra Demo panel ready.");
    }

    private void Update()
    {
        if (_liveInputLabel == null) return;
        var pos = InputDemo.MouseScreenPosition();
        _liveInputLabel.text = $"Mouse: ({pos.x:0}, {pos.y:0})  ·  Gamepad: {InputDemo.DescribeConnectedGamepad()}";
    }

    private void BuildCoroutineRows(Transform root, TMP_FontAsset font)
    {
        var countdownBtn = AdvancedWidgets.CreateFlatButton(root, font, "Countdown", new Vector2(-150, 245), new Vector2(220, 34), "Start 3s Countdown");
        _countdownLabel = CreateLabel(root, font, new Vector2(180, 245), new Vector2(220, 30), "", TextAlignmentOptions.MidlineLeft);
        countdownBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            CoroutineDemo.RunCountdown(_host, 3,
                remaining => _countdownLabel.text = $"{remaining}...",
                () => { _countdownLabel.text = "Go!"; _appendLog("Countdown finished."); });
        });

        var delayedBtn = AdvancedWidgets.CreateFlatButton(root, font, "DelayedAction", new Vector2(-150, 200), new Vector2(220, 34), "Log Something In 3s");
        _delayedLabel = CreateLabel(root, font, new Vector2(180, 200), new Vector2(220, 30), "", TextAlignmentOptions.MidlineLeft);
        delayedBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            _delayedLabel.text = "Waiting...";
            CoroutineDemo.RunDelayedAction(_host, 3f, () =>
            {
                _delayedLabel.text = "Done - check Player.log.";
                _appendLog("Delayed coroutine action ran.");
            });
        });

        var waitBtn = AdvancedWidgets.CreateFlatButton(root, font, "WaitForPlayer", new Vector2(-150, 155), new Vector2(220, 34), "Wait For Player To Exist");
        _waitPlayerLabel = CreateLabel(root, font, new Vector2(180, 155), new Vector2(220, 30), "", TextAlignmentOptions.MidlineLeft);
        waitBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            _waitPlayerLabel.text = "Waiting...";
            CoroutineDemo.RunWhenPlayerExists(_host, player =>
            {
                _waitPlayerLabel.text = $"Found: {player.name}";
                _appendLog("WaitUntil coroutine found the player.");
            });
        });
    }

    private void BuildInputRows(Transform root, TMP_FontAsset font)
    {
        var rebindBtn = AdvancedWidgets.CreateFlatButton(root, font, "Rebind", new Vector2(-150, 110), new Vector2(220, 34), "Rebind Ping Key");
        _rebindLabel = CreateLabel(root, font, new Vector2(180, 110), new Vector2(220, 30), $"Current: {_inputDemo?.PingKeyName}", TextAlignmentOptions.MidlineLeft);
        rebindBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            _rebindLabel.text = "Press any key...";
            _inputDemo.ArmRebind();
            _appendLog("Armed ping-key rebind - press any key.");
        });

        _liveInputLabel = CreateLabel(root, font, new Vector2(0, 65), new Vector2(600, 28), "Mouse: (0, 0)");
        _liveInputLabel.alignment = TextAlignmentOptions.MidlineLeft;
        _liveInputLabel.fontSize = 15;
    }

    private void BuildBezierRow(Transform root, TMP_FontAsset font)
    {
        var track = new GameObject("BezierTrack", typeof(RectTransform));
        track.transform.SetParent(root, false);
        ((RectTransform)track.transform).anchoredPosition = new Vector2(0, 20);
        ((RectTransform)track.transform).sizeDelta = new Vector2(600, 40);

        var dotGo = new GameObject("BezierDot", typeof(RectTransform), typeof(Image));
        dotGo.transform.SetParent(track.transform, false);
        var dotRt = (RectTransform)dotGo.transform;
        dotRt.sizeDelta = new Vector2(20, 20);
        dotRt.anchoredPosition = new Vector2(-280, -15);
        dotGo.GetComponent<Image>().color = new Color(1f, 0.6f, 0.2f);

        var runBtn = AdvancedWidgets.CreateFlatButton(root, font, "RunBezier", new Vector2(0, -15), new Vector2(220, 30), "Run Bezier Move");
        runBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            StopCoroutine(nameof(BezierMoveRoutine));
            StartCoroutine(BezierMoveRoutine(dotRt, new Vector2(-280, -15), new Vector2(0, 15), new Vector2(280, -15), 1.2f));
            _appendLog("Running a quadratic-bezier UI move over 1.2s.");
        });
    }

    private IEnumerator BezierMoveRoutine(RectTransform dot, Vector2 p0, Vector2 p1, Vector2 p2, float duration)
    {
        var elapsed = 0f;
        while (elapsed < duration)
        {
            elapsed += Time.deltaTime;
            var t = MathAndCameraDemo.EaseInOutSine(elapsed / duration);
            dot.anchoredPosition = MathAndCameraDemo.QuadraticBezier(p0, p1, p2, t);
            yield return null;
        }
        dot.anchoredPosition = p2;
    }

    private void BuildFlipbookRow(Transform root, TMP_FontAsset font)
    {
        var imgGo = new GameObject("FlipbookImage", typeof(RectTransform), typeof(Image));
        imgGo.transform.SetParent(root, false);
        var imgRt = (RectTransform)imgGo.transform;
        imgRt.anchoredPosition = new Vector2(-260, -60);
        imgRt.sizeDelta = new Vector2(48, 48);
        var image = imgGo.GetComponent<Image>();
        image.preserveAspect = true;

        var toggleBtn = AdvancedWidgets.CreateFlatButton(root, font, "FlipbookToggle", new Vector2(-40, -60), new Vector2(220, 34), "Play Flipbook");
        var label = toggleBtn.transform.Find("Text (TMP)").GetComponent<TMP_Text>();
        toggleBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            if (_flipbook.IsPlaying)
            {
                _flipbook.Stop();
                label.text = "Play Flipbook";
            }
            else
            {
                _flipbook.PlayOn(image);
                label.text = "Stop Flipbook";
            }
        });
    }

    private void BuildPhysicsAndCameraRows(Transform root, TMP_FontAsset font)
    {
        var groundBtn = AdvancedWidgets.CreateFlatButton(root, font, "CheckGround", new Vector2(-150, -105), new Vector2(220, 34), "Check Ground Below Player");
        _groundLabel = CreateLabel(root, font, new Vector2(180, -105), new Vector2(240, 30), "", TextAlignmentOptions.MidlineLeft);
        groundBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            var player = GameObject.FindGameObjectWithTag("Player");
            var hit = PhysicsRaycastDemo.CheckGround(player);
            _groundLabel.text = hit.Grounded ? $"Grounded on {hit.HitObjectName} ({hit.Distance:0.00}m)" : "Airborne / no player";
            PhysicsRaycastDemo.LogGroundCheck(_host, player);
            _appendLog("Ran a Physics2D.Raycast ground check.");
        });

        var screenBtn = AdvancedWidgets.CreateFlatButton(root, font, "ScreenPos", new Vector2(-150, -150), new Vector2(220, 34), "Player's Screen Position");
        _screenPosLabel = CreateLabel(root, font, new Vector2(180, -150), new Vector2(240, 30), "", TextAlignmentOptions.MidlineLeft);
        screenBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            var player = GameObject.FindGameObjectWithTag("Player");
            if (player != null && MathAndCameraDemo.TryWorldToScreen(Camera.main, player.transform.position, out var screen))
            {
                _screenPosLabel.text = $"({screen.x:0}, {screen.y:0})";
                _appendLog("Converted the player's world position to screen space.");
            }
            else
            {
                _screenPosLabel.text = "No player / no camera.";
            }
        });
    }

    private void BuildLog(Transform root, TMP_FontAsset font)
    {
        _appendLog = AdvancedWidgets.CreateScrollableLog(root, font, new Vector2(0, -280), new Vector2(640, 150), out _);
    }

    private static TMP_Text CreateLabel(Transform parent, TMP_FontAsset font, Vector2 pos, Vector2 size, string text, TextAlignmentOptions align = TextAlignmentOptions.Center)
    {
        var go = new GameObject("Label", typeof(RectTransform));
        go.transform.SetParent(parent, false);
        var rt = (RectTransform)go.transform;
        rt.anchoredPosition = pos;
        rt.sizeDelta = size;
        var tmp = go.AddComponent<TextMeshProUGUI>();
        tmp.font = font;
        tmp.fontSize = 16;
        tmp.alignment = align;
        tmp.color = Color.white;
        tmp.text = text;
        tmp.enableWordWrapping = false;
        return tmp;
    }
}
