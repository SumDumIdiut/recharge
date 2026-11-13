// The editor's "Test in game" slot: a real map on disk under a fixed id, because the game loads
// maps by id. It is not a map of its own, so every listing leaves it out - through isTestMap,
// not through a copy of the id.
export const TEST_MAP_ID = 'map-maker-test';

export const isTestMap = (m) => !!m && m.id === TEST_MAP_ID;
