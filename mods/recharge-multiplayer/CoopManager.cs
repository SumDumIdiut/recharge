using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityEngine;

// Host-authoritative shared economy for Host Panel's Co-op mode.
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
	private readonly List<(courseScript course, int originalBaseReward)> _scaledRewards = new List<(courseScript, int)>();
	private readonly List<(upgradeBox box, double originalBaseCost)> _scaledUpgradeCosts = new List<(upgradeBox, double)>();

	private static readonly FieldInfo BaseRewardField =
		typeof(courseScript).GetField("baseReward", BindingFlags.NonPublic | BindingFlags.Instance);
	private static readonly MethodInfo DeactivateMethod =
		typeof(upgradeBox).GetMethod("deactivate", BindingFlags.NonPublic | BindingFlags.Instance);

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

		_courses.Clear();
		_courses.AddRange(UnityEngine.Object.FindObjectsByType<courseScript>(FindObjectsInactive.Include, FindObjectsSortMode.None));

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
			// non-host: zero the local view until the host's first sync arrives
			ModeSaveFile.Restore(ModeSaveFile.RealSaveFolder(), _localMovement, _courses);
			ModeSaveFile.ResetEconomyToZero(_localMovement, _courses);
		}

		// After Load/ResetEconomyToZero (both can touch reward/baseReward), so every
		// client ends up with the same host-broadcast-playerCount-scaled values.
		ScaleBaseRewards(playerCount);
		ScaleMovementUpgradeCosts(playerCount);

		CaptureBaseline();
	}

	// A scene load after Begin() destroys every Movement/courseScript captured
	// above - called from HostPanelController once it re-finds the local player,
	// so sync comparisons stop targeting dead references.
	public void RefreshSceneReferences(Movement localMovement)
	{
		if (!Active) return;
		_localMovement = localMovement;
		_courses.Clear();
		_courses.AddRange(UnityEngine.Object.FindObjectsByType<courseScript>(FindObjectsInactive.Include, FindObjectsSortMode.None));
		ModeSaveFile.Restore(ModeSaveFile.RealSaveFolder(), _localMovement, _courses);
		// A freshly spawned Movement starts from the real single-player save, not
		// this session's progress - reapply the session's own tracked state.
		_localMovement.dashUnlocked = _lastDash;
		_localMovement.wallJumpUnlocked = _lastWallJump;
		_localMovement.doubleJumpUnlocked = _lastDoubleJump;
		_localMovement.blockSwapUnlocked = _lastBlockSwap;
		// Same leak, same fix, for course-level upgrades and TimesUsed.
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
				}
			}
		}
		DisableClones();
		ScaleBaseRewards(_playerCount);
		ScaleMovementUpgradeCosts(_playerCount);
	}

	private static List<upgradeBox> GetUpgradeBoxes(courseScript course) => ModeSaveFile.GetUpgradeBoxes(course);

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
			// enabled=false alone leaves stale clones/cloneCount from the real save
			c.onPrestige(true);
			c.enabled = false;
			c.gameObject.SetActive(false); // hide the purchase kiosk itself - disabled-but-visible looked broken, not disabled
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

	public void Tick(float unscaledDt, bool isHost, Action<JObject> sendGameMessage)
	{
		if (!Active) return;

		if (!isHost)
		{
			_deltaAccumulator += unscaledDt;
			if (_deltaAccumulator >= DeltaInterval)
			{
				_deltaAccumulator = 0f;
				var delta = BuildDelta();
				if (delta != null) sendGameMessage(delta);
			}

			// BuildDelta sends abilities only once on change, and a dropped coopDelta
			// loses it permanently - periodically resend full state instead; safe
			// since ApplyAbilities OR-merges rather than overwriting.
			_abilityResendAccumulator += unscaledDt;
			if (_abilityResendAccumulator >= AbilityResendInterval)
			{
				_abilityResendAccumulator = 0f;
				var resend = BuildAbilitiesResend();
				if (resend != null) sendGameMessage(resend);
			}
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
					// Same stale-full-sync race as globalUpgradeDict below.
					course.localUpgradesScript.localUpgradeDict[key] = additive ? Math.Max(0, current + kv.Value.Value<double>()) : Math.Max(current, kv.Value.Value<double>());
				}
			}
			if (courseObj["boxTimesUsed"] is JObject boxTimesUsedObj)
			{
				var boxes = GetUpgradeBoxes(course);
				foreach (var kv in boxTimesUsedObj)
				{
					if (!int.TryParse(kv.Key, out var boxIndex) || boxIndex < 0 || boxIndex >= boxes.Count) continue;
					var box = boxes[boxIndex];
					box.TimesUsed = additive ? Math.Max(0, box.TimesUsed + kv.Value.Value<int>()) : Math.Max(box.TimesUsed, kv.Value.Value<int>());
					box.CalcBoxCost();
					if (box.TimesUsed >= box.Cap && box.isActive) DeactivateMethod?.Invoke(box, null);
					else if (box.TimesUsed < box.Cap && !box.isActive) box.isActive = true;
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
					// A periodic full sync can be stale relative to a purchase this client
					// just applied locally - take whichever value is higher instead of
					// blindly trusting the incoming one (upgrade levels only ever go up).
					globalStats.globalUpgradeDict[u] = additive
						? Math.Max(0, globalStats.globalUpgradeDict[u] + kv.Value.Value<double>())
						: Math.Max(globalStats.globalUpgradeDict[u], kv.Value.Value<double>());
	}

	private void ApplyAbilities(JObject payload)
	{
		if (!(payload["abilities"] is JObject abilities) || _localMovement == null) return;
		// OR, never overwrite - abilities only ever get unlocked, never revoked, so a
		// stale "false" must never un-set one another client already has.
		if (abilities["dash"] != null) _localMovement.dashUnlocked |= abilities["dash"].Value<bool>();
		if (abilities["wallJump"] != null) _localMovement.wallJumpUnlocked |= abilities["wallJump"].Value<bool>();
		if (abilities["doubleJump"] != null) _localMovement.doubleJumpUnlocked |= abilities["doubleJump"].Value<bool>();
		if (abilities["blockSwap"] != null) _localMovement.blockSwapUnlocked |= abilities["blockSwap"].Value<bool>();
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

	private void PersistSave() { if (_saveFolder != null) ModeSaveFile.Save(_saveFolder, _localMovement, _courses); }

	public void End(bool isHost)
	{
		if (!Active) return;
		Active = false;

		if (isHost) PersistSave();

		foreach (var c in _disabledClones) if (c != null) { c.gameObject.SetActive(true); c.enabled = true; }
		_disabledClones.Clear();

		// baseReward isn't part of the save format, so Restore() below never touches
		// it - without this the scaled value leaks into the real single-player save.
		foreach (var (course, original) in _scaledRewards)
			if (course != null) BaseRewardField.SetValue(course, original);
		_scaledRewards.Clear();

		// baseUpgradeCost isn't saved either (see ScaleMovementUpgradeCosts) - same
		// leak risk into the real single-player save without an explicit restore.
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
