using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEngine;

// Shared helper for giving a Host Panel mode (Co-op, Hide & Seek, Infection)
// its own dedicated, always-fresh save slot, completely isolated from the
// player's real save. Every session wipes whatever was there before and
// starts from a true blank slate (zero currency, zero upgrades, no
// abilities) - nothing carries over between sessions.
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
				// TimesUsed = 0 alone leaves a box that was already maxed out in the
				// player's real save visually stuck on "CAPPED" (deactivate() greys it
				// out and swaps its cost text) - reactivateAndReset() is the game's own
				// method for undoing exactly that, so reuse it instead of only touching
				// the counter.
				box.reactivateAndReset();
				box.upgradeCost = box.baseUpgradeCost;
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
		}
	}

	public static string RealSaveFolder() => "/Savedata" + (globalStats.difficultyLevel == 1 ? "hard" : "");
}
