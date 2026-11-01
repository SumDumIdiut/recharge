using System;
using System.Globalization;

namespace Recharge.Core.Models
{
    /// <summary>A version string following the Recharge/SemVer rules.</summary>
    public sealed class RechargeVersion : IComparable<RechargeVersion>, IEquatable<RechargeVersion>
    {
        private readonly int[] _parts;
        private readonly string? _preRelease;
        private readonly string _text;

        private RechargeVersion(int[] parts, string? preRelease, string text)
        {
            _parts = parts;
            _preRelease = preRelease;
            _text = text;
        }

        /// <summary>The original text.</summary>
        public override string ToString() => _text;

        public static bool TryParse(string? text, out RechargeVersion? version)
        {
            version = null;
            if (string.IsNullOrWhiteSpace(text))
            {
                return false;
            }
            string s = text!;

            string core = s;
            string? pre = null;
            int dash = s.IndexOf('-');
            if (dash >= 0)
            {
                // Only the first '-' separates the pre-release.
                core = s.Substring(0, dash);
                pre = s.Substring(dash + 1);
                if (core.Length == 0 || pre.Length == 0)
                {
                    return false;
                }
                if (s.IndexOf('-', dash + 1) >= 0)
                {
                    // Multiple pre-release separators are not supported here.
                    return false;
                }
            }

            if (core.Length == 0)
            {
                return false;
            }

            string[] partStrs = core.Split('.');
            if (partStrs.Length < 1 || partStrs.Length > 4)
            {
                return false;
            }

            int[] parts = new int[partStrs.Length];
            for (int i = 0; i < partStrs.Length; i++)
            {
                string p = partStrs[i];
                if (p.Length == 0)
                {
                    return false;
                }
                for (int c = 0; c < p.Length; c++)
                {
                    if (p[c] < '0' || p[c] > '9')
                    {
                        return false;
                    }
                }
                if (p.Length > 1 && p[0] == '0')
                {
                    return false;
                }
                if (!int.TryParse(p, NumberStyles.None, CultureInfo.InvariantCulture, out int v))
                {
                    return false;
                }
                if (v < 0)
                {
                    return false;
                }
                parts[i] = v;
            }

            // Pre-release: keep it simple but reject whitespace.
            if (pre != null && (pre.IndexOf(' ') >= 0 || pre.IndexOf('\t') >= 0))
            {
                return false;
            }

            version = new RechargeVersion(parts, pre, s);
            return true;
        }

        public static RechargeVersion Parse(string text)
        {
            if (!TryParse(text, out var v) || v is null)
            {
                throw new FormatException("Invalid RechargeVersion: " + text);
            }
            return v;
        }

        public int CompareTo(RechargeVersion? other)
        {
            if (other is null)
            {
                return 1;
            }
            int max = Math.Max(_parts.Length, other._parts.Length);
            for (int i = 0; i < max; i++)
            {
                int a = i < _parts.Length ? _parts[i] : 0;
                int b = i < other._parts.Length ? other._parts[i] : 0;
                if (a != b)
                {
                    return a.CompareTo(b);
                }
            }

            bool thisPre = _preRelease != null;
            bool otherPre = other._preRelease != null;
            if (!thisPre && !otherPre)
            {
                return 0;
            }
            if (!thisPre && otherPre)
            {
                return 1;
            }
            if (thisPre && !otherPre)
            {
                return -1;
            }
            return ComparePreRelease(_preRelease!, other._preRelease!);
        }

        private static int ComparePreRelease(string a, string b)
        {
            if (a == b)
            {
                return 0;
            }
            (string pa, long? na) = SplitTrailingNumber(a);
            (string pb, long? nb) = SplitTrailingNumber(b);

            if (pa == pb)
            {
                if (na.HasValue && nb.HasValue)
                {
                    return na.Value.CompareTo(nb.Value);
                }
                if (na.HasValue)
                {
                    return -1;
                }
                if (nb.HasValue)
                {
                    return 1;
                }
            }
            return string.CompareOrdinal(a, b);
        }

        private static (string prefix, long? number) SplitTrailingNumber(string s)
        {
            int i = s.Length - 1;
            while (i >= 0 && char.IsDigit(s[i]))
            {
                i--;
            }
            if (i == s.Length - 1)
            {
                return (s, null);
            }
            string numStr = s.Substring(i + 1);
            string prefix = i >= 0 ? s.Substring(0, i + 1) : string.Empty;
            if (long.TryParse(numStr, NumberStyles.None, CultureInfo.InvariantCulture, out long n))
            {
                return (prefix, n);
            }
            return (s, null);
        }

        public bool Equals(RechargeVersion? other) => CompareTo(other) == 0;

        public override bool Equals(object? obj) => obj is RechargeVersion v && Equals(v);

        public override int GetHashCode()
        {
            int h = 0;
            foreach (int p in _parts)
            {
                h = h * 31 + p;
            }
            if (_preRelease != null)
            {
                h = h * 31 + _preRelease.GetHashCode();
            }
            return h;
        }

        public static bool operator ==(RechargeVersion? a, RechargeVersion? b)
        {
            if (ReferenceEquals(a, b)) return true;
            if (a is null || b is null) return false;
            return a.CompareTo(b) == 0;
        }

        public static bool operator !=(RechargeVersion? a, RechargeVersion? b) => !(a == b);

        public static bool operator <(RechargeVersion? a, RechargeVersion? b)
        {
            if (a is null) return b is not null;
            if (b is null) return false;
            return a.CompareTo(b) < 0;
        }

        public static bool operator >(RechargeVersion? a, RechargeVersion? b) => b < a;

        public static bool operator <=(RechargeVersion? a, RechargeVersion? b) => !(b < a);

        public static bool operator >=(RechargeVersion? a, RechargeVersion? b) => !(a < b);
    }
}
