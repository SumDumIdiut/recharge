export const MOD_CATALOG = [
  {
    id: 'recharge.multiplayer',
    name: 'DOTnet',
    author: 'Flipped',
    version: '1.0.0',
    description:
      'Adds a native Host / Direct Connect / lobby browser to the pause menu, with ghost players, in-game chat, and a lobby list. Connect through the built-in relay or point Direct Connect at any server IP and port to play IGTAP with friends.',
    image: '/mods/assets/recharge-multiplayer/02-multiplayer-panel-hq.png',
    icon: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08s5.97 1.09 6 3.08c-1.29 1.94-3.5 3.22-6 3.22z"/>',
    // Other catalog mod ids this one's real mod.json requires (see loader's
    // "dependencies" - RechargeLoaderBootstrap.cs). Checked before install so
    // a missing one can be offered alongside it instead of silently failing
    // to load in-game later - see __modInstall in script.js.
    dependencies: [],
  },
];
