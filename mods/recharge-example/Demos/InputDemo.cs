using System;
using UnityEngine;
using UnityEngine.InputSystem;
using Recharge.ModApi;

// Deeper Input System usage than UpdateLoopDemo's single wasPressedThisFrame
// check: reading the mouse every frame, detecting whether a gamepad is
// connected at all, and a real rebindable-keybind pattern (press a button to
// arm rebinding, then the next key pressed becomes the new bind and gets
// persisted to config) - the same trick recharge-multiplayer's chat keybind
// uses for real.
internal class InputDemo
{
    internal class InputConfig
    {
        public string PingKeyName = "P";
    }

    private readonly IRechargeHost _host;
    private readonly string _modId;
    private readonly InputConfig _config;
    private bool _rebindArmed;

    public event Action<string> KeyRebound;

    public InputDemo(IRechargeHost host, string modId)
    {
        _host = host;
        _modId = modId;
        _config = host.LoadConfig<InputConfig>(modId, "input-config.json");
        host.OnUpdate += Tick;
    }

    public string PingKeyName => _config.PingKeyName;

    public void ArmRebind() => _rebindArmed = true;

    private void Tick()
    {
        PollPingKey();
        if (_rebindArmed) PollRebind();
    }

    private void PollPingKey()
    {
        var keyboard = Keyboard.current;
        if (keyboard == null) return;
        if (!Enum.TryParse<Key>(_config.PingKeyName, true, out var key)) return;
        if (keyboard[key].wasPressedThisFrame)
            _host.Log($"Ping key ({_config.PingKeyName}) pressed.");
    }

    private void PollRebind()
    {
        var keyboard = Keyboard.current;
        if (keyboard == null) return;
        foreach (var control in keyboard.allKeys)
        {
            if (!control.wasPressedThisFrame) continue;
            _config.PingKeyName = control.keyCode.ToString();
            _rebindArmed = false;
            _host.SaveConfig(_modId, _config, "input-config.json");
            _host.Log($"Ping key rebound to {_config.PingKeyName}.");
            KeyRebound?.Invoke(_config.PingKeyName);
            break;
        }
    }

    public static Vector2 MouseScreenPosition()
    {
        var mouse = Mouse.current;
        return mouse != null ? mouse.position.ReadValue() : Vector2.zero;
    }

    public static bool MouseLeftPressedThisFrame() => Mouse.current != null && Mouse.current.leftButton.wasPressedThisFrame;

    public static bool AnyGamepadConnected() => Gamepad.current != null;

    public static string DescribeConnectedGamepad()
        => Gamepad.current != null ? Gamepad.current.displayName : "no gamepad connected";
}
