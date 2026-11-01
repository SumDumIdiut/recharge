using System;
using System.Collections.Generic;
using System.Text;

namespace Recharge.MapDoc
{
    /// <summary>A JSON Pointer (RFC 6901) path into a document.</summary>
    public sealed class DocPath : IEquatable<DocPath>
    {
        public static readonly DocPath Root = new DocPath(Array.Empty<string>());

        private readonly string[] _segments;

        public DocPath(IEnumerable<string> segments)
        {
            if (segments is null)
            {
                throw new ArgumentNullException(nameof(segments));
            }
            var list = new List<string>(segments);
            _segments = list.ToArray();
        }

        public int Length => _segments.Length;

        public bool IsRoot => _segments.Length == 0;

        public IReadOnlyList<string> Segments => _segments;

        public static DocPath Parse(string pointer)
        {
            if (pointer is null)
            {
                throw new ArgumentNullException(nameof(pointer));
            }
            if (pointer == string.Empty)
            {
                return Root;
            }
            if (!pointer.StartsWith("/", StringComparison.Ordinal))
            {
                throw new ArgumentException("A JSON pointer must be empty or start with '/'.", nameof(pointer));
            }

            var segments = new List<string>();
            // Split on '/' but keep empty segments. Drop the leading empty from the first '/'.

            var sb = new StringBuilder();
            // We'll parse manually to handle escapes.
            // First split raw by '/'.
            var rawSegments = new List<string>();
            int start = 1;
            for (int p = 1; p <= pointer.Length; p++)
            {
                if (p == pointer.Length || pointer[p] == '/')
                {
                    rawSegments.Add(pointer.Substring(start, p - start));
                    start = p + 1;
                }
            }
            foreach (var raw in rawSegments)
            {
                segments.Add(Unescape(raw));
            }
            return new DocPath(segments);
        }

        private static string Unescape(string token)
        {
            // ~1 -> / first, then ~0 -> ~.
            return token.Replace("~1", "/").Replace("~0", "~");
        }

        public override string ToString()
        {
            if (_segments.Length == 0)
            {
                return string.Empty;
            }
            var sb = new StringBuilder();
            foreach (var seg in _segments)
            {
                sb.Append('/');
                sb.Append(Escape(seg));
            }
            return sb.ToString();
        }

        private static string Escape(string segment)
        {
            // ~ -> ~0 first, then / -> ~1.
            return segment.Replace("~", "~0").Replace("/", "~1");
        }

        public DocPath? Parent
        {
            get
            {
                if (_segments.Length == 0)
                {
                    return null;
                }
                var copy = new string[_segments.Length - 1];
                Array.Copy(_segments, copy, copy.Length);
                return new DocPath(copy);
            }
        }

        public string? Last
        {
            get
            {
                if (_segments.Length == 0)
                {
                    return null;
                }
                return _segments[_segments.Length - 1];
            }
        }

        public DocPath Append(string segment)
        {
            if (segment is null)
            {
                throw new ArgumentNullException(nameof(segment));
            }
            var copy = new string[_segments.Length + 1];
            Array.Copy(_segments, copy, _segments.Length);
            copy[_segments.Length] = segment;
            return new DocPath(copy);
        }

        public DocPath Append(int index) => Append(index.ToString(System.Globalization.CultureInfo.InvariantCulture));

        public bool Equals(DocPath? other)
        {
            if (other is null)
            {
                return false;
            }
            if (_segments.Length != other._segments.Length)
            {
                return false;
            }
            for (int i = 0; i < _segments.Length; i++)
            {
                if (_segments[i] != other._segments[i])
                {
                    return false;
                }
            }
            return true;
        }

        public override bool Equals(object? obj) => obj is DocPath other && Equals(other);

        public override int GetHashCode()
        {
            int h = 0;
            foreach (var s in _segments)
            {
                h = (h * 31) + (s is null ? 0 : s.GetHashCode());
            }
            return h;
        }

        public static bool operator ==(DocPath? a, DocPath? b)
        {
            if (ReferenceEquals(a, b))
            {
                return true;
            }
            if (a is null || b is null)
            {
                return false;
            }
            return a.Equals(b);
        }

        public static bool operator !=(DocPath? a, DocPath? b) => !(a == b);
    }
}