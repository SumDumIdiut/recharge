using System;
using Recharge.ModApi;

// Deeper Events usage: unsubscribing, a typed payload class, a
// request/response pattern on top of the bus, and GetModApi<T> (see
// IExampleModApi.cs for the interface ExampleMod itself implements).
internal class EventsDemo
{
    public class ScorePayload
    {
        public string PlayerName;
        public int Points;
    }

    private readonly IRechargeHost _host;
    private readonly Action<object> _scoreHandler;
    private readonly Action<object> _pingRequestHandler;

    public EventsDemo(IRechargeHost host)
    {
        _host = host;

        _scoreHandler = payload =>
        {
            if (payload is ScorePayload score) host.Log($"{score.PlayerName} scored {score.Points} points.");
        };
        host.Events.On("recharge.example.score", _scoreHandler);

        // A "request" is just a convention: its payload IS the answer callback.
        _pingRequestHandler = payload =>
        {
            if (payload is Action<string> respond) respond("pong from ExampleMod");
        };
        host.Events.On("recharge.example.ping_request", _pingRequestHandler);
    }

    public void EmitSampleScore()
    {
        _host.Events.Emit("recharge.example.score", new ScorePayload { PlayerName = "Demo Player", Points = 100 });
    }

    public void AskAQuestion(Action<string> onAnswer)
    {
        _host.Events.Emit("recharge.example.ping_request", (Action<string>)(answer =>
        {
            _host.Log($"Got an answer: {answer}");
            onAnswer?.Invoke(answer);
        }));
    }

    public void LookUpMapsMod()
    {
        var maps = _host.GetMod("recharge.maps");
        _host.Log(maps != null ? $"Maps mod: {maps.DisplayName} v{maps.Version}" : "Maps mod isn't loaded.");
    }

    public void LookUpOwnApiTypedByOtherMods()
    {
        var api = _host.GetModApi<IExampleModApi>("recharge.example");
        if (api != null) _host.Log($"Talked to ourselves via IExampleModApi: {api.ClickCount} click(s) recorded so far.");
    }

    public void Dispose()
    {
        _host.Events.Off("recharge.example.score", _scoreHandler);
        _host.Events.Off("recharge.example.ping_request", _pingRequestHandler);
    }
}
