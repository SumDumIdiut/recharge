using UnityEngine;
using Recharge.ModApi;

// Finding the player two ways (the PlayerSpawned payload vs a manual
// FindGameObjectWithTag lookup), reading live Rigidbody2D state, and
// reusing ReflectionDemo.ToggleIcyPhysics on it.
internal class PlayerPhysicsDemo
{
    private readonly IRechargeHost _host;
    private GameObject _player;
    private bool _icyPhysicsOn;
    private float _logAccumulator;

    public PlayerPhysicsDemo(IRechargeHost host)
    {
        _host = host;
        host.Events.On(RechargeEvents.PlayerSpawned, payload => _player = payload as GameObject);
        host.OnUpdate += Tick;
    }

    public bool IcyPhysicsOn => _icyPhysicsOn;

    public GameObject FindPlayerManually() => GameObject.FindGameObjectWithTag("Player");

    public void SetIcyPhysics(bool icy)
    {
        var player = _player != null ? _player : FindPlayerManually();
        if (player == null) { _host.LogWarning("No player in the current scene."); return; }
        _icyPhysicsOn = icy;
        ReflectionDemo.ToggleIcyPhysics(_host, player, icy);
    }

    public void ToggleIcyPhysics() => SetIcyPhysics(!_icyPhysicsOn);

    private void Tick()
    {
        if (_player == null) return;
        var body = _player.GetComponent<Rigidbody2D>();
        if (body == null) return;

        _logAccumulator += Time.deltaTime;
        if (_logAccumulator < 2f) return;
        _logAccumulator = 0f;
        _host.Log($"Player velocity: {body.linearVelocity}, position: {(Vector2)_player.transform.position}");
    }
}
