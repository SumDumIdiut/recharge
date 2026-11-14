using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace Recharge.Module.Maps;

internal sealed class NodeVisual { public string Sprite; public bool Tiled; }
internal sealed class NodeColliderDef { public string Shape = "none"; public bool Trigger = true; }

internal sealed class NodeBehaviorRef
{
    public string Behavior;
    public string Event = "enter";          // onLoad|enter|stay|exit (meaningful for OneShot)
    public NodeBMode Mode;
    public Dictionary<string, JToken> Params = new Dictionary<string, JToken>(); // raw token per declared param (literal or {option})
}

// A validated node definition read from the map's nodeDefs. Untrusted data: unknown behaviours and params are
// dropped at parse, so only whitelisted effects with declared params survive (params are clamped at spawn).
internal sealed class NodeManifestModel
{
    public string Id;
    public string Place = "cell";
    public NodeVisual Visual;
    public NodeColliderDef Collider;
    public readonly Dictionary<string, JToken> OptionDefaults = new Dictionary<string, JToken>();
    public readonly List<NodeBehaviorRef> Behaviors = new List<NodeBehaviorRef>();
    public bool HasKill;

    private static readonly HashSet<string> Places = new HashSet<string> { "cell", "zone", "point", "path" };
    private static readonly HashSet<string> Events = new HashSet<string> { "onLoad", "enter", "stay", "exit" };

    public static NodeManifestModel Parse(JObject raw)
    {
        if (raw == null) return null;
        var id = raw["id"]?.Value<string>();
        if (string.IsNullOrEmpty(id)) return null;

        var m = new NodeManifestModel { Id = id };
        var place = raw["place"]?.Value<string>();
        if (place != null && Places.Contains(place)) m.Place = place;

        if (raw["options"] is JArray opts)
            foreach (var o in opts)
                if (o is JObject oo && oo["key"]?.Value<string>() is string k && k.Length > 0)
                    m.OptionDefaults[k] = oo["default"] ?? JValue.CreateNull();

        if (raw["build"] is JObject build)
        {
            if (build["visual"] is JObject vis && vis["sprite"]?.Value<string>() is string sp && sp.Length > 0)
                m.Visual = new NodeVisual { Sprite = sp, Tiled = vis["tiled"]?.Value<bool>() ?? false };
            if (build["collider"] is JObject col)
                m.Collider = new NodeColliderDef { Shape = col["shape"]?.Value<string>() == "box" ? "box" : "none", Trigger = col["trigger"]?.Value<bool>() ?? true };
            if (build["behaviors"] is JArray behs)
                foreach (var b in behs)
                {
                    var parsed = ParseBehavior(b as JObject);
                    if (parsed == null) continue;
                    if (parsed.Behavior == "kill") m.HasKill = true;
                    m.Behaviors.Add(parsed);
                }
        }
        return m;
    }

    private static NodeBehaviorRef ParseBehavior(JObject raw)
    {
        var id = raw?["behavior"]?.Value<string>();
        if (!NodeBehaviors.Known(id)) return null;
        var def = NodeBehaviors.Registry[id];
        var evt = raw["event"]?.Value<string>();
        var r = new NodeBehaviorRef { Behavior = id, Mode = def.Mode, Event = evt != null && Events.Contains(evt) ? evt : "enter" };
        var rawParams = raw["params"] as JObject;
        foreach (var spec in def.Params)       // keep only declared params
        {
            var tok = rawParams?[spec.Key];
            if (tok != null) r.Params[spec.Key] = tok;
        }
        return r;
    }
}
