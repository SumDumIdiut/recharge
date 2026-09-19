using System.Collections.Generic;
using System.Reflection;
using UnityEngine;

namespace RechargeCustomSkins
{
    internal static class CloneSkinApplier
    {
        // cloneSprites is real save data and must stay untouched or autosave throws.
        private static readonly FieldInfo ActiveSpriteRenderersField =
            typeof(clonesScript).GetField("activeSpriteRenderers", BindingFlags.NonPublic | BindingFlags.Instance);

        private static bool _loggedMissingField;
        private static int _lastLoggedStatsKey = -1;

        public static void Apply(SkinController controller, SkinRuntime runtime)
        {
            if (runtime == null) return;
            if (ActiveSpriteRenderersField == null)
            {
                if (!_loggedMissingField) { Debug.LogWarning("[CustomSkins] clonesScript.activeSpriteRenderers field not found via reflection"); _loggedMissingField = true; }
                return;
            }

            var cloneScripts = Object.FindObjectsByType<clonesScript>(FindObjectsInactive.Include, FindObjectsSortMode.None);
            int totalRenderers = 0;
            int matched = 0;
            foreach (var cs in cloneScripts)
            {
                if (!(ActiveSpriteRenderersField.GetValue(cs) is List<SpriteRenderer> renderers)) continue;
                foreach (var sr in renderers)
                {
                    if (sr == null) continue;
                    totalRenderers++;
                    if (runtime.IsSheet)
                    {
                        if (controller.TryGetVanillaRowFrame(sr.sprite, sr.flipY, out var m))
                        {
                            sr.sprite = controller.GetCustomCellSprite(runtime, m.row, m.frame);
                            if (m.flipY) sr.flipY = false;
                            matched++;
                        }
                    }
                    else if (runtime.FlatSprite != null)
                    {
                        sr.sprite = runtime.FlatSprite;
                        matched++;
                    }
                }
            }

            int statsKey = cloneScripts.Length * 100000 + totalRenderers * 1000 + matched;
            if (statsKey != _lastLoggedStatsKey)
            {
                _lastLoggedStatsKey = statsKey;
                Debug.Log("[CustomSkins] CloneSkinApplier.Apply: " + cloneScripts.Length + " clonesScript instance(s), " + totalRenderers + " active renderer(s), " + matched + " matched+skinned");
            }
        }

        public static void RestoreVanilla()
        {
        }
    }
}
