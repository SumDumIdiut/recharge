using System;
using System.Collections.Generic;
using Recharge.Core.Json;

namespace Recharge.MapDoc
{
    public sealed class Transaction
    {
        public List<DocOp> Ops { get; } = new List<DocOp>();

        public string? Label { get; set; }

        public Transaction()
        {
        }

        public Transaction(string? label)
        {
            Label = label;
        }

        public Transaction(IEnumerable<DocOp> ops, string? label = null)
        {
            if (ops is null)
            {
                throw new ArgumentNullException(nameof(ops));
            }
            Ops.AddRange(ops);
            Label = label;
        }

        public Transaction(params DocOp[] ops) : this((IEnumerable<DocOp>)ops, null)
        {
        }

        public Transaction Apply(JsonNode root)
        {
            if (root is null)
            {
                throw new ArgumentNullException(nameof(root));
            }
            var inverses = new List<DocOp>();
            for (int i = 0; i < Ops.Count; i++)
            {
                try
                {
                    var inv = Ops[i].Apply(root);
                    inverses.Add(inv);
                }
                catch
                {
                    // Roll back ops 0..i-1.
                    for (int j = inverses.Count - 1; j >= 0; j--)
                    {
                        try
                        {
                            inverses[j].Apply(root);
                        }
                        catch
                        {
                            // Best effort rollback.
                        }
                    }
                    throw;
                }
            }
            inverses.Reverse();
            return new Transaction(inverses, Label);
        }
    }
}