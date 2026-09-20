// A contract another mod could reach via host.GetModApi<IExampleModApi>("recharge.example").
public interface IExampleModApi
{
    int ClickCount { get; }
    void Ping();
}
