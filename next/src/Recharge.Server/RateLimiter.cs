using System;
using System.Collections.Generic;

namespace Recharge.Server
{
    /// <summary>A sliding-window limiter: at most Max hits per Window for each key.</summary>
    public sealed class RateLimiter
    {
        private readonly int _max;
        private readonly TimeSpan _window;
        private readonly Func<DateTimeOffset> _clock;
        private readonly Dictionary<string, Queue<DateTimeOffset>> _hits = new Dictionary<string, Queue<DateTimeOffset>>(StringComparer.Ordinal);
        private readonly object _gate = new object();

        public RateLimiter(int max, TimeSpan window, Func<DateTimeOffset> clock)
        {
            _max = max;
            _window = window;
            _clock = clock;
        }

        /// <summary>Counts a hit. False (with seconds to wait) when the key is over the limit.</summary>
        public bool TryHit(string key, out double retryAfterSeconds)
        {
            lock (_gate)
            {
                DateTimeOffset now = _clock();
                if (!_hits.TryGetValue(key, out Queue<DateTimeOffset>? q))
                {
                    if (_hits.Count > 20000) Sweep(now);
                    q = new Queue<DateTimeOffset>();
                    _hits[key] = q;
                }
                while (q.Count > 0 && now - q.Peek() >= _window) q.Dequeue();
                if (q.Count >= _max)
                {
                    retryAfterSeconds = Math.Max(1, Math.Ceiling((q.Peek() + _window - now).TotalSeconds));
                    return false;
                }
                q.Enqueue(now);
                retryAfterSeconds = 0;
                return true;
            }
        }

        /// <summary>Throws SocialException(429) when over the limit.</summary>
        public void Hit(string key, string what)
        {
            if (!TryHit(key, out double wait)) throw new SocialException(429, what, wait);
        }

        private void Sweep(DateTimeOffset now)
        {
            var dead = new List<string>();
            foreach (KeyValuePair<string, Queue<DateTimeOffset>> e in _hits)
            {
                if (e.Value.Count == 0 || now - e.Value.Peek() >= _window) dead.Add(e.Key);
            }
            foreach (string k in dead) _hits.Remove(k);
        }
    }
}
