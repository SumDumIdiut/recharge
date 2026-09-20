using UnityEngine;
using Recharge.ModApi;

// Small math helpers real gameplay/UI mods reach for constantly, plus the
// "world position -> screen-space UI element" conversion a floating marker
// or health bar over an object's head always needs.
internal static class MathAndCameraDemo
{
    public static float EaseOutCubic(float t) => 1f - Mathf.Pow(1f - Mathf.Clamp01(t), 3f);

    public static float EaseInOutSine(float t) => -(Mathf.Cos(Mathf.PI * Mathf.Clamp01(t)) - 1f) / 2f;

    public static Vector2 QuadraticBezier(Vector2 p0, Vector2 p1, Vector2 p2, float t)
    {
        t = Mathf.Clamp01(t);
        var a = Vector2.Lerp(p0, p1, t);
        var b = Vector2.Lerp(p1, p2, t);
        return Vector2.Lerp(a, b, t);
    }

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
        if (point.z < 0f) return false; // behind the camera
        screenPosition = point;
        return true;
    }
}

// Keeps a UI RectTransform (a marker, a name tag, a health bar - anything)
// pinned above a moving world Transform, converting world -> screen ->
// canvas-local space every frame. Add via AddComponent and call Follow().
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
