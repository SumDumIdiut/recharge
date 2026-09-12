using System;
using Recharge.ModApi;
using TMPro;
using UnityEngine;

namespace RechargeCustomSkins
{
    public class RechargeCustomSkinsMod : IRechargeMod
    {
        public const string ModId = "recharge.customskins";

        public string Id => ModId;
        public string DisplayName => "Custom Skins";
        public Version Version => new Version(1, 0, 0);

        private SkinController _controller;

        public void OnLoad(IRechargeHost host)
        {
            var go = new GameObject("SkinController");
            UnityEngine.Object.DontDestroyOnLoad(go);
            _controller = go.AddComponent<SkinController>();
            _controller.Init(host);

            host.Events.On(RechargeEvents.SceneLoaded, _ =>
            {
                var menu = UnityEngine.Object.FindFirstObjectByType<pauseMenuScript>();
                if (menu != null) InstallMenuRow(menu);
            });
        }

        private void InstallMenuRow(pauseMenuScript menu)
        {
            if (menu.mainBitPublic == null) return;
            var panel = PauseMenuHelper.AddPanelRow(menu, "CustomSkins", "Custom Skins");
            if (panel == null) return;
            if (panel.GetComponent<SkinPanelUI>() != null) return;

            var title = panel.transform.Find("Settings") ?? (panel.transform.childCount > 0 ? panel.transform.GetChild(0) : null);
            var font = title != null ? title.GetComponent<TMP_Text>()?.font : null;

            var ui = panel.AddComponent<SkinPanelUI>();
            ui.Build(panel, font, _controller);
        }

        public void OnUnload() { }
    }
}
