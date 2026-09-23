using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Recharge.ModApi;
using UnityEngine;

namespace RechargeCustomSkins
{
    // Describes the live, per-frame layout of the animations a skin sheet can
    // cover. Row set/order is fixed (SupportedRowClipNames) so it always
    // matches the static template - no live-discovered row count/order to
    // drift out of sync with a file someone painted earlier.
    internal struct SkinGridLayout
    {
        public int Cols;
        public int Rows;
        public List<(string name, int frameCount)> RowClips;
        public List<List<Sprite>> RowFrameSprites;
    }

    internal static class TemplateGrid
    {
        // Must match the static skin-template.png's row order/set (built from
        // Downloads/Character, which doesn't have mantle/chinStanding/Die).
        public static readonly string[] SupportedRowClipNames = { "Idle", "run", "Fall", "Jump", "wallPose", "Dash" };

        // Sampling every clip's every frame back-to-back in one synchronous
        // call is a real allocation burst (Object.Instantiate + dozens of
        // Animator.Play/Update calls) - spreading it across a few frames
        // (one yield per clip) meaningfully lowers peak GC pressure at the
        // moment it runs, which matters on this game's Wine/Proton build
        // (see the SuspendThread crash class documented elsewhere in this repo).
        public static IEnumerator ComputeLayoutCoroutine(GameObject spriteChildTemplate, IRechargeHost host, Action<SkinGridLayout?> onDone)
        {
            var animator = spriteChildTemplate.GetComponent<Animator>();
            if (animator == null || animator.runtimeAnimatorController == null) { onDone(null); yield break; }

            var byName = animator.runtimeAnimatorController.animationClips
                .Where(c => c != null)
                .GroupBy(c => c.name)
                .ToDictionary(g => g.Key, g => g.First());
            var clips = SupportedRowClipNames.Where(byName.ContainsKey).Select(n => byName[n]).ToList();
            if (clips.Count == 0)
            {
                host.LogWarning("[CustomSkins] none of the supported clips (" + string.Join(", ", SupportedRowClipNames) + ") were found on the controller");
                onDone(null);
                yield break;
            }

            var farPos = new Vector3(70000f, 70000f, 0f);
            var clone = UnityEngine.Object.Instantiate(spriteChildTemplate, farPos, Quaternion.identity);
            clone.SetActive(true);
            var cloneAnimator = clone.GetComponent<Animator>();
            var cloneRenderer = clone.GetComponent<SpriteRenderer>();

            var rowClips = new List<(string, int)>();
            var rowFrameSprites = new List<List<Sprite>>();
            foreach (var clip in clips)
            {
                var frames = new List<Sprite>();
                int steps = Mathf.Max(1, Mathf.RoundToInt(clip.length * clip.frameRate));
                for (int i = 0; i <= steps; i++)
                {
                    float t = steps == 0 ? 0f : (float)i / steps;
                    cloneAnimator.Play(clip.name, 0, t);
                    cloneAnimator.Update(0f);
                    var s = cloneRenderer.sprite;
                    if (s != null && (frames.Count == 0 || frames[frames.Count - 1] != s))
                        frames.Add(s);
                }
                if (frames.Count > 0)
                {
                    rowClips.Add((clip.name, frames.Count));
                    rowFrameSprites.Add(frames);
                }
                yield return null;
            }
            UnityEngine.Object.Destroy(clone);

            if (rowClips.Count == 0) { onDone(null); yield break; }

            onDone(new SkinGridLayout
            {
                Cols = rowClips.Max(c => c.Item2),
                Rows = rowClips.Count,
                RowClips = rowClips,
                RowFrameSprites = rowFrameSprites,
            });
        }
    }
}
