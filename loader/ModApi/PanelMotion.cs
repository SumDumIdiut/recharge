using UnityEngine;

namespace Recharge.ModApi
{
    /// <summary>Named movement shapes <see cref="PanelMotion.Evaluate"/> can animate a point along.</summary>
    public enum MotionPath
    {
        Linear,
        QuadraticBezier,
        Circular,
        Bounce,
        Zigzag,
        Wave,
        Elastic,
    }

    /// <summary>
    /// Easing curves and path shapes for animating a UI element between two
    /// points - the math every mod ends up hand-rolling once it wants
    /// anything fancier than a straight Lerp. Pure functions only; driving
    /// the actual per-frame update is still a mod's own Coroutine/Update -
    /// this just answers "where should the point be at time t".
    /// </summary>
    public static class PanelMotion
    {
        public static float EaseInOutSine(float t) => -(Mathf.Cos(Mathf.PI * Mathf.Clamp01(t)) - 1f) / 2f;

        public static float EaseOutCubic(float t) => 1f - Mathf.Pow(1f - Mathf.Clamp01(t), 3f);

        /// <summary>Standard "overshoot and settle" bounce-out curve (the one every animation library ships as EaseOutBounce).</summary>
        public static float EaseOutBounce(float t)
        {
            t = Mathf.Clamp01(t);
            const float n1 = 7.5625f;
            const float d1 = 2.75f;
            if (t < 1f / d1) return n1 * t * t;
            if (t < 2f / d1) { t -= 1.5f / d1; return n1 * t * t + 0.75f; }
            if (t < 2.5f / d1) { t -= 2.25f / d1; return n1 * t * t + 0.9375f; }
            t -= 2.625f / d1;
            return n1 * t * t + 0.984375f;
        }

        public static Vector2 QuadraticBezier(Vector2 p0, Vector2 control, Vector2 p2, float t)
        {
            t = Mathf.Clamp01(t);
            var a = Vector2.Lerp(p0, control, t);
            var b = Vector2.Lerp(control, p2, t);
            return Vector2.Lerp(a, b, t);
        }

        /// <summary>A point on a circle of the given radius around center - t in [0,1] is one full revolution starting at angle 0.</summary>
        public static Vector2 Circular(Vector2 center, float radius, float t) =>
            center + radius * new Vector2(Mathf.Cos(t * Mathf.PI * 2f), Mathf.Sin(t * Mathf.PI * 2f));

        /// <summary>Overshoots past 1 and springs back to settle exactly on target - the "elastic" curve every animation library ships as EaseOutElastic.</summary>
        public static float EaseOutElastic(float t)
        {
            t = Mathf.Clamp01(t);
            if (t <= 0f) return 0f;
            if (t >= 1f) return 1f;
            const float c4 = 2f * Mathf.PI / 3f;
            return Mathf.Pow(2f, -10f * t) * Mathf.Sin((t * 10f - 0.75f) * c4) + 1f;
        }

        /// <summary>A point offset perpendicular to the straight line from->to by a sine wave of the given number of full cycles over the path.</summary>
        public static Vector2 PerpendicularWave(Vector2 from, Vector2 to, float t, float amplitude, float cycles, bool triangle)
        {
            var linear = Vector2.Lerp(from, to, t);
            var delta = to - from;
            if (delta.sqrMagnitude < 0.0001f) return linear;
            var perpendicular = new Vector2(-delta.y, delta.x).normalized;
            float wave = triangle
                ? Mathf.PingPong(t * cycles * 2f, 2f) - 1f
                : Mathf.Sin(t * Mathf.PI * 2f * cycles);
            return linear + perpendicular * wave * amplitude;
        }

        /// <summary>
        /// The position along a named <see cref="MotionPath"/> from
        /// <paramref name="from"/> to <paramref name="to"/> at normalized
        /// time t (0 = start, 1 = end) - Circular treats from/to as
        /// diametrically opposite points on one full loop, everything else
        /// is a straightforward eased or curved path between them.
        /// </summary>
        public static Vector2 Evaluate(MotionPath path, Vector2 from, Vector2 to, float t)
        {
            t = Mathf.Clamp01(t);
            switch (path)
            {
                case MotionPath.Linear:
                    return Vector2.Lerp(from, to, EaseOutCubic(t));
                case MotionPath.QuadraticBezier:
                    var control = new Vector2((from.x + to.x) / 2f, Mathf.Max(from.y, to.y) + Vector2.Distance(from, to) * 0.35f);
                    return QuadraticBezier(from, control, to, EaseInOutSine(t));
                case MotionPath.Circular:
                    var center = Vector2.Lerp(from, to, 0.5f);
                    var radius = Vector2.Distance(from, to) / 2f;
                    return Circular(center, radius, t);
                case MotionPath.Bounce:
                    return Vector2.Lerp(from, to, EaseOutBounce(t));
                case MotionPath.Zigzag:
                    return PerpendicularWave(from, to, t, Vector2.Distance(from, to) * 0.12f, 3f, triangle: true);
                case MotionPath.Wave:
                    return PerpendicularWave(from, to, t, Vector2.Distance(from, to) * 0.15f, 3f, triangle: false);
                case MotionPath.Elastic:
                    return Vector2.Lerp(from, to, EaseOutElastic(t));
                default:
                    return Vector2.Lerp(from, to, t);
            }
        }
    }
}
