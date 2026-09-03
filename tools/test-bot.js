// Fake player(s) for testing recharge-multiplayer. Matches the current
// WebSocket protocol (MpProtocol.cs) and Movement.cs's real animator codes
// (0=idle, 1=walk, 2=falling, 5=jumping) so the ghost looks like it's
// actually playing rather than sitting still.
//
// Usage:
//   node test-bot.js host <host> <port> <baseX> <baseY> [lobbyName]
//   node test-bot.js join <host> <port> <lobbyId> <baseX> <baseY>
const MODE = process.argv[2];
const HOST = process.argv[3] || '127.0.0.1';
const PORT = process.argv[4] || '7777';
const BOT_NAME = 'Jordan';

// Matches MpNetClient's BuildUri(): port 443 means the public portal-proxied
// relay, reached over wss:// at the /dotnet path, not a plain host:port.
const URL = PORT === '443' ? `wss://${HOST}/dotnet` : `ws://${HOST}:${PORT}/`;
const ws = new WebSocket(URL);
console.log('connecting to', URL);

function sendState(baseX, baseY) {
  let t = 0;
  let jumping = false;
  let jumpT = 0;
  setInterval(() => {
    t += 0.066;
    const dx = Math.sin(t * 0.5);
    const facingRight = Math.cos(t * 0.5) >= 0;
    const x = baseX + dx * 60;
    let y = baseY;
    let animState = 1;

    if (!jumping && Math.random() < 0.01) {
      jumping = true;
      jumpT = 0;
    }
    if (jumping) {
      const dur = 0.6;
      jumpT += 0.066;
      if (jumpT < dur) {
        animState = jumpT < dur / 2 ? 5 : 2;
        y = baseY + Math.sin((jumpT / dur) * Math.PI) * 40;
      } else {
        jumping = false;
      }
    }

    ws.send(
      JSON.stringify({
        type: 'state',
        x,
        y,
        facingRight,
        animState,
        animSpeed: 1,
        isPaused: false,
        name: BOT_NAME,
        nameColor: '#FFFFFF',
        dotColor: '#3399FF',
      })
    );
  }, 66);
}

if (MODE === 'host') {
  const X = parseFloat(process.argv[5] || '0');
  const Y = parseFloat(process.argv[6] || '0');
  const LOBBY_NAME = process.argv[7] || '';
  ws.addEventListener('open', () => {
    console.log('connected, hosting lobby');
    ws.send(JSON.stringify({ type: 'host', name: LOBBY_NAME, playerName: BOT_NAME }));
    sendState(X, Y);
  });
} else if (MODE === 'join') {
  const LOBBY_ID = parseInt(process.argv[5] || '1', 10);
  const X = parseFloat(process.argv[6] || '0');
  const Y = parseFloat(process.argv[7] || '0');
  let joined = false;
  function tryJoin() {
    if (!joined) ws.send(JSON.stringify({ type: 'join_lobby', lobbyId: LOBBY_ID, playerName: BOT_NAME }));
  }
  ws.addEventListener('open', () => {
    console.log('connected, joining lobby', LOBBY_ID);
    tryJoin();
    setInterval(tryJoin, 3000);
    sendState(X, Y);
  });
  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'joined') joined = true;
      if (msg.type === 'left') joined = false;
    } catch (e) {}
  });
} else {
  console.error('Usage: node test-bot.js <host|join> <host> <port> ...');
  process.exit(1);
}

ws.addEventListener('message', (event) => console.log('recv:', event.data));
ws.addEventListener('error', (e) => console.error('error:', e.message));
ws.addEventListener('close', () => console.log('closed'));
