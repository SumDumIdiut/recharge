using System.Linq;
using Recharge.ModApi;
using UnityEngine;

namespace RechargeRlAgent
{
    internal enum AgentMode { Idle, Training, Watching }

    // Drives the real player exactly like a human would - overrides the same
    // Velocity/jumpBuffer/dashBuffer surface PauseBufferController/IcyPhysics
    // already proved settable by reflection, rather than fighting Unity's
    // Input System for a fake device. Movement.FixedUpdate() reads real
    // input and consumes it for MoveLeftAndRight() all within the same
    // call, so there's no way to inject a mid-method value - instead this
    // class's own FixedUpdate runs LAST (DefaultExecutionOrder) each physics
    // step and adds its own hold-direction contribution on top of whatever
    // Movement already computed from (always-zero) real input that tick.
    // The result lands in body.linearVelocity one tick later than a real
    // key press would (imperceptible - 20ms at the game's 50Hz fixed tick).
    [DefaultExecutionOrder(32000)]
    internal class RlAgentController : MonoBehaviour
    {
        private const int ObservationSize = 25;
        private const float WorldScale = 10000f; // normalizes absolute world coordinates - observed course spans run in the low thousands of units
        private const int HiddenSize = 16;
        private const int ActionCount = 9; // direction {-1,0,1} x button {none,jump,dash}
        private const int DecisionIntervalTicks = 4;
        private const int MaxEpisodeTicks = 1500; // 30s of game time at the game's own 50Hz fixed tick
        private const float DeathPenaltySeconds = 60f; // always worse than any real finish, bounds the fitness scale
        private const float MinPlausibleFinishSeconds = 0.5f; // guards against a spurious tracking-flip being mistaken for a real (impossibly fast) finish
        private const int GraceTicksAfterReset = 5; // absorbs the startGate-retrigger race right after ResetToStart (see TickEpisode)
        private const float TrainingTimeScale = 2.5f; // conservative - thin hazard colliders can tunnel through at higher multipliers
        private const float RayDistance = 300f;

        private static readonly Vector2[] RayDirections =
        {
            Vector2.up, new Vector2(1, 1).normalized, Vector2.right, new Vector2(1, -1).normalized,
            Vector2.down, new Vector2(-1, -1).normalized, Vector2.left, new Vector2(-1, 1).normalized,
        };

        private IRechargeHost _host;
        private Movement _movement;
        private Rigidbody2D _body;
        private LayerMask _terrainMask;
        private float _framesToReachTopSpeed = 2f;

        private courseScript _course;
        private endGate _endGate;
        private Vector2 _startResetPoint;
        private bool _hasCourseLock;

        private readonly NeuralNet _net = new NeuralNet(ObservationSize, HiddenSize, ActionCount);
        private EvolutionTrainer _trainer;
        private RlAgentSave _save;
        private int _courseNumber;

        public AgentMode Mode { get; private set; } = AgentMode.Idle;
        private int _tickInEpisode;
        private int _currentAction;
        private float _lastKnownPathTime;
        private bool _wasTracking;

        public void Init(IRechargeHost host)
        {
            _host = host;
            _save = host.LoadConfig<RlAgentSave>(RlAgentMod.ModId);
        }

        // TEMPORARY (dev verification only, removed before release): lets a
        // real training run be exercised without needing keyboard input to
        // reach the pause menu - see the marker file check in Update().
        private bool _debugAutoStartTried;

        private void TryDebugAutoStart()
        {
            if (_debugAutoStartTried || Mode != AgentMode.Idle) return;
            var markerPath = System.IO.Path.Combine(_host.ModDataDir(RlAgentMod.ModId), "DEBUG_AUTOSTART");
            if (!System.IO.File.Exists(markerPath)) return;
            if (!EnsurePlayer()) return; // keep retrying every frame until the player actually exists (e.g. mod loads while still on the MainMenu scene)
            _debugAutoStartTried = true;
            _host.Log("[RlAgent] DEBUG_AUTOSTART marker found - starting training automatically");
            StartTraining();
        }

        private pauseMenuScript _menu;
        private bool _wasMenuOpen;

        // Re-registers this session's two pause-menu rows with a freshly
        // rendered label - PauseMenuHelper only re-renders a row's text when
        // its page is (re)shown, so this must be called both on a genuinely
        // new pauseMenuScript instance (a scene load) and every time the
        // existing one's menu is reopened, or the generation/best-time text
        // goes stale while the player is off playing between checks.
        public void InstallMenuRow(pauseMenuScript menu)
        {
            _menu = menu;
            RefreshMenuRows();
        }

        private void RefreshMenuRows()
        {
            if (_menu == null) return;
            PauseMenuHelper.AddRow(_menu, "RlAgentToggle", StatusText(), () =>
            {
                if (Mode == AgentMode.Idle) StartTraining(); else Stop();
                RefreshMenuRows();
            });
            PauseMenuHelper.AddRow(_menu, "RlAgentWatch", Mode == AgentMode.Watching ? "AI Training: Stop Watching" : "AI Training: Watch Best", () =>
            {
                if (Mode == AgentMode.Watching) Stop(); else StartWatching();
                RefreshMenuRows();
            });
        }

        private void Update()
        {
            if (_menu != null)
            {
                bool isOpen = _menu.menuOpen;
                if (isOpen && !_wasMenuOpen) RefreshMenuRows();
                _wasMenuOpen = isOpen;
            }

            if (Mode == AgentMode.Idle) { TryDebugAutoStart(); return; }
            if (!EnsurePlayer()) return;

            // Jump/dash must be buffered from Update() - same timing
            // PauseBufferController already ships with successfully, since
            // Movement's own Update() (which sets these flags from real
            // input) runs before its FixedUpdate consumes them.
            int button = _currentAction % 3;
            if (button == 1)
            {
                Reflect.SetField(_movement, "jumpBuffer", true);
                _movement.CancelInvoke("cancelJumpBuffer");
                _movement.Invoke("cancelJumpBuffer", 0.12f);
            }
            else if (button == 2)
            {
                Reflect.SetField(_movement, "dashBuffer", true);
                _movement.CancelInvoke("cancelDashBuffer");
                _movement.Invoke("cancelDashBuffer", 0.12f);
            }
        }

        private void FixedUpdate()
        {
            if (Mode == AgentMode.Idle) return;
            if (!EnsurePlayer()) return;

            TickEpisode();

            int direction = _currentAction / 3 - 1; // 0,1,2 -> -1,0,1
            if (direction != 0)
            {
                var v = _movement.Velocity;
                float accel = direction * _movement.runSpeed * 10f / _framesToReachTopSpeed;
                v.x += accel;
                if (Mathf.Sign(v.x) != Mathf.Sign(direction)) v.x += accel; // mirrors the real reversal-boost in MoveLeftAndRight()
                _movement.Velocity = v;
                _movement.facingRight = direction > 0;
            }
        }

        private bool EnsurePlayer()
        {
            if (_movement != null) return true;
            var playerGo = GameObject.FindGameObjectWithTag("Player");
            if (playerGo == null) return false;
            _movement = playerGo.GetComponent<Movement>();
            if (_movement == null) return false;
            _body = Reflect.GetField<Rigidbody2D>(_movement, "body");
            var groundMask = Reflect.GetField<LayerMask>(_movement, "groundRaycastLayer");
            var blockMask = Reflect.GetField<LayerMask>(_movement, "blockingGroundRaycastLayer");
            _terrainMask = groundMask | blockMask;
            _framesToReachTopSpeed = Reflect.TryGetField(_movement, "framesToReachTopSpeed", 2f);
            return true;
        }

        // Called once, right when the user clicks "Start Training"/"Watch
        // Best" - picks whichever course's start gate is nearest the
        // player's current position (BeginEpisode teleports there anyway
        // via ResetToStart, so the player doesn't need to be standing in
        // the trigger already - just generally near the course they want).
        public string TryLock()
        {
            if (!EnsurePlayer()) return "Player not found - get in-game first.";

            var playerPos = (Vector2)_movement.transform.position;
            courseScript foundCourse = null;
            startGate foundStartGate = null;
            float bestDist = float.MaxValue;
            foreach (var c in UnityEngine.Object.FindObjectsByType<courseScript>(FindObjectsSortMode.None))
            {
                var sg = c.GetComponentsInChildren<startGate>(includeInactive: true).FirstOrDefault();
                if (sg == null) continue;
                var resetGo = Reflect.TryGetField<GameObject>(sg, "resetPoint", null);
                var pos = resetGo != null ? (Vector2)resetGo.transform.position : (Vector2)sg.transform.position;
                float dist = Vector2.Distance(playerPos, pos);
                if (dist < bestDist) { bestDist = dist; foundCourse = c; foundStartGate = sg; }
            }
            if (foundCourse == null) return "No course with a start gate found nearby.";

            var endGates = foundCourse.GetComponentsInChildren<endGate>(includeInactive: true);
            var realEndGate = endGates.FirstOrDefault(g => Reflect.TryGetField(g, "isEndOfCourse", false)) ?? endGates.FirstOrDefault();
            if (realEndGate == null) return "Couldn't find this course's end gate.";

            var resetPointGo = Reflect.TryGetField<GameObject>(foundStartGate, "resetPoint", null);
            _startResetPoint = resetPointGo != null ? (Vector2)resetPointGo.transform.position : (Vector2)foundStartGate.transform.position;

            _course = foundCourse;
            _endGate = realEndGate;
            _courseNumber = foundCourse.courseNumber;
            _hasCourseLock = true;
            _host.Log($"[RlAgent] locked onto course {_courseNumber} at {bestDist:0}u away, start={_startResetPoint}, end={realEndGate.transform.position}");
            return null;
        }

        public void StartTraining()
        {
            var error = TryLock();
            if (error != null) { _host.Log("[RlAgent] " + error); return; }
            LoadOrCreateTrainer();
            Mode = AgentMode.Training;
            Time.timeScale = TrainingTimeScale;
            BeginEpisode();
        }

        public void StartWatching()
        {
            var error = TryLock();
            if (error != null) { _host.Log("[RlAgent] " + error); return; }
            LoadOrCreateTrainer();
            Mode = AgentMode.Watching;
            Time.timeScale = 1f;
            BeginEpisode();
        }

        public void Stop()
        {
            Mode = AgentMode.Idle;
            Time.timeScale = 1f;
            _hasCourseLock = false;
            SavePersisted();
        }

        private void LoadOrCreateTrainer()
        {
            if (!_save.Courses.TryGetValue(_courseNumber, out var record))
            {
                record = new CourseRecord { ChampionWeights = _net.GetWeights() };
                _save.Courses[_courseNumber] = record;
            }
            if (record.ChampionWeights == null || record.ChampionWeights.Length != _net.WeightCount)
                record.ChampionWeights = _net.GetWeights();
            _trainer = new EvolutionTrainer(record.ChampionWeights, record.BestTime, record.Generation, seed: _courseNumber * 7919 + 13);
        }

        private void BeginEpisode()
        {
            _tickInEpisode = 0;
            _currentAction = 0;
            var weights = Mode == AgentMode.Watching ? _trainer.ChampionWeights : _trainer.NextCandidate();
            _net.SetWeights(weights);
            ResetToStart();
        }

        private void ResetToStart()
        {
            _movement.courseResetPoint = _startResetPoint;
            Reflect.InvokeMethod(_movement, "respawn", true);
            _movement.Velocity = Vector2.zero;
            if (_body != null) _body.linearVelocity = Vector2.zero;
            _course.startTracking(_movement.gameObject);
            _wasTracking = true;
            _lastKnownPathTime = 0f;
        }

        private void TickEpisode()
        {
            if (!_hasCourseLock) return;

            bool tracking = Reflect.TryGetField(_course, "tracking", false);
            float pathTime = Reflect.TryGetField(_course, "currentPathTime", 0f);
            bool isDead = Reflect.TryGetField(_movement, "isDead", false);

            if (_wasTracking && !tracking)
            {
                if (_tickInEpisode < GraceTicksAfterReset)
                {
                    // Something (most likely the real startGate's own
                    // OnTriggerStay2D re-touching courseScript.startTracking
                    // while the reset teleport lands the player back inside
                    // its trigger, racing this class's own call the same
                    // physics step) un-sets tracking within the first tick or
                    // two of almost every reset, well before the player has
                    // moved at all - confirmed live (lastKnownPathTime was
                    // 0.00-0.02s at the exact reset position every time).
                    // Cheaper to just re-arm than to chase the exact
                    // interleaving further - it's a false alarm, not a real
                    // finish or a real failure.
                    _course.startTracking(_movement.gameObject);
                    _wasTracking = true;
                    _lastKnownPathTime = 0f;
                    return;
                }
                // The real endGate fired stopTracking itself (a genuine,
                // legitimate finish - the same call a human touching it
                // triggers, so the real save/reward/bestPathTime already
                // updated too) - _lastKnownPathTime holds the pre-reset time
                // from last tick, since currentPathTime is already back to
                // 0 by the time this observes the flip.
                if (_lastKnownPathTime < MinPlausibleFinishSeconds)
                {
                    // Belt-and-braces beyond the grace window above: a
                    // finish this fast is never real (course 1's own
                    // recorded best is 7.4s). Treat it as a failed attempt
                    // instead of a "best" that then poisons every real
                    // result forever (ReportFitness never accepts anything
                    // worse than the current champion, so a bogus near-zero
                    // time would permanently block real progress).
                    _host.Log($"[RlAgent] rejecting implausible finish ({_lastKnownPathTime:0.000}s) as a bogus tracking flip");
                    _course.stopTracking(_movement.gameObject, false);
                    FinishEpisode(DeathPenaltySeconds);
                    return;
                }
                FinishEpisode(_lastKnownPathTime);
                return;
            }
            _wasTracking = tracking;
            _lastKnownPathTime = pathTime;

            if (isDead || _tickInEpisode >= MaxEpisodeTicks)
            {
                // Bounded, clean-episode training semantics rather than the
                // real game's own "clock keeps running across a death"
                // economy - forcibly ends + resets so every candidate gets
                // evaluated on a comparable, bounded attempt.
                _course.stopTracking(_movement.gameObject, false);
                FinishEpisode(DeathPenaltySeconds);
                return;
            }

            _tickInEpisode++;
            if (_tickInEpisode % DecisionIntervalTicks == 0)
            {
                _currentAction = _net.ChooseAction(BuildObservation());
            }
        }

        private void FinishEpisode(float fitness)
        {
            if (Mode == AgentMode.Training)
            {
                _trainer.ReportFitness(fitness);
                var record = _save.Courses[_courseNumber];
                record.EpisodesRun++;
                record.Generation = _trainer.Generation;
                bool improved = _trainer.BestFitness < record.BestTime;
                if (improved)
                {
                    record.BestTime = _trainer.BestFitness;
                    record.ChampionWeights = _trainer.ChampionWeights;
                }
                _host.Log($"[RlAgent] episode {record.EpisodesRun} done: fitness={fitness:0.00} gen={_trainer.Generation} best={_trainer.BestFitness:0.00}{(improved ? " (new best!)" : "")} | start={_startResetPoint} end={(_endGate != null ? (Vector2)_endGate.transform.position : Vector2.zero)} endPos={(Vector2)_movement.transform.position}");
                if (record.EpisodesRun % 20 == 0) SavePersisted();
            }
            BeginEpisode();
        }

        private void SavePersisted()
        {
            if (_save != null) _host.SaveConfig(RlAgentMod.ModId, _save);
        }

        public string StatusText()
        {
            if (Mode == AgentMode.Idle) return "AI Training: Start (trains on the nearest course)";
            var record = _save.Courses.TryGetValue(_courseNumber, out var r) ? r : null;
            float best = record?.BestTime ?? float.MaxValue;
            string bestStr = best < float.MaxValue ? best.ToString("0.00") + "s" : "--";
            string verb = Mode == AgentMode.Watching ? "Watching" : "Training";
            return $"AI {verb}: Course {_courseNumber} - gen {_trainer?.Generation ?? 0} - best {bestStr} (click to stop)";
        }

        private readonly float[] _obs = new float[ObservationSize];

        private float[] BuildObservation()
        {
            var pos = (Vector2)_movement.transform.position;
            var vel = _movement.Velocity;
            float runSpeed = Mathf.Max(1f, _movement.runSpeed);

            _obs[0] = Mathf.Clamp(vel.x / (runSpeed * 5f), -1f, 1f);
            _obs[1] = Mathf.Clamp(vel.y / (runSpeed * 5f), -1f, 1f);
            _obs[2] = Reflect.TryGetField(_movement, "onGround", false) ? 1f : 0f;
            _obs[3] = Reflect.TryGetField(_movement, "OnWall", false) ? 1f : 0f;
            _obs[4] = _movement.facingRight ? 1f : 0f;
            _obs[5] = _movement.maxAirJumps > 0 ? (float)_movement.airJumpsLeft / _movement.maxAirJumps : 0f;
            _obs[6] = _movement.maxAirDashes > 0 ? (float)_movement.airDashesLeft / _movement.maxAirDashes : 0f;

            if (_endGate != null)
            {
                var toGoal = (Vector2)_endGate.transform.position - pos;
                _obs[7] = Mathf.Clamp(toGoal.x / 2000f, -1f, 1f);
                _obs[8] = Mathf.Clamp(toGoal.y / 2000f, -1f, 1f);
            }

            for (int i = 0; i < RayDirections.Length; i++)
            {
                var hit = Physics2D.Raycast(pos, RayDirections[i], RayDistance, _terrainMask);
                _obs[9 + i] = hit.collider != null ? hit.distance / RayDistance : 1f;
            }

            _obs[17] = Mathf.Clamp01((float)_tickInEpisode / MaxEpisodeTicks);

            // Full world layout - absolute coordinates for player/start/goal
            // plus the real elapsed clock, not just the relative/local
            // signals above. courseScript.currentPathTime is the SAME timer
            // the real game's own bestPathTime economy uses, so this is the
            // literal "how far into a real attempt am I" signal, not a
            // separate approximation.
            _obs[18] = Mathf.Clamp(pos.x / WorldScale, -1f, 1f);
            _obs[19] = Mathf.Clamp(pos.y / WorldScale, -1f, 1f);
            _obs[20] = Mathf.Clamp(_startResetPoint.x / WorldScale, -1f, 1f);
            _obs[21] = Mathf.Clamp(_startResetPoint.y / WorldScale, -1f, 1f);
            if (_endGate != null)
            {
                var goal = (Vector2)_endGate.transform.position;
                _obs[22] = Mathf.Clamp(goal.x / WorldScale, -1f, 1f);
                _obs[23] = Mathf.Clamp(goal.y / WorldScale, -1f, 1f);
            }
            float rawPathTime = Reflect.TryGetField(_course, "currentPathTime", 0f);
            _obs[24] = Mathf.Clamp01(rawPathTime / 30f);

            return _obs;
        }
    }
}
