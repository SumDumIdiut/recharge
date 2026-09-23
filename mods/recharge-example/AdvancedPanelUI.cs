using TMPro;
using UnityEngine;
using UnityEngine.UI;
using Recharge.ModApi;

// Most Demos/*.cs classes wired to a real widget from Recharge.ModApi.PanelWidgets.
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
        _appendLog = msg => host.Log(msg);

        var root = panel.transform;

        BuildIcyToggleRow(root, font);
        BuildBeepSliderRow(root, font);
        BuildSpriteAndTweenRows(root, font);
        BuildStateMachineRow(root, font);
        BuildEventsRow(root, font);
        BuildCrossModRow(root, font);
        BuildDataFolderRow(root, font);

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

    private void BuildIcyToggleRow(Transform root, TMP_FontAsset font)
    {
        _icyToggle = PanelWidgets.CreateToggle(root, font, new Vector2(0, 370f), "Icy physics (or just press F9 in-game)", false, icy =>
        {
            _playerPhysics.SetIcyPhysics(icy);
            _appendLog($"Icy physics toggled to {icy} via the panel.");
        });
    }

    private void BuildBeepSliderRow(Transform root, TMP_FontAsset font)
    {
        var slider = PanelWidgets.CreateSlider(root, font, new Vector2(-60, 280), new Vector2(260, 20), 220f, 880f, 440f, null, out _);
        var playBtn = PanelWidgets.CreateButton(root, font, "PlayBeep", new Vector2(220, 280), new Vector2(150, 38), "Play Beep");
        playBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            AudioDemo.PlayBeep(_host, slider.value);
            _appendLog($"Played a {Mathf.RoundToInt(slider.value)}Hz beep.");
        });
    }

    private void BuildSpriteAndTweenRows(Transform root, TMP_FontAsset font)
    {
        var previewGo = new GameObject("SpritePreview", typeof(RectTransform), typeof(Image));
        previewGo.transform.SetParent(root, false);
        var previewRt = (RectTransform)previewGo.transform;
        previewRt.anchoredPosition = new Vector2(-60, 190);
        previewRt.sizeDelta = new Vector2(54, 54);
        _spritePreview = previewGo.GetComponent<Image>();
        _spritePreview.preserveAspect = true;
        _currentSprite = SpriteDemo.ByStyleIndex(_host, 0);
        _spritePreview.sprite = _currentSprite;

        var spawnBtn = PanelWidgets.CreateButton(root, font, "SpawnMarker", new Vector2(100, 190), new Vector2(220, 38), "Spawn in World");
        spawnBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            _sceneDemo.SpawnWorldMarker(_currentSprite);
            _appendLog("Spawned a world-space marker above the player.");
        });

        var punchBtn = PanelWidgets.CreateButton(root, font, "PunchPanel", new Vector2(340, 190), new Vector2(160, 38), "Punch Panel");
        punchBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            TweenDemo.Punch(punchBtn.transform.parent);
            _appendLog("Punched the panel (DOTween DOPunchScale).");
        });

        var bounceLabelGo = new GameObject("BounceLabel", typeof(RectTransform));
        bounceLabelGo.transform.SetParent(root, false);
        var bounceLabelRt = (RectTransform)bounceLabelGo.transform;
        bounceLabelRt.anchoredPosition = new Vector2(0, 90f);
        bounceLabelRt.sizeDelta = new Vector2(300, 30);
        var bounceLabelTmp = bounceLabelGo.AddComponent<TextMeshProUGUI>();
        bounceLabelTmp.font = font;
        bounceLabelTmp.fontSize = 18;
        bounceLabelTmp.color = Color.white;
        bounceLabelTmp.alignment = TextAlignmentOptions.Center;
        bounceLabelTmp.text = "Watch me bounce";

        var bounceBtn = PanelWidgets.CreateButton(root, font, "BounceLabelBtn", new Vector2(-180, 135), new Vector2(180, 36), "Bounce Label");
        bounceBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            TweenDemo.Bounce(bounceLabelGo.transform);
            _appendLog("Bounced the label (DOTween DOLocalMoveY sequence).");
        });

        var flashBtn = PanelWidgets.CreateButton(root, font, "FlashButton", new Vector2(180, 135), new Vector2(180, 36), "Flash This Button");
        flashBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            TweenDemo.FadeOutIn(flashBtn.GetComponent<Image>());
            _appendLog("Flashed this button's own Image (DOTween.To generic color tween).");
        });

        PanelWidgets.CreateDropdown(root, font, new Vector2(-300, 190), new Vector2(200, 32), SpriteDemo.StyleNames, 0, index =>
        {
            _currentSprite = SpriteDemo.ByStyleIndex(_host, index);
            _spritePreview.sprite = _currentSprite;
            _appendLog($"Sprite style set to {SpriteDemo.StyleNames[index]}.");
        }, onOpenChanged: open =>
        {
            bounceBtn.SetActive(!open);
            bounceLabelGo.SetActive(!open);
        });
    }

    private void BuildStateMachineRow(Transform root, TMP_FontAsset font)
    {
        var startBtn = PanelWidgets.CreateButton(root, font, "StartStateMachine", new Vector2(-150, 0), new Vector2(270, 38), "Start State Machine Demo");
        startBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            _updateLoop.StartRun();
            _appendLog("Started the Idle -> Running -> Cooldown -> Idle state machine.");
        });

        _stateLabel = PanelWidgets.CreateLabel(root, font, new Vector2(150, 0), new Vector2(260, 32), "State: Idle",
            fontSize: 16f, align: TextAlignmentOptions.MidlineLeft);
    }

    private void BuildEventsRow(Transform root, TMP_FontAsset font)
    {
        var emitBtn = PanelWidgets.CreateButton(root, font, "EmitScore", new Vector2(-220, -90), new Vector2(190, 38), "Emit Score Event");
        emitBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            _eventsDemo.EmitSampleScore();
            _appendLog("Emitted recharge.example.score - see Player.log.");
        });

        var askBtn = PanelWidgets.CreateButton(root, font, "AskQuestion", new Vector2(0, -90), new Vector2(190, 38), "Ask A Question");
        askBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            _eventsDemo.AskAQuestion(answer => _appendLog($"Request/response answer: {answer}"));
        });

        var mapsBtn = PanelWidgets.CreateButton(root, font, "LookUpMaps", new Vector2(220, -90), new Vector2(190, 38), "Look Up Maps Mod");
        mapsBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            _eventsDemo.LookUpMapsMod();
            _appendLog("Looked up recharge.maps via host.GetMod - see Player.log.");
        });
    }

    private void BuildCrossModRow(Transform root, TMP_FontAsset font)
    {
        var apiBtn = PanelWidgets.CreateButton(root, font, "LookUpOwnApi", new Vector2(-220, -140), new Vector2(210, 38), "Look Up Own API");
        apiBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            _eventsDemo.LookUpOwnApiTypedByOtherMods();
            _appendLog("Called host.GetModApi<IExampleModApi> on ourselves - see Player.log.");
        });

        var difficultyBtn = PanelWidgets.CreateButton(root, font, "CycleDifficulty", new Vector2(0, -140), new Vector2(210, 38), "Cycle Difficulty");
        difficultyBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            LoggingConfigDemo.CycleDifficulty(_host, _modId, _extendedConfig);
            _appendLog($"Difficulty is now {_extendedConfig.Difficulty}.");
        });

        var reflectBtn = PanelWidgets.CreateButton(root, font, "RunReflection", new Vector2(220, -140), new Vector2(210, 38), "Run Reflection Demo");
        reflectBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            ReflectionDemo.Run(_host);
            _appendLog("Ran every Reflect.* method - see Player.log for the results.");
        });
    }

    private void BuildDataFolderRow(Transform root, TMP_FontAsset font)
    {
        var scoreBtn = PanelWidgets.CreateButton(root, font, "AppendScore", new Vector2(-220, -190), new Vector2(190, 38), "Append Score");
        scoreBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            DataFolderDemo.AppendDemoScore(_host, _modId);
            _appendLog("Appended a record to scores.json (atomic write).");
        });

        var blobBtn = PanelWidgets.CreateButton(root, font, "RoundTripBlob", new Vector2(0, -190), new Vector2(190, 38), "Round-trip Blob");
        blobBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            DataFolderDemo.RoundTripBinaryBlob(_host, _modId);
            _appendLog("Wrote + read back a binary blob - see Player.log.");
        });

        var listBtn = PanelWidgets.CreateButton(root, font, "ListFiles", new Vector2(220, -190), new Vector2(190, 38), "List Data Files");
        listBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            DataFolderDemo.ListDataFiles(_host, _modId);
            _appendLog("Listed this mod's data folder - see Player.log.");
        });
    }
}
