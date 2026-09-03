using TMPro;
using UnityEngine;
using UnityEngine.UI;

internal class MpChatKeybindRow : MonoBehaviour
{
	private TMP_Text _keyText;

	public void Init(TMP_Text keyText, Button keyButton)
	{
		_keyText = keyText;
		keyButton.onClick.RemoveAllListeners();
		keyButton.onClick.AddListener(MpInGameChatHud.BeginRebind);
	}

	private void Update()
	{
		if (_keyText == null) return;
		_keyText.text = MpInGameChatHud.IsRebinding ? "..." : MpInGameChatHud.ChatKeyName.ToUpperInvariant();
	}
}
