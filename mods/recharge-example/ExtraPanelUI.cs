using System.Collections;
using TMPro;
using UnityEngine;
using UnityEngine.UI;
using Recharge.ModApi;

// Coroutines, Input System, world/screen math, flipbook animation, and a
// physics raycast, each wired to a button/label pair.
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
        _appendLog = msg => host.Log(msg);

        var root = panel.transform;

        BuildCoroutineRows(root, font);
        BuildInputRows(root, font);
        BuildMotionRow(root, font);
        BuildFlipbookRow(root, font);
        BuildPhysicsAndCameraRows(root, font);

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
        const float btnY = 365f;
        const float labelY = 325f;
        const float colWidth = 270f;

        var countdownBtn = PanelWidgets.CreateButton(root, font, "Countdown", new Vector2(-280, btnY), new Vector2(colWidth, 36), "Start 3s Countdown");
        _countdownLabel = PanelWidgets.CreateLabel(root, font, new Vector2(-280, labelY), new Vector2(colWidth, 28), "", fontSize: 15f);
        countdownBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            CoroutineDemo.RunCountdown(_host, 3,
                remaining => _countdownLabel.text = $"{remaining}...",
                () => { _countdownLabel.text = "Go!"; _appendLog("Countdown finished."); });
        });

        var delayedBtn = PanelWidgets.CreateButton(root, font, "DelayedAction", new Vector2(0, btnY), new Vector2(colWidth, 36), "Log Something In 3s");
        _delayedLabel = PanelWidgets.CreateLabel(root, font, new Vector2(0, labelY), new Vector2(colWidth, 28), "", fontSize: 15f);
        delayedBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            _delayedLabel.text = "Waiting...";
            CoroutineDemo.RunDelayedAction(_host, 3f, () =>
            {
                _delayedLabel.text = "Done - check Player.log.";
                _appendLog("Delayed coroutine action ran.");
            });
        });

        var waitBtn = PanelWidgets.CreateButton(root, font, "WaitForPlayer", new Vector2(280, btnY), new Vector2(colWidth, 36), "Wait For Player To Exist");
        _waitPlayerLabel = PanelWidgets.CreateLabel(root, font, new Vector2(280, labelY), new Vector2(colWidth, 28), "", fontSize: 15f);
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
        var rebindBtn = PanelWidgets.CreateButton(root, font, "Rebind", new Vector2(-260, 215), new Vector2(230, 36), "Rebind Ping Key");
        _rebindLabel = PanelWidgets.CreateLabel(root, font, new Vector2(30, 215), new Vector2(270, 32), $"Current: {_inputDemo?.PingKeyName}", fontSize: 17f, align: TextAlignmentOptions.MidlineLeft);
        rebindBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            _rebindLabel.text = "Press any key...";
            _inputDemo.ArmRebind();
            _appendLog("Armed ping-key rebind - press any key.");
        });

        _liveInputLabel = PanelWidgets.CreateLabel(root, font, new Vector2(0, 175), new Vector2(780, 30), "Mouse: (0, 0)",
            fontSize: 16f, align: TextAlignmentOptions.MidlineLeft);
    }

    // Picking a PanelMotion.MotionPath and hitting Run animates MotionDot
    // between the same two endpoints along that curve.
    private static readonly string[] MotionOptionLabels = { "Bezier Curve", "Linear", "Circular Orbit", "Bounce", "Zigzag", "Wave", "Elastic" };
    private static readonly MotionPath[] MotionOptionPaths = { MotionPath.QuadraticBezier, MotionPath.Linear, MotionPath.Circular, MotionPath.Bounce, MotionPath.Zigzag, MotionPath.Wave, MotionPath.Elastic };
    private int _selectedMotionIndex;

    private void BuildMotionRow(Transform root, TMP_FontAsset font)
    {
        var track = new GameObject("MotionTrack", typeof(RectTransform));
        track.transform.SetParent(root, false);
        ((RectTransform)track.transform).anchoredPosition = new Vector2(-160, 25);
        ((RectTransform)track.transform).sizeDelta = new Vector2(440, 40);

        var dotGo = new GameObject("MotionDot", typeof(RectTransform), typeof(Image));
        dotGo.transform.SetParent(track.transform, false);
        var dotRt = (RectTransform)dotGo.transform;
        dotRt.sizeDelta = new Vector2(22, 22);
        dotRt.anchoredPosition = new Vector2(-200, 0);
        dotGo.GetComponent<Image>().color = new Color(1f, 0.6f, 0.2f);
        var from = new Vector2(-200, 0);
        var to = new Vector2(200, 0);

        var runBtn = PanelWidgets.CreateButton(root, font, "RunMotion", new Vector2(300, 25), new Vector2(240, 38), "Run");
        runBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            StopCoroutine(nameof(MotionRoutine));
            var path = MotionOptionPaths[_selectedMotionIndex];
            StartCoroutine(MotionRoutine(dotRt, from, to, 1.2f, path));
            _appendLog($"Running a {MotionOptionLabels[_selectedMotionIndex]} UI move over 1.2s.");
        });

        PanelWidgets.CreateDropdown(root, font, new Vector2(300, 70), new Vector2(240, 38), MotionOptionLabels, _selectedMotionIndex,
            index => _selectedMotionIndex = index,
            onOpenChanged: open => runBtn.SetActive(!open));
    }

    private IEnumerator MotionRoutine(RectTransform dot, Vector2 from, Vector2 to, float duration, MotionPath path)
    {
        var elapsed = 0f;
        while (elapsed < duration)
        {
            elapsed += Time.deltaTime;
            dot.anchoredPosition = PanelMotion.Evaluate(path, from, to, elapsed / duration);
            yield return null;
        }
        dot.anchoredPosition = to;
    }

    private void BuildFlipbookRow(Transform root, TMP_FontAsset font)
    {
        var imgGo = new GameObject("FlipbookImage", typeof(RectTransform), typeof(Image));
        imgGo.transform.SetParent(root, false);
        var imgRt = (RectTransform)imgGo.transform;
        imgRt.anchoredPosition = new Vector2(-370, -80);
        imgRt.sizeDelta = new Vector2(52, 52);
        var image = imgGo.GetComponent<Image>();
        image.preserveAspect = true;

        var toggleBtn = PanelWidgets.CreateButton(root, font, "FlipbookToggle", new Vector2(-150, -80), new Vector2(230, 38), "Play Flipbook");
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
        var groundBtn = PanelWidgets.CreateButton(root, font, "CheckGround", new Vector2(-220, -150), new Vector2(270, 38), "Check Ground Below Player");
        _groundLabel = PanelWidgets.CreateLabel(root, font, new Vector2(-220, -185), new Vector2(330, 28), "", fontSize: 15f);
        groundBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            var player = GameObject.FindGameObjectWithTag("Player");
            var hit = PhysicsRaycastDemo.CheckGround(player);
            _groundLabel.text = hit.Grounded ? $"Grounded on {hit.HitObjectName} ({hit.Distance:0.00}m)" : "Airborne / no player";
            PhysicsRaycastDemo.LogGroundCheck(_host, player);
            _appendLog("Ran a Physics2D.Raycast ground check.");
        });

        var screenBtn = PanelWidgets.CreateButton(root, font, "ScreenPos", new Vector2(220, -150), new Vector2(270, 38), "Player's Screen Position");
        _screenPosLabel = PanelWidgets.CreateLabel(root, font, new Vector2(220, -185), new Vector2(330, 28), "", fontSize: 15f);
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
}
