using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Recharge.Module.Maps;

// Builds a placed node ({ "type":"node", "nodeId", ...options }) from its manifest in the map's nodeDefs:
// a visual sprite, a trigger collider, and a NodeRuntime carrying the composed behaviours with resolved params.
internal static class NodeSpawner
{
    private static readonly ConditionalWeakTable<MapWorld, Dictionary<string, NodeManifestModel>> _cache = new ConditionalWeakTable<MapWorld, Dictionary<string, NodeManifestModel>>();

    private static Dictionary<string, NodeManifestModel> Defs(MapWorld w)
    {
        if (_cache.TryGetValue(w, out var d)) return d;
        d = new Dictionary<string, NodeManifestModel>();
        var defs = w.Def.NodeDefs ?? (w.Def.Amp?["nodeDefs"] as JObject);
        if (defs != null)
            foreach (var prop in defs.Properties())
            {
                var m = NodeManifestModel.Parse(prop.Value as JObject);
                if (m != null) d[m.Id] = m;
            }
        _cache.Add(w, d);
        return d;
    }

    public static void SpawnNode(MapWorld w, JObject obj)
    {
        var id = obj["nodeId"]?.Value<string>();
        if (string.IsNullOrEmpty(id)) return;
        if (!Defs(w).TryGetValue(id, out var m)) { Debug.LogWarning("[RechargeMaps] unknown node '" + id + "'"); return; }

        var go = new GameObject("Node_" + id);
        go.transform.SetParent(w.Root, false);
        go.transform.SetPositionAndRotation(w.Point(obj), MapWorld.Rot(obj));

        if (m.Visual != null)
        {
            var sprite = RealAssetPalette.SpriteByName(m.Visual.Sprite);
            if (sprite != null)
            {
                var sr = go.AddComponent<SpriteRenderer>();
                sr.sprite = sprite;
                if (m.Visual.Tiled)
                {
                    sr.drawMode = SpriteDrawMode.Tiled;
                    sr.size = new Vector2(obj["w"]?.Value<float>() ?? sprite.rect.width, obj["h"]?.Value<float>() ?? sprite.rect.height);
                }
            }
        }

        bool wantsEvents = m.Behaviors.Any(b => b.Event != "onLoad") || (m.Collider != null && m.Collider.Shape == "box") || m.HasKill;
        if (wantsEvents)
        {
            var box = go.AddComponent<BoxCollider2D>();
            box.isTrigger = m.Collider == null || m.Collider.Trigger;
            box.size = new Vector2(obj["w"]?.Value<float>() ?? 64f, obj["h"]?.Value<float>() ?? 64f);
        }

        if (m.HasKill)
        {
            var spikes = w.RealTilemap("Spikes");
            if (spikes != null) go.layer = spikes.gameObject.layer;
            go.AddComponent<spikeScript>();
        }

        var rt = go.AddComponent<NodeRuntime>();
        rt.World = w;
        foreach (var bd in m.Behaviors)
        {
            if (bd.Behavior == "kill") continue; // handled structurally by the spike above
            rt.Behaviors.Add(new NodeBehaviorInstance { Id = bd.Behavior, Event = bd.Event, Mode = bd.Mode, Params = Resolve(bd, obj, m) });
        }

        MapGroups.Add(w, obj, go);
    }

    private static Dictionary<string, object> Resolve(NodeBehaviorRef bd, JObject obj, NodeManifestModel m)
    {
        var def = NodeBehaviors.Registry[bd.Behavior];
        var outp = new Dictionary<string, object>();
        foreach (var spec in def.Params)
        {
            bd.Params.TryGetValue(spec.Key, out var tok);
            outp[spec.Key] = ResolveOne(spec, tok, obj, m);
        }
        return outp;
    }

    // A param is a literal or { "option": "<key>" } -> read the placed option value, falling back to the option's default.
    private static object ResolveOne(NodePSpec spec, JToken tok, JObject obj, NodeManifestModel m)
    {
        JToken val = tok;
        if (tok is JObject po && po["option"]?.Value<string>() is string optKey)
        {
            val = obj[optKey];
            if (val == null || val.Type == JTokenType.Null) m.OptionDefaults.TryGetValue(optKey, out val);
        }
        switch (spec.Type)
        {
            case NodePType.Num:
                return NodeBehaviors.Clamp(spec, val != null && (val.Type == JTokenType.Float || val.Type == JTokenType.Integer) ? val.Value<float>() : System.Convert.ToSingle(spec.Def));
            case NodePType.Bool:
                return val != null && val.Type == JTokenType.Boolean ? val.Value<bool>() : (bool)spec.Def;
            default:
                return val != null && val.Type == JTokenType.String ? val.Value<string>() : (string)spec.Def;
        }
    }
}
