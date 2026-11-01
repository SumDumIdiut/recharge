using System;
using System.Collections.Generic;
using Recharge.Core.Json;

namespace Recharge.MapDoc
{
    /// <summary>
    /// A typed view over a JSON object whose keys are "x,y" cell coordinates,
    /// stored at a fixed <see cref="Path"/> inside a <see cref="MapDocument"/>.
    /// </summary>
    public sealed class CellLayer : IDisposable
    {
        private readonly MapDocument _doc;
        private readonly SpatialIndex<CellKey> _index = new SpatialIndex<CellKey>();

        public CellLayer(MapDocument document, DocPath layerPath)
        {
            _doc = document ?? throw new ArgumentNullException(nameof(document));
            Path = layerPath ?? throw new ArgumentNullException(nameof(layerPath));
            _doc.Changed += OnChanged;
        }

        public CellLayer(MapDocument document, string layerPath)
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

        public JsonNode? Get(CellKey k)
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

        public bool Contains(CellKey k)
        {
            if (!TryResolve(out var node) || node is not JsonObject obj)
            {
                return false;
            }
            return obj.ContainsKey(k.ToString());
        }

        public IEnumerable<KeyValuePair<CellKey, JsonNode>> All()
        {
            UnparsedKeys = 0;
            if (!TryResolve(out var node) || node is not JsonObject obj)
            {
                yield break;
            }
            foreach (var kv in obj)
            {
                if (CellKey.TryParse(kv.Key, out var key))
                {
                    yield return new KeyValuePair<CellKey, JsonNode>(key, kv.Value);
                }
                else
                {
                    UnparsedKeys++;
                }
            }
        }

        public DocOp Set(CellKey k, JsonNode value)
        {
            if (value is null)
            {
                throw new ArgumentNullException(nameof(value));
            }
            return new SetOp(Path.Append(k.ToString()), value);
        }

        public DocOp? Remove(CellKey k)
        {
            if (!Contains(k))
            {
                return null;
            }
            return new RemoveOp(Path.Append(k.ToString()));
        }

        public Transaction Paint(IEnumerable<(CellKey key, JsonNode? value)> cells, string label)
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

        public IReadOnlyList<CellKey> QueryRect(int x0, int y0, int x1, int y1)
        {
            EnsureIndex();
            return _index.QueryRect(x0, y0, x1, y1);
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
            var keys = new List<CellKey>();
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
                    if (keyStr is not null && CellKey.TryParse(keyStr, out var key))
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
