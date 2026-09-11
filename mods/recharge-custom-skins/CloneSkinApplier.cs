using System.Collections.Generic;
using System.Reflection;
using UnityEngine;

namespace RechargeCustomSkins
{
    internal static class CloneSkinApplier
    {
        // clonesScript.cloneSprites is real save data - courseScript.save()
        // looks each entry up in spriteLookup.lookup to serialize it, so it
        // must always hold real vanilla Sprite references or autosave throws
        // a KeyNotFoundException and silently aborts. clonesScript's own
        // Update() assigns activeSpriteRenderers[k].sprite = cloneSprites[n]
        // every frame - overwriting that same renderer field afterward (from
        // LateUpdate, which Unity always runs after Update) reskins the
        // visible ghosts without ever touching the array that gets saved.
        private static readonly FieldInfo ActiveSpriteRenderersField =
            typeof(clonesScript).GetField("activeSpriteRenderers", BindingFlags.NonPublic | BindingFlags.Instance);

        private static bool _loggedOnce;

        public static void Apply(Sprite skinSprite)
        {
            if (skinSprite == null) return;
            if (ActiveSpriteRenderersField == null)
            {
                if (!_loggedOnce) { Debug.LogWarning("[CustomSkins] clonesScript.activeSpriteRenderers field not found via reflection"); _loggedOnce = true; }
                return;
            }

            var cloneScripts = Object.FindObjectsByType<clonesScript>(FindObjectsInactive.Include, FindObjectsSortMode.None);
            int totalRenderers = 0;
            foreach (var cs in cloneScripts)
            {
                if (ActiveSpriteRenderersField.GetValue(cs) is List<SpriteRenderer> renderers)
                {
                    totalRenderers += renderers.Count;
                    foreach (var sr in renderers)
                    {
                        if (sr != null) sr.sprite = skinSprite;
                    }
                }
            }

            if (!_loggedOnce && cloneScripts.Length > 0)
            {
                Debug.Log("[CustomSkins] CloneSkinApplier.Apply: found " + cloneScripts.Length + " clonesScript instance(s), " + totalRenderers + " active clone renderer(s) skinned");
                _loggedOnce = true;
            }
        }

        public static void RestoreVanilla()
        {
            // No-op: cloneSprites was never modified, and clonesScript's own
            // Update() reassigns each active clone's real sprite every frame.
        }
    }
}
