using UnityEngine;
using UnityEngine.UI;
using DG.Tweening;

// DOTween is already a dependency of the base game (every mod's Managed dir
// carries DOTween.dll), so no extra bundling is needed to use it here. Only
// the core module is linked into this build - not the UI/Sprite/Audio
// convenience modules - so a Graphic's color is animated through the fully
// generic DOTween.To(getter, setter, target, duration) instead of a
// shortcut like Image.DOFade/DOColor, which aren't available.
internal static class TweenDemo
{
    public static void Punch(Transform target)
    {
        target.DOKill();
        target.DOPunchScale(Vector3.one * 0.25f, 0.35f, vibrato: 8, elasticity: 0.6f);
    }

    public static void FadeOutIn(Graphic graphic, float duration = 0.4f)
    {
        graphic.DOKill();
        var original = graphic.color;
        var faded = original;
        faded.a = 0.1f;
        DOTween.Sequence()
            .Append(DOTween.To(() => graphic.color, c => graphic.color = c, faded, duration / 2f))
            .Append(DOTween.To(() => graphic.color, c => graphic.color = c, original, duration / 2f));
    }

    public static void Bounce(Transform target, float height = 20f)
    {
        target.DOKill();
        var startY = target.localPosition.y;
        DOTween.Sequence()
            .Append(target.DOLocalMoveY(startY + height, 0.2f).SetEase(Ease.OutQuad))
            .Append(target.DOLocalMoveY(startY, 0.35f).SetEase(Ease.OutBounce));
    }
}
