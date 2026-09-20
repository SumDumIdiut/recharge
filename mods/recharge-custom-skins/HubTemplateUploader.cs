using System.Collections;
using System.Collections.Generic;
using System.IO;
using Recharge.ModApi;
using UnityEngine;
using UnityEngine.Networking;

namespace RechargeCustomSkins
{
    // Uploads a freshly-exported skin template (the reference image + its
    // sounds/ folder) to the hub, so the desktop app's Export Template button
    // can hand it out without the game needing to be running. Best-effort -
    // a failed upload doesn't affect the local export the player already got,
    // and there's only ever one template stored hub-side (this replaces it).
    internal static class HubTemplateUploader
    {
        private const string UploadUrl = "https://codecade.co.za/recharge/api/skin-template";

        public static void Upload(MonoBehaviour coroutineHost, IRechargeHost host, string pngPath, string soundsDir)
        {
            coroutineHost.StartCoroutine(UploadRoutine(host, pngPath, soundsDir));
        }

        private static IEnumerator UploadRoutine(IRechargeHost host, string pngPath, string soundsDir)
        {
            var form = new List<IMultipartFormSection>
            {
                new MultipartFormFileSection("image", File.ReadAllBytes(pngPath), "skin-template.png", "image/png"),
            };

            if (Directory.Exists(soundsDir))
            {
                foreach (var file in Directory.EnumerateFiles(soundsDir))
                    form.Add(new MultipartFormFileSection("sounds", File.ReadAllBytes(file), Path.GetFileName(file), "audio/wav"));
            }

            using var req = UnityWebRequest.Post(UploadUrl, form);
            yield return req.SendWebRequest();

            if (req.result != UnityWebRequest.Result.Success)
            {
                host.LogWarning($"[CustomSkins] couldn't upload the skin template to the hub: {req.error}");
                yield break;
            }
            host.Log("[CustomSkins] uploaded the skin template to the hub.");
        }
    }
}
