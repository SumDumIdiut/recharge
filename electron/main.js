// Runs a Unity WebGL build in its own window. Recharge downloads the Electron
// runtime and calls this as:  electron <this folder> --game <build folder> [--title <name>]
//
// A Unity WebGL build is a static site, but its Brotli files (*.br) need a
// Content-Encoding header a plain file:// load can't provide, so the build is
// served from a tiny local server instead.
const { app, BrowserWindow, Menu, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}

const gameDir = arg('game');
const title = arg('title') || 'Recharge Game';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

function serve(root) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(base, '.' + rel);
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404).end('Not found');
        return;
      }
      const headers = { 'Cache-Control': 'no-cache' };
      let typeName = file;
      if (file.endsWith('.br')) {
        headers['Content-Encoding'] = 'br';
        typeName = file.slice(0, -3);
      } else if (file.endsWith('.gz')) {
        headers['Content-Encoding'] = 'gzip';
        typeName = file.slice(0, -3);
      }
      headers['Content-Type'] = TYPES[path.extname(typeName).toLowerCase()] || 'application/octet-stream';
      headers['Content-Length'] = stat.size;
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  if (!gameDir || !fs.existsSync(path.join(gameDir, 'index.html'))) {
    console.error('usage: electron . --game <folder with index.html> [--title <name>]');
    app.exit(2);
    return;
  }

  const server = await serve(gameDir);
  const url = `http://127.0.0.1:${server.address().port}/index.html`;

  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1280,
    height: 760,
    title,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });

  // Keep our title, not the page's "Unity Web Player | ...".
  win.webContents.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle(title);
  });
  win.webContents.on('did-finish-load', () => win.setTitle(title));
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    } else if (input.key === 'Escape' && win.isFullScreen()) {
      win.setFullScreen(false);
    }
  });
  // Unity's default page template pins the canvas to a fixed size and adds a
  // footer; make the game fill the window instead.
  win.webContents.on('dom-ready', () => {
    win.webContents.insertCSS(`
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
      #unity-container, #unity-container.unity-desktop { position: fixed !important; inset: 0; left: 0 !important; top: 0 !important; transform: none !important; width: 100% !important; height: 100% !important; }
      #unity-canvas { width: 100% !important; height: 100% !important; }
      #unity-footer { display: none !important; }
    `);
  });
  win.on('closed', () => server.close());

  await win.loadURL(url);
}

app.whenReady().then(main);
app.on('window-all-closed', () => app.quit());
