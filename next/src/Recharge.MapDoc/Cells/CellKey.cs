using System;

namespace Recharge.MapDoc
{
    public readonly struct CellKey(int x, int y) : IEquatable<CellKey>, ISpatialKey
    {
        public int X { get; } = x;
        public int Y { get; } = y;

        public override string ToString() => X.ToString() + "," + Y.ToString();

        public static bool TryParse(string? s, out CellKey k)
        {
            k = default;
            if (string.IsNullOrEmpty(s))
            {
                return false;
            }

            int comma = s.IndexOf(',');
            if (comma < 0 || comma != s.LastIndexOf(','))
            {
                return false;
            }
            if (comma == 0 || comma == s.Length - 1)
            {
                return false;
            }

            var left = s.Substring(0, comma);
            var right = s.Substring(comma + 1);
            if (!TryParseInt(left, out int x) || !TryParseInt(right, out int y))
            {
                return false;
            }
            k = new CellKey(x, y);
            return true;
        }

        private static bool TryParseInt(string s, out int value)
        {
            value = 0;
            if (string.IsNullOrEmpty(s))
            {
                return false;
            }
            int i = 0;
            bool negative = false;
            if (s[0] == '-')
            {
                negative = true;
                i = 1;
                if (s.Length == 1)
                {
                    return false;
                }
            }
            else if (s[0] == '+')
            {
                return false;
            }

            if (i >= s.Length)
            {
                return false;
            }
            if (s.Length - i > 1 && s[i] == '0')
            {
                return false;
            }

            long acc = 0;
            for (; i < s.Length; i++)
            {
                char c = s[i];
                if (c < '0' || c > '9')
                {
                    return false;
                }
                acc = acc * 10 + (c - '0');
                if (acc > 2147483648L)
                {
                    return false;
                }
            }
            if (negative)
            {
                acc = -acc;
                if (acc < int.MinValue)
                {
                    return false;
                }
            }
            else
            {
                if (acc > int.MaxValue)
                {
                    return false;
                }
            }
            value = (int)acc;
            return true;
        }

        public bool Equals(CellKey other) => X == other.X && Y == other.Y;
        public override bool Equals(object? obj) => obj is CellKey other && Equals(other);
        public override int GetHashCode() => HashCode.Combine(X, Y);

        public static bool operator ==(CellKey a, CellKey b) => a.Equals(b);
        public static bool operator !=(CellKey a, CellKey b) => !a.Equals(b);
    }

    public interface ISpatialKey
    {
        int X { get; }
        int Y { get; }
    }
}
