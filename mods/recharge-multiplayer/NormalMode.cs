using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

internal class NormalMode
{
	private Movement _localMovement;
	private readonly Dictionary<string, bool> _abilityRestore = new Dictionary<string, bool>();

	public void Apply(Movement localMovement, JObject abilities)
	{
		_localMovement = localMovement;
		_abilityRestore.Clear();
		if (abilities == null || localMovement == null) return;
		ApplyAbility(abilities, "dash", () => localMovement.dashUnlocked, v => localMovement.dashUnlocked = v);
		ApplyAbility(abilities, "wallJump", () => localMovement.wallJumpUnlocked, v => localMovement.wallJumpUnlocked = v);
		ApplyAbility(abilities, "doubleJump", () => localMovement.doubleJumpUnlocked, v => localMovement.doubleJumpUnlocked = v);
		ApplyAbility(abilities, "blockSwap", () => localMovement.blockSwapUnlocked, v => localMovement.blockSwapUnlocked = v);
		if (localMovement.dashUnlocked && localMovement.maxAirDashes < 1) localMovement.maxAirDashes = 1;
		if (localMovement.doubleJumpUnlocked && localMovement.maxAirJumps < 1) localMovement.maxAirJumps = 1;
	}

	private void ApplyAbility(JObject abilities, string key, Func<bool> get, Action<bool> set)
	{
		var allowed = abilities[key]?.Value<bool>() ?? true;
		var current = get();
		if (current == allowed) return;
		_abilityRestore[key] = current;
		set(allowed);
	}

	public void Restore()
	{
		if (_localMovement != null)
		{
			foreach (var kv in _abilityRestore)
			{
				switch (kv.Key)
				{
					case "dash": _localMovement.dashUnlocked = kv.Value; break;
					case "wallJump": _localMovement.wallJumpUnlocked = kv.Value; break;
					case "doubleJump": _localMovement.doubleJumpUnlocked = kv.Value; break;
					case "blockSwap": _localMovement.blockSwapUnlocked = kv.Value; break;
				}
			}
		}
		_abilityRestore.Clear();
	}
}
