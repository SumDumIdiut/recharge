using System;
using System.Collections.Generic;
using Recharge.Core.Json;

namespace Recharge.MapDoc
{
    public sealed class TileLayerSet : IDisposable
    {
        private readonly MapDocument _doc;
        private readonly SpatialIndex<TileKey> _index = new SpatialIndex<TileKey>();

        public TileLayerSet(MapDocument document, DocPath layerPath)
        {
            _doc = document ?? throw new ArgumentNullException(nameof(document));
            Path = layerPath ?? throw new ArgumentNullException(nameof(layerPath));
            _doc.Changed += OnChanged;
        }

        public TileLayerSet(MapDocument document, string layerPath)
            : this(document, DocPath.Parse(layerPath))
        {
        }

        public MapDocument Document => _doc;
        public DocPath Path { get; }

        public bool Exists
        {
            get
            {
                if (!TryResolve(out var node))
                {
                    return false;
                }
                return node is JsonObject;
            }
        }

        public int Count
        {
            get
            {
                if (!TryResolve(out var node) || node is not JsonObject obj)
                {
                    return 0;
                }
                return obj.Count;
            }
        }

        public int UnparsedKeys { get; private set; }

        public IReadOnlyList<string> Layers
        {
            get
            {
                var result = new List<string>();
                var seen = new HashSet<string>(StringComparer.Ordinal);
                if (!Exists)
                {
                    return result;
                }
                foreach (var kv in All())
                {
                    if (seen.Add(kv.Key.Layer))
                    {
                        result.Add(kv.Key.Layer);
                    }
                }
                return result;
            }
        }

        public JsonNode? Get(TileKey k)
        {
            if (!TryResolve(out var node) || node is not JsonObject obj)
            {
                return null;
            }
            if (obj.TryGetValue(k.ToString(), out var v))
            {
                return v;
            }
            return null;
        }

        public bool Contains(TileKey k)
        {
            if (!TryResolve(out var node) || node is not JsonObject obj)
            {
                return false;
            }
            return obj.ContainsKey(k.ToString());
        }

        public IEnumerable<KeyValuePair<TileKey, JsonNode>> All()
        {
            UnparsedKeys = 0;
            if (!TryResolve(out var node) || node is not JsonObject obj)
            {
                yield break;
            }
            foreach (var kv in obj)
            {
                if (TileKey.TryParse(kv.Key, out var key))
                {
                    yield return new KeyValuePair<TileKey, JsonNode>(key, kv.Value);
                }
                else
                {
                    UnparsedKeys++;
                }
            }
        }

        public DocOp Set(TileKey k, JsonNode value)
        {
            if (value is null)
            {
                throw new ArgumentNullException(nameof(value));
            }
            return new SetOp(Path.Append(k.ToString()), value);
        }

        public DocOp? Remove(TileKey k)
        {
            if (!Contains(k))
            {
                return null;
            }
            return new RemoveOp(Path.Append(k.ToString()));
        }

        public Transaction Paint(IEnumerable<(TileKey key, JsonNode? value)> cells, string label)
        {
            if (cells is null)
            {
                throw new ArgumentNullException(nameof(cells));
            }
            var effective = new List<DocOp>();
            bool layerExistsNow = Exists;
            foreach (var (key, value) in cells)
            {
                bool contains = Contains(key);
                if (value is null)
                {
                    if (contains)
                    {
                        effective.Add(new RemoveOp(Path.Append(key.ToString())));
                    }
                }
                else
                {
                    var current = Get(key);
                    if (contains && current is not null && JsonNode.DeepEquals(current, value))
                    {
                        // no-op
                    }
                    else
                    {
                        effective.Add(new SetOp(Path.Append(key.ToString()), value));
                    }
                }
            }

            var ops = new List<DocOp>();
            if (effective.Count > 0 && !layerExistsNow)
            {
                ops.Add(new SetOp(Path, new JsonObject()));
            }
            ops.AddRange(effective);
            return new Transaction(ops, label);
        }

        public IReadOnlyList<TileKey> QueryRect(string? layer, int x0, int y0, int x1, int y1)
        {
            EnsureIndex();
            var all = _index.QueryRect(x0, y0, x1, y1);
            if (layer is null)
            {
                return all;
            }
            var result = new List<TileKey>();
            foreach (var k in all)
            {
                if (k.Layer == layer)
                {
                    result.Add(k);
                }
            }
            return result;
        }

        public void Dispose()
        {
            _doc.Changed -= OnChanged;
        }

        private bool TryResolve(out JsonNode node)
        {
            node = _doc.Root;
            if (Path.IsRoot)
            {
                return true;
            }
            foreach (var seg in Path.Segments)
            {
                if (node is JsonObject o)
                {
                    if (!o.TryGetValue(seg, out var next))
                    {
                        return false;
                    }
                    node = next;
                }
                else if (node is JsonArray a)
                {
                    if (!DocOpHelpers.TryParseIndex(seg, out int idx) || idx < 0 || idx >= a.Count)
                    {
                        return false;
                    }
                    node = a[idx];
                }
                else
                {
                    return false;
                }
            }
            return true;
        }

        private void EnsureIndex()
        {
            if (_index.NeedsBuild)
            {
                RebuildIndex();
            }
        }

        private void RebuildIndex()
        {
            var keys = new List<TileKey>();
            if (Exists)
            {
                foreach (var kv in All())
                {
                    keys.Add(kv.Key);
                }
            }
            _index.Rebuild(keys);
        }

        private void OnChanged(Transaction tx, long revision)
        {
            if (tx is null)
            {
                return;
            }
            foreach (var op in tx.Ops)
            {
                if (IsAncestorOrSelf(op.Path, Path))
                {
                    _index.MarkDirty();
                    continue;
                }
                if (_index.IsDirty)
                {
                    continue;
                }
                if (op.Path.Parent is not null && op.Path.Parent.Equals(Path))
                {
                    var keyStr = op.Path.Last;
                    if (keyStr is not null && TileKey.TryParse(keyStr, out var key))
                    {
                        if (Contains(key))
                        {
                            _index.Add(key);
                        }
                        else
                        {
                            _index.Remove(key);
                        }
                    }
                }
            }
        }

        private static bool IsAncestorOrSelf(DocPath op, DocPath layer)
        {
            if (op.Length > layer.Length)
            {
                return false;
            }
            for (int i = 0; i < op.Length; i++)
            {
                if (op.Segments[i] != layer.Segments[i])
                {
                    return false;
                }
            }
            return true;
        }
    }
}
