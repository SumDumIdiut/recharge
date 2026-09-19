using UnityEngine;
using UnityEngine.InputSystem;
using Recharge.ModApi;

// Movement.Update() only reads jump/dash input inside
// "if (!pauseMenu.menuOpen && !GamePaused)" - a press made while the pause
// menu is open is read by nobody and simply lost. This polls the same
// InputActions independently (Update() keeps running during pause; only
// FixedUpdate()/physics stop), remembers a press made while paused, and
// replays it into Movement's own private jumpBuffer/dashBuffer fields
// (reflection - no public setter exists) the instant the menu closes,
// re-arming the same auto-expiry Movement itself uses so a buffered press
// behaves exactly like a real one timed right after unpausing.
internal class PauseBufferController : MonoBehaviour
{
    private const float BufferSeconds = 0.12f;

    private Movement _movement;
    private InputAction _jumpAction;
    private InputAction _dashAction;
    private bool _wasMenuOpen;
    private bool _pendingJump;
    private bool _pendingDash;

    private void Awake()
    {
        _jumpAction = InputSystem.actions?.FindAction("Jump");
        _dashAction = InputSystem.actions?.FindAction("Dash");
    }

    private void Update()
    {
        if (_movement == null)
        {
            var playerGo = GameObject.FindGameObjectWithTag("Player");
            if (playerGo == null) return;
            _movement = playerGo.GetComponent<Movement>();
            if (_movement == null) return;
            _wasMenuOpen = false;
            _pendingJump = false;
            _pendingDash = false;
        }

        var menuOpen = _movement.pauseMenu != null && _movement.pauseMenu.menuOpen;

        if (menuOpen)
        {
            if (_jumpAction != null && _jumpAction.WasPressedThisFrame()) _pendingJump = true;
            if (_dashAction != null && _dashAction.WasPressedThisFrame()) _pendingDash = true;
        }

        if (_wasMenuOpen && !menuOpen)
        {
            if (_pendingJump)
            {
                Reflect.SetField(_movement, "jumpBuffer", true);
                _movement.CancelInvoke("cancelJumpBuffer");
                _movement.Invoke("cancelJumpBuffer", BufferSeconds);
            }
            if (_pendingDash)
            {
                Reflect.SetField(_movement, "dashBuffer", true);
                _movement.CancelInvoke("cancelDashBuffer");
                _movement.Invoke("cancelDashBuffer", BufferSeconds);
            }
            _pendingJump = false;
            _pendingDash = false;
        }

        _wasMenuOpen = menuOpen;
    }
}
