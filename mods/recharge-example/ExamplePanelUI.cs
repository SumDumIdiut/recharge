using System;
using TMPro;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;
using Recharge.ModApi;

// AddPanelRow only hands back a blank panel with a title and a Close button -
// everything else here is built by hand, the same way any real mod does it.
internal class ExamplePanelUI : MonoBehaviour
{
    private TMP_FontAsset _font;

    public void Build(GameObject panel, TMP_FontAsset font, IRechargeHost host, ExampleMod.MyConfig config, string modId)
    {
        _font = font;
        var root = panel.transform;

        var panelRt = panel.GetComponent<RectTransform>();
        if (panelRt != null) panelRt.sizeDelta = new Vector2(620f, 540f);

        var header = CreateLabel(root, "DemoHeader", new Vector2(0, 165), new Vector2(560, 30), "Interactive demo");
        header.fontSize = 22;
        header.color = new Color(1f, 1f, 1f, 0.65f);

        var infoLabel = CreateLabel(root, "InfoLabel", new Vector2(0, 128), new Vector2(560, 26), "");
        infoLabel.fontSize = 16;
        infoLabel.color = new Color(1f, 1f, 1f, 0.8f);
        Action refreshInfo = () => infoLabel.text = $"Loaded {config.TimesLoaded} time(s) · clicked {config.TimesClicked} time(s)";
        refreshInfo();

        CreateDivider(root, new Vector2(0, 100), 560);

        var clickGo = CreateButton(root, "ClickMe", new Vector2(0, 55), new Vector2(220, 54), $"Click me ({config.TimesClicked})", 20f, Color.white);
        PauseMenuHelper.ScaleButtonFontSize(clickGo, 1.1f);
        PauseMenuHelper.SetButtonTextColor(clickGo, new Color(1f, 0.85f, 0.4f));
        clickGo.GetComponent<Button>().onClick.AddListener(() =>
        {
            config.TimesClicked++;
            host.SaveConfig(modId, config);
            PauseMenuHelper.SetButtonLabel(clickGo, $"Click me ({config.TimesClicked})");
            refreshInfo();
            if (config.TimesClicked % 5 == 0)
                host.Events.Emit("recharge.example.buttonClicked", config.TimesClicked);
        });

        CreateDivider(root, new Vector2(0, 10), 560);

        var sayHeader = CreateLabel(root, "SayHeader", new Vector2(0, -20), new Vector2(560, 26), "Say something");
        sayHeader.fontSize = 18;
        sayHeader.color = new Color(1f, 1f, 1f, 0.65f);

        var input = CreateInputField(root, new Vector2(-100, -60), new Vector2(340, 44), "Type here...");
        var sayGo = CreateButton(root, "SayIt", new Vector2(150, -60), new Vector2(150, 44), "Say it", 18f, Color.white);

        var responseLabel = CreateLabel(root, "ResponseLabel", new Vector2(0, -100), new Vector2(560, 26), "");
        responseLabel.fontSize = 15;
        responseLabel.color = new Color(0.6f, 1f, 0.6f, 1f);
        responseLabel.enableWordWrapping = false;
        responseLabel.overflowMode = TextOverflowModes.Ellipsis;

        Action say = () =>
        {
            var text = input.text.Trim();
            if (string.IsNullOrEmpty(text)) return;
            host.Log($"You said: {text}");
            host.Events.Emit("recharge.example.echo", text);
            responseLabel.text = $"Echoed: \"{text}\"";
            input.text = "";
        };
        sayGo.GetComponent<Button>().onClick.AddListener(() => say());
        input.onSubmit.AddListener(_ => say());

        CreateDivider(root, new Vector2(0, -130), 560);

        var imageHeader = CreateLabel(root, "ImageHeader", new Vector2(0, -160), new Vector2(560, 26), "Custom image (host.LoadSprite)");
        imageHeader.fontSize = 18;
        imageHeader.color = new Color(1f, 1f, 1f, 0.65f);

        var image = CreateImage(root, new Vector2(-220, -215), new Vector2(72, 72));
        image.sprite = BuildDemoSprite(host);

        var caption = CreateLabel(root, "ImageCaption", new Vector2(70, -215), new Vector2(360, 60),
            "This icon was generated in-memory (a checkerboard Texture2D), PNG-encoded, then handed to host.LoadSprite - a real mod would usually ship an actual .png in its data folder instead.");
        caption.fontSize = 13;
        caption.color = new Color(1f, 1f, 1f, 0.7f);
        caption.alignment = TextAlignmentOptions.TopLeft;
        caption.enableWordWrapping = true;
    }

    private Sprite BuildDemoSprite(IRechargeHost host)
    {
        const int size = 32;
        var tex = new Texture2D(size, size, TextureFormat.RGBA32, false);
        var from = new Color(1f, 0.45f, 0.1f);
        var to = new Color(0.2f, 0.6f, 1f);
        for (int y = 0; y < size; y++)
        {
            for (int x = 0; x < size; x++)
            {
                bool checker = ((x / 4) + (y / 4)) % 2 == 0;
                var baseColor = Color.Lerp(from, to, (float)x / (size - 1));
                var pixel = checker ? baseColor : baseColor * 0.6f;
                pixel.a = 1f;
                tex.SetPixel(x, y, pixel);
            }
        }
        tex.Apply();
        var pngBytes = ImageConversion.EncodeToPNG(tex);
        Destroy(tex);
        return host.LoadSprite(pngBytes);
    }

    private GameObject CreateButton(Transform parent, string name, Vector2 anchoredPos, Vector2 size, string label, float fontSize, Color color)
    {
        var go = new GameObject(name, typeof(RectTransform));
        go.transform.SetParent(parent, false);
        var rt = (RectTransform)go.transform;
        rt.anchoredPosition = anchoredPos;
        rt.sizeDelta = size;

        var img = go.AddComponent<Image>();
        var baseColor = new Color(1f, 1f, 1f, 0.08f);
        img.color = baseColor;

        var btn = go.AddComponent<Button>();
        btn.targetGraphic = img;

        var trigger = go.AddComponent<EventTrigger>();
        var enter = new EventTrigger.Entry { eventID = EventTriggerType.PointerEnter };
        enter.callback.AddListener(_ => img.color = new Color(1f, 1f, 1f, 0.18f));
        trigger.triggers.Add(enter);
        var exit = new EventTrigger.Entry { eventID = EventTriggerType.PointerExit };
        exit.callback.AddListener(_ => img.color = baseColor);
        trigger.triggers.Add(exit);

        var textGo = new GameObject("Text (TMP)", typeof(RectTransform));
        textGo.transform.SetParent(go.transform, false);
        var textRt = (RectTransform)textGo.transform;
        textRt.anchorMin = Vector2.zero;
        textRt.anchorMax = Vector2.one;
        textRt.offsetMin = Vector2.zero;
        textRt.offsetMax = Vector2.zero;
        var tmp = textGo.AddComponent<TextMeshProUGUI>();
        tmp.font = _font;
        tmp.fontSize = fontSize;
        tmp.alignment = TextAlignmentOptions.Center;
        tmp.color = color;
        tmp.text = label;
        tmp.enableWordWrapping = false;
        tmp.overflowMode = TextOverflowModes.Ellipsis;

        return go;
    }

    private TMP_Text CreateLabel(Transform parent, string name, Vector2 anchoredPos, Vector2 size, string text)
    {
        var go = new GameObject(name, typeof(RectTransform));
        go.transform.SetParent(parent, false);
        var rt = (RectTransform)go.transform;
        rt.anchoredPosition = anchoredPos;
        rt.sizeDelta = size;
        var tmp = go.AddComponent<TextMeshProUGUI>();
        tmp.font = _font;
        tmp.fontSize = 24;
        tmp.alignment = TextAlignmentOptions.Center;
        tmp.color = Color.white;
        tmp.text = text;
        return tmp;
    }

    private GameObject CreateDivider(Transform parent, Vector2 anchoredPos, float width)
    {
        var go = new GameObject("Divider", typeof(RectTransform));
        go.transform.SetParent(parent, false);
        var rt = (RectTransform)go.transform;
        rt.anchoredPosition = anchoredPos;
        rt.sizeDelta = new Vector2(width, 2);
        var img = go.AddComponent<Image>();
        img.color = new Color(1f, 1f, 1f, 0.15f);
        return go;
    }

    private Image CreateImage(Transform parent, Vector2 anchoredPos, Vector2 size)
    {
        var go = new GameObject("Image", typeof(RectTransform));
        go.transform.SetParent(parent, false);
        var rt = (RectTransform)go.transform;
        rt.anchoredPosition = anchoredPos;
        rt.sizeDelta = size;
        var img = go.AddComponent<Image>();
        img.preserveAspect = true;
        return img;
    }

    private TMP_InputField CreateInputField(Transform parent, Vector2 anchoredPos, Vector2 size, string placeholder)
    {
        var go = new GameObject("InputField", typeof(RectTransform));
        go.transform.SetParent(parent, false);
        var rt = (RectTransform)go.transform;
        rt.anchoredPosition = anchoredPos;
        rt.sizeDelta = size;
        go.AddComponent<Image>().color = new Color(1f, 1f, 1f, 0.08f);

        var textArea = new GameObject("Text Area", typeof(RectTransform));
        textArea.transform.SetParent(go.transform, false);
        var textAreaRt = (RectTransform)textArea.transform;
        textAreaRt.anchorMin = Vector2.zero;
        textAreaRt.anchorMax = Vector2.one;
        textAreaRt.offsetMin = new Vector2(12, 2);
        textAreaRt.offsetMax = new Vector2(-12, -2);
        textArea.AddComponent<RectMask2D>();

        var textGo = new GameObject("Text", typeof(RectTransform));
        textGo.transform.SetParent(textArea.transform, false);
        var textRt = (RectTransform)textGo.transform;
        textRt.anchorMin = Vector2.zero;
        textRt.anchorMax = Vector2.one;
        textRt.offsetMin = Vector2.zero;
        textRt.offsetMax = Vector2.zero;
        var text = textGo.AddComponent<TextMeshProUGUI>();
        text.font = _font;
        text.fontSize = 18;
        text.color = Color.white;
        text.alignment = TextAlignmentOptions.MidlineLeft;
        text.enableWordWrapping = false;

        var placeholderGo = new GameObject("Placeholder", typeof(RectTransform));
        placeholderGo.transform.SetParent(textArea.transform, false);
        var placeholderRt = (RectTransform)placeholderGo.transform;
        placeholderRt.anchorMin = Vector2.zero;
        placeholderRt.anchorMax = Vector2.one;
        placeholderRt.offsetMin = Vector2.zero;
        placeholderRt.offsetMax = Vector2.zero;
        var placeholderText = placeholderGo.AddComponent<TextMeshProUGUI>();
        placeholderText.font = _font;
        placeholderText.fontSize = 18;
        placeholderText.color = new Color(1f, 1f, 1f, 0.4f);
        placeholderText.text = placeholder;
        placeholderText.fontStyle = FontStyles.Italic;
        placeholderText.alignment = TextAlignmentOptions.MidlineLeft;

        var input = go.AddComponent<TMP_InputField>();
        input.textViewport = textAreaRt;
        input.textComponent = text;
        input.placeholder = placeholderText;
        input.text = "";
        return input;
    }
}
