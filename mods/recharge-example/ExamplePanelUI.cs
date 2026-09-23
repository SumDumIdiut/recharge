using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;
using Recharge.ModApi;

// AddPanelRow only hands back a blank panel with a title and a Close button -
// everything else here is built from PanelWidgets, the same way any real
// mod does it.
internal class ExamplePanelUI : MonoBehaviour
{
    public void Build(GameObject panel, TMP_FontAsset font, IRechargeHost host, ExampleMod.MyConfig config, string modId)
    {
        var root = panel.transform;

        PanelWidgets.CreateLabel(root, font, new Vector2(0, 310), new Vector2(560, 30), "Interactive demo",
            fontSize: 22f, color: new Color(1f, 1f, 1f, 0.65f));

        var infoLabel = PanelWidgets.CreateLabel(root, font, new Vector2(0, 273), new Vector2(560, 26), "",
            fontSize: 16f, color: new Color(1f, 1f, 1f, 0.8f));
        Action refreshInfo = () => infoLabel.text = $"Loaded {config.TimesLoaded} time(s) · clicked {config.TimesClicked} time(s)";
        refreshInfo();

        PanelWidgets.CreateDivider(root, new Vector2(0, 245), 560);

        var clickGo = PanelWidgets.CreateButton(root, font, "ClickMe", new Vector2(0, 200), new Vector2(220, 54), $"Click me ({config.TimesClicked})", 20f);
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

        PanelWidgets.CreateDivider(root, new Vector2(0, 155), 560);

        PanelWidgets.CreateLabel(root, font, new Vector2(0, 125), new Vector2(560, 26), "Say something",
            fontSize: 18f, color: new Color(1f, 1f, 1f, 0.65f));

        var input = PanelWidgets.CreateInputField(root, font, new Vector2(-100, 85), new Vector2(340, 44), "Type here...");
        var sayGo = PanelWidgets.CreateButton(root, font, "SayIt", new Vector2(150, 85), new Vector2(150, 44), "Say it", 18f);

        var responseLabel = PanelWidgets.CreateLabel(root, font, new Vector2(0, 45), new Vector2(560, 26), "",
            fontSize: 15f, color: new Color(0.6f, 1f, 0.6f, 1f));
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

        PanelWidgets.CreateDivider(root, new Vector2(0, 15), 560);

        PanelWidgets.CreateLabel(root, font, new Vector2(0, -15), new Vector2(560, 26), "Custom image (host.LoadSprite)",
            fontSize: 18f, color: new Color(1f, 1f, 1f, 0.65f));

        var image = PanelWidgets.CreateImage(root, new Vector2(-220, -70), new Vector2(72, 72));
        image.sprite = BuildDemoSprite(host);

        var caption = PanelWidgets.CreateLabel(root, font, new Vector2(70, -70), new Vector2(360, 60),
            "This icon was generated in-memory (a checkerboard Texture2D), PNG-encoded, then handed to host.LoadSprite - a real mod would usually ship an actual .png in its data folder instead.",
            fontSize: 13f, color: new Color(1f, 1f, 1f, 0.7f), align: TextAlignmentOptions.TopLeft);
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

}
