// Shadow bot for DOTnet: hosts a lobby, waits for you to join, then copies
// everything you do 1 second later - position, facing, animation and your
// dash/double-jump indicators, taken from the relay's snapshots and your
// "ind" messages. Positions are the world-space values
// DOTnet clients send, so it lines up across FloatingOrigin shifts too.
//
// Usage:
//   node shadow-bot.js [host] [port] [lobbyName] [botName] [delaySeconds] [followName]
// Defaults: codecade.co.za 443 (the public relay), "Shadow Bot", "Shadow", 1,
// and whoever joins first.
//
// It always reports every ability unlocked (dash, wall jump, double jump,
// block swap) and ready, so Co-op rounds and the Host Panel see it that way.
const crypto = require('crypto');

const [HOST = 'codecade.co.za', PORT = '443', LOBBY_NAME = 'Shadow Bot', BOT_NAME = 'Shadow', DELAY_S = '1', FOLLOW = ''] = process.argv.slice(2);
const DELAY_MS = parseFloat(DELAY_S) * 1000;
const SEND_HZ = 30;
const NAME_COLOR = '#B48CFF';
const DOT_COLOR = '#6A3DFF';
const ALL_ABILITIES = { dash: true, wallJump: true, doubleJump: true, blockSwap: true };

// Same rule as MpNetClient.BuildUri: 443 is the portal-proxied wss relay.
const url = PORT === '443' ? `wss://${HOST}/dotnet` : `ws://${HOST}:${PORT}/`;
const token = crypto.randomBytes(16).toString('hex'); // reclaims our lobby after a reconnect

let ws = null;
let lobbyId = 0;
let targetId = 0;
let lastSeenTargetAt = 0;
const buffer = []; // { at, x, y, facingRight, animState, animSpeed, isPaused }, oldest first
let current = null; // the state we're showing
const indBuffer = []; // { at, d, j } - the target's air dashes/jumps left, oldest first

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function pickTarget(players) {
  if (targetId && players.some((p) => p.id === targetId)) return players.find((p) => p.id === targetId);
  const p = FOLLOW ? players.find((q) => q.name === FOLLOW) : players[0];
  if (p && p.id !== targetId) {
    targetId = p.id;
    buffer.length = 0;
    indBuffer.length = 0;
    console.log(`following ${p.name} ${DELAY_MS / 1000}s behind`);
  }
  return p;
}

function connect() {
  console.log('connecting to', url);
  ws = new WebSocket(url);
  ws.addEventListener('open', () => send({ type: 'host', name: LOBBY_NAME, playerName: BOT_NAME, token }));
  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'hosted') {
      lobbyId = msg.lobbyId;
      console.log(`hosting "${msg.name}" (#${lobbyId}) - waiting for a player to join`);
    } else if (msg.type === 'join_failed') {
      console.error('host failed:', msg.reason);
    } else if (msg.type === 'snapshot') {
      const p = pickTarget(msg.players || []);
      if (!p) return;
      lastSeenTargetAt = Date.now();
      buffer.push({ at: Date.now(), x: p.x, y: p.y, facingRight: p.facingRight, animState: p.animState, animSpeed: p.animSpeed, isPaused: p.isPaused });
    } else if (msg.type === 'game_msg' && msg.from === targetId && msg.payload && msg.payload.k === 'ind') {
      indBuffer.push({ at: Date.now(), d: msg.payload.d, j: msg.payload.j });
    } else if (msg.type === 'chat') {
      console.log(`[chat] ${msg.from}: ${msg.text}`);
    }
  });
  ws.addEventListener('close', () => {
    console.log('disconnected - reconnecting in 3s');
    lobbyId = 0;
    setTimeout(connect, 3000);
  });
  ws.addEventListener('error', (e) => console.error('error:', e.message || e));
}

setInterval(() => {
  if (!lobbyId) return;
  if (targetId && Date.now() - lastSeenTargetAt > 5000) {
    console.log('target left - waiting for a player to join');
    targetId = 0;
    buffer.length = 0;
    indBuffer.length = 0;
  }

  // Indicator changes replay on the same delay as movement.
  while (indBuffer.length > 0 && indBuffer[0].at <= Date.now() - DELAY_MS) {
    const { d, j } = indBuffer.shift();
    send({ type: 'game_msg', payload: { k: 'ind', d, j } });
  }

  // Play back what the target did DELAY_MS ago, interpolating position
  // between the two snapshots around that moment.
  const playAt = Date.now() - DELAY_MS;
  while (buffer.length >= 2 && buffer[1].at <= playAt) buffer.shift();
  if (buffer.length > 0 && buffer[0].at <= playAt) {
    const a = buffer[0];
    const b = buffer[1];
    const k = b ? (playAt - a.at) / (b.at - a.at) : 0;
    current = b ? { ...a, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k } : a;
  }
  if (!current) return; // nobody to copy yet - don't appear until there is

  send({
    type: 'state',
    x: current.x,
    y: current.y,
    facingRight: current.facingRight,
    animState: current.animState,
    animSpeed: current.animSpeed,
    isPaused: current.isPaused,
    name: BOT_NAME,
    nameColor: NAME_COLOR,
    dotColor: DOT_COLOR,
  });
}, 1000 / SEND_HZ);

// Ready + every ability unlocked, re-sent like real clients do.
setInterval(() => {
  if (!lobbyId) return;
  send({ type: 'game_msg', payload: { k: 'ready', ready: true } });
  send({ type: 'game_msg', payload: { k: 'coopDelta', abilities: ALL_ABILITIES } });
}, 2000);

connect();
