using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;

// Host-authoritative shared economy for Host Panel's Co-op mode. The host's
// own save (a separate "/SavedataCoop" folder, never the real "/Savedata")
// is the single source of truth; everyone else mirrors whatever the host
// broadcasts. Non-host clients still earn/spend locally through completely
// normal vanilla gameplay - this only detects the resulting changes and
// forwards them as deltas for the host to apply and rebroadcast.
internal class CoopManager
{
	private const string SaveFolder = "/SavedataCoop";
	private const float SyncInterval = 3f;
	private const float SaveInterval = 20f;

	public bool Active { get; private set; }

	private Movement _localMovement;
	private readonly List<courseScript> _courses = new List<courseScript>();
	private readonly List<clonesScript> _disabledClones = new List<clonesScript>();
	private readonly List<(upgradeBox box, double scaleFactor, double baseCost)> _rebalancedBoxes = new List<(upgradeBox, double, double)>();

	private float _syncAccumulator;
	private float _saveAccumulator;

	private readonly Dictionary<globalStats.Currencies, double> _lastCurrency = new Dictionary<globalStats.Currencies, double>();
	private readonly Dictionary<globalStats.globalUpgradeSet, double> _lastGlobalUpgrade = new Dictionary<globalStats.globalUpgradeSet, double>();
	private readonly Dictionary<int, Dictionary<localUpgrades.localUpgradeSet, double>> _lastLocalUpgrade = new Dictionary<int, Dictionary<localUpgrades.localUpgradeSet, double>>();
	private readonly Dictionary<int, int[]> _lastTimesUsed = new Dictionary<int, int[]>();
	private bool _lastDash, _lastWallJump, _lastDoubleJump, _lastBlockSwap;

	public void Begin(bool isHost, int playerCount, Movement localMovement)
	{
		Active = true;
		_localMovement = localMovement;
		_syncAccumulator = 0f;
		_saveAccumulator = 0f;

		var saveloader = UnityEngine.Object.FindFirstObjectByType<Saveloader>();
		if (saveloader != null) saveloader.CancelInvoke("autosave");

		_courses.Clear();
		_courses.AddRange(UnityEngine.Object.FindObjectsByType<courseScript>(FindObjectsInactive.Include, FindObjectsSortMode.None));

		DisableClones();
		RebalanceCosts(playerCount);

		// Every Co-op session starts from a true blank slate, host or not - a
		// non-host's local view gets zeroed here too so it isn't showing their
		// own stale real-save numbers for the few seconds before the host's
		// first sync arrives; only the host actually persists the reset to disk.
		ModeSaveFile.ResetEconomyToZero(_localMovement, _courses);
		if (isHost)
		{
			ModeSaveFile.DeleteAndRecreateFolder(SaveFolder);
			ModeSaveFile.Save(SaveFolder, _localMovement, _courses);
		}

		CaptureBaseline();
	}

	private static List<upgradeBox> GetUpgradeBoxes(courseScript course) => ModeSaveFile.GetUpgradeBoxes(course);

	private void DisableClones()
	{
		_disabledClones.Clear();
		foreach (var c in UnityEngine.Object.FindObjectsByType<clonesScript>(FindObjectsInactive.Include, FindObjectsSortMode.None))
		{
			if (!c.enabled) continue;
			c.enabled = false;
			_disabledClones.Add(c);
		}
	}

	private void RebalanceCosts(int playerCount)
	{
		_rebalancedBoxes.Clear();
		if (playerCount <= 1) return;
		var factor = 1.0 / playerCount;
		foreach (var box in UnityEngine.Object.FindObjectsByType<upgradeBox>(FindObjectsInactive.Include, FindObjectsSortMode.None))
		{
			_rebalancedBoxes.Add((box, box.upgradeScaleFactor, box.baseUpgradeCost));
			box.upgradeScaleFactor *= factor;
			box.baseUpgradeCost *= factor;
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

	public void Tick(float unscaledDt, bool isHost, Action<JObject> sendGameMessage)
	{
		if (!Active) return;

		if (!isHost)
		{
			var delta = BuildDelta();
			if (delta != null) sendGameMessage(delta);
		}

		_syncAccumulator += unscaledDt;
		if (isHost && _syncAccumulator >= SyncInterval)
		{
			_syncAccumulator = 0f;
			sendGameMessage(BuildFullSync());
		}

		if (isHost)
		{
			_saveAccumulator += unscaledDt;
			if (_saveAccumulator >= SaveInterval)
			{
				_saveAccumulator = 0f;
				PersistSave();
			}
		}
	}

	public void HandleMessage(string kind, JObject payload, bool isHost)
	{
		if (!Active) return;
		if (kind == "coopDelta")
		{
			if (isHost) ApplyDelta(payload);
		}
		else if (kind == "coopSync")
		{
			ApplyFullSync(payload);
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
				foreach (var kv in localUpgradesObj)
				{
					if (!Enum.TryParse<global::localUpgrades.localUpgradeSet>(kv.Key, out var key)) continue;
					var current = course.localUpgradesScript.localUpgradeDict.TryGetValue(key, out var v) ? v : 0.0;
					course.localUpgradesScript.localUpgradeDict[key] = additive ? Math.Max(0, current + kv.Value.Value<double>()) : kv.Value.Value<double>();
				}
			}
			if (courseObj["boxTimesUsed"] is JObject boxTimesUsedObj)
			{
				var boxes = GetUpgradeBoxes(course);
				foreach (var kv in boxTimesUsedObj)
				{
					if (!int.TryParse(kv.Key, out var boxIndex) || boxIndex < 0 || boxIndex >= boxes.Count) continue;
					boxes[boxIndex].TimesUsed = additive ? Math.Max(0, boxes[boxIndex].TimesUsed + kv.Value.Value<int>()) : kv.Value.Value<int>();
				}
			}
		}
	}

	private JObject BuildDelta()
	{
		JObject currencies = null;
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

		if (currencies == null && upgrades == null && abilities == null && courses == null) return null;
		var msg = new JObject { ["k"] = "coopDelta" };
		if (currencies != null) msg["currencies"] = currencies;
		if (upgrades != null) msg["upgrades"] = upgrades;
		if (abilities != null) msg["abilities"] = abilities;
		if (courses != null) msg["courses"] = courses;
		return msg;
	}

	private JObject BuildFullSync()
	{
		var currencies = new JObject();
		foreach (globalStats.Currencies c in Enum.GetValues(typeof(globalStats.Currencies)))
			currencies[c.ToString()] = globalStats.currencyLookup[c];
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
		// re-baseline so the host doesn't immediately read its own broadcast back as a new delta next tick
		CaptureBaseline();
		return new JObject { ["k"] = "coopSync", ["currencies"] = currencies, ["upgrades"] = upgrades, ["abilities"] = abilities, ["courses"] = courses };
	}

	private static void ApplyCurrenciesAndUpgrades(JObject payload, bool additive)
	{
		if (payload["currencies"] is JObject currencies)
			foreach (var kv in currencies)
				if (Enum.TryParse<globalStats.Currencies>(kv.Key, out var c))
					globalStats.currencyLookup[c] = additive ? Math.Max(0, globalStats.currencyLookup[c] + kv.Value.Value<double>()) : kv.Value.Value<double>();
		if (payload["upgrades"] is JObject upgrades)
			foreach (var kv in upgrades)
				if (Enum.TryParse<globalStats.globalUpgradeSet>(kv.Key, out var u))
					globalStats.globalUpgradeDict[u] = additive ? Math.Max(0, globalStats.globalUpgradeDict[u] + kv.Value.Value<double>()) : kv.Value.Value<double>();
	}

	private void ApplyAbilities(JObject payload)
	{
		if (!(payload["abilities"] is JObject abilities) || _localMovement == null) return;
		if (abilities["dash"] != null) _localMovement.dashUnlocked = abilities["dash"].Value<bool>();
		if (abilities["wallJump"] != null) _localMovement.wallJumpUnlocked = abilities["wallJump"].Value<bool>();
		if (abilities["doubleJump"] != null) _localMovement.doubleJumpUnlocked = abilities["doubleJump"].Value<bool>();
		if (abilities["blockSwap"] != null) _localMovement.blockSwapUnlocked = abilities["blockSwap"].Value<bool>();
	}

	private void ApplyDelta(JObject payload)
	{
		ApplyCurrenciesAndUpgrades(payload, additive: true);
		ApplyAbilities(payload);
		ApplyCoursesPayload(payload, additive: true);
	}

	private void ApplyFullSync(JObject payload)
	{
		ApplyCurrenciesAndUpgrades(payload, additive: false);
		ApplyAbilities(payload);
		ApplyCoursesPayload(payload, additive: false);
		CaptureBaseline();
	}

	private void PersistSave() => ModeSaveFile.Save(SaveFolder, _localMovement, _courses);

	public void End(bool isHost)
	{
		if (!Active) return;
		Active = false;

		if (isHost) PersistSave();

		foreach (var c in _disabledClones) if (c != null) c.enabled = true;
		_disabledClones.Clear();

		foreach (var (box, scaleFactor, baseCost) in _rebalancedBoxes)
		{
			if (box == null) continue;
			box.upgradeScaleFactor = scaleFactor;
			box.baseUpgradeCost = baseCost;
		}
		_rebalancedBoxes.Clear();

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
