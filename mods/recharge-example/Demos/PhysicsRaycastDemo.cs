using UnityEngine;
using Recharge.ModApi;

// A ground check via Physics2D.Raycast - the same building block a "coyote
// time," a custom jump mod, or a footstep-sound mod would all start from.
internal static class PhysicsRaycastDemo
{
    public readonly struct GroundHit
    {
        public readonly bool Grounded;
        public readonly float Distance;
        public readonly string HitObjectName;

        public GroundHit(bool grounded, float distance, string hitObjectName)
        {
            Grounded = grounded;
            Distance = distance;
            HitObjectName = hitObjectName;
        }
    }

    public static GroundHit CheckGround(GameObject player, float maxDistance = 1.2f)
    {
        if (player == null) return new GroundHit(false, 0f, null);

        var origin = player.transform.position;
        var hit = Physics2D.Raycast(origin, Vector2.down, maxDistance);
        return hit.collider != null
            ? new GroundHit(true, hit.distance, hit.collider.gameObject.name)
            : new GroundHit(false, maxDistance, null);
    }

    public static void LogGroundCheck(IRechargeHost host, GameObject player)
    {
        var result = CheckGround(player);
        host.Log(result.Grounded
            ? $"Ground check: grounded on '{result.HitObjectName}', {result.Distance:0.00}m below."
            : "Ground check: airborne (nothing hit within range).");
    }
}
