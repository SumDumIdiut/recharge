using System;
using UnityEngine;
using UnityEngine.InputSystem;
using Recharge.ModApi;

// OnUpdate/OnLateUpdate/OnFixedUpdate patterns beyond the "log the first
// tick" one-liners in ExampleMod.cs itself: a tiny state machine driven
// purely by polling (no coroutines, no extra GameObject needed), a fixed-step
// tick counter, and reading the new Input System directly for a keybind the
// pause menu doesn't need to know about.
internal class UpdateLoopDemo
{
    internal enum State
    {
        Idle,
        Running,
        Cooldown,
    }

    private readonly IRechargeHost _host;
    private State _state = State.Idle;
    private float _timer;
    private int _fixedTicks;
    private bool _icyPhysicsOn;

    private const float RunDuration = 2f;
    private const float CooldownDuration = 3f;

    public event Action<bool> IcyPhysicsToggleRequested;
    public event Action<State> StateChanged;

    public UpdateLoopDemo(IRechargeHost host)
    {
        _host = host;
        host.OnUpdate += Tick;
        host.OnFixedUpdate += () => _fixedTicks++;
    }

    public int FixedTickCount => _fixedTicks;
    public string StateName => _state.ToString();

    public void StartRun()
    {
        if (_state != State.Idle) return;
        SetState(State.Running);
        _timer = 0f;
    }

    private void Tick()
    {
        PollToggleKeybind();

        switch (_state)
        {
            case State.Running:
                _timer += Time.deltaTime;
                if (_timer >= RunDuration) { SetState(State.Cooldown); _timer = 0f; }
                break;
            case State.Cooldown:
                _timer += Time.deltaTime;
                if (_timer >= CooldownDuration) { SetState(State.Idle); _timer = 0f; }
                break;
        }
    }

    private void SetState(State state)
    {
        _state = state;
        _host.Log($"UpdateLoopDemo: state -> {state}");
        StateChanged?.Invoke(state);
    }

    private void PollToggleKeybind()
    {
        var keyboard = Keyboard.current;
        if (keyboard == null || !keyboard.f9Key.wasPressedThisFrame) return;
        _icyPhysicsOn = !_icyPhysicsOn;
        _host.Log($"F9 pressed - requesting icy physics = {_icyPhysicsOn} (polled directly via the Input System, no pause menu involved).");
        IcyPhysicsToggleRequested?.Invoke(_icyPhysicsOn);
    }
}
