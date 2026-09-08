using UnityEngine;
using Recharge.ModApi;

// framesToReachTopSpeed drives BOTH acceleration and deceleration in
// Movement.MoveLeftAndRight() - every frame, Velocity.x moves toward the
// target (or toward zero with no input) by runSpeed*10/framesToReachTopSpeed.
// The base game's default is 2f (near-instant stop/start). Scaling it up
// makes both gradual - the player keeps sliding after releasing input and
// takes a moment to get going - which reads as "icy" without touching
// ground detection, jump, or dash at all.
//
// The player's visual is a single flat animated sprite (Movement finds it
// via transform.Find("Sprite").GetComponent<Animator>(), and the ghost-clone
// system elsewhere in this codebase clones that same single SpriteRenderer) -
// there's no separate "feet" part to recolor on the real sprite itself. This
// adds a small light-blue accent sprite positioned near the feet instead, as
// the closest achievable approximation - not a true recolor of the existing
// art. Worth a screenshot to confirm the position/size actually reads as
// "feet" once seen in-game rather than assuming it's right.
internal class IcyPhysicsController : MonoBehaviour
{
    private const float IcyFramesToReachTopSpeed = 14f;
    private const string FramesFieldName = "framesToReachTopSpeed";

    private Movement _movement;
    private Sprite _dotSprite;

    private void Awake()
    {
        var tex = new Texture2D(1, 1);
        tex.SetPixel(0, 0, Color.white);
        tex.Apply();
        _dotSprite = Sprite.Create(tex, new Rect(0f, 0f, 1f, 1f), new Vector2(0.5f, 0.5f), 1f);
    }

    private void Update()
    {
        if (_movement != null) return;

        var playerGo = GameObject.FindGameObjectWithTag("Player");
        if (playerGo == null) return;
        _movement = playerGo.GetComponent<Movement>();
        if (_movement == null) return;

        Reflect.SetField(_movement, FramesFieldName, IcyFramesToReachTopSpeed);
        AddFeetOverlay();
    }

    private void AddFeetOverlay()
    {
        var spriteTf = _movement.transform.Find("Sprite");
        if (spriteTf == null) return;

        var overlay = new GameObject("IcyFeetOverlay");
        overlay.transform.SetParent(spriteTf, false);
        overlay.transform.localPosition = new Vector3(0f, -20f, 0f);
        overlay.transform.localScale = new Vector3(20f, 8f, 1f);

        var sr = overlay.AddComponent<SpriteRenderer>();
        sr.sprite = _dotSprite;
        sr.color = new Color(0.53f, 0.81f, 0.98f);
        sr.sortingOrder = 100;
    }
}
