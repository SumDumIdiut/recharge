using System.Collections.Generic;
using Recharge.ModApi;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

internal static class MpMenuBuilder
{
	public static void Install(pauseMenuScript menu)
	{
		MpNetworkManager.GetOrCreate();

		if (menu.mainBitPublic == null || menu.settingsBitPublic == null) return;

		var mpPanel = BuildPanel(menu, backTarget: menu.mainBitPublic);
		PauseMenuHelper.AddRow(menu, "Multiplayer", "DOTnet", () => mpPanel.SetActive(true));

		MpNetworkManager.LatestMainBit = menu.mainBitPublic;
		MpNetworkManager.LatestMpPanel = mpPanel;
	}

	private static void SetButtonLabel(GameObject buttonGo, string text)
	{
		var label = buttonGo.transform.Find("Text (TMP)");
		if (label == null) return;
		var loc = label.GetComponent<UnityEngine.Localization.Components.LocalizeStringEvent>();
		if (loc != null) Object.DestroyImmediate(loc);
		var tmp = label.GetComponent<TMP_Text>();
		if (tmp != null) tmp.text = text;
	}

	private static GameObject BuildPanel(pauseMenuScript menu, GameObject backTarget)
	{
		var existing = menu.settingsBitPublic.transform.parent.Find("MultiplayerBit");
		if (existing != null) return existing.gameObject;

		var clone = Object.Instantiate(menu.settingsBitPublic, menu.settingsBitPublic.transform.parent);
		clone.name = "MultiplayerBit";
		clone.SetActive(false);

		var settingsScript = clone.GetComponent<SettingsScript>();
		if (settingsScript != null) Object.Destroy(settingsScript);

		Transform title = null;
		var toDestroy = new List<GameObject>();
		foreach (Transform child in clone.transform)
		{
			if (child.name == "Settings") { title = child; continue; }
			toDestroy.Add(child.gameObject);
		}
		foreach (var go in toDestroy) Object.Destroy(go);

		TMP_FontAsset font = null;
		if (title != null)
		{
			var titleTmp = title.GetComponent<TMP_Text>();
			if (titleTmp != null) { titleTmp.text = "DOTnet"; font = titleTmp.font; }
			var loc = title.GetComponent<UnityEngine.Localization.Components.LocalizeStringEvent>();
			if (loc != null) Object.DestroyImmediate(loc);

			var closeBtn = title.Find("Close");
			if (closeBtn != null)
			{
				SetButtonLabel(closeBtn.gameObject, "Back");
				var btn = closeBtn.GetComponent<Button>();
				btn.onClick = new Button.ButtonClickedEvent();
				btn.onClick.AddListener(() =>
				{
					clone.SetActive(false);
					backTarget.SetActive(true);
				});
			}
		}

		var ui = clone.AddComponent<MpPanelUI>();
		ui.Build(clone, font, settingsButtonTemplate: menu.mainBitPublic.transform.Find("Settings").gameObject, menu);
		return clone;
	}
}
