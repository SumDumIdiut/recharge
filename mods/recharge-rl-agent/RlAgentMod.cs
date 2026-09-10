using System;
using Recharge.ModApi;
using UnityEngine;

namespace RechargeRlAgent
{
    public class RlAgentMod : IRechargeMod
    {
        public const string ModId = "recharge.rlagent";

        public string Id => ModId;
        public string DisplayName => "RL Speedrunner";
        public Version Version => new Version(1, 0, 0);

        public void OnLoad(IRechargeHost host)
        {
            var go = new GameObject("RlAgentController");
            UnityEngine.Object.DontDestroyOnLoad(go);
            var controller = go.AddComponent<RlAgentController>();
            controller.Init(host);

            // Every scene load creates a fresh, undecorated pauseMenuScript -
            // reinstall the row each time, same as recharge-multiplayer does.
            host.Events.On(RechargeEvents.SceneLoaded, _ =>
            {
                var menu = UnityEngine.Object.FindFirstObjectByType<pauseMenuScript>();
                if (menu != null) controller.InstallMenuRow(menu);
            });
        }

        public void OnUnload() { }
    }
}
