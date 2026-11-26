using Recharge.ModApi;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityEngine;

internal class CoopManager
{
	private const string SaveRoot = "/SavedataCoop";
	private const float SyncInterval = 3f;
	private const float SaveInterval = 20f;

	public bool Active { get; private set; }

	private string _saveFolder;
	private Movement _localMovement;
	private readonly List<courseScript> _courses = new List<courseScript>();
	private readonly List<clonesScript> _disabledClones = new List<clonesScript>();
	private bool _isHost;
	// Zip movers (PlatformMover): the host drives their positions, guests follow.
	// Sorted by initial position so the index matches on every client that built
	// the same map. Experimental and host-authoritative; needs 2-client tuning.
	private readonly List<(Transform tf, Vector3 initial)> _movers = new List<(Transform, Vector3)>();
	private readonly Dictionary<int, Vector3> _moverTargets = new Dictionary<int, Vector3>();
	private readonly Dictionary<int, Vector3> _lastSentMover = new Dictionary<int, Vector3>();
	private readonly List<(courseScript course, int originalBaseReward)> _scaledRewards = new List<(courseScript, int)>();
	private readonly List<(upgradeBox box, double originalBaseCost)> _scaledUpgradeCosts = new List<(upgradeBox, double)>();

	private static readonly FieldInfo BaseRewardField = Reflect.FieldOf<courseScript>("baseReward");
	private static readonly MethodInfo DeactivateMethod = Reflect.MethodOf<upgradeBox>("deactivate");

	private float _syncAccumulator;
	private float _saveAccumulator;
	private float _abilityResendAccumulator;
	private float _deltaAccumulator;
	private const float AbilityResendInterval = 3f;
	private const float DeltaInterval = 0.25f;

	private readonly Dictionary<globalStats.Currencies, double> _lastCurrency = new Dictionary<globalStats.Currencies, double>();
	private readonly Dictionary<globalStats.globalUpgradeSet, double> _lastGlobalUpgrade = new Dictionary<globalStats.globalUpgradeSet, double>();
	private readonly Dictionary<int, Dictionary<localUpgrades.localUpgradeSet, double>> _lastLocalUpgrade = new Dictionary<int, Dictionary<localUpgrades.localUpgradeSet, double>>();
	private readonly Dictionary<int, int[]> _lastTimesUsed = new Dictionary<int, int[]>();
	private bool _lastDash, _lastWallJump, _lastDoubleJump, _lastBlockSwap;
	private int _playerCount;
	private Saveloader _realSaveloader;

	private readonly List<upgradeBox> _hiddenCloneBoxes = new List<upgradeBox>();
	private readonly List<courseScript> _blankedCloneMultCourses = new List<courseScript>();

	public void Begin(bool isHost, int playerCount, Movement localMovement, string saveName)
	{
		Active = true;
		_playerCount = playerCount;
		_localMovement = localMovement;
		_syncAccumulator = 0f;
		_saveAccumulator = 0f;
		_deltaAccumulator = 0f;

		var saveloader = UnityEngine.Object.FindFirstObjectByType<Saveloader>();
		if (saveloader != null) saveloader.CancelInvoke("autosave");
		_realSaveloader = saveloader;

		_isHost = isHost;
		_courses.Clear();
		_courses.AddRange(UnityEngine.Object.FindObjectsByType<courseScript>(FindObjectsInactive.Include, FindObjectsSortMode.None));
		RebuildMovers();

		DisableClones();

		var resolvedName = saveName ?? ("New-" + System.DateTime.Now.ToString("yyyyMMdd-HHmmss"));
		_saveFolder = SaveRoot + "/" + resolvedName;

		if (isHost)
		{
			if (saveName != null && ModeSaveFile.Exists(_saveFolder))
			{
				ModeSaveFile.Load(_saveFolder, _localMovement, _courses);
			}
			else
			{
				ModeSaveFile.Restore(ModeSaveFile.RealSaveFolder(), _localMovement, _courses);
				ModeSaveFile.ResetEconomyToZero(_localMovement, _courses);
				ModeSaveFile.DeleteAndRecreateFolder(_saveFolder);
				ModeSaveFile.Save(_saveFolder, _localMovement, _courses);
			}
		}
		else
		{
			ModeSaveFile.Restore(ModeSaveFile.RealSaveFolder(), _localMovement, _courses);
			ModeSaveFile.ResetEconomyToZero(_localMovement, _courses);
		}

		ScaleBaseRewards(playerCount);
		ScaleMovementUpgradeCosts(playerCount);

		CaptureBaseline();
	}

	public void RefreshSceneReferences(Movement localMovement)
	{
		if (!Active) return;
		_localMovement = localMovement;
		_realSaveloader = UnityEngine.Object.FindFirstObjectByType<Saveloader>();
		if (_realSaveloader != null) _realSaveloader.CancelInvoke("autosave");
		_courses.Clear();
		_courses.AddRange(UnityEngine.Object.FindObjectsByType<courseScript>(FindObjectsInactive.Include, FindObjectsSortMode.None));
		RebuildMovers();
		ModeSaveFile.Restore(ModeSaveFile.RealSaveFolder(), _localMovement, _courses);
		_localMovement.dashUnlocked = _lastDash;
		_localMovement.wallJumpUnlocked = _lastWallJump;
		_localMovement.doubleJumpUnlocked = _lastDoubleJump;
		_localMovement.blockSwapUnlocked = _lastBlockSwap;
		if (_lastDash && _localMovement.maxAirDashes < 1) _localMovement.maxAirDashes = 1;
		if (_lastDoubleJump && _localMovement.maxAirJumps < 1) _localMovement.maxAirJumps = 1;
		foreach (var course in _courses)
		{
			if (course?.localUpgradesScript == null) continue;
			if (_lastLocalUpgrade.TryGetValue(course.courseNumber, out var lastDict))
			{
				foreach (var kv in lastDict)
					course.localUpgradesScript.localUpgradeDict[kv.Key] = kv.Value;
			}
			if (_lastTimesUsed.TryGetValue(course.courseNumber, out var lastTimes))
			{
				var boxes = GetUpgradeBoxes(course);
				for (int i = 0; i < boxes.Count && i < lastTimes.Length; i++)
				{
					boxes[i].TimesUsed = lastTimes[i];
					boxes[i].CalcBoxCost();
					ApplyBoxCapState(boxes[i]);
				}
			}
		}
		DisableClones();
		ScaleBaseRewards(_playerCount);
		ScaleMovementUpgradeCosts(_playerCount);
	}

	private static List<upgradeBox> GetUpgradeBoxes(courseScript course) => ModeSaveFile.GetUpgradeBoxes(course);

	private static void ApplyBoxCapState(upgradeBox box)
	{
		bool shouldBeCapped = box.upgrade == localUpgrades.localUpgradeSet.Movement ? box.TimesUsed >= 1 : box.TimesUsed >= box.Cap;
		if (shouldBeCapped && box.isActive) DeactivateMethod?.Invoke(box, null);
		else if (!shouldBeCapped && !box.isActive) box.isActive = true;
	}

	private void ScaleMovementUpgradeCosts(int playerCount)
	{
		_scaledUpgradeCosts.Clear();
		foreach (var course in _courses)
		{
			if (course == null) continue;
			foreach (var box in GetUpgradeBoxes(course))
			{
				if (box == null) continue;
				if (box.upgrade == localUpgrades.localUpgradeSet.Movement)
				{
					if (box.movementUpgrade == upgradeBox.movementUpgrades.endDemo) continue;
					var original = box.baseUpgradeCost;
					_scaledUpgradeCosts.Add((box, original));
					box.baseUpgradeCost = original / 5.0 * playerCount;
					box.CalcBoxCost();
				}
			}
		}
	}

	private void ScaleBaseRewards(int playerCount)
	{
		_scaledRewards.Clear();
		if (playerCount <= 1 || BaseRewardField == null) return;
		foreach (var course in _courses)
		{
			if (course == null) continue;
			var original = (int)BaseRewardField.GetValue(course);
			BaseRewardField.SetValue(course, original * playerCount);
			_scaledRewards.Add((course, original));
			course.UpdateReward();
		}
	}

	private void DisableClones()
	{
		_disabledClones.Clear();
		foreach (var c in UnityEngine.Object.FindObjectsByType<clonesScript>(FindObjectsInactive.Include, FindObjectsSortMode.None))
		{
			if (!c.enabled) continue;
			c.onPrestige(true);
			c.enabled = false;
			c.gameObject.SetActive(false);
			_disabledClones.Add(c);
		}
	}

private void CaptureBaseline()
	{
		_lastCurrency.Clear();
		foreach (globalStats.Currencies c in Enum.GetValues(typeof(globalStats.Currencies)))
			_lastCurrency[c] = globalStats.currencyLookup[c];
		_lastGlobalUpgrade.Clear();
		foreach (globalStats.globalUpgradeSet u in Enum.GetValues(typeof(globalStats.globalUpgradeSet)))
			_lastGlobalUpgrade[u] = globalStats.globalUpgradeDict[u];
		if (_localMovement != null)
		{
			_lastDash = _localMovement.dashUnlocked;
			_lastWallJump = _localMovement.wallJumpUnlocked;
			_lastDoubleJump = _localMovement.doubleJumpUnlocked;
			_lastBlockSwap = _localMovement.blockSwapUnlocked;
		}

		_lastLocalUpgrade.Clear();
		_lastTimesUsed.Clear();
		foreach (var course in _courses)
		{
			if (course == null || course.localUpgradesScript == null) continue;
			var dict = new Dictionary<localUpgrades.localUpgradeSet, double>();
			foreach (localUpgrades.localUpgradeSet key in Enum.GetValues(typeof(localUpgrades.localUpgradeSet)))
				dict[key] = course.localUpgradesScript.localUpgradeDict.TryGetValue(key, out var v) ? v : 0.0;
			_lastLocalUpgrade[course.courseNumber] = dict;

			var boxes = GetUpgradeBoxes(course);
			_lastTimesUsed[course.courseNumber] = boxes.Select(b => b.TimesUsed).ToArray();
		}
	}

	// Every player builds/applies deltas and snapshots the same way now - no host-only privilege.
	public void Tick(float unscaledDt, bool isHost, Action<JObject> sendGameMessage)
	{
		if (!Active) return;

		if (!isHost) ApplyMoverLerp(unscaledDt);

		_realSaveloader?.CancelInvoke("manualSave");

		_deltaAccumulator += unscaledDt;
		if (_deltaAccumulator >= DeltaInterval)
		{
			_deltaAccumulator = 0f;
			var delta = BuildDelta();
			if (delta != null) sendGameMessage(delta);
		}

		_abilityResendAccumulator += unscaledDt;
		if (_abilityResendAccumulator >= AbilityResendInterval)
		{
			_abilityResendAccumulator = 0f;
			var resend = BuildAbilitiesResend();
			if (resend != null) sendGameMessage(resend);
		}

		_syncAccumulator += unscaledDt;
		if (_syncAccumulator >= SyncInterval)
		{
			_syncAccumulator = 0f;
			sendGameMessage(BuildSnapshot());
		}

		_saveAccumulator += unscaledDt;
		if (_saveAccumulator >= SaveInterval)
		{
			_saveAccumulator = 0f;
			PersistSave();
		}
	}

	public void HandleMessage(string kind, JObject payload, int from, int localPlayerId)
	{
		if (!Active || from == localPlayerId) return; // never apply a message that's actually our own
		if (kind == "coopDelta")
		{
			ApplyDelta(payload);
		}
		else if (kind == "coopSync")
		{
			ApplySnapshot(payload);
		}
	}

	private JObject BuildCoursesDelta()
	{
		JObject courses = null;
		foreach (var course in _courses)
		{
			if (course == null || course.localUpgradesScript == null) continue;
			var lastDict = _lastLocalUpgrade.TryGetValue(course.courseNumber, out var ld) ? ld : null;
			JObject localUpgrades = null;
			foreach (global::localUpgrades.localUpgradeSet key in Enum.GetValues(typeof(global::localUpgrades.localUpgradeSet)))
			{
				var now = course.localUpgradesScript.localUpgradeDict.TryGetValue(key, out var v) ? v : 0.0;
				var prev = lastDict != null && lastDict.TryGetValue(key, out var p) ? p : now;
				if (Math.Abs(now - prev) > 0.0001)
				{
					(localUpgrades ??= new JObject())[key.ToString()] = now - prev;
					if (lastDict == null) { lastDict = new Dictionary<global::localUpgrades.localUpgradeSet, double>(); _lastLocalUpgrade[course.courseNumber] = lastDict; }
					lastDict[key] = now;
				}
			}

			var boxes = GetUpgradeBoxes(course);
			var lastTimes = _lastTimesUsed.TryGetValue(course.courseNumber, out var lt) && lt.Length == boxes.Count ? lt : new int[boxes.Count];
			JObject boxTimesUsed = null;
			for (int i = 0; i < boxes.Count; i++)
			{
				var boxDelta = boxes[i].TimesUsed - lastTimes[i];
				if (boxDelta != 0) (boxTimesUsed ??= new JObject())[i.ToString()] = boxDelta;
			}
			if (boxTimesUsed != null) _lastTimesUsed[course.courseNumber] = boxes.Select(b => b.TimesUsed).ToArray();

			if (localUpgrades == null && boxTimesUsed == null) continue;
			var courseObj = new JObject();
			if (localUpgrades != null) courseObj["localUpgrades"] = localUpgrades;
			if (boxTimesUsed != null) courseObj["boxTimesUsed"] = boxTimesUsed;
			(courses ??= new JObject())[course.courseNumber.ToString()] = courseObj;
		}
		return courses;
	}

	private JObject BuildCoursesFullSync()
	{
		var courses = new JObject();
		foreach (var course in _courses)
		{
			if (course == null || course.localUpgradesScript == null) continue;
			var localUpgradesObj = new JObject();
			foreach (global::localUpgrades.localUpgradeSet key in Enum.GetValues(typeof(global::localUpgrades.localUpgradeSet)))
				localUpgradesObj[key.ToString()] = course.localUpgradesScript.localUpgradeDict.TryGetValue(key, out var v) ? v : 0.0;
			var boxes = GetUpgradeBoxes(course);
			var boxTimesUsedObj = new JObject();
			for (int i = 0; i < boxes.Count; i++) boxTimesUsedObj[i.ToString()] = boxes[i].TimesUsed;
			courses[course.courseNumber.ToString()] = new JObject { ["localUpgrades"] = localUpgradesObj, ["boxTimesUsed"] = boxTimesUsedObj };
		}
		return courses;
	}

	private void ApplyCoursesPayload(JObject payload, bool additive)
	{
		if (!(payload["courses"] is JObject courses)) return;
		foreach (var courseEntry in courses)
		{
			if (!int.TryParse(courseEntry.Key, out var courseNumber)) continue;
			var course = _courses.FirstOrDefault(c => c != null && c.courseNumber == courseNumber);
			if (course == null || course.localUpgradesScript == null || !(courseEntry.Value is JObject courseObj)) continue;

			if (courseObj["localUpgrades"] is JObject localUpgradesObj)
			{
				Dictionary<global::localUpgrades.localUpgradeSet, double> baseline = null;
				foreach (var kv in localUpgradesObj)
				{
					if (!Enum.TryParse<global::localUpgrades.localUpgradeSet>(kv.Key, out var key)) continue;
					var current = course.localUpgradesScript.localUpgradeDict.TryGetValue(key, out var v) ? v : 0.0;
					// Only ever goes up in this game, so symmetric Math.Max across all peers is safe.
					var updated = additive ? Math.Max(0, current + kv.Value.Value<double>()) : Math.Max(current, kv.Value.Value<double>());
					course.localUpgradesScript.localUpgradeDict[key] = updated;
					// Keep our own delta-baseline in sync, or a later RefreshSceneReferences reverts this.
					baseline ??= _lastLocalUpgrade.TryGetValue(course.courseNumber, out var d) ? d : (_lastLocalUpgrade[course.courseNumber] = new Dictionary<global::localUpgrades.localUpgradeSet, double>());
					baseline[key] = updated;
				}
			}
			if (courseObj["boxTimesUsed"] is JObject boxTimesUsedObj)
			{
				var boxes = GetUpgradeBoxes(course);
				int[] baseline = _lastTimesUsed.TryGetValue(course.courseNumber, out var bt) && bt.Length == boxes.Count
					? bt
					: (_lastTimesUsed[course.courseNumber] = boxes.Select(b => b.TimesUsed).ToArray());
				foreach (var kv in boxTimesUsedObj)
				{
					if (!int.TryParse(kv.Key, out var boxIndex) || boxIndex < 0 || boxIndex >= boxes.Count) continue;
					var box = boxes[boxIndex];
					var updated = additive ? Math.Max(0, box.TimesUsed + kv.Value.Value<int>()) : Math.Max(box.TimesUsed, kv.Value.Value<int>());
					box.TimesUsed = updated;
					box.CalcBoxCost();
					ApplyBoxCapState(box);
					baseline[boxIndex] = updated;
				}
			}
		}
	}

	private JObject BuildAbilitiesResend()
	{
		if (_localMovement == null) return null;
		return new JObject
		{
			["k"] = "coopDelta",
			["abilities"] = new JObject
			{
				["dash"] = _localMovement.dashUnlocked,
				["wallJump"] = _localMovement.wallJumpUnlocked,
				["doubleJump"] = _localMovement.doubleJumpUnlocked,
				["blockSwap"] = _localMovement.blockSwapUnlocked,
			},
		};
	}

	private JObject BuildDelta()
	{
		// Currency is host-authoritative (it can go down when spending, so additive
		// peer-to-peer drifts): the host broadcasts absolute values that guests
		// mirror, while guests forward only their own earn/spend as a one-time delta
		// over the reliable relay channel for the host to bank.
		JObject currencies = null;    // guest -> host: this client's earn/spend since last forward
		JObject currencyAbs = null;   // host -> guests: the authoritative absolute totals
		if (_isHost)
		{
			currencyAbs = new JObject();
			foreach (globalStats.Currencies c in Enum.GetValues(typeof(globalStats.Currencies)))
				currencyAbs[c.ToString()] = globalStats.currencyLookup[c];
		}
		else
		{
			foreach (globalStats.Currencies c in Enum.GetValues(typeof(globalStats.Currencies)))
			{
				var now = globalStats.currencyLookup[c];
				var prev = _lastCurrency.TryGetValue(c, out var p) ? p : now;
				if (Math.Abs(now - prev) > 0.0001)
				{
					(currencies ??= new JObject())[c.ToString()] = now - prev;
					_lastCurrency[c] = now;
				}
			}
		}
		JObject upgrades = null;
		foreach (globalStats.globalUpgradeSet u in Enum.GetValues(typeof(globalStats.globalUpgradeSet)))
		{
			var now = globalStats.globalUpgradeDict[u];
			var prev = _lastGlobalUpgrade.TryGetValue(u, out var p) ? p : now;
			if (Math.Abs(now - prev) > 0.0001)
			{
				(upgrades ??= new JObject())[u.ToString()] = now - prev;
				_lastGlobalUpgrade[u] = now;
			}
		}
		JObject abilities = null;
		if (_localMovement != null)
		{
			if (_localMovement.dashUnlocked != _lastDash) { (abilities ??= new JObject())["dash"] = _localMovement.dashUnlocked; _lastDash = _localMovement.dashUnlocked; }
			if (_localMovement.wallJumpUnlocked != _lastWallJump) { (abilities ??= new JObject())["wallJump"] = _localMovement.wallJumpUnlocked; _lastWallJump = _localMovement.wallJumpUnlocked; }
			if (_localMovement.doubleJumpUnlocked != _lastDoubleJump) { (abilities ??= new JObject())["doubleJump"] = _localMovement.doubleJumpUnlocked; _lastDoubleJump = _localMovement.doubleJumpUnlocked; }
			if (_localMovement.blockSwapUnlocked != _lastBlockSwap) { (abilities ??= new JObject())["blockSwap"] = _localMovement.blockSwapUnlocked; _lastBlockSwap = _localMovement.blockSwapUnlocked; }
		}
		var courses = BuildCoursesDelta();
		var movers = _isHost ? BuildMoversDelta() : null;

		if (currencies == null && currencyAbs == null && upgrades == null && abilities == null && courses == null && movers == null) return null;
		var msg = new JObject { ["k"] = "coopDelta" };
		if (currencies != null) msg["currencies"] = currencies;
		if (currencyAbs != null) msg["currencyAbs"] = currencyAbs;
		if (upgrades != null) msg["upgrades"] = upgrades;
		if (abilities != null) msg["abilities"] = abilities;
		if (courses != null) msg["courses"] = courses;
		if (movers != null) msg["movers"] = movers;
		return msg;
	}

	// No currency here - it can go DOWN (spending), so it only ever moves via BuildDelta's additive path.
	private JObject BuildSnapshot()
	{
		var upgrades = new JObject();
		foreach (globalStats.globalUpgradeSet u in Enum.GetValues(typeof(globalStats.globalUpgradeSet)))
			upgrades[u.ToString()] = globalStats.globalUpgradeDict[u];
		var abilities = new JObject();
		if (_localMovement != null)
		{
			abilities["dash"] = _localMovement.dashUnlocked;
			abilities["wallJump"] = _localMovement.wallJumpUnlocked;
			abilities["doubleJump"] = _localMovement.doubleJumpUnlocked;
			abilities["blockSwap"] = _localMovement.blockSwapUnlocked;
		}
		var courses = BuildCoursesFullSync();
		CaptureBaseline();
		var snap = new JObject { ["k"] = "coopSync", ["upgrades"] = upgrades, ["abilities"] = abilities, ["courses"] = courses };
		if (_isHost)
		{
			var currencyAbs = new JObject();
			foreach (globalStats.Currencies c in Enum.GetValues(typeof(globalStats.Currencies)))
				currencyAbs[c.ToString()] = globalStats.currencyLookup[c];
			snap["currencyAbs"] = currencyAbs;
		}
		return snap;
	}

	// Applying a peer's contribution must also move our own delta-baseline to
	// match, or our next BuildDelta compares our (now peer-bumped) live value
	// against a stale baseline, treats the peer's own contribution as new
	// local activity, and rebroadcasts it - which they then apply as
	// additional additive income, which we then see reflected back etc.
	private void ApplyCurrenciesAndUpgrades(JObject payload, bool additive)
	{
		// Host banks each guest's earn/spend (reliable channel -> applied once).
		if (_isHost && payload["currencies"] is JObject guestCurrencies)
			foreach (var kv in guestCurrencies)
				if (Enum.TryParse<globalStats.Currencies>(kv.Key, out var c))
					globalStats.currencyLookup[c] = Math.Max(0, globalStats.currencyLookup[c] + kv.Value.Value<double>());
		// Guests reconcile to the host's authoritative absolute totals, but keep any
		// earn/spend not yet banked by the host (currency - baseline) so a broadcast
		// that predates the host banking it never loses it; that pending amount is
		// forwarded on the next delta and then shows up in the host's totals.
		if (!_isHost && payload["currencyAbs"] is JObject hostCurrencies)
			foreach (var kv in hostCurrencies)
				if (Enum.TryParse<globalStats.Currencies>(kv.Key, out var c))
				{
					var hostAbs = kv.Value.Value<double>();
					var baseline = _lastCurrency.TryGetValue(c, out var b) ? b : globalStats.currencyLookup[c];
					var pending = globalStats.currencyLookup[c] - baseline; // our un-banked earn/spend
					globalStats.currencyLookup[c] = Math.Max(0, hostAbs + pending);
					_lastCurrency[c] = hostAbs;
				}
		if (payload["upgrades"] is JObject upgrades)
			foreach (var kv in upgrades)
				if (Enum.TryParse<globalStats.globalUpgradeSet>(kv.Key, out var u))
				{
					var updated = additive
						? Math.Max(0, globalStats.globalUpgradeDict[u] + kv.Value.Value<double>())
						: Math.Max(globalStats.globalUpgradeDict[u], kv.Value.Value<double>());
					globalStats.globalUpgradeDict[u] = updated;
					_lastGlobalUpgrade[u] = updated;
				}
	}

	private void ApplyAbilities(JObject payload)
	{
		if (!(payload["abilities"] is JObject abilities) || _localMovement == null) return;
		if (abilities["dash"] != null) _localMovement.dashUnlocked |= abilities["dash"].Value<bool>();
		if (abilities["wallJump"] != null) _localMovement.wallJumpUnlocked |= abilities["wallJump"].Value<bool>();
		if (abilities["doubleJump"] != null) _localMovement.doubleJumpUnlocked |= abilities["doubleJump"].Value<bool>();
		if (abilities["blockSwap"] != null) _localMovement.blockSwapUnlocked |= abilities["blockSwap"].Value<bool>();
		if (_localMovement.dashUnlocked && _localMovement.maxAirDashes < 1) _localMovement.maxAirDashes = 1;
		if (_localMovement.doubleJumpUnlocked && _localMovement.maxAirJumps < 1) _localMovement.maxAirJumps = 1;
		// Keep our own resend-baseline in sync so we don't mistake a peer's
		// grant for new local activity and needlessly rebroadcast it forever.
		_lastDash = _localMovement.dashUnlocked;
		_lastWallJump = _localMovement.wallJumpUnlocked;
		_lastDoubleJump = _localMovement.doubleJumpUnlocked;
		_lastBlockSwap = _localMovement.blockSwapUnlocked;
	}

	private void ApplyDelta(JObject payload)
	{
		ApplyCurrenciesAndUpgrades(payload, additive: true);
		ApplyAbilities(payload);
		ApplyCoursesPayload(payload, additive: true);
		ApplyMoversPayload(payload);
	}

	private void ApplySnapshot(JObject payload)
	{
		ApplyCurrenciesAndUpgrades(payload, additive: false);
		ApplyAbilities(payload);
		ApplyCoursesPayload(payload, additive: false);
		CaptureBaseline();
	}

	// Only the host owns the shared co-op save; guests mirror the host's state and
	// must never write to the shared folder (two writers corrupt it).
	private void PersistSave() { if (_isHost && _saveFolder != null) ModeSaveFile.Save(_saveFolder, _localMovement, _courses); }

	// --- Zip-mover (PlatformMover) sync: host broadcasts positions, guests follow ---

	private void RebuildMovers()
	{
		_movers.Clear();
		_moverTargets.Clear();
		_lastSentMover.Clear();
		var found = UnityEngine.Object.FindObjectsByType<PlatformMover>(FindObjectsInactive.Include, FindObjectsSortMode.None);
		var tfs = new List<Transform>(found.Length);
		foreach (var m in found) if (m != null) tfs.Add(m.transform);
		// Deterministic order so index i is the same mover on every client building this map.
		tfs.Sort((a, b) => { int c = a.position.x.CompareTo(b.position.x); return c != 0 ? c : a.position.y.CompareTo(b.position.y); });
		foreach (var tf in tfs) _movers.Add((tf, tf.localPosition));
	}

	private JObject BuildMoversDelta()
	{
		JObject movers = null;
		for (int i = 0; i < _movers.Count; i++)
		{
			var tf = _movers[i].tf;
			if (tf == null) continue;
			var off = tf.localPosition - _movers[i].initial;
			var last = _lastSentMover.TryGetValue(i, out var l) ? l : new Vector3(float.PositiveInfinity, 0f, 0f);
			if ((off - last).sqrMagnitude < 0.0001f) continue; // unchanged since last sent (also covers at-rest)
			_lastSentMover[i] = off;
			(movers ??= new JObject())[i.ToString()] = new JArray { (double)off.x, (double)off.y };
		}
		return movers;
	}

	private void ApplyMoversPayload(JObject payload)
	{
		if (!(payload["movers"] is JObject movers)) return;
		foreach (var kv in movers)
			if (int.TryParse(kv.Key, out int idx) && kv.Value is JArray a && a.Count >= 2)
				_moverTargets[idx] = new Vector3(a[0].Value<float>(), a[1].Value<float>(), 0f);
	}

	// Guest side, per frame: ease each mover toward the host's position. The local
	// PlatformMover keeps running (so riders still inherit its velocity); this just
	// corrects the position toward the host, who is authoritative.
	private void ApplyMoverLerp(float dt)
	{
		if (_moverTargets.Count == 0) return;
		float t = 1f - Mathf.Exp(-12f * dt);
		foreach (var kv in _moverTargets)
		{
			if (kv.Key < 0 || kv.Key >= _movers.Count) continue;
			var tf = _movers[kv.Key].tf;
			if (tf == null) continue;
			tf.localPosition = Vector3.Lerp(tf.localPosition, _movers[kv.Key].initial + kv.Value, t);
		}
	}

	private static bool IsCloneUpgrade(localUpgrades.localUpgradeSet upgrade) => upgrade switch
	{
		localUpgrades.localUpgradeSet.cloneCount => true,
		localUpgrades.localUpgradeSet.cloneMult => true,
		localUpgrades.localUpgradeSet.fastCloneChance => true,
		localUpgrades.localUpgradeSet.bigCloneChance => true,
		localUpgrades.localUpgradeSet.GreenCloneRewardBase => true,
		localUpgrades.localUpgradeSet.enableCloneDustGeneration => true,
		_ => false,
	};

	public void HideCloneUpgradeBoxes()
	{
		foreach (var b in UnityEngine.Object.FindObjectsByType<upgradeBox>(FindObjectsInactive.Include, FindObjectsSortMode.None))
		{
			if (!IsCloneUpgrade(b.upgrade) || !b.gameObject.activeSelf) continue;
			b.gameObject.SetActive(false);
			if (!_hiddenCloneBoxes.Contains(b)) _hiddenCloneBoxes.Add(b);
		}
		foreach (var c in UnityEngine.Object.FindObjectsByType<courseScript>(FindObjectsInactive.Include, FindObjectsSortMode.None))
		{
			if (c.personalBonusDisplay == null || c.personalBonusDisplay.text.Length == 0) continue;
			c.personalBonusDisplay.text = "";
			if (!_blankedCloneMultCourses.Contains(c)) _blankedCloneMultCourses.Add(c);

			if (c.currentTimeDisplay != null && c.currentTimeDisplay.text.Contains("Clone"))
				c.currentTimeDisplay.text = "";
		}
	}

	public void RestoreCloneUpgradeBoxes()
	{
		foreach (var b in _hiddenCloneBoxes)
			if (b != null) b.gameObject.SetActive(true);
		_hiddenCloneBoxes.Clear();
		foreach (var c in _blankedCloneMultCourses)
			if (c != null) c.updateCloneMultBonus();
		_blankedCloneMultCourses.Clear();
	}

	public void End(bool isHost)
	{
		if (!Active) return;
		Active = false;

		PersistSave();

		foreach (var c in _disabledClones) if (c != null) { c.gameObject.SetActive(true); c.enabled = true; }
		_disabledClones.Clear();

		foreach (var (course, original) in _scaledRewards)
			if (course != null) BaseRewardField.SetValue(course, original);
		_scaledRewards.Clear();

		foreach (var (box, original) in _scaledUpgradeCosts)
			if (box != null) { box.baseUpgradeCost = original; box.CalcBoxCost(); }
		_scaledUpgradeCosts.Clear();

		ModeSaveFile.Restore(ModeSaveFile.RealSaveFolder(), _localMovement, _courses);
		_courses.Clear();

		var saveloader = UnityEngine.Object.FindFirstObjectByType<Saveloader>();
		if (saveloader != null)
		{
			saveloader.CancelInvoke("autosave");
			saveloader.InvokeRepeating("autosave", 10f, 10f);
		}
	}
}

internal static class ModeSaveFile
{
	public static List<upgradeBox> GetUpgradeBoxes(courseScript course)
	{
		var list = new List<upgradeBox>();
		var t = course?.localUpgradesScript?.transform;
		if (t == null) return list;
		for (int i = 0; i < t.childCount; i++)
		{
			var box = t.GetChild(i).GetComponent<upgradeBox>();
			if (box != null) list.Add(box);
		}
		return list;
	}

	public static void ResetEconomyToZero(Movement localMovement, List<courseScript> courses)
	{
		foreach (globalStats.Currencies c in Enum.GetValues(typeof(globalStats.Currencies)))
			globalStats.currencyLookup[c] = 0.0;
		foreach (globalStats.globalUpgradeSet u in Enum.GetValues(typeof(globalStats.globalUpgradeSet)))
			globalStats.globalUpgradeDict[u] = 0.0;
		if (localMovement != null)
		{
			localMovement.dashUnlocked = false;
			localMovement.wallJumpUnlocked = false;
			localMovement.doubleJumpUnlocked = false;
			localMovement.blockSwapUnlocked = false;
		}
		foreach (var course in courses)
		{
			if (course?.localUpgradesScript == null) continue;
			foreach (var key in course.localUpgradesScript.localUpgradeDict.Keys.ToList())
				course.localUpgradesScript.localUpgradeDict[key] = 0.0;
			foreach (var box in GetUpgradeBoxes(course))
			{
				box.reactivateAndReset();
				box.CalcBoxCost();
			}
		}
	}

	public static void DeleteAndRecreateFolder(string saveFolder)
	{
		var path = Application.persistentDataPath + saveFolder;
		try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch (Exception e) { Debug.LogError("[ModeSaveFile] delete failed: " + e); }
		Directory.CreateDirectory(path);
	}

	public static bool Exists(string saveFolder) => File.Exists(Application.persistentDataPath + saveFolder + "/playerdata.txt");

	public static void Load(string saveFolder, Movement localMovement, List<courseScript> courses)
	{
		if (localMovement != null)
		{
			try { localMovement.load(saveFolder); } catch (Exception e) { Debug.LogError("[ModeSaveFile] load failed: " + e); }
		}
		foreach (var c in courses)
		{
			if (c == null) continue;
			try { c.load(saveFolder); } catch { }
			foreach (var box in GetUpgradeBoxes(c)) box.CalcBoxCost();
		}
	}

	public static void Save(string saveFolder, Movement localMovement, List<courseScript> courses)
	{
		if (localMovement == null) return;
		try
		{
			localMovement.save(saveFolder);
			foreach (var c in courses) c.save(saveFolder);
		}
		catch (Exception e) { Debug.LogError("[ModeSaveFile] save failed: " + e); }
	}

	public static void Restore(string realFolder, Movement localMovement, List<courseScript> courses)
	{
		if (localMovement != null)
		{
			try { localMovement.load(realFolder); } catch (Exception e) { Debug.LogError("[ModeSaveFile] restore failed: " + e); }
		}
		foreach (var c in courses)
		{
			if (c == null) continue;
			try { c.load(realFolder); } catch { }
			foreach (var box in GetUpgradeBoxes(c)) box.CalcBoxCost();
		}
	}

	public static string RealSaveFolder() => "/Savedata" + (globalStats.difficultyLevel == 1 ? "hard" : "");
}
