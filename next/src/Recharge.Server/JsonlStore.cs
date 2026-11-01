using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Recharge.Server
{
    /// <summary>
    /// An append-only JSON-lines collection held in memory. Each line is {"k":key,"v":value} or {"k":key,"d":1} (a delete).
    /// The file is compacted (rewritten to a temp file, then moved over the original) every time the store opens, which also
    /// drops a half-written last line left by a crash. Writes are flushed to disk before the call returns.
    /// </summary>
    public sealed class JsonlStore<T> : IDisposable where T : class
    {
        private static readonly JsonSerializerOptions Options = new JsonSerializerOptions();
        private readonly string _path;
        private readonly Dictionary<string, T> _items = new Dictionary<string, T>(StringComparer.Ordinal);
        private FileStream? _out;

        public JsonlStore(string path)
        {
            _path = path;
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
            Load();
            Compact();
            _out = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read);
        }

        public IReadOnlyDictionary<string, T> Items => _items;

        public bool TryGet(string key, out T value)
        {
            bool found = _items.TryGetValue(key, out T? v);
            value = v!;
            return found;
        }

        public void Put(string key, T value)
        {
            _items[key] = value;
            Append("{\"k\":" + JsonSerializer.Serialize(key) + ",\"v\":" + JsonSerializer.Serialize(value, Options) + "}\n");
        }

        public bool Remove(string key)
        {
            if (!_items.Remove(key)) return false;
            Append("{\"k\":" + JsonSerializer.Serialize(key) + ",\"d\":1}\n");
            return true;
        }

        private void Append(string line)
        {
            if (_out is null) throw new ObjectDisposedException(nameof(JsonlStore<T>));
            byte[] bytes = Encoding.UTF8.GetBytes(line);
            _out.Write(bytes, 0, bytes.Length);
            _out.Flush(true);
        }

        private void Load()
        {
            if (!File.Exists(_path)) return;
            foreach (string line in File.ReadLines(_path))
            {
                if (line.Length == 0) continue;
                try
                {
                    using JsonDocument doc = JsonDocument.Parse(line);
                    JsonElement root = doc.RootElement;
                    string key = root.GetProperty("k").GetString() ?? "";
                    if (root.TryGetProperty("d", out _))
                    {
                        _items.Remove(key);
                    }
                    else
                    {
                        T? value = root.GetProperty("v").Deserialize<T>(Options);
                        if (value is not null) _items[key] = value;
                    }
                }
                catch (Exception e) when (e is JsonException || e is KeyNotFoundException || e is InvalidOperationException)
                {
                    // A torn or damaged line (usually the last, after a crash) is skipped; compaction removes it.
                }
            }
        }

        private void Compact()
        {
            string temp = _path + ".tmp";
            using (var f = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                foreach (KeyValuePair<string, T> item in _items)
                {
                    string line = "{\"k\":" + JsonSerializer.Serialize(item.Key) + ",\"v\":" + JsonSerializer.Serialize(item.Value, Options) + "}\n";
                    byte[] bytes = Encoding.UTF8.GetBytes(line);
                    f.Write(bytes, 0, bytes.Length);
                }
                f.Flush(true);
            }
            File.Move(temp, _path, overwrite: true);
        }

        public void Dispose()
        {
            _out?.Dispose();
            _out = null;
        }
    }
}
