using TMPro;
using UnityEngine;
using UnityEngine.UI;
using Recharge.ModApi;

// One panel, a tab strip (Basics/Advanced/Extra), and a persistent footer
// (ping button + stats) that stays visible no matter which tab is open -
// sized off the vanilla panel's own native size instead of the screen.
internal class ExampleHubPanelUI : MonoBehaviour
{
    // Each page's content is authored assuming this much vertical room;
    // used to derive how much to shrink it by if the real page is smaller.
    private const float SubPageAuthoredTop = 400f;
    private const float SubPageAuthoredBottom = -280f;
    private const float AuthoredSpan = SubPageAuthoredTop - SubPageAuthoredBottom;
    // The midpoint of AuthoredTop/Bottom, i.e. where a child at
    // anchoredPosition.y=0 actually renders (a page's default (0.5,0.5)
    // anchor references ITS OWN rect center, not row Y=0) - not 0, since
    // sub-page content is authored with more room above 0 than below it.
    private const float AuthoredMid = (SubPageAuthoredTop + SubPageAuthoredBottom) / 2f;
    private const float EdgeMargin = 35f; // clearance from the panel's true edge to title/Close

    private const float NativeSizeScale = 1.15f;

    private Vector2 _panelSize;
    private PanelLayout _layout;
    private float _titleY;
    private float _closeY;
    private float _subPageContentScale;

    private GameObject[] _tabPages;
    private Button[] _tabButtons;
    private TMP_Text _pingStatusLabel;
    private IRechargeHost _host;

    public void Build(
        GameObject panel,
        TMP_FontAsset font,
        IRechargeHost host,
        ExampleMod.MyConfig config,
        string modId,
        PlayerPhysicsDemo playerPhysics,
        UpdateLoopDemo updateLoop,
        SceneDemo sceneDemo,
        EventsDemo eventsDemo,
        LoggingConfigDemo.ExtendedConfig extendedConfig,
        InputDemo inputDemo)
    {
        _host = host;

        var nativeSize = panel.GetComponent<RectTransform>().sizeDelta;
        if (nativeSize.x < 10f || nativeSize.y < 10f) nativeSize = new Vector2(700f, 620f);
        _panelSize = nativeSize * NativeSizeScale;
        _titleY = _panelSize.y / 2f - EdgeMargin;
        _closeY = -_titleY;

        _layout = PanelLayout.Apply(panel, _panelSize);
        var root = panel.transform;

        PauseMenuHelper.NormalizePanelLayout(panel, _titleY, _closeY);

        float tabBarY = _titleY - 45f;
        float footerTop = _closeY + 100f;
        float contentTop = tabBarY - 5f;

        _subPageContentScale = Mathf.Clamp((contentTop - footerTop) / AuthoredSpan, 0.45f, 1f);

        var basicsPage = CreatePage(root, "BasicsPage", contentTop, footerTop);
        basicsPage.transform.localScale = Vector3.one * _subPageContentScale;
        basicsPage.AddComponent<ExamplePanelUI>().Build(basicsPage, font, host, config, modId);

        var advancedPage = CreatePage(root, "AdvancedPage", contentTop, footerTop);
        advancedPage.transform.localScale = Vector3.one * _subPageContentScale;
        advancedPage.AddComponent<AdvancedPanelUI>().Build(advancedPage, font, host, modId, playerPhysics, updateLoop, sceneDemo, eventsDemo, extendedConfig);

        var extraPage = CreatePage(root, "ExtraPage", contentTop, footerTop);
        extraPage.transform.localScale = Vector3.one * _subPageContentScale;
        extraPage.AddComponent<ExtraPanelUI>().Build(extraPage, font, host, modId, inputDemo);

        _tabPages = new[] { basicsPage, advancedPage, extraPage };
        BuildTabBar(root, font, tabBarY, new[] { "Basics", "Advanced", "Extra" });
        SelectTab(0);

        BuildFooter(root, font, host, config, footerTop);
    }

    // A page fills the same footprint every time (so switching tabs never
    // shifts the panel around), masked to exactly [bottom, top] so content
    // can never render over the tab strip or footer. Pivot is offset to
    // AuthoredMid (not the default 0.5) so that offset - not the rect's
    // own geometric center - is what a child's authored Y=0 lines up with.
    private GameObject CreatePage(Transform parent, string name, float top, float bottom)
    {
        var go = new GameObject(name, typeof(RectTransform));
        go.transform.SetParent(parent, false);
        var rt = (RectTransform)go.transform;
        rt.anchorMin = new Vector2(0.5f, 0.5f);
        rt.anchorMax = new Vector2(0.5f, 0.5f);
        rt.pivot = new Vector2(0.5f, -SubPageAuthoredBottom / AuthoredSpan);
        rt.sizeDelta = new Vector2(_panelSize.x, AuthoredSpan);
        rt.anchoredPosition = new Vector2(0, top - (SubPageAuthoredTop + AuthoredMid) * _subPageContentScale);
        PauseMenuHelper.IgnoreLayout(go);
        go.AddComponent<RectMask2D>();
        return go;
    }

    private void BuildTabBar(Transform root, TMP_FontAsset font, float y, string[] labels)
    {
        float barWidth = _panelSize.x - 60f;
        float tabWidth = barWidth / labels.Length;
        float startX = -barWidth / 2f + tabWidth / 2f;

        _tabButtons = new Button[labels.Length];
        for (int i = 0; i < labels.Length; i++)
        {
            int index = i;
            var pos = new Vector2(startX + i * tabWidth, y);
            var tabGo = PanelWidgets.CreateButton(root, font, "Tab_" + labels[i], pos, new Vector2(tabWidth - 8f, 38f), labels[i], 17f);
            PauseMenuHelper.IgnoreLayout(tabGo);
            var btn = tabGo.GetComponent<Button>();
            btn.onClick.AddListener(() => SelectTab(index));
            _tabButtons[i] = btn;
        }

        PanelWidgets.CreateDivider(root, new Vector2(0, y - 24f), _panelSize.x - 40f);
    }

    private void SelectTab(int index)
    {
        for (int i = 0; i < _tabPages.Length; i++)
        {
            _tabPages[i].SetActive(i == index);
            var img = _tabButtons[i].GetComponent<Image>();
            img.color = i == index ? new Color(1f, 0.7f, 0.2f, 0.35f) : PanelWidgets.DefaultButtonBackground;
        }
    }

    private void BuildFooter(Transform root, TMP_FontAsset font, IRechargeHost host, ExampleMod.MyConfig config, float y)
    {
        PanelWidgets.CreateDivider(root, new Vector2(0, y + 30f), _panelSize.x - 40f);

        var pingBtn = PanelWidgets.CreateButton(root, font, "SendPing", new Vector2(-_panelSize.x / 2f + 130f, y), new Vector2(200, 40), "Send a Ping", 16f);
        PauseMenuHelper.IgnoreLayout(pingBtn);
        _pingStatusLabel = PanelWidgets.CreateLabel(root, font, new Vector2(60, y), new Vector2(_panelSize.x - 380f, 28), "",
            fontSize: 13f, color: new Color(0.6f, 1f, 0.6f, 1f), align: TextAlignmentOptions.MidlineLeft);
        pingBtn.GetComponent<Button>().onClick.AddListener(() =>
        {
            host.Log("Ping sent from the hub.");
            host.Events.Emit("recharge.example.ping", "hello from the pause menu");
            _pingStatusLabel.text = "Sent - check Player.log";
        });

        var stats = PanelWidgets.CreateLabel(root, font, new Vector2(0, y - 34f), new Vector2(_panelSize.x - 60f, 22),
            $"Loaded {config.TimesLoaded} time(s) so far - every action here also logs to Player.log.",
            fontSize: 12f, color: new Color(1f, 1f, 1f, 0.45f));
        PauseMenuHelper.IgnoreLayout(stats.gameObject);
    }
}
