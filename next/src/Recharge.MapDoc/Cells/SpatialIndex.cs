using System;
using System.Collections.Generic;

namespace Recharge.MapDoc
{
    /// <summary>
    /// A 64x64-cell chunked spatial index for keys that expose X/Y coordinates.
    /// </summary>
    internal sealed class SpatialIndex<TKey> where TKey : struct, ISpatialKey, IEquatable<TKey>
    {
        private readonly Dictionary<(int cx, int cy), HashSet<TKey>> _chunks =
            new Dictionary<(int, int), HashSet<TKey>>();

        private bool _built;
        private bool _dirty;

        public bool IsDirty => _dirty;
        public bool NeedsBuild => !_built || _dirty;

        public void MarkDirty() => _dirty = true;

        public void Rebuild(IEnumerable<TKey> keys)
        {
            _chunks.Clear();
            foreach (var k in keys)
            {
                Add(k);
            }
            _built = true;
            _dirty = false;
        }

        public void Add(TKey key)
        {
            int cx = FloorDiv(key.X, 64);
            int cy = FloorDiv(key.Y, 64);
            var chunk = (cx, cy);
            if (!_chunks.TryGetValue(chunk, out var set))
            {
                set = new HashSet<TKey>();
                _chunks[chunk] = set;
            }
            set.Add(key);
        }

        public void Remove(TKey key)
        {
            int cx = FloorDiv(key.X, 64);
            int cy = FloorDiv(key.Y, 64);
            var chunk = (cx, cy);
            if (_chunks.TryGetValue(chunk, out var set))
            {
                set.Remove(key);
                if (set.Count == 0)
                {
                    _chunks.Remove(chunk);
                }
            }
        }

        public List<TKey> QueryRect(int x0, int y0, int x1, int y1)
        {
            int xmin = Math.Min(x0, x1);
            int xmax = Math.Max(x0, x1);
            int ymin = Math.Min(y0, y1);
            int ymax = Math.Max(y0, y1);

            int cxMin = FloorDiv(xmin, 64);
            int cxMax = FloorDiv(xmax, 64);
            int cyMin = FloorDiv(ymin, 64);
            int cyMax = FloorDiv(ymax, 64);

            var result = new List<TKey>();
            for (int cx = cxMin; cx <= cxMax; cx++)
            {
                for (int cy = cyMin; cy <= cyMax; cy++)
                {
                    if (_chunks.TryGetValue((cx, cy), out var set))
                    {
                        foreach (var key in set)
                        {
                            if (key.X >= xmin && key.X <= xmax && key.Y >= ymin && key.Y <= ymax)
                            {
                                result.Add(key);
                            }
                        }
                    }
                }
            }
            return result;
        }

        private static int FloorDiv(int value, int divisor)
        {
            // divisor > 0
            return value >= 0 ? value / divisor : (value - (divisor - 1)) / divisor;
        }
    }
}
