using System;
using System.IO;
using System.Text;

namespace Recharge.Core.Json
{
    /// <summary>Writes JSON in the style of JS JSON.stringify(value, null, indent).</summary>
    public static class JsonWriter
    {
        public static string Write(JsonNode node, int indent = 2)
        {
            var sw = new StringWriter();
            Write(node, sw, indent);
            return sw.ToString();
        }

        public static void Write(JsonNode node, TextWriter writer, int indent = 2)
        {
            if (writer == null)
            {
                throw new ArgumentNullException(nameof(writer));
            }
            int unit = indent < 0 ? 0 : indent;
            // JS caps indent at 10 for numbers; mirror that for safety.
            if (unit > 10)
            {
                unit = 10;
            }
            WriteValue(node, writer, 0, unit);
        }

        private static void WriteValue(JsonNode node, TextWriter writer, int currentIndent, int unit)
        {
            switch (node)
            {
                case JsonObject obj:
                    WriteObject(obj, writer, currentIndent, unit);
                    break;
                case JsonArray arr:
                    WriteArray(arr, writer, currentIndent, unit);
                    break;
                case JsonString str:
                    writer.Write(EscapeString(str.Value));
                    break;
                case JsonNumber num:
                    writer.Write(num.Raw);
                    break;
                case JsonBool b:
                    writer.Write(b.Value ? "true" : "false");
                    break;
                case JsonNull:
                    writer.Write("null");
                    break;
                default:
                    throw new ArgumentException("Unknown JsonNode type", nameof(node));
            }
        }

        private static void WriteObject(JsonObject obj, TextWriter writer, int currentIndent, int unit)
        {
            if (obj.Count == 0)
            {
                writer.Write("{}");
                return;
            }
            if (unit == 0)
            {
                writer.Write("{");
                bool first = true;
                foreach (var kv in obj)
                {
                    if (!first)
                    {
                        writer.Write(",");
                    }
                    first = false;
                    writer.Write("\"");
                    writer.Write(EscapeStringBody(kv.Key));
                    writer.Write("\":");
                    WriteValue(kv.Value, writer, currentIndent, unit);
                }
                writer.Write("}");
                return;
            }

            writer.Write("{\n");
            bool firstItem = true;
            foreach (var kv in obj)
            {
                if (!firstItem)
                {
                    writer.Write(",\n");
                }
                firstItem = false;
                writer.Write(new string(' ', currentIndent + unit));
                writer.Write("\"");
                writer.Write(EscapeStringBody(kv.Key));
                writer.Write("\": ");
                WriteValue(kv.Value, writer, currentIndent + unit, unit);
            }
            writer.Write("\n");
            writer.Write(new string(' ', currentIndent));
            writer.Write("}");
        }

        private static void WriteArray(JsonArray arr, TextWriter writer, int currentIndent, int unit)
        {
            if (arr.Count == 0)
            {
                writer.Write("[]");
                return;
            }
            if (unit == 0)
            {
                writer.Write("[");
                bool first = true;
                foreach (var item in arr)
                {
                    if (!first)
                    {
                        writer.Write(",");
                    }
                    first = false;
                    WriteValue(item, writer, currentIndent, unit);
                }
                writer.Write("]");
                return;
            }

            writer.Write("[\n");
            bool firstItem = true;
            foreach (var item in arr)
            {
                if (!firstItem)
                {
                    writer.Write(",\n");
                }
                firstItem = false;
                writer.Write(new string(' ', currentIndent + unit));
                WriteValue(item, writer, currentIndent + unit, unit);
            }
            writer.Write("\n");
            writer.Write(new string(' ', currentIndent));
            writer.Write("]");
        }

        // Full escaped JSON string including surrounding quotes.
        private static string EscapeString(string s)
        {
            var sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            AppendEscaped(sb, s);
            sb.Append('"');
            return sb.ToString();
        }

        // Escaped body without surrounding quotes (used for keys via Write).
        private static string EscapeStringBody(string s) => EscapeBody(s);

        private static string EscapeBody(string s)
        {
            // We build via StringBuilder and return; but Write calls need string. Could write directly.
            // For simplicity return escaped body.
            var sb = new StringBuilder(s.Length);
            AppendEscaped(sb, s);
            return sb.ToString();
        }

        private static void AppendEscaped(StringBuilder sb, string s)
        {
            if (s == null)
            {
                return;
            }
            int len = s.Length;
            for (int i = 0; i < len; i++)
            {
                char c = s[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x0020)
                        {
                            sb.Append("\\u");
                            sb.Append(((int)c).ToString("x4", System.Globalization.CultureInfo.InvariantCulture));
                        }
                        else if (IsHighSurrogate(c))
                        {
                            // Lone high surrogate if not followed by low.
                            if (i + 1 < len && IsLowSurrogate(s[i + 1]))
                            {
                                sb.Append(c);
                                sb.Append(s[i + 1]);
                                i++;
                            }
                            else
                            {
                                sb.Append("\\u");
                                sb.Append(((int)c).ToString("x4", System.Globalization.CultureInfo.InvariantCulture));
                            }
                        }
                        else if (IsLowSurrogate(c))
                        {
                            // Lone low surrogate (not preceded by high).
                            sb.Append("\\u");
                            sb.Append(((int)c).ToString("x4", System.Globalization.CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
        }

        private static bool IsHighSurrogate(char c) => c >= '\uD800' && c <= '\uDBFF';
        private static bool IsLowSurrogate(char c) => c >= '\uDC00' && c <= '\uDFFF';
    }
}
