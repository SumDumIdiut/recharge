using System;
using System.IO;
using System.Text;

namespace Recharge.Core.Json
{
    /// <summary>
    /// A JSON file preserving its on-disk layout (compact vs. indented, indent width,
    /// and an optional trailing newline) so that a load+save is byte-identical.
    /// </summary>
    public sealed class JsonFile
    {
        /// <summary>The root object of the file.</summary>
        public JsonObject Root { get; }

        /// <summary>Indent width: 0 means compact, otherwise the number of spaces per level.</summary>
        public int Indent { get; }

        /// <summary>Alias for <see cref="Indent"/>.</summary>
        public int IndentWidth => Indent;

        /// <summary>Alias for <see cref="Indent"/>.</summary>
        public int IndentSize => Indent;

        /// <summary>Whether the original text ended with a newline.</summary>
        public bool TrailingNewline { get; }

        /// <summary>Alias for <see cref="TrailingNewline"/>.</summary>
        public bool HasTrailingNewline => TrailingNewline;

        private JsonFile(JsonObject root, int indent, bool trailingNewline)
        {
            Root = root ?? throw new ArgumentNullException(nameof(root));
            Indent = indent < 0 ? 0 : indent;
            TrailingNewline = trailingNewline;
        }

        /// <summary>Parses <paramref name="text"/>, detecting its layout.</summary>
        public static JsonFile Parse(string text)
        {
            if (text == null)
            {
                throw new ArgumentNullException(nameof(text));
            }

            bool hasNewlineOutsideStrings = false;
            bool inString = false;
            bool escape = false;
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (inString)
                {
                    if (escape)
                    {
                        escape = false;
                    }
                    else if (c == '\\')
                    {
                        escape = true;
                    }
                    else if (c == '"')
                    {
                        inString = false;
                    }
                }
                else
                {
                    if (c == '"')
                    {
                        inString = true;
                    }
                    else if (c == '\n')
                    {
                        hasNewlineOutsideStrings = true;
                    }
                }
            }

            bool trailingNewline = text.EndsWith("\n", StringComparison.Ordinal);

            int indent = 0;
            if (hasNewlineOutsideStrings)
            {
                indent = DetectIndent(text);
                if (indent <= 0)
                {
                    indent = 2;
                }
            }

            var node = JsonReader.Parse(text);
            if (node is not JsonObject obj)
            {
                throw new ArgumentException("JSON root must be an object.", nameof(text));
            }
            return new JsonFile(obj, indent, trailingNewline);
        }

        private static int DetectIndent(string text)
        {
            var lines = text.Split('\n');
            for (int li = 1; li < lines.Length; li++)
            {
                string line = lines[li];
                int spaces = 0;
                while (spaces < line.Length && line[spaces] == ' ')
                {
                    spaces++;
                }
                if (spaces > 0 && spaces < line.Length)
                {
                    return spaces;
                }
            }
            return 0;
        }

        /// <summary>Creates a new file with the given root and indent (no trailing newline).</summary>
        public static JsonFile New(JsonObject root, int indent = 2) => new JsonFile(root, indent, false);

        /// <summary>Reproduces the original layout.</summary>
        public string Write()
        {
            string s = JsonWriter.Write(Root, Indent);
            if (TrailingNewline)
            {
                s += "\n";
            }
            return s;
        }
    }
}
