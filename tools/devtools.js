// CDP client for testing Recharge without touching the OS mouse/keyboard or
// window focus. Launch the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
// set to "--remote-debugging-port=9222" first.
//
// Usage:
//   node devtools.js eval "document.title"
//   node devtools.js click "#some-button"
//   node devtools.js screenshot out.png

const PORT = process.env.RECHARGE_DEVTOOLS_PORT || 9222;

async function findTarget() {
  const res = await fetch(`http://localhost:${PORT}/json`);
  const targets = await res.json();
  const target = targets.find((t) => t.type === 'page') || targets[0];
  if (!target) throw new Error('No debuggable target found - is the app running with the debug port set?');
  return target;
}

function send(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  const [mode, arg] = process.argv.slice(2);
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  if (mode === 'eval') {
    const result = await send(ws, 1, 'Runtime.evaluate', {
      expression: arg,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log(JSON.stringify(result.result.value ?? result.result, null, 2));
  } else if (mode === 'click') {
    const result = await send(ws, 1, 'Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(arg)}); if (!el) return 'NOT_FOUND'; el.click(); return 'OK'; })()`,
      returnByValue: true,
    });
    console.log(result.result.value);
  } else if (mode === 'screenshot') {
    const result = await send(ws, 1, 'Page.captureScreenshot', { format: 'png' });
    const fs = await import('node:fs');
    fs.writeFileSync(arg, Buffer.from(result.data, 'base64'));
    console.log('saved to ' + arg);
  } else {
    console.error('Usage: node devtools.js <eval|click|screenshot> <arg>');
    process.exit(1);
  }

  ws.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
