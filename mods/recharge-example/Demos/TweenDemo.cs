using UnityEngine;
using UnityEngine.UI;
using DG.Tweening;

// DOTween.dll ships with every mod's Managed dir already, no bundling needed.
// Only the core module is linked in this build though - not UI/Sprite/Audio -
// so a Graphic's color is faded via the generic DOTween.To instead of the
// unavailable Image.DOFade/DOColor shortcuts.
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
