using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Recharge.ModApi
{
    // Builds and reuses the blank sub-panels AddPanelRow hands out, keyed by
    // rowName. Panels survive scene loads (parented as siblings of
    // settingsBit, not inside mainBit, which is destroyed each load), so a
    // cached panel's Close button must be rewired to the current mainBit.
    internal static class MenuPanelRegistry
    {
        private static readonly Dictionary<string, GameObject> _panels = new Dictionary<string, GameObject>();

        public static GameObject GetOrCreate(pauseMenuScript menu, string rowName, string label)
        {
            var mainBit = MenuReflection.MainBit(menu);

            if (_panels.TryGetValue(rowName, out var panel) && panel != null)
            {
                RewireCloseButton(panel, backTarget: mainBit);
                return panel;
            }

            panel = BuildBlankPanel(menu, rowName, label, backTarget: mainBit);
            _panels[rowName] = panel;
            return panel;
        }

        private static void RewireCloseButton(GameObject panel, GameObject backTarget)
        {
            Transform closeTransform = null;
            foreach (var t in panel.GetComponentsInChildren<Transform>(true))
            {
                if (t.name == "Close") { closeTransform = t; break; }
            }
            var btn = closeTransform != null ? closeTransform.GetComponent<Button>() : null;
            if (btn == null) return;
            btn.onClick = new Button.ButtonClickedEvent();
            btn.onClick.AddListener(() =>
            {
                panel.SetActive(false);
                backTarget.SetActive(true);
            });
        }

        private static GameObject BuildBlankPanel(pauseMenuScript menu, string rowName, string label, GameObject backTarget)
        {
            var settingsBitGo = MenuReflection.SettingsBit(menu);
            var clone = Object.Instantiate(settingsBitGo, settingsBitGo.transform.parent);
            clone.name = rowName + "Bit";
            clone.SetActive(false);

            var settingsScript = clone.GetComponent<SettingsScript>();
            if (settingsScript != null) Object.Destroy(settingsScript);

            Transform title = null;
            foreach (Transform child in clone.transform)
            {
                if (child.name != "Settings") continue;
                title = child;
                break;
            }
            if (title == null && clone.transform.childCount > 0) title = clone.transform.GetChild(0);

            var toDestroy = new List<GameObject>();
            foreach (Transform child in clone.transform)
            {
                if (child != title) toDestroy.Add(child.gameObject);
            }
            foreach (var go in toDestroy) Object.Destroy(go);

            if (title != null)
            {
                var titleTmp = title.GetComponent<TMP_Text>();
                if (titleTmp != null) titleTmp.text = label;
                var loc = title.GetComponent<UnityEngine.Localization.Components.LocalizeStringEvent>();
                if (loc != null) Object.DestroyImmediate(loc);

                var closeBtn = title.Find("Close");
                if (closeBtn != null)
                {
                    MenuUiUtil.SetButtonLabel(closeBtn.gameObject, "Back");
                    var btn = closeBtn.GetComponent<Button>();
                    btn.onClick = new Button.ButtonClickedEvent();
                    btn.onClick.AddListener(() =>
                    {
                        clone.SetActive(false);
                        backTarget.SetActive(true);
                    });
                }
            }

            return clone;
        }
    }
}
