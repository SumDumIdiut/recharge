using System;

namespace RechargeRlAgent
{
    // A tiny hand-rolled feedforward net (obs -> hidden(tanh) -> logits) - no
    // autodiff, no external ML library available at runtime, and none needed:
    // EvolutionTrainer only ever perturbs/copies the flat weight vector as a
    // black box, it never needs a gradient.
    internal class NeuralNet
    {
        public readonly int InputSize;
        public readonly int HiddenSize;
        public readonly int OutputSize;
        public readonly int WeightCount;

        private readonly float[] _w1; // InputSize x HiddenSize
        private readonly float[] _b1; // HiddenSize
        private readonly float[] _w2; // HiddenSize x OutputSize
        private readonly float[] _b2; // OutputSize
        private readonly float[] _hidden; // scratch buffer, reused every Evaluate call

        public NeuralNet(int inputSize, int hiddenSize, int outputSize)
        {
            InputSize = inputSize;
            HiddenSize = hiddenSize;
            OutputSize = outputSize;
            _w1 = new float[inputSize * hiddenSize];
            _b1 = new float[hiddenSize];
            _w2 = new float[hiddenSize * outputSize];
            _b2 = new float[outputSize];
            _hidden = new float[hiddenSize];
            WeightCount = _w1.Length + _b1.Length + _w2.Length + _b2.Length;
        }

        public float[] GetWeights()
        {
            var flat = new float[WeightCount];
            int i = 0;
            Array.Copy(_w1, 0, flat, i, _w1.Length); i += _w1.Length;
            Array.Copy(_b1, 0, flat, i, _b1.Length); i += _b1.Length;
            Array.Copy(_w2, 0, flat, i, _w2.Length); i += _w2.Length;
            Array.Copy(_b2, 0, flat, i, _b2.Length);
            return flat;
        }

        public void SetWeights(float[] flat)
        {
            int i = 0;
            Array.Copy(flat, i, _w1, 0, _w1.Length); i += _w1.Length;
            Array.Copy(flat, i, _b1, 0, _b1.Length); i += _b1.Length;
            Array.Copy(flat, i, _w2, 0, _w2.Length); i += _w2.Length;
            Array.Copy(flat, i, _b2, 0, _b2.Length);
        }

        // Deterministic - the champion policy plays the same way every time
        // for a given state. Exploration comes from EvolutionTrainer trying
        // many different weight vectors across candidates/generations, not
        // from stochastic action sampling within one candidate's lifetime.
        public int ChooseAction(float[] obs)
        {
            for (int h = 0; h < HiddenSize; h++)
            {
                float sum = _b1[h];
                for (int i = 0; i < InputSize; i++) sum += obs[i] * _w1[i * HiddenSize + h];
                _hidden[h] = (float)Math.Tanh(sum);
            }

            int best = 0;
            float bestScore = float.NegativeInfinity;
            for (int o = 0; o < OutputSize; o++)
            {
                float sum = _b2[o];
                for (int h = 0; h < HiddenSize; h++) sum += _hidden[h] * _w2[h * OutputSize + o];
                if (sum > bestScore) { bestScore = sum; best = o; }
            }
            return best;
        }
    }
}
