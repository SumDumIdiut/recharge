using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Net;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

public static class MpMapLibrary
{
	private const string HubBase = "https://codecade.co.za/recharge";

	// The full game ships the demo's B-Side code but has no B-Side to play.
	public static bool HasBSide => Application.productName != "IGTAPfullGame";

	public static string MapsDir => Path.Combine(Path.GetDirectoryName(Application.dataPath) ?? ".", "Recharge", "Mods", "recharge.maps", "maps");

	public struct HostableMap
	{
		public string LocalId;
		public string HubId;
		public string Name;
	}

	public static List<(string Id, string Name)> GetLocalMaps()
	{
		var result = new List<(string, string)>();
		if (!Directory.Exists(MapsDir)) return result;
		foreach (var dir in Directory.GetDirectories(MapsDir))
		{
			var mapJsonPath = Path.Combine(dir, "map.json");
			if (!File.Exists(mapJsonPath)) continue;
			try
			{
				// Whole-level maps run tens of MB - read just the top-level "name" instead of parsing the whole file into memory.
				var name = ReadMapName(mapJsonPath);
				if (string.IsNullOrEmpty(name)) continue;
				result.Add((Path.GetFileName(dir), name));
			}
			catch (Exception e) { Debug.LogWarning("[DOTnet] couldn't read " + mapJsonPath + ": " + e.Message); }
		}
		return result;
	}

	private static string ReadMapName(string mapJsonPath)
	{
		using (var reader = new JsonTextReader(new StreamReader(mapJsonPath)))
			while (reader.Read())
			{
				if (reader.Depth == 1 && reader.TokenType == JsonToken.PropertyName && (string)reader.Value == "name")
					return reader.ReadAsString();
				if (reader.Depth == 1 && reader.TokenType == JsonToken.PropertyName) { reader.Read(); reader.Skip(); }
			}
		return null;
	}

	public static List<HostableMap> GetHostableMaps()
	{
		var result = new List<HostableMap>();
		List<(string Id, string Name)> hubMaps;
		try
		{
			using (var wc = new WebClient())
			{
				var json = wc.DownloadString(HubBase + "/api/maps");
				var arr = JArray.Parse(json);
				hubMaps = new List<(string, string)>();
				foreach (var item in arr)
				{
					var id = (string)item["id"];
					var name = (string)item["name"];
					if (!string.IsNullOrEmpty(id) && !string.IsNullOrEmpty(name)) hubMaps.Add((id, name));
				}
			}
		}
		catch (Exception e)
		{
			Debug.LogWarning("[DOTnet] couldn't reach Recharge Hub for the map library: " + e.Message);
			return result;
		}

		foreach (var local in GetLocalMaps())
		{
			foreach (var hub in hubMaps)
			{
				if (hub.Name == local.Name)
				{
					result.Add(new HostableMap { LocalId = local.Id, HubId = hub.Id, Name = local.Name });
					break;
				}
			}
		}
		return result;
	}

	public static bool IsDownloaded(string hubId) => !string.IsNullOrEmpty(hubId) && Directory.Exists(Path.Combine(MapsDir, hubId));

	public static void DownloadAndExtract(string hubId)
	{
		byte[] bytes;
		using (var wc = new WebClient())
		{
			bytes = wc.DownloadData(HubBase + "/api/maps/" + Uri.EscapeDataString(hubId) + "/file");
		}

		var target = Path.Combine(MapsDir, hubId);
		var tmp = target + ".downloading";
		if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
		Directory.CreateDirectory(tmp);

		using (var stream = new MemoryStream(bytes))
		using (var archive = new ZipArchive(stream, ZipArchiveMode.Read))
		{
			foreach (var entry in archive.Entries)
			{
				if (string.IsNullOrEmpty(entry.Name)) continue;
				var destPath = Path.Combine(tmp, entry.FullName);
				Directory.CreateDirectory(Path.GetDirectoryName(destPath));
				entry.ExtractToFile(destPath, overwrite: true);
			}
		}

		if (Directory.Exists(target)) Directory.Delete(target, true);
		Directory.Move(tmp, target);
	}
}
