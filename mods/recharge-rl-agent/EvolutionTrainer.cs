using System;

namespace RechargeRlAgent
{
    // A plain elitist (1+K) evolution strategy: each generation, perturb the
    // current champion K ways with Gaussian noise, evaluate every candidate
    // with one real in-game episode, and keep whichever weight vector (old
    // champion included) produced the best fitness. No backprop/gradients
    // needed - fitness is just "how many seconds did this attempt take"
    // (lower is better), which black-box search handles directly without
    // any reward-shaping detour.
    internal class EvolutionTrainer
    {
        public const int CandidatesPerGeneration = 6;

        private readonly Random _rng;
        private float[] _championWeights;
        private float _championFitness;
        private int _candidateIndex;
        private float[] _candidateWeights;
        private float _sigma;

        public int Generation { get; private set; }
        public float BestFitness => _championFitness;
        public float[] ChampionWeights => _championWeights;

        public EvolutionTrainer(float[] initialWeights, float initialBestFitness, int startGeneration, int seed, float sigma = 0.3f)
        {
            _rng = new Random(seed);
            _championWeights = (float[])initialWeights.Clone();
            _championFitness = initialBestFitness;
            Generation = startGeneration;
            _sigma = sigma;
            _candidateIndex = 0;
        }

        // Called once per episode, right before it starts - returns the
        // weight vector the controller should load into its NeuralNet for
        // this attempt.
        public float[] NextCandidate()
        {
            _candidateWeights = Perturb(_championWeights);
            return _candidateWeights;
        }

        // Called once per episode, right after it ends, with that attempt's
        // final course time (float.MaxValue for a death/timeout with no
        // completion - always worse than any real finish).
        public void ReportFitness(float fitness)
        {
            if (fitness < _championFitness)
            {
                _championFitness = fitness;
                _championWeights = _candidateWeights;
            }
            _candidateIndex++;
            if (_candidateIndex >= CandidatesPerGeneration)
            {
                _candidateIndex = 0;
                Generation++;
                // Anneal step size as the champion improves - early on, big
                // jumps explore the whole action-timing space; once a course
                // is being finished reliably, smaller steps refine technique
                // instead of undoing what already works.
                _sigma = Math.Max(0.05f, _sigma * 0.97f);
            }
        }

        private float[] Perturb(float[] baseWeights)
        {
            var result = new float[baseWeights.Length];
            for (int i = 0; i < baseWeights.Length; i++)
            {
                result[i] = baseWeights[i] + (float)NextGaussian() * _sigma;
            }
            return result;
        }

        private double NextGaussian()
        {
            // Box-Muller - System.Random has no built-in normal distribution.
            double u1 = 1.0 - _rng.NextDouble();
            double u2 = _rng.NextDouble();
            return Math.Sqrt(-2.0 * Math.Log(u1)) * Math.Sin(2.0 * Math.PI * u2);
        }
    }
}
