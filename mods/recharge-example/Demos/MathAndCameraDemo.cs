using UnityEngine;
using Recharge.ModApi;

// Small math helpers gameplay/UI mods reach for constantly, plus a
// world-to-screen-space conversion for floating markers/health bars.
internal static class MathAndCameraDemo
{
    public static float EaseOutCubic(float t) => 1f - Mathf.Pow(1f - Mathf.Clamp01(t), 3f);

    // A framerate-independent "catch up to target" smoother - unlike a fixed
    // Lerp(a, b, 0.1f) called every frame, this converges at the same real-
    // world speed regardless of the current frame rate.
    public static float SmoothTowards(float current, float target, float halfLifeSeconds, float deltaTime)
    {
        if (halfLifeSeconds <= 0f) return target;
        var decay = Mathf.Pow(0.5f, deltaTime / halfLifeSeconds);
        return Mathf.Lerp(target, current, decay);
    }

    public static bool TryWorldToScreen(Camera camera, Vector3 worldPosition, out Vector2 screenPosition)
    {
        screenPosition = Vector2.zero;
        if (camera == null) return false;
        var point = camera.WorldToScreenPoint(worldPosition);
        if (point.z < 0f) return false;
        screenPosition = point;
        return true;
    }
}

// Pins a UI RectTransform above a moving world Transform. Add via
// AddComponent, then call Follow().
internal class WorldToUiFollower : MonoBehaviour
{
    private RectTransform _uiTarget;
    private Transform _worldTarget;
    private Canvas _canvas;
    private Vector3 _worldOffset = Vector3.up * 2f;

    public void Follow(RectTransform uiTarget, Transform worldTarget, Canvas canvas)
    {
        _uiTarget = uiTarget;
        _worldTarget = worldTarget;
        _canvas = canvas;
    }

    public void StopFollowing() => _worldTarget = null;

    private void LateUpdate()
    {
        if (_worldTarget == null || _uiTarget == null || _canvas == null) return;

        var camera = _canvas.renderMode == RenderMode.ScreenSpaceOverlay ? null : _canvas.worldCamera;
        if (!MathAndCameraDemo.TryWorldToScreen(Camera.main, _worldTarget.position + _worldOffset, out var screenPoint))
        {
            _uiTarget.gameObject.SetActive(false);
            return;
        }
        _uiTarget.gameObject.SetActive(true);

        var canvasRt = (RectTransform)_canvas.transform;
        if (RectTransformUtility.ScreenPointToLocalPointInRectangle(canvasRt, screenPoint, camera, out var localPoint))
            _uiTarget.anchoredPosition = localPoint;
    }
}
