using System;
using System.Collections;
using System.Collections.Generic;

namespace Recharge.Core.Json
{
    /// <summary>Base class for all JSON DOM nodes.</summary>
    public abstract class JsonNode
    {
        /// <summary>Returns a deep copy of this node (and all descendants).</summary>
        public JsonNode DeepClone() => DeepCloneNode(this);

        /// <summary>Deep equality: object keys are order-sensitive; numbers compare by Raw text.</summary>
        public static bool DeepEquals(JsonNode? a, JsonNode? b) => DeepEqualsNodes(a, b);

        private static JsonNode DeepCloneNode(JsonNode node)
        {
            switch (node)
            {
                case JsonObject obj:
                    var o = new JsonObject();
                    foreach (var kv in obj)
                    {
                        o[kv.Key] = DeepCloneNode(kv.Value);
                    }
                    return o;
                case JsonArray arr:
                    var a = new JsonArray();
                    foreach (var item in arr)
                    {
                        a.Add(DeepCloneNode(item));
                    }
                    return a;
                case JsonString s:
                    return new JsonString(s.Value);
                case JsonNumber n:
                    return new JsonNumber(n.Raw);
                case JsonBool b:
                    return b.Value ? JsonBool.True : JsonBool.False;
                case JsonNull:
                    return JsonNull.Instance;
                default:
                    throw new ArgumentException("Unknown JsonNode type", nameof(node));
            }
        }

        private static bool DeepEqualsNodes(JsonNode? a, JsonNode? b)
        {
            if (ReferenceEquals(a, b))
            {
                return true;
            }
            if (a is null || b is null)
            {
                return false;
            }
            if (a.GetType() != b.GetType())
            {
                return false;
            }
            switch (a)
            {
                case JsonObject oa:
                    {
                        var ob = (JsonObject)b;
                        if (oa.Count != ob.Count)
                        {
                            return false;
                        }
                        var ka = oa.Keys;
                        var kb = ob.Keys;
                        for (int i = 0; i < ka.Count; i++)
                        {
                            if (ka[i] != kb[i])
                            {
                                return false;
                            }
                            if (!DeepEqualsNodes(oa[ka[i]], ob[kb[i]]))
                            {
                                return false;
                            }
                        }
                        return true;
                    }
                case JsonArray aa:
                    {
                        var ab = (JsonArray)b;
                        if (aa.Count != ab.Count)
                        {
                            return false;
                        }
                        for (int i = 0; i < aa.Count; i++)
                        {
                            if (!DeepEqualsNodes(aa[i], ab[i]))
                            {
                                return false;
                            }
                        }
                        return true;
                    }
                case JsonString sa:
                    return sa.Value == ((JsonString)b).Value;
                case JsonNumber na:
                    return na.Raw == ((JsonNumber)b).Raw;
                case JsonBool ba:
                    return ba.Value == ((JsonBool)b).Value;
                case JsonNull:
                    return true;
                default:
                    return false;
            }
        }
    }

    /// <summary>JSON object following JavaScript property order.</summary>
    public sealed class JsonObject : JsonNode, IEnumerable<KeyValuePair<string, JsonNode>>
    {
        // Array-index keys (canonical decimal integers 0..4294967294) come first,
        // in ascending numeric order. All other keys follow in insertion order.
        private readonly SortedDictionary<uint, string> _indexKeys = new SortedDictionary<uint, string>();
        private readonly LinkedList<string> _nonIndex = new LinkedList<string>();
        private readonly Dictionary<string, LinkedListNode<string>> _nonIndexNodes =
            new Dictionary<string, LinkedListNode<string>>(StringComparer.Ordinal);
        private readonly Dictionary<string, JsonNode> _values =
            new Dictionary<string, JsonNode>(StringComparer.Ordinal);

        public int Count => _values.Count;

        public JsonNode this[string key]
        {
            get => _values[key];
            set
            {
                if (_values.ContainsKey(key))
                {
                    // Replacing keeps the existing position.
                    _values[key] = value;
                }
                else
                {
                    AddNew(key, value);
                }
            }
        }

        private void AddNew(string key, JsonNode value)
        {
            _values[key] = value;
            if (IsArrayIndexKey(key))
            {
                _indexKeys[ParseIndexKey(key)] = key;
            }
            else
            {
                var node = new LinkedListNode<string>(key);
                _nonIndex.AddLast(node);
                _nonIndexNodes[key] = node;
            }
        }

        public bool TryGetValue(string key, out JsonNode value) => _values.TryGetValue(key, out value);

        public bool ContainsKey(string key) => _values.ContainsKey(key);

        public bool Remove(string key)
        {
            if (!_values.Remove(key))
            {
                return false;
            }
            if (IsArrayIndexKey(key))
            {
                _indexKeys.Remove(ParseIndexKey(key));
            }
            else if (_nonIndexNodes.TryGetValue(key, out var node))
            {
                _nonIndex.Remove(node);
                _nonIndexNodes.Remove(key);
            }
            return true;
        }

        public IList<string> Keys
        {
            get
            {
                var list = new List<string>(_values.Count);
                foreach (var kv in _indexKeys)
                {
                    list.Add(kv.Value);
                }
                for (var node = _nonIndex.First; node != null; node = node.Next)
                {
                    list.Add(node.Value);
                }
                return list;
            }
        }

        public void Add(string key, JsonNode value) => this[key] = value;

        public int IndexOf(string key)
        {
            int i = 0;
            foreach (var kv in _indexKeys)
            {
                if (kv.Value == key)
                {
                    return i;
                }
                i++;
            }
            for (var node = _nonIndex.First; node != null; node = node.Next)
            {
                if (node.Value == key)
                {
                    return i;
                }
                i++;
            }
            return -1;
        }

        /// <summary>
        /// Returns the non-index key that follows <paramref name="key"/> in the
        /// non-index order, or <c>null</c> if it is the last one. O(1).
        /// Throws <see cref="KeyNotFoundException"/> if the key is absent.
        /// For an array-index key, returns <c>null</c>.
        /// </summary>
        public string? NextKey(string key)
        {
            if (!_values.ContainsKey(key))
            {
                throw new KeyNotFoundException("Key not found: " + key);
            }
            if (IsArrayIndexKey(key))
            {
                return null;
            }
            if (!_nonIndexNodes.TryGetValue(key, out var node))
            {
                return null;
            }
            return node.Next?.Value;
        }

        /// <summary>
        /// Inserts <paramref name="key"/> before <paramref name="beforeKey"/> in the
        /// non-index order (O(1)). Throws if <paramref name="key"/> already exists.
        /// An array-index <paramref name="key"/> is placed numerically and
        /// <paramref name="beforeKey"/> is ignored. <paramref name="beforeKey"/> == null
        /// appends after the last non-index key. If <paramref name="beforeKey"/> is not
        /// a present non-index key, appends at the end.
        /// </summary>
        public void InsertBefore(string? beforeKey, string key, JsonNode value)
        {
            if (key is null)
            {
                throw new ArgumentNullException(nameof(key));
            }
            if (_values.ContainsKey(key))
            {
                throw new ArgumentException("Key already exists.", nameof(key));
            }

            _values[key] = value;

            if (IsArrayIndexKey(key))
            {
                // Index argument is ignored; numeric position is used.
                _indexKeys[ParseIndexKey(key)] = key;
                return;
            }

            var node = new LinkedListNode<string>(key);
            if (beforeKey is null)
            {
                _nonIndex.AddLast(node);
            }
            else if (IsArrayIndexKey(beforeKey) || !_nonIndexNodes.ContainsKey(beforeKey))
            {
                // Not a present non-index key: append at the end.
                _nonIndex.AddLast(node);
            }
            else
            {
                var beforeNode = _nonIndexNodes[beforeKey];
                _nonIndex.AddBefore(beforeNode, node);
            }
            _nonIndexNodes[key] = node;
        }

        public void Insert(int index, string key, JsonNode value)
        {
            if (key is null)
            {
                throw new ArgumentNullException(nameof(key));
            }
            if (_values.ContainsKey(key))
            {
                throw new ArgumentException("Key already exists.", nameof(key));
            }

            if (IsArrayIndexKey(key))
            {
                // Index argument is ignored; numeric position is used.
                _values[key] = value;
                _indexKeys[ParseIndexKey(key)] = key;
                return;
            }

            if (index < 0 || index > _nonIndex.Count)
            {
                throw new ArgumentOutOfRangeException(nameof(index));
            }

            var node = new LinkedListNode<string>(key);
            if (_nonIndex.Count == 0 || index == _nonIndex.Count)
            {
                _nonIndex.AddLast(node);
            }
            else
            {
                var target = _nonIndex.First;
                for (int i = 0; i < index; i++)
                {
                    target = target!.Next;
                }
                _nonIndex.AddBefore(target!, node);
            }
            _nonIndexNodes[key] = node;
            _values[key] = value;
        }

        public string KeyAt(int index)
        {
            if (index < 0 || index >= Count)
            {
                throw new ArgumentOutOfRangeException(nameof(index));
            }
            int idxCount = _indexKeys.Count;
            if (index < idxCount)
            {
                int i = 0;
                foreach (var kv in _indexKeys)
                {
                    if (i == index)
                    {
                        return kv.Value;
                    }
                    i++;
                }
            }
            int ni = index - idxCount;
            var node = _nonIndex.First;
            for (int i = 0; i < ni; i++)
            {
                node = node!.Next;
            }
            return node!.Value;
        }

        public IEnumerator<KeyValuePair<string, JsonNode>> GetEnumerator()
        {
            foreach (var kv in _indexKeys)
            {
                yield return new KeyValuePair<string, JsonNode>(kv.Value, _values[kv.Value]);
            }
            for (var node = _nonIndex.First; node != null; node = node.Next)
            {
                yield return new KeyValuePair<string, JsonNode>(node.Value, _values[node.Value]);
            }
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        public static bool IsArrayIndexKey(string key)
        {
            if (string.IsNullOrEmpty(key))
            {
                return false;
            }
            if (key[0] == '-' || key[0] == '+')
            {
                return false;
            }
            if (key.Length > 1 && key[0] == '0')
            {
                return false;
            }
            for (int i = 0; i < key.Length; i++)
            {
                if (key[i] < '0' || key[i] > '9')
                {
                    return false;
                }
            }
            // Parse manually to avoid culture/overflow surprises.
            if (key.Length > 10)
            {
                // 4294967294 has 10 digits; longer can't be <= max unless leading zeros (already excluded).
                return false;
            }
            if (!ulong.TryParse(key, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var v))
            {
                return false;
            }
            return v <= 4294967294UL;
        }

        private static uint ParseIndexKey(string key)
        {
            return uint.Parse(key, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture);
        }
    }

    /// <summary>JSON array.</summary>
    public sealed class JsonArray : JsonNode, IList<JsonNode>
    {
        private readonly List<JsonNode> _items = new List<JsonNode>();

        public int Count => _items.Count;

        public bool IsReadOnly => false;

        public JsonNode this[int index]
        {
            get => _items[index];
            set => _items[index] = value;
        }

        public void Add(JsonNode item) => _items.Add(item);

        public void Insert(int index, JsonNode item) => _items.Insert(index, item);

        public void RemoveAt(int index) => _items.RemoveAt(index);

        public bool Remove(JsonNode item) => _items.Remove(item);

        public void Clear() => _items.Clear();

        public bool Contains(JsonNode item) => _items.Contains(item);

        public int IndexOf(JsonNode item) => _items.IndexOf(item);

        public void CopyTo(JsonNode[] array, int arrayIndex) => _items.CopyTo(array, arrayIndex);

        public IEnumerator<JsonNode> GetEnumerator() => _items.GetEnumerator();

        IEnumerator IEnumerable.GetEnumerator() => _items.GetEnumerator();
    }

    /// <summary>JSON string.</summary>
    public sealed class JsonString : JsonNode
    {
        public string Value { get; }

        public JsonString(string value) => Value = value;
    }

    /// <summary>JSON number stored as its original raw text.</summary>
    public sealed class JsonNumber : JsonNode
    {
        public string Raw { get; }

        public JsonNumber(string raw) => Raw = raw;

        public double AsDouble() => double.Parse(Raw, System.Globalization.CultureInfo.InvariantCulture);

        public long AsInt64() => long.Parse(Raw, System.Globalization.CultureInfo.InvariantCulture);

        public int AsInt32() => int.Parse(Raw, System.Globalization.CultureInfo.InvariantCulture);

        public static JsonNumber From(double d) => new JsonNumber(JsNumber.Format(d));

        public static JsonNumber From(long l) => new JsonNumber(l.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    /// <summary>JSON boolean.</summary>
    public sealed class JsonBool : JsonNode
    {
        public bool Value { get; }

        public static readonly JsonBool True = new JsonBool(true);
        public static readonly JsonBool False = new JsonBool(false);

        private JsonBool(bool value) => Value = value;
    }

    /// <summary>JSON null.</summary>
    public sealed class JsonNull : JsonNode
    {
        public static readonly JsonNull Instance = new JsonNull();

        private JsonNull() { }
    }
}
