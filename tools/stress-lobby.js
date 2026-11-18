// Stress test: N fake players in ONE lobby, all spamming random movement
// (random walk + random jumps + random chat every so often). Matches the
// current WebSocket protocol (MpProtocol.cs) and Movement.cs's animator
// codes (0=idle, 1=walk, 2=falling, 5=jumping).
//
// Usage:
//   node stress-lobby.js [count] [host] [port] [lobbyId]
//   node stress-lobby.js 100 127.0.0.1 7777 1     # join lobby 1 with 100 bots
//   node stress-lobby.js 100 127.0.0.1 7777 host  # bot 1 hosts, the rest join
//
// The first bot hosts when lobbyId is "host"; every bot picks its own random
// walk region so ghosts spread out instead of stacking on one spot.
const COUNT = Math.max(1, parseInt(process.argv[2] || '100', 10));
const HOST = process.argv[3] || '127.0.0.1';
const PORT = process.argv[4] || '7777';
const LOBBY = process.argv[5] || 'host'; // a number joins that lobby; "host" makes bot 1 host it

// Teleport-to-player mode: the first real player the bots see pins the crowd origin ONCE;
// after that the bots free-roam from there (wide scatter) and stop tracking.
const target = { x: null, y: null, name: null, locked: false };

// Port 443 means the public portal-proxied relay: wss://host/dotnet.
const URL = String(PORT) === '443' ? `wss://${HOST}/dotnet` : `ws://${HOST}:${PORT}/`;

const ANIMS = [0, 1, 1, 1, 2, 5]; // weighted to look like running around
const COLORS = ['#3399FF', '#FF424D', '#33CC77', '#FFD24A', '#DC72EC', '#FF8800'];

function makeBot(i) {
  const name = `Stress${String(i).padStart(3, '0')}`;
  const baseX = (i % 10) * 80 - 360;
  const baseY = Math.floor(i / 10) * 80 - 360;
  const dotColor = COLORS[i % COLORS.length];
  const nameColor = i === 0 ? '#FFD24A' : '#FFFFFF';
  let t = Math.random() * 100;
  let jumpT = -1;
  let chatT = Math.random() * 40;

  const ws = new WebSocket(URL);
  const bot = { ws, name, joined: false, sent: 0, recv: 0, errors: 0 };
  let hostTimer = null;

  ws.addEventListener('open', () => {
    if (LOBBY === 'host' && i === 0) {
      ws.send(JSON.stringify({ type: 'host', name: 'StressLobby', playerName: name }));
      bot.joined = true;
    } else {
      const id = LOBBY === 'host' ? 1 : parseInt(LOBBY, 10);
      hostTimer = setInterval(() => {
        if (!bot.joined) ws.send(JSON.stringify({ type: 'join_lobby', lobbyId: id, playerName: name }));
      }, 3000);
      ws.send(JSON.stringify({ type: 'join_lobby', lobbyId: LOBBY === 'host' ? 1 : parseInt(LOBBY, 10), playerName: name }));
    }
    // random inputs, ~15 Hz like a real client's animator tick
    bot.tick = setInterval(() => {
      if (ws.readyState !== 1) return;
      t += 0.066;
      // home: the pinned player position (one teleport), then each bot flings out to its own roam
      // spot across the map (golden-angle spiral, 200-2000 units out) so the crowd never bunches up
      const ang = i * 2.39996, dist = 200 + (i * 37) % 1800;
      const homeX = target.x !== null ? target.x + Math.cos(ang) * dist : (i % 10) * 80 - 360;
      const homeY = target.x !== null ? target.y + Math.sin(ang) * dist : Math.floor(i / 10) * 80 - 360;
      // free roam around the home spot: horizontal drift only - the y stays on the player's floor line
      // (bots are protocol ghosts: no physics, so without this they float through the level)
      const dx = Math.sin(t * 0.45 + i * 1.7) * 180 + Math.sin(t * 1.3) * 40;
      let y = homeY + Math.sin(t * 1.8 + i * 2) * 6;
      let animState = 1;
      if (jumpT < 0 && Math.random() < 0.03) jumpT = 0; // random jump
      if (jumpT >= 0) {
        const dur = 0.6;
        jumpT += 0.066;
        if (jumpT < dur) {
          animState = jumpT < dur / 2 ? 5 : 2;
          y += Math.sin((jumpT / dur) * Math.PI) * 40; // jumps rise and land back on the floor line
        } else jumpT = -1;
      }
      bot.sent++;
      ws.send(JSON.stringify({
        type: 'state',
        x: homeX + dx,
        y,
        facingRight: Math.cos(t * 0.7 + i) >= 0,
        animState,
        animSpeed: 1,
        isPaused: false,
        name,
        nameColor,
        dotColor,
      }));
      // the occasional chat bubble
      chatT -= 0.066;
      if (chatT <= 0) {
        chatT = 30 + Math.random() * 60;
        ws.send(JSON.stringify({ type: 'chat', text: `${name} reporting in (${bot.sent} states)` }));
      }
    }, 66);
  });

  ws.addEventListener('message', (event) => {
    bot.recv++;
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'joined') bot.joined = true;
      if (msg.type === 'left') bot.joined = false;
      if (msg.type === 'error') bot.errors++;
      // a real player in the snapshot: the first sighting pins the crowd origin once, then they roam free
      if (msg.type === 'snapshot' && Array.isArray(msg.players) && !target.locked) {
        const real = msg.players.find((p) => p && typeof p.x === 'number' && typeof p.y === 'number' && !/^Stress/.test(p.name || ''));
        if (real) { target.x = real.x; target.y = real.y; target.name = real.name; target.locked = true; }
      }
    } catch (e) { bot.errors++; }
  });

  ws.addEventListener('error', () => { bot.errors++; });
  ws.addEventListener('close', () => { clearInterval(bot.tick); clearInterval(hostTimer); });
  return bot;
}

console.log(`stress: ${COUNT} bots -> ${URL} (lobby: ${LOBBY})`);
const bots = [];
for (let i = 0; i < COUNT; i++) bots.push(makeBot(i));

// every 5 seconds: how many joined, how chatty, how broken
setInterval(() => {
  const joined = bots.filter((b) => b.joined).length;
  const open = bots.filter((b) => b.ws.readyState === 1).length;
  const sent = bots.reduce((a, b) => a + b.sent, 0);
  const recv = bots.reduce((a, b) => a + b.recv, 0);
  const errs = bots.reduce((a, b) => a + b.errors, 0);
  const at = target.locked ? ` pinned at (${Math.round(target.x)},${Math.round(target.y)}) - free roaming` : ' (grid)';
  console.log(`open=${open} joined=${joined} sent=${sent} recv=${recv} errors=${errs}${at}`);
}, 5000);

process.on('SIGINT', () => {
  console.log('closing all bots...');
  for (const b of bots) { clearInterval(b.tick); try { b.ws.close(); } catch (e) {} }
  setTimeout(() => process.exit(0), 300);
});
