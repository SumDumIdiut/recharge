using System;
using System.Collections.Concurrent;
using System.Threading.Tasks;
using Recharge.Core.Json;
using Recharge.Link;
using Recharge.Loader.Core;
using Recharge.Loader.Core.Skins;
using Recharge.ModApi;
using TMPro;
using UnityEngine;

namespace Recharge.Module.Skins
{
    /// <summary>
    /// SkinMod built into RechargeLoader 2: custom player sprites, dash / double-jump indicators, sounds and the pause-menu
    /// picker. It replaces the hub mod <c>recharge.customskins</c> but keeps that mod's data folder, so installed skins
    /// and the chosen skin carry over. Over the app link it answers the <c>skin.apply</c> intent and reports state <c>skin</c>.
    /// </summary>
    public sealed class SkinsModule : IRechargeMod, IBuiltinModule
    {
        public const string ModuleId = "Skins";

        /// <summary>How long a skin.apply intent waits for the main thread before it is answered with an error.</summary>
        private static readonly TimeSpan ApplyTimeout = TimeSpan.FromSeconds(10);

        private static readonly BuiltinModule Identity = new BuiltinModule(ModuleId, SkinPaths.DataModId, "Skinmod");

        /// <summary>
        /// The loader's own link client, if it owns one (the game has a single channel to the app). When null the module
        /// connects one itself from the RECHARGE_LINK environment variable.
        /// </summary>
        public static LinkClient SharedLink { get; set; }

        private readonly ConcurrentQueue<(string folder, TaskCompletionSource<bool> done)> _applyQueue =
            new ConcurrentQueue<(string, TaskCompletionSource<bool>)>();

        private SkinController _controller;
        private IRechargeHost _host;
        private LinkClient _link;
        private bool _ownsLink;

        public string Id => ModuleId;
        public string Name => "Skinmod";
        public string DisplayName => "Skinmod";
        public string ReplacesModId => SkinPaths.DataModId;
        public string LegacyModId => SkinPaths.DataModId;
        public Version Version => new Version(2, 1, 0);

        public bool Handles(string modId) => Identity.Handles(modId);

        public void OnLoad(IRechargeHost host)
        {
            _host = host;
            var go = new GameObject("SkinController");
            UnityEngine.Object.DontDestroyOnLoad(go);
            _controller = go.AddComponent<SkinController>();
            _controller.Init(host);

            PauseMenuHelper.OnMenuReady(host, InstallMenuRow);
            ConnectLink(host);
        }

        private void ConnectLink(IRechargeHost host)
        {
            try
            {
                _link = SharedLink;
                if (_link == null)
                {
                    _link = LinkClient.FromEnvironment();
                    _ownsLink = _link != null;
                }
                if (_link == null) return; // not launched by the app

                _link.OnIntent(SkinLinkProtocol.ApplyIntent, OnApplyIntent);
                _controller.StateChanged += PublishState;
                host.OnUpdate += DrainApplyQueue;
                PublishState(_controller.CurrentFolder, _controller.CurrentDisplayName);
                if (_ownsLink) _ = _link.ConnectAsync();
            }
            catch (Exception e)
            {
                host.LogWarning("[CustomSkins] couldn't join the app link: " + e.Message);
            }
        }

        private void PublishState(string folder, string name)
        {
            var link = _link;
            if (link == null) return;
            try { _ = link.SetStateAsync(SkinLinkProtocol.StateKey, SkinLinkProtocol.State(folder, name)); }
            catch (Exception e) { _host.LogWarning("[CustomSkins] couldn't report the skin: " + e.Message); }
        }

        // Runs on the link's thread: queue the switch for the main thread and wait for it.
        private async Task OnApplyIntent(JsonNode args)
        {
            string folder = SkinLinkProtocol.ParseApplyArgs(args);
            var done = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            _applyQueue.Enqueue((folder, done));
            var first = await Task.WhenAny(done.Task, Task.Delay(ApplyTimeout)).ConfigureAwait(false);
            if (first != done.Task) throw new TimeoutException("the game did not switch the skin in time");
            if (!await done.Task.ConfigureAwait(false)) throw new InvalidOperationException("no such skin: " + folder);
        }

        private void DrainApplyQueue()
        {
            while (_applyQueue.TryDequeue(out var request))
            {
                try { request.done.TrySetResult(_controller.ApplyFolder(request.folder)); }
                catch (Exception e) { request.done.TrySetException(e); }
            }
        }

        private void InstallMenuRow(pauseMenuScript menu)
        {
            if (PauseMenuHelper.MainBit(menu) == null) return;
            var panel = PauseMenuHelper.AddPanelRow(menu, "CustomSkins", "Skinmod");
            if (panel == null) return;
            if (panel.GetComponent<SkinPanelUI>() != null) return;

            var title = panel.transform.Find("Settings") ?? (panel.transform.childCount > 0 ? panel.transform.GetChild(0) : null);
            var font = title != null ? title.GetComponent<TMP_Text>()?.font : null;

            var ui = panel.AddComponent<SkinPanelUI>();
            try
            {
                ui.Build(panel, font, _controller);
            }
            catch (Exception e)
            {
                _host.LogError("[CustomSkins] couldn't build the skin panel: " + e);
                ShowBuildFailure(panel, font);
            }
        }

        private static void ShowBuildFailure(GameObject panel, TMP_FontAsset font)
        {
            var go = new GameObject("BuildFailure", typeof(RectTransform));
            go.transform.SetParent(panel.transform, false);
            var rt = (RectTransform)go.transform;
            rt.sizeDelta = new Vector2(520f, 200f);
            var text = go.AddComponent<TextMeshProUGUI>();
            text.font = font;
            text.fontSize = 22f;
            text.alignment = TextAlignmentOptions.Center;
            text.text = "Skinmod couldn't build its menu.\nYour Recharge loader is out of date - open the Recharge app and let it finish updating, then restart the game.";
        }

        public void OnUnload()
        {
            if (_host != null) _host.OnUpdate -= DrainApplyQueue;
            if (_controller != null) _controller.StateChanged -= PublishState;
            if (_ownsLink && _link != null) _link.Dispose();
            _link = null;
        }
    }
}
