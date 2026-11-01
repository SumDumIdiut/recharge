using System;

namespace Recharge.MapDoc
{
    public readonly struct TileKey(string layer, int x, int y) : IEquatable<TileKey>, ISpatialKey
    {
        public string Layer { get; } = layer ?? throw new ArgumentNullException(nameof(layer));
        public int X { get; } = x;
        public int Y { get; } = y;

        public override string ToString() => Layer + "|" + X.ToString() + "," + Y.ToString();

        public static bool TryParse(string? s, out TileKey k)
        {
            k = default;
            if (string.IsNullOrEmpty(s))
            {
                return false;
            }
            int sep = s.IndexOf('|');
            if (sep < 0)
            {
                return false;
            }
            if (s.IndexOf('|', sep + 1) >= 0)
            {
                return false;
            }
            var layer = s.Substring(0, sep);
            var rest = s.Substring(sep + 1);
            if (!CellKey.TryParse(rest, out var ck))
            {
                return false;
            }
            k = new TileKey(layer, ck.X, ck.Y);
            return true;
        }

        public bool Equals(TileKey other) => Layer == other.Layer && X == other.X && Y == other.Y;
        public override bool Equals(object? obj) => obj is TileKey other && Equals(other);
        public override int GetHashCode() => HashCode.Combine(Layer, X, Y);

        public static bool operator ==(TileKey a, TileKey b) => a.Equals(b);
        public static bool operator !=(TileKey a, TileKey b) => !a.Equals(b);
    }
}
