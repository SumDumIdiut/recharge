// A tiny public contract another mod could compile against directly, or
// reach without a compile-time reference at all via
// host.GetModApi<IExampleModApi>("recharge.example") so long as it knows the
// shape - implemented directly by ExampleMod in ExampleMod.cs.
public interface IExampleModApi
{
    int ClickCount { get; }
    void Ping();
}
