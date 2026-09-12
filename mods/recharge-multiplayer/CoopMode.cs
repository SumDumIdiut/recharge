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

	public void Tick(float unscaledDt, bool isHost, Action<JObject> sendGameMessage)
	{
		if (!Active) return;

		_realSaveloader?.CancelInvoke("manualSave");

		if (!isHost)
		{
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
					ApplyBoxCapState(box);
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
					globalStats.globalUpgradeDict[u] = additive
						? Math.Max(0, globalStats.globalUpgradeDict[u] + kv.Value.Value<double>())
						: Math.Max(globalStats.globalUpgradeDict[u], kv.Value.Value<double>());
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

		if (isHost) PersistSave();

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
