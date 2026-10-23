// Mods that come from a GitHub repo instead of a Hub package: installing one pulls the repo and the
// loader builds it, and the hub never updates it. One table, so the installer and the auto-updater
// cannot disagree about which mods these are.
export const REPO_MODS = {
  // Navigator is built into every install by the loader (see loader.rs): never installed, never updated.
  'recharge.maps': { repo: 'recharge-maps', builtIn: true },
  'recharge.customskins': { repo: 'recharge-skins' },
  'recharge.example': { repo: 'recharge-mods', folder: 'recharge-example' },
  'recharge.multiplayer': { repo: 'recharge-mods', folder: 'recharge-multiplayer' },
};

// The auto-updater leaves these alone: a repo mod is never a Hub package.
export const REPO_MOD_IDS = new Set(Object.keys(REPO_MODS));

// The mods the loader builds into every install - nothing installs, updates or removes them.
export const BUILT_IN_MOD_IDS = new Set(Object.keys(REPO_MODS).filter((id) => REPO_MODS[id].builtIn));
