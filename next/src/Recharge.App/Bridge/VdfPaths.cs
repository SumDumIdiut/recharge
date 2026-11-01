using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace Recharge.App.Bridge
{
    /// <summary>Extracts Steam library roots from libraryfolders.vdf.</summary>
    public static class VdfPaths
    {
        private static readonly Regex PathLine = new Regex(
            "^\\s*\"path\"\\s+\"((?:[^\"\\\\]|\\\\.)*)\"\\s*$",
            RegexOptions.Multiline | RegexOptions.CultureInvariant);

        public static IReadOnlyList<string> Parse(string text)
        {
            var paths = new List<string>();
            var seen = new HashSet<string>(StringComparer.Ordinal);

            if (string.IsNullOrEmpty(text))
            {
                return paths;
            }

            foreach (Match match in PathLine.Matches(text))
            {
                string path = Unescape(match.Groups[1].Value);
                if (path.Length > 0 && seen.Add(path))
                {
                    paths.Add(path);
                }
            }

            return paths;
        }

        private static string Unescape(string value)
        {
            if (value.IndexOf('\\') < 0)
            {
                return value;
            }

            var chars = new System.Text.StringBuilder(value.Length);
            for (int i = 0; i < value.Length; i++)
            {
                if (value[i] == '\\' && i + 1 < value.Length)
                {
                    i++;
                    chars.Append(value[i]);
                }
                else
                {
                    chars.Append(value[i]);
                }
            }
            return chars.ToString();
        }
    }
}
