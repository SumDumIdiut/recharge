using TMPro;
using UnityEngine;

namespace Recharge.ModApi
{
    /// <summary>
    /// Owns the text of a TMP label a mod has taken over - usually a button
    /// cloned from a vanilla one (the pause menu's "Settings" button is the
    /// usual template). Taking a label over strips every Unity Localization
    /// component in the button (LocalizeStringEvent, GameObjectLocalizer...),
    /// and if the label is ever reset back to the text the template carried
    /// (e.g. "Settings"), it's restored and the reset is logged once, so the
    /// culprit shows up in Player.log. A mod writing its own new text to
    /// .text directly is left alone - only a revert to the template's text
    /// counts as a reset.
    /// </summary>
    public sealed class ModLabel : MonoBehaviour
    {
        private TMP_Text _tmp;
        private string _text;
        private string _templateText;
        private bool _warned;

        public string Text
        {
            get => _text;
            set
            {
                _text = value ?? "";
                if (_tmp != null) _tmp.text = _text;
            }
        }

        /// <summary>Takes over <paramref name="tmp"/> and sets its text; safe to call repeatedly.</summary>
        public static ModLabel Attach(TMP_Text tmp, string text)
        {
            if (tmp == null) return null;
            var label = tmp.GetComponent<ModLabel>();
            if (label == null)
            {
                StripLocalizers(tmp.gameObject);
                label = tmp.gameObject.AddComponent<ModLabel>();
                label._tmp = tmp;
                label._templateText = tmp.text;
            }
            label.Text = text;
            return label;
        }

        /// <summary>Takes over a button's "Text (TMP)" label; null if the button has none.</summary>
        public static ModLabel ForButton(GameObject buttonGo, string text)
        {
            if (buttonGo == null) return null;
            var labelT = buttonGo.transform.Find("Text (TMP)");
            var tmp = labelT != null ? labelT.GetComponent<TMP_Text>() : null;
            if (tmp == null)
            {
                Debug.LogWarning($"[Recharge] ModLabel: '{buttonGo.name}' has no \"Text (TMP)\" label to set to '{text}'");
                return null;
            }
            if (tmp.GetComponent<ModLabel>() == null) StripLocalizers(buttonGo);
            return Attach(tmp, text);
        }

        /// <summary>Destroys every Unity Localization component on <paramref name="root"/> and its children (inactive included).</summary>
        public static void StripLocalizers(GameObject root)
        {
            if (root == null) return;
            foreach (var loc in root.GetComponentsInChildren<UnityEngine.Localization.Components.LocalizedMonoBehaviour>(true))
                Object.DestroyImmediate(loc);
            foreach (var loc in root.GetComponentsInChildren<UnityEngine.Localization.PropertyVariants.GameObjectLocalizer>(true))
                Object.DestroyImmediate(loc);
        }

        private void OnEnable() => Guard();
        private void LateUpdate() => Guard();

        private void Guard()
        {
            if (_tmp == null || _text == null) return;
            if (_tmp.text == _text || _tmp.text != _templateText || _templateText == _text) return;
            if (!_warned)
            {
                _warned = true;
                Debug.LogWarning($"[Recharge] ModLabel: '{PathOf(transform)}' was reset to '{_templateText}' - restoring '{_text}'");
            }
            _tmp.text = _text;
        }

        private static string PathOf(Transform t)
        {
            var path = t.name;
            for (var p = t.parent; p != null; p = p.parent) path = p.name + "/" + path;
            return path;
        }
    }
}
