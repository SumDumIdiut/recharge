using TMPro;
using UnityEngine;
using UnityEngine.UI;
using Recharge.ModApi;

// The second pause-menu panel ExampleMod installs - most Demos/*.cs classes
// wired to a real widget from Widgets/AdvancedWidgets.cs, with a live
// scrolling log at the bottom.
internal class AdvancedPanelUI : MonoBehaviour
{
    private IRechargeHost _host;
    private string _modId;
    private PlayerPhysicsDemo _playerPhysics;
    private UpdateLoopDemo _updateLoop;
    private SceneDemo _sceneDemo;
    private EventsDemo _eventsDemo;
    private LoggingConfigDemo.ExtendedConfig _extendedConfig;

    private Toggle _icyToggle;
    private Image _spritePreview;
    private Sprite _currentSprite;
    private TMP_Text _stateLabel;
    private System.Action<string> _appendLog;

    public void Build(
        GameObject panel,
        TMP_FontAsset font,
        IRechargeHost host,
        string modId,
        PlayerPhysicsDemo playerPhysics,
        UpdateLoopDemo updateLoop,
        SceneDemo sceneDemo,
        EventsDemo eventsDemo,
        LoggingConfigDemo.ExtendedConfig extendedConfig)
    {
        _host = host;
        _modId = modId;
        _playerPhysics = playerPhysics;
        _updateLoop = updateLoop;
        _sceneDemo = sceneDemo;
        _eventsDemo = eventsDemo;
        _extendedConfig = extendedConfig;

        var root = panel.transform;
        var panelRt = panel.GetComponent<RectTransform>();
        if (panelRt != null) panelRt.sizeDelta = new Vector2(680f, 680f);

        BuildHeader(root, font);
        BuildIcyToggleRow(root, font);
        BuildBeepSliderRow(root, font);
        BuildSpriteAndTweenRows(root, font);
        BuildStateMachineRow(root, font);
        BuildEventsRow(root, font);
        BuildCrossModRow(root, font);
        BuildDataFolderRow(root, font);
        BuildLog(root, font);

        _appendLog("Advanced Demo panel ready. Try F9 in-game to toggle icy physics without opening this menu at all.");

        updateLoop.IcyPhysicsToggleRequested += icy =>
        {
            playerPhysics.SetIcyPhysics(icy);
            _icyToggle.SetIsOnWithoutNotify(icy);
            _appendLog($"Icy physics toggled to {icy} via F9.");
        };
        updateLoop.StateChanged += _ => RefreshStateLabel();
        RefreshStateLabel();
    }

    private void Update()
    {
        if (_stateLabel != null) RefreshStateLabel();
    }

    private void RefreshStateLabel()
    {
        if (_stateLabel != null) _stateLabel.text = $"State: {_updateLoop.StateName}  ·  fixed ticks: {_updateLoop.FixedTickCount}";
    }

    private void BuildHeader(Transform root, TMP_FontAsset font)
    {
        var header = CreateLabel(root, font, new Vector2(0, 320), new Vector2(640, 30), "Advanced Demo - everything else ExampleMod can do");
        header.fontSize = 20;
        header.color = new Color(1f, 1f, 1f, 0.65f);
    }

    private void BuildIcyToggleRow(Transform root, TMP_FontAsset font)
    {
        _icyToggle = AdvancedWidgets.CreateToggle(root, font, new Vector2(0, 280), "Icy physics (or just press F9 in-game)", false, icy =>
        {
            _playerPhysics.SetIcyPhysics(icy);
            _appendLog($"Icy physics toggled to {icy} via the panel.");
        });
    }

    private void BuildBeepSliderRow(Transform root, TMP_FontAsset font)
    {
        var slider = AdvancedWidgets.CreateSlider(root, font, new Vector2(-60, 235), new Vector2(260, 20), 220f, 880f, 440f, null, out _);
        var playBtn = AdvancedWidgets.CreateFlatButton(root, font, "PlayBeep", new Vector2(220, 235), new Vector2(140, 36), "Play Beep");
        playBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            AudioDemo.PlayBeep(_host, slider.value);
            _appendLog($"Played a {Mathf.RoundToInt(slider.value)}Hz beep.");
        });
    }

    private void BuildSpriteAndTweenRows(Transform root, TMP_FontAsset font)
    {
        AdvancedWidgets.CreateExpandableChoiceList(root, font, new Vector2(-220, 190), new Vector2(200, 30), SpriteDemo.StyleNames, 0, index =>
        {
            _currentSprite = SpriteDemo.ByStyleIndex(_host, index);
            _spritePreview.sprite = _currentSprite;
            _appendLog($"Sprite style set to {SpriteDemo.StyleNames[index]}.");
        });

        var previewGo = new GameObject("SpritePreview", typeof(RectTransform), typeof(Image));
        previewGo.transform.SetParent(root, false);
        var previewRt = (RectTransform)previewGo.transform;
        previewRt.anchoredPosition = new Vector2(20, 190);
        previewRt.sizeDelta = new Vector2(50, 50);
        _spritePreview = previewGo.GetComponent<Image>();
        _spritePreview.preserveAspect = true;
        _currentSprite = SpriteDemo.ByStyleIndex(_host, 0);
        _spritePreview.sprite = _currentSprite;

        var spawnBtn = AdvancedWidgets.CreateFlatButton(root, font, "SpawnMarker", new Vector2(180, 190), new Vector2(220, 36), "Spawn in World");
        spawnBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            _sceneDemo.SpawnWorldMarker(_currentSprite);
            _appendLog("Spawned a world-space marker above the player.");
        });

        var punchBtn = AdvancedWidgets.CreateFlatButton(root, font, "PunchPanel", new Vector2(-220, 145), new Vector2(180, 34), "Punch Panel");
        punchBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            TweenDemo.Punch(punchBtn.transform.parent);
            _appendLog("Punched the panel (DOTween DOPunchScale).");
        });

        var bounceLabelGo = new GameObject("BounceLabel", typeof(RectTransform));
        bounceLabelGo.transform.SetParent(root, false);
        var bounceLabelRt = (RectTransform)bounceLabelGo.transform;
        bounceLabelRt.anchoredPosition = new Vector2(0, 105);
        bounceLabelRt.sizeDelta = new Vector2(300, 30);
        var bounceLabelTmp = bounceLabelGo.AddComponent<TextMeshProUGUI>();
        bounceLabelTmp.font = font;
        bounceLabelTmp.fontSize = 17;
        bounceLabelTmp.color = Color.white;
        bounceLabelTmp.alignment = TextAlignmentOptions.Center;
        bounceLabelTmp.text = "Watch me bounce";

        var bounceBtn = AdvancedWidgets.CreateFlatButton(root, font, "BounceLabelBtn", new Vector2(0, 145), new Vector2(180, 34), "Bounce Label");
        bounceBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            TweenDemo.Bounce(bounceLabelGo.transform);
            _appendLog("Bounced the label (DOTween DOLocalMoveY sequence).");
        });

        var flashBtn = AdvancedWidgets.CreateFlatButton(root, font, "FlashButton", new Vector2(220, 145), new Vector2(180, 34), "Flash This Button");
        flashBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            TweenDemo.FadeOutIn(flashBtn.GetComponent<Image>());
            _appendLog("Flashed this button's own Image (DOTween.To generic color tween).");
        });
    }

    private void BuildStateMachineRow(Transform root, TMP_FontAsset font)
    {
        var startBtn = AdvancedWidgets.CreateFlatButton(root, font, "StartStateMachine", new Vector2(-150, 60), new Vector2(260, 34), "Start State Machine Demo");
        startBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            _updateLoop.StartRun();
            _appendLog("Started the Idle -> Running -> Cooldown -> Idle state machine.");
        });

        _stateLabel = CreateLabel(root, font, new Vector2(150, 60), new Vector2(260, 30), "State: Idle");
        _stateLabel.fontSize = 15;
        _stateLabel.alignment = TextAlignmentOptions.MidlineLeft;
    }

    private void BuildEventsRow(Transform root, TMP_FontAsset font)
    {
        var emitBtn = AdvancedWidgets.CreateFlatButton(root, font, "EmitScore", new Vector2(-220, 15), new Vector2(180, 34), "Emit Score Event");
        emitBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            _eventsDemo.EmitSampleScore();
            _appendLog("Emitted recharge.example.score - see Player.log.");
        });

        var askBtn = AdvancedWidgets.CreateFlatButton(root, font, "AskQuestion", new Vector2(0, 15), new Vector2(180, 34), "Ask A Question");
        askBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            _eventsDemo.AskAQuestion(answer => _appendLog($"Request/response answer: {answer}"));
        });

        var mapsBtn = AdvancedWidgets.CreateFlatButton(root, font, "LookUpMaps", new Vector2(220, 15), new Vector2(180, 34), "Look Up Maps Mod");
        mapsBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            _eventsDemo.LookUpMapsMod();
            _appendLog("Looked up recharge.maps via host.GetMod - see Player.log.");
        });
    }

    private void BuildCrossModRow(Transform root, TMP_FontAsset font)
    {
        var apiBtn = AdvancedWidgets.CreateFlatButton(root, font, "LookUpOwnApi", new Vector2(-220, -25), new Vector2(200, 34), "Look Up Own API");
        apiBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            _eventsDemo.LookUpOwnApiTypedByOtherMods();
            _appendLog("Called host.GetModApi<IExampleModApi> on ourselves - see Player.log.");
        });

        var difficultyBtn = AdvancedWidgets.CreateFlatButton(root, font, "CycleDifficulty", new Vector2(0, -25), new Vector2(200, 34), "Cycle Difficulty");
        difficultyBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            LoggingConfigDemo.CycleDifficulty(_host, _modId, _extendedConfig);
            _appendLog($"Difficulty is now {_extendedConfig.Difficulty}.");
        });

        var reflectBtn = AdvancedWidgets.CreateFlatButton(root, font, "RunReflection", new Vector2(220, -25), new Vector2(200, 34), "Run Reflection Demo");
        reflectBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            ReflectionDemo.Run(_host);
            _appendLog("Ran every Reflect.* method - see Player.log for the results.");
        });
    }

    private void BuildDataFolderRow(Transform root, TMP_FontAsset font)
    {
        var scoreBtn = AdvancedWidgets.CreateFlatButton(root, font, "AppendScore", new Vector2(-220, -65), new Vector2(180, 34), "Append Score");
        scoreBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            DataFolderDemo.AppendDemoScore(_host, _modId);
            _appendLog("Appended a record to scores.json (atomic write).");
        });

        var blobBtn = AdvancedWidgets.CreateFlatButton(root, font, "RoundTripBlob", new Vector2(0, -65), new Vector2(180, 34), "Round-trip Blob");
        blobBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            DataFolderDemo.RoundTripBinaryBlob(_host, _modId);
            _appendLog("Wrote + read back a binary blob - see Player.log.");
        });

        var listBtn = AdvancedWidgets.CreateFlatButton(root, font, "ListFiles", new Vector2(220, -65), new Vector2(180, 34), "List Data Files");
        listBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            DataFolderDemo.ListDataFiles(_host, _modId);
            _appendLog("Listed this mod's data folder - see Player.log.");
        });
    }

    private void BuildLog(Transform root, TMP_FontAsset font)
    {
        _appendLog = AdvancedWidgets.CreateScrollableLog(root, font, new Vector2(0, -215), new Vector2(640, 170), out _);
    }

    private static TMP_Text CreateLabel(Transform parent, TMP_FontAsset font, Vector2 pos, Vector2 size, string text)
    {
        var go = new GameObject("Label", typeof(RectTransform));
        go.transform.SetParent(parent, false);
        var rt = (RectTransform)go.transform;
        rt.anchoredPosition = pos;
        rt.sizeDelta = size;
        var tmp = go.AddComponent<TextMeshProUGUI>();
        tmp.font = font;
        tmp.fontSize = 24;
        tmp.alignment = TextAlignmentOptions.Center;
        tmp.color = Color.white;
        tmp.text = text;
        return tmp;
    }
}
