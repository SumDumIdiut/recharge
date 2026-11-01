using System;
using System.IO;
using System.Text;

namespace Recharge.Core.Json
{
    public sealed class JsonParseException : Exception
    {
        public int Line { get; }
        public int Column { get; }
        public int LineNumber => Line;
        public int ColumnNumber => Column;

        public JsonParseException(string message, int line, int column)
            : base(message)
        {
            Line = line;
            Column = column;
        }

        public JsonParseException(string message, int line, int column, Exception innerException)
            : base(message, innerException)
        {
            Line = line;
            Column = column;
        }
    }

    public static class JsonReader
    {
        public static JsonNode Parse(string text)
        {
            if (text == null)
            {
                throw new ArgumentNullException(nameof(text));
            }
            var p = new Parser(text);
            var node = p.ParseValue();
            p.SkipWhitespace();
            if (p.Position < p.Length)
            {
                throw p.Error("Unexpected trailing content");
            }
            return node;
        }

        public static JsonNode Parse(TextReader reader)
        {
            if (reader == null)
            {
                throw new ArgumentNullException(nameof(reader));
            }
            return Parse(reader.ReadToEnd());
        }

        private sealed class Parser
        {
            private readonly string _text;
            private int _pos;
            private int _line = 1;
            private int _col = 1;
            private int _depth;

            public Parser(string text) => _text = text;

            public int Position => _pos;
            public int Length => _text.Length;

            public JsonNode ParseValue()
            {
                SkipWhitespace();
                if (_pos >= _text.Length)
                {
                    throw Error("Unexpected end of input");
                }
                char c = _text[_pos];
                switch (c)
                {
                    case '{': return ParseObject();
                    case '[': return ParseArray();
                    case '"': return new JsonString(ParseString());
                    case 't': return ParseLiteral("true", JsonBool.True);
                    case 'f': return ParseLiteral("false", JsonBool.False);
                    case 'n': return ParseLiteral("null", JsonNull.Instance);
                    default:
                        if (c == '-' || (c >= '0' && c <= '9'))
                        {
                            return ParseNumber();
                        }
                        throw Error("Unexpected character '" + c + "'");
                }
            }

            private JsonObject ParseObject()
            {
                _depth++;
                if (_depth > 10000)
                {
                    throw Error("Nesting too deep");
                }
                Expect('{');
                var obj = new JsonObject();
                SkipWhitespace();
                if (Peek() == '}')
                {
                    Advance();
                    _depth--;
                    return obj;
                }
                while (true)
                {
                    SkipWhitespace();
                    if (_pos >= _text.Length || _text[_pos] != '"')
                    {
                        throw Error("Expected string key");
                    }
                    string key = ParseString();
                    SkipWhitespace();
                    if (_pos >= _text.Length || _text[_pos] != ':')
                    {
                        throw Error("Expected ':'");
                    }
                    Advance();
                    JsonNode value = ParseValue();
                    obj[key] = value;
                    SkipWhitespace();
                    if (_pos >= _text.Length)
                    {
                        throw Error("Unexpected end of input");
                    }
                    char sep = _text[_pos];
                    if (sep == ',')
                    {
                        Advance();
                        SkipWhitespace();
                        if (_pos < _text.Length && _text[_pos] == '}')
                        {
                            throw Error("Trailing comma in object");
                        }
                        continue;
                    }
                    if (sep == '}')
                    {
                        Advance();
                        break;
                    }
                    throw Error("Expected ',' or '}'");
                }
                _depth--;
                return obj;
            }

            private JsonArray ParseArray()
            {
                _depth++;
                if (_depth > 10000)
                {
                    throw Error("Nesting too deep");
                }
                Expect('[');
                var arr = new JsonArray();
                SkipWhitespace();
                if (Peek() == ']')
                {
                    Advance();
                    _depth--;
                    return arr;
                }
                while (true)
                {
                    JsonNode value = ParseValue();
                    arr.Add(value);
                    SkipWhitespace();
                    if (_pos >= _text.Length)
                    {
                        throw Error("Unexpected end of input");
                    }
                    char sep = _text[_pos];
                    if (sep == ',')
                    {
                        Advance();
                        SkipWhitespace();
                        if (_pos < _text.Length && _text[_pos] == ']')
                        {
                            throw Error("Trailing comma in array");
                        }
                        continue;
                    }
                    if (sep == ']')
                    {
                        Advance();
                        break;
                    }
                    throw Error("Expected ',' or ']'");
                }
                _depth--;
                return arr;
            }

            private string ParseString()
            {
                if (_pos >= _text.Length || _text[_pos] != '"')
                {
                    throw Error("Expected string");
                }
                Advance();
                var sb = new StringBuilder();
                while (true)
                {
                    if (_pos >= _text.Length)
                    {
                        throw Error("Unterminated string");
                    }
                    char c = _text[_pos];
                    if (c == '"')
                    {
                        Advance();
                        return sb.ToString();
                    }
                    if (c == '\\')
                    {
                        Advance();
                        if (_pos >= _text.Length)
                        {
                            throw Error("Unterminated escape");
                        }
                        char e = _text[_pos];
                        switch (e)
                        {
                            case '"': sb.Append('"'); Advance(); break;
                            case '\\': sb.Append('\\'); Advance(); break;
                            case '/': sb.Append('/'); Advance(); break;
                            case 'b': sb.Append('\b'); Advance(); break;
                            case 'f': sb.Append('\f'); Advance(); break;
                            case 'n': sb.Append('\n'); Advance(); break;
                            case 'r': sb.Append('\r'); Advance(); break;
                            case 't': sb.Append('\t'); Advance(); break;
                            case 'u':
                                Advance();
                                int code = ParseHex4();
                                if (code >= 0xD800 && code <= 0xDBFF)
                                {
                                    if (_pos + 6 <= _text.Length &&
                                        _text[_pos] == '\\' &&
                                        _text[_pos + 1] == 'u' &&
                                        IsHex4At(_pos + 2))
                                    {
                                        int low = Hex4At(_pos + 2);
                                        if (low >= 0xDC00 && low <= 0xDFFF)
                                        {
                                            Advance();
                                            Advance();
                                            for (int i = 0; i < 4; i++) Advance();
                                            sb.Append((char)code);
                                            sb.Append((char)low);
                                            break;
                                        }
                                    }
                                    sb.Append((char)code);
                                }
                                else
                                {
                                    sb.Append((char)code);
                                }
                                break;
                            default:
                                throw Error("Invalid escape sequence");
                        }
                        continue;
                    }
                    if (c < 0x0020)
                    {
                        throw Error("Unescaped control character in string");
                    }
                    sb.Append(c);
                    Advance();
                }
            }

            private JsonNumber ParseNumber()
            {
                int start = _pos;
                if (_pos < _text.Length && _text[_pos] == '-')
                {
                    Advance();
                }
                else if (_pos < _text.Length && _text[_pos] == '+')
                {
                    throw Error("Invalid number");
                }

                if (_pos >= _text.Length)
                {
                    throw Error("Invalid number");
                }

                if (_text[_pos] == '0')
                {
                    Advance();
                    if (_pos < _text.Length && _text[_pos] >= '0' && _text[_pos] <= '9')
                    {
                        throw Error("Invalid number");
                    }
                }
                else if (_text[_pos] >= '0' && _text[_pos] <= '9')
                {
                    while (_pos < _text.Length && _text[_pos] >= '0' && _text[_pos] <= '9')
                    {
                        Advance();
                    }
                }
                else
                {
                    throw Error("Invalid number");
                }

                if (_pos < _text.Length && _text[_pos] == '.')
                {
                    Advance();
                    if (_pos >= _text.Length || _text[_pos] < '0' || _text[_pos] > '9')
                    {
                        throw Error("Invalid number");
                    }
                    while (_pos < _text.Length && _text[_pos] >= '0' && _text[_pos] <= '9')
                    {
                        Advance();
                    }
                }

                if (_pos < _text.Length && (_text[_pos] == 'e' || _text[_pos] == 'E'))
                {
                    Advance();
                    if (_pos < _text.Length && (_text[_pos] == '+' || _text[_pos] == '-'))
                    {
                        Advance();
                    }
                    if (_pos >= _text.Length || _text[_pos] < '0' || _text[_pos] > '9')
                    {
                        throw Error("Invalid number");
                    }
                    while (_pos < _text.Length && _text[_pos] >= '0' && _text[_pos] <= '9')
                    {
                        Advance();
                    }
                }

                string raw = _text.Substring(start, _pos - start);
                return new JsonNumber(raw);
            }

            private JsonNode ParseLiteral(string lit, JsonNode value)
            {
                if (_pos + lit.Length > _text.Length)
                {
                    throw Error("Unexpected end of input");
                }
                for (int i = 0; i < lit.Length; i++)
                {
                    if (_text[_pos + i] != lit[i])
                    {
                        throw Error("Unexpected character");
                    }
                }
                int after = _pos + lit.Length;
                if (after < _text.Length)
                {
                    char c = _text[after];
                    if (char.IsLetterOrDigit(c) || c == '_')
                    {
                        throw Error("Invalid literal");
                    }
                }
                for (int i = 0; i < lit.Length; i++)
                {
                    Advance();
                }
                return value;
            }

            private void Expect(char c)
            {
                SkipWhitespace();
                if (_pos >= _text.Length || _text[_pos] != c)
                {
                    throw Error("Expected '" + c + "'");
                }
                Advance();
            }

            public void SkipWhitespace()
            {
                while (_pos < _text.Length)
                {
                    char c = _text[_pos];
                    if (c == ' ' || c == '\t' || c == '\n' || c == '\r')
                    {
                        Advance();
                    }
                    else
                    {
                        break;
                    }
                }
            }

            private char Peek() => _pos < _text.Length ? _text[_pos] : '\0';

            private void Advance()
            {
                if (_pos >= _text.Length)
                {
                    return;
                }
                if (_text[_pos] == '\n')
                {
                    _line++;
                    _col = 1;
                }
                else
                {
                    _col++;
                }
                _pos++;
            }

            private int ParseHex4()
            {
                if (_pos + 4 > _text.Length)
                {
                    throw Error("Invalid unicode escape");
                }
                int val = 0;
                for (int i = 0; i < 4; i++)
                {
                    char c = _text[_pos];
                    if (!IsHex(c))
                    {
                        throw Error("Invalid unicode escape");
                    }
                    val = (val << 4) + HexVal(c);
                    Advance();
                }
                return val;
            }

            private bool IsHex4At(int pos)
            {
                if (pos + 4 > _text.Length)
                {
                    return false;
                }
                for (int i = 0; i < 4; i++)
                {
                    if (!IsHex(_text[pos + i]))
                    {
                        return false;
                    }
                }
                return true;
            }

            private int Hex4At(int pos)
            {
                int val = 0;
                for (int i = 0; i < 4; i++)
                {
                    val = (val << 4) + HexVal(_text[pos + i]);
                }
                return val;
            }

            private static bool IsHex(char c) =>
                (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

            private static int HexVal(char c)
            {
                if (c >= '0' && c <= '9') return c - '0';
                if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                return c - 'A' + 10;
            }

            public JsonParseException Error(string msg) => new JsonParseException(msg, _line, _col);
        }
    }
}
