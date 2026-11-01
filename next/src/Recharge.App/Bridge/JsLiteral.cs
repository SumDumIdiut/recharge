using System.Text;

namespace Recharge.App.Bridge
{
    /// <summary>Escapes text for embedding in a JavaScript source string literal.</summary>
    public static class JsLiteral
    {
        public static string Quote(string value)
        {
            var sb = new StringBuilder(value.Length + 2);
            sb.Append('"');
            foreach (char c in value)
            {
                switch (c)
                {
                    case '"':
                        sb.Append("\\\"");
                        break;
                    case '\\':
                        sb.Append("\\\\");
                        break;
                    case '\b':
                        sb.Append("\\b");
                        break;
                    case '\f':
                        sb.Append("\\f");
                        break;
                    case '\n':
                        sb.Append("\\n");
                        break;
                    case '\r':
                        sb.Append("\\r");
                        break;
                    case '\t':
                        sb.Append("\\t");
                        break;
                    case '<':
                        sb.Append("\\u003C");
                        break;
                    case '>':
                        sb.Append("\\u003E");
                        break;
                    case '&':
                        sb.Append("\\u0026");
                        break;
                    case '\u2028':
                        sb.Append("\\u2028");
                        break;
                    case '\u2029':
                        sb.Append("\\u2029");
                        break;
                    default:
                        if (c < ' ' || (c >= '\uD800' && c <= '\uDFFF'))
                        {
                            sb.Append("\\u");
                            sb.Append(((int)c).ToString("X4", System.Globalization.CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }
}
