using System;
using System.Collections.Generic;
using System.IO;
using Recharge.Core.Json;

namespace Recharge.MapDoc
{
    public sealed class MapDocument
    {
        private sealed class Step
        {
            public Transaction Forward = null!;
            public Transaction Inverse = null!;
            public string? Label;
        }

        private readonly List<Step> _undo = new List<Step>();
        private readonly List<Step> _redo = new List<Step>();
        private int _mergeDepth;
        private readonly List<Transaction> _mergeApplied = new List<Transaction>();
        private readonly List<Transaction> _mergeInverses = new List<Transaction>();
        private string? _mergeLabel;

        public MapDocument(JsonNode root)
        {
            Root = root ?? throw new ArgumentNullException(nameof(root));
            Revision = 0;
            HistoryLimit = 1000;
        }

        public JsonNode Root { get; }

        public long Revision { get; private set; }

        private int _historyLimit = 1000;
        public int HistoryLimit
        {
            get => _historyLimit;
            set
            {
                _historyLimit = value < 0 ? 0 : value;
                TrimUndo();
            }
        }

        public bool CanUndo => _undo.Count > 0;
        public bool CanRedo => _redo.Count > 0;

        public event Action<Transaction, long>? Changed;

        public static MapDocument Load(string json)
        {
            if (json is null)
            {
                throw new ArgumentNullException(nameof(json));
            }
            return new MapDocument(JsonReader.Parse(json));
        }

        public static MapDocument Load(TextReader reader)
        {
            if (reader is null)
            {
                throw new ArgumentNullException(nameof(reader));
            }
            return new MapDocument(JsonReader.Parse(reader));
        }

        public string Save()
        {
            var sw = new StringWriter();
            Save(sw);
            return sw.ToString();
        }

        public void Save(TextWriter writer)
        {
            if (writer is null)
            {
                throw new ArgumentNullException(nameof(writer));
            }
            JsonWriter.Write(Root, writer, 2);
        }

        public void Apply(Transaction t)
        {
            if (t is null)
            {
                throw new ArgumentNullException(nameof(t));
            }

            Transaction inverse;
            try
            {
                inverse = t.Apply(Root);
            }
            catch
            {
                throw;
            }

            _redo.Clear();
            Revision++;
            Changed?.Invoke(t, Revision);

            if (_mergeDepth > 0)
            {
                _mergeApplied.Add(t);
                _mergeInverses.Add(inverse);
                return;
            }

            var step = new Step
            {
                Forward = t,
                Inverse = inverse,
                Label = t.Label
            };
            PushUndo(step);
        }

        public bool Undo()
        {
            if (_undo.Count == 0)
            {
                return false;
            }
            var step = _undo[_undo.Count - 1];
            _undo.RemoveAt(_undo.Count - 1);

            step.Inverse.Apply(Root);
            Revision++;
            _redo.Add(step);
            Changed?.Invoke(step.Inverse, Revision);
            return true;
        }

        public bool Redo()
        {
            if (_redo.Count == 0)
            {
                return false;
            }
            var step = _redo[_redo.Count - 1];
            _redo.RemoveAt(_redo.Count - 1);

            step.Forward.Apply(Root);
            Revision++;
            _undo.Add(step);
            // Respect history limit.
            TrimUndo();
            Changed?.Invoke(step.Forward, Revision);
            return true;
        }

        public void BeginMerge(string label)
        {
            _mergeDepth++;
            if (_mergeDepth == 1)
            {
                _mergeLabel = label;
                _mergeApplied.Clear();
                _mergeInverses.Clear();
            }
        }

        public void EndMerge()
        {
            if (_mergeDepth <= 0)
            {
                throw new InvalidOperationException("EndMerge called without BeginMerge.");
            }
            _mergeDepth--;
            if (_mergeDepth > 0)
            {
                return;
            }

            if (_mergeApplied.Count > 0)
            {
                var fwdOps = new List<DocOp>();
                foreach (var tx in _mergeApplied)
                {
                    fwdOps.AddRange(tx.Ops);
                }
                var invOps = new List<DocOp>();
                for (int i = _mergeInverses.Count - 1; i >= 0; i--)
                {
                    invOps.AddRange(_mergeInverses[i].Ops);
                }
                var fwdTx = new Transaction(fwdOps, _mergeLabel);
                var invTx = new Transaction(invOps, _mergeLabel);
                var step = new Step
                {
                    Forward = fwdTx,
                    Inverse = invTx,
                    Label = _mergeLabel
                };
                PushUndo(step);
            }

            _mergeApplied.Clear();
            _mergeInverses.Clear();
            _mergeLabel = null;
        }

        private void PushUndo(Step step)
        {
            if (_historyLimit <= 0)
            {
                return;
            }
            if (_undo.Count >= _historyLimit)
            {
                _undo.RemoveAt(0);
            }
            _undo.Add(step);
        }

        private void TrimUndo()
        {
            while (_undo.Count > _historyLimit && _historyLimit >= 0)
            {
                _undo.RemoveAt(0);
            }
            if (_historyLimit <= 0)
            {
                _undo.Clear();
            }
        }
    }
}