using System.Collections.Generic;
using UnityEngine;

namespace Recharge.Module.Maps;

// One placed node's behaviours with their params already resolved to literals. OneShot runs on its event;
// ApplyUndo applies on enter and undoes on exit; PerFrame runs every stay. Mirrors MapGroupTrigger's event model.
internal sealed class NodeBehaviorInstance
{
    public string Id;
    public string Event;
    public NodeBMode Mode;
    public Dictionary<string, object> Params;
    public readonly Dictionary<string, float> State = new Dictionary<string, float>();
}

internal sealed class NodeRuntime : MonoBehaviour
{
    public MapWorld World;
    public readonly List<NodeBehaviorInstance> Behaviors = new List<NodeBehaviorInstance>();

    private void Start()
    {
        foreach (var b in Behaviors)
            if (b.Mode == NodeBMode.OneShot && b.Event == "onLoad") NodeBehaviors.Run(b.Id, this, null, World, b.Params);
    }

    private void OnTriggerEnter2D(Collider2D c)
    {
        if (!c.CompareTag("Player")) return;
        var mv = c.GetComponent<Movement>();
        foreach (var b in Behaviors)
        {
            if (b.Mode == NodeBMode.ApplyUndo) NodeBehaviors.Apply(b.Id, mv, World, b.Params, b.State);
            else if (b.Mode == NodeBMode.OneShot && b.Event == "enter") NodeBehaviors.Run(b.Id, this, mv, World, b.Params);
        }
    }

    private void OnTriggerStay2D(Collider2D c)
    {
        if (!c.CompareTag("Player")) return;
        var mv = c.GetComponent<Movement>();
        foreach (var b in Behaviors)
            if (b.Mode == NodeBMode.PerFrame) NodeBehaviors.Stay(b.Id, mv, b.Params);
    }

    private void OnTriggerExit2D(Collider2D c)
    {
        if (!c.CompareTag("Player")) return;
        var mv = c.GetComponent<Movement>();
        foreach (var b in Behaviors)
        {
            if (b.Mode == NodeBMode.ApplyUndo) NodeBehaviors.Undo(b.Id, mv, World, b.Params, b.State);
            else if (b.Mode == NodeBMode.OneShot && b.Event == "exit") NodeBehaviors.Run(b.Id, this, mv, World, b.Params);
        }
    }
}
