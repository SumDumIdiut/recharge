using UnityEngine;
using Recharge.ModApi;

// framesToReachTopSpeed drives BOTH acceleration and deceleration in
// Movement.MoveLeftAndRight() - every frame, Velocity.x moves toward the
// target (or toward zero with no input) by runSpeed*10/framesToReachTopSpeed.
// The base game's default is 2f (near-instant stop/start). Scaling it up
// makes both gradual - the player keeps sliding after releasing input and
// takes real time to get going - which reads as "icy" without touching
// ground detection, jump, or dash at all.
internal class IcyPhysicsController : MonoBehaviour
{
    private const float IcyFramesToReachTopSpeed = 50f;
    private const string FramesFieldName = "framesToReachTopSpeed";

    private Movement _movement;

    private void Update()
    {
        if (_movement != null) return;

        var playerGo = GameObject.FindGameObjectWithTag("Player");
        if (playerGo == null) return;
        _movement = playerGo.GetComponent<Movement>();
        if (_movement == null) return;

        Reflect.SetField(_movement, FramesFieldName, IcyFramesToReachTopSpeed);
    }
}
