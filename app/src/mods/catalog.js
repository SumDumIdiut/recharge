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
  {
    id: 'recharge.tas',
    name: 'TAS Tool',
    author: 'Flipped',
    version: '1.0.0',
    description:
      'A practice and tool-assisted-speedrun toolkit. Press Tab in-game to open it: pause/frame-advance/slow-motion time controls, an always-on rewind buffer with step back/forward, full-state record and replay (position, velocity, facing, dash/air-jump state) with automatic trimming of failed retries, clipboard and file-based save/load for sharing recordings, a single-slot quicksave, and Z/X/R checkpoints that also override death so you respawn exactly where you left off. Includes a hitbox viewer with an optional fading trail.',
    image: '/mods/assets/recharge-tas/01-menu.png',
    icon: '<path d="M14 2v2h2v2h-2v2h-2V6H8V4h2V2h2v2zM4 12h16v2H4v-2zm2 4h2v4H6v-4zm10 0h2v4h-2v-4zm-6 0h4v4h-4v-4z"/>',
    dependencies: [],
  },
];
