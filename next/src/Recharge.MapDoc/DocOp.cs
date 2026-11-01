using System;
using System.Collections.Generic;
using Recharge.Core.Json;

namespace Recharge.MapDoc
{
    /// <summary>Base class for document operations.</summary>
    public abstract class DocOp
    {
        public abstract DocPath Path { get; }

        /// <summary>Applies the operation to <paramref name="root"/> and returns its exact inverse.</summary>
        public abstract DocOp Apply(JsonNode root);
    }

    public sealed class SetOp : DocOp
    {
        public override DocPath Path { get; }
        public JsonNode? Value { get; }

        public SetOp(DocPath path, JsonNode? value)
        {
            Path = path ?? throw new ArgumentNullException(nameof(path));
            Value = value;
        }

        public override DocOp Apply(JsonNode root)
        {
            return ApplySet(root, Path, Value);
        }

        internal static DocOp ApplySet(JsonNode root, DocPath path, JsonNode? value)
        {
            if (path.IsRoot)
            {
                throw new DocOpException("Cannot set the document root.");
            }
            var segments = path.Segments;
            var parent = DocOpHelpers.ResolveParent(root, segments, out var last);
            var clone = value is null ? JsonNull.Instance : value.DeepClone();

            if (parent is JsonObject obj)
            {
                bool exists = obj.ContainsKey(last!);
                JsonNode? oldValue = exists ? obj[last!].DeepClone() : null;
                obj[last!] = clone;
                if (exists)
                {
                    return new SetOp(path, oldValue);
                }
                return new RemoveOp(path);
            }

            if (parent is JsonArray arr)
            {
                if (!DocOpHelpers.TryParseIndex(last!, out int idx) || idx < 0 || idx >= arr.Count)
                {
                    throw new DocOpException("Array index out of range: " + last);
                }
                var oldValue = arr[idx].DeepClone();
                arr[idx] = clone;
                return new SetOp(path, oldValue);
            }

            throw new DocOpException("Parent is not a container.");
        }
    }

    public sealed class InsertOp : DocOp
    {
        public override DocPath Path { get; }
        public JsonNode? Value { get; }

        public InsertOp(DocPath path, JsonNode? value)
        {
            Path = path ?? throw new ArgumentNullException(nameof(path));
            Value = value;
        }

        public override DocOp Apply(JsonNode root)
        {
            if (Path.IsRoot)
            {
                throw new DocOpException("Cannot insert at the document root.");
            }
            var segments = Path.Segments;
            // Parent resolution needs special handling for '-' on arrays; resolve all but last.
            var parent = DocOpHelpers.ResolveParent(root, segments, out var last);
            var clone = Value is null ? JsonNull.Instance : Value.DeepClone();

            if (parent is JsonObject obj)
            {
                if (obj.ContainsKey(last!))
                {
                    throw new DocOpException("Key already exists: " + last);
                }
                obj[last!] = clone;
                return new RemoveOp(Path);
            }

            if (parent is JsonArray arr)
            {
                int idx;
                if (last == "-")
                {
                    idx = arr.Count;
                }
                else
                {
                    if (!DocOpHelpers.TryParseIndex(last!, out idx) || idx < 0 || idx > arr.Count)
                    {
                        throw new DocOpException("Array insert index out of range: " + last);
                    }
                }
                arr.Insert(idx, clone);
                var removePath = Path.Parent!.Append(idx);
                return new RemoveOp(removePath);
            }

            throw new DocOpException("Parent is not a container.");
        }
    }

    public sealed class RemoveOp : DocOp
    {
        public override DocPath Path { get; }

        public RemoveOp(DocPath path)
        {
            Path = path ?? throw new ArgumentNullException(nameof(path));
        }

        public override DocOp Apply(JsonNode root)
        {
            if (Path.IsRoot)
            {
                throw new DocOpException("Cannot remove the document root.");
            }
            var segments = Path.Segments;
            var parent = DocOpHelpers.ResolveParent(root, segments, out var last);

            if (parent is JsonObject obj)
            {
                if (!obj.ContainsKey(last!))
                {
                    throw new DocOpException("Key not found: " + last);
                }
                var before = obj.NextKey(last!);
                var oldValue = obj[last!].DeepClone();
                obj.Remove(last!);
                return new RestoreKeyOp(Path, oldValue, before);
            }

            if (parent is JsonArray arr)
            {
                if (!DocOpHelpers.TryParseIndex(last!, out int idx) || idx < 0 || idx >= arr.Count)
                {
                    throw new DocOpException("Array index out of range: " + last);
                }
                var oldValue = arr[idx].DeepClone();
                arr.RemoveAt(idx);
                // Inverse inserts at the same index.
                return new InsertOp(Path, oldValue);
            }

            throw new DocOpException("Parent is not a container.");
        }
    }

    public sealed class RestoreKeyOp : DocOp
    {
        public override DocPath Path { get; }
        public JsonNode? Value { get; }
        public string? Before { get; }

        public RestoreKeyOp(DocPath path, JsonNode? value, string? before)
        {
            Path = path ?? throw new ArgumentNullException(nameof(path));
            Value = value;
            Before = before;
        }

        public override DocOp Apply(JsonNode root)
        {
            if (Path.IsRoot)
            {
                throw new DocOpException("Cannot restore the document root.");
            }
            var segments = Path.Segments;
            var parent = DocOpHelpers.ResolveParent(root, segments, out var last);

            if (parent is not JsonObject obj)
            {
                throw new DocOpException("RestoreKey requires an object parent.");
            }
            if (obj.ContainsKey(last!))
            {
                throw new DocOpException("Key already exists: " + last);
            }

            var clone = Value is null ? JsonNull.Instance : Value.DeepClone();

            obj.InsertBefore(Before, last!, clone);

            return new RemoveOp(Path);
        }
    }

    internal static class DocOpHelpers
    {
        public static JsonNode ResolveParent(JsonNode root, IReadOnlyList<string> segments, out string? last)
        {
            if (segments.Count == 0)
            {
                throw new DocOpException("Path points at the root.");
            }
            JsonNode current = root;
            for (int i = 0; i < segments.Count - 1; i++)
            {
                var seg = segments[i];
                if (current is JsonObject o)
                {
                    if (!o.ContainsKey(seg))
                    {
                        throw new DocOpException("Path not found: " + seg);
                    }
                    current = o[seg];
                }
                else if (current is JsonArray a)
                {
                    if (!TryParseIndex(seg, out int idx) || idx < 0 || idx >= a.Count)
                    {
                        throw new DocOpException("Array index out of range: " + seg);
                    }
                    current = a[idx];
                }
                else
                {
                    throw new DocOpException("Path does not point to a container.");
                }
            }
            last = segments[segments.Count - 1];
            return current;
        }

        public static bool TryParseIndex(string s, out int value)
        {
            value = 0;
            if (string.IsNullOrEmpty(s))
            {
                return false;
            }
            for (int i = 0; i < s.Length; i++)
            {
                if (s[i] < '0' || s[i] > '9')
                {
                    return false;
                }
            }
            // Guard against huge values.
            if (s.Length > 10)
            {
                return false;
            }
            if (!int.TryParse(s, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out value))
            {
                return false;
            }
            if (value < 0)
            {
                return false;
            }
            return true;
        }
    }
}