using System;
using System.Collections.Generic;
using Recharge.Core.Json;

namespace Recharge.MapDoc
{
    public static class OpJson
    {
        public static JsonNode ToJson(DocOp op)
        {
            if (op is null)
            {
                throw new ArgumentNullException(nameof(op));
            }

            var obj = new JsonObject();
            switch (op)
            {
                case SetOp s:
                    obj["op"] = new JsonString("set");
                    obj["path"] = new JsonString(s.Path.ToString());
                    obj["value"] = s.Value is null ? JsonNull.Instance : s.Value.DeepClone();
                    break;
                case InsertOp i:
                    obj["op"] = new JsonString("insert");
                    obj["path"] = new JsonString(i.Path.ToString());
                    obj["value"] = i.Value is null ? JsonNull.Instance : i.Value.DeepClone();
                    break;
                case RemoveOp r:
                    obj["op"] = new JsonString("remove");
                    obj["path"] = new JsonString(r.Path.ToString());
                    break;
                case RestoreKeyOp rk:
                    obj["op"] = new JsonString("restoreKey");
                    obj["path"] = new JsonString(rk.Path.ToString());
                    obj["value"] = rk.Value is null ? JsonNull.Instance : rk.Value.DeepClone();
                    obj["before"] = rk.Before is null ? JsonNull.Instance : new JsonString(rk.Before);
                    break;
                default:
                    throw new ArgumentException("Unknown DocOp type.", nameof(op));
            }
            return obj;
        }

        public static DocOp FromJson(JsonNode node)
        {
            if (node is not JsonObject obj)
            {
                throw new DocOpException("Op JSON must be an object.");
            }
            if (!obj.TryGetValue("op", out var opNode) || opNode is not JsonString opStr)
            {
                throw new DocOpException("Missing op.");
            }
            if (!obj.TryGetValue("path", out var pathNode) || pathNode is not JsonString pathStr)
            {
                throw new DocOpException("Missing path.");
            }
            var path = DocPath.Parse(pathStr.Value);

            switch (opStr.Value)
            {
                case "set":
                    if (!obj.TryGetValue("value", out var sv))
                    {
                        throw new DocOpException("Missing value.");
                    }
                    return new SetOp(path, sv.DeepClone());
                case "insert":
                    if (!obj.TryGetValue("value", out var iv))
                    {
                        throw new DocOpException("Missing value.");
                    }
                    return new InsertOp(path, iv.DeepClone());
                case "remove":
                    return new RemoveOp(path);
                case "restoreKey":
                    if (!obj.TryGetValue("value", out var rv))
                    {
                        throw new DocOpException("Missing value.");
                    }
                    if (!obj.TryGetValue("before", out var beforeNode))
                    {
                        throw new DocOpException("Missing before.");
                    }
                    string? before;
                    if (beforeNode is JsonNull)
                    {
                        before = null;
                    }
                    else if (beforeNode is JsonString bs)
                    {
                        before = bs.Value;
                    }
                    else
                    {
                        throw new DocOpException("Invalid before.");
                    }
                    return new RestoreKeyOp(path, rv.DeepClone(), before);
                default:
                    throw new DocOpException("Unknown op: " + opStr.Value);
            }
        }

        public static JsonNode ToJson(Transaction tx)
        {
            if (tx is null)
            {
                throw new ArgumentNullException(nameof(tx));
            }
            var obj = new JsonObject();
            if (tx.Label is not null)
            {
                obj["label"] = new JsonString(tx.Label);
            }
            var ops = new JsonArray();
            foreach (var op in tx.Ops)
            {
                ops.Add(ToJson(op));
            }
            obj["ops"] = ops;
            return obj;
        }

        public static Transaction TransactionFromJson(JsonNode node)
        {
            if (node is not JsonObject obj)
            {
                throw new DocOpException("Transaction JSON must be an object.");
            }
            string? label = null;
            if (obj.TryGetValue("label", out var labelNode))
            {
                if (labelNode is JsonString ls)
                {
                    label = ls.Value;
                }
                else if (labelNode is JsonNull)
                {
                    label = null;
                }
                else
                {
                    throw new DocOpException("Invalid label.");
                }
            }
            if (!obj.TryGetValue("ops", out var opsNode) || opsNode is not JsonArray opsArr)
            {
                throw new DocOpException("Missing ops array.");
            }
            var tx = new Transaction(label);
            foreach (var item in opsArr)
            {
                tx.Ops.Add(FromJson(item));
            }
            return tx;
        }

        // Aliases to maximize API compatibility.
        public static JsonNode ToNode(DocOp op) => ToJson(op);
        public static DocOp FromNode(JsonNode node) => FromJson(node);
        public static JsonNode Serialize(DocOp op) => ToJson(op);
        public static DocOp Deserialize(JsonNode node) => FromJson(node);
        public static JsonNode Encode(DocOp op) => ToJson(op);
        public static DocOp Decode(JsonNode node) => FromJson(node);
        public static JsonNode Write(DocOp op) => ToJson(op);
        public static DocOp Read(JsonNode node) => FromJson(node);
        public static JsonNode OpToJson(DocOp op) => ToJson(op);
        public static DocOp OpFromJson(JsonNode node) => FromJson(node);
        public static JsonNode ToJsonNode(DocOp op) => ToJson(op);
        public static DocOp FromJsonNode(JsonNode node) => FromJson(node);

        public static JsonNode ToNode(Transaction tx) => ToJson(tx);
        public static Transaction FromNode(JsonNode node, bool transaction) => TransactionFromJson(node);
        public static JsonNode Serialize(Transaction tx) => ToJson(tx);
        public static Transaction DeserializeTransaction(JsonNode node) => TransactionFromJson(node);
        public static JsonNode Encode(Transaction tx) => ToJson(tx);
        public static Transaction DecodeTransaction(JsonNode node) => TransactionFromJson(node);
        public static JsonNode Write(Transaction tx) => ToJson(tx);
        public static Transaction ReadTransaction(JsonNode node) => TransactionFromJson(node);
        public static JsonNode TransactionToJson(Transaction tx) => ToJson(tx);

        public static JsonNode ToJsonNode(Transaction tx) => ToJson(tx);
        public static Transaction TransactionFromJsonNode(JsonNode node) => TransactionFromJson(node);
        public static Transaction ParseTransaction(JsonNode node) => TransactionFromJson(node);
        public static JsonNode WriteTransaction(Transaction tx) => ToJson(tx);

        public static DocOp ParseOp(JsonNode node) => FromJson(node);
        public static DocOp ReadOp(JsonNode node) => FromJson(node);
        public static JsonNode WriteOp(DocOp op) => ToJson(op);
        public static DocOp DeserializeOp(JsonNode node) => FromJson(node);
        public static JsonNode SerializeOp(DocOp op) => ToJson(op);
    }
}