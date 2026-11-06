#!/usr/bin/env node
// Maestro — one player for Spotify (desktop / SpotX) and YouTube.
const http = require('http');
const fs = require('fs');
const path = require('path');

const store = require('./lib/store');
const youtube = require('./lib/youtube');
const spotify = require('./lib/spotify');
const app = require('./lib/spotify-app');
const { launch } = require('./lib/launch');

const PORT = Number(process.env.PORT) || 5454;
const HOST = 'localhost';
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

// ---- helpers --------------------------------------------------------------

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

// Only the Maestro page itself may call state-changing endpoints (blocks other websites
// from poking the local server).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && Number(u.port) === PORT;
  } catch {
    return false;
  }
}

// ---- API ------------------------------------------------------------------

const routes = {
  'GET /api/status': async () => {
    const s = store.getSettings();
    return { platform: process.platform, spotify: await app.status(s.spotifyExePath), youtubeApi: !!s.youtubeApiKey };
  },

  'GET /api/search': async (req, url) => {
    const q = (url.searchParams.get('q') || '').trim();
    const source = url.searchParams.get('source');
    if (!q) return { items: [] };
    const s = store.getSettings();
    if (source === 'spotify') {
      await app.ensure(s.spotifyExePath);
      return { items: await app.call('search', q, 25) };
    }
    if (source === 'youtube') return { items: await youtube.search(q, s.youtubeApiKey) };
    throw Object.assign(new Error('source must be spotify or youtube'), { status: 400 });
  },

  // Turn a pasted link into playable items.
  'POST /api/resolve': async (req) => {
    const { url } = await readBody(req);
    const s = store.getSettings();
    const sp = spotify.parseUrl(url || '');
    if (sp) return spotify.resolve(sp.kind, sp.id);
    const yt = youtube.parseUrl(url || '');
    if (yt?.kind === 'video') {
      const item = await youtube.video(yt.id, s.youtubeApiKey);
      return { title: item.title, items: [item] };
    }
    if (yt?.kind === 'playlist') return youtube.playlist(yt.id, s.youtubeApiKey);
    throw Object.assign(new Error("That doesn't look like a Spotify or YouTube link."), { status: 400 });
  },

  // Polled while a Spotify track is playing; never launches Spotify by itself.
  'GET /api/spotify/state': async () => {
    try {
      return { connected: true, ...(await app.call('state')) };
    } catch (err) {
      if (err.code === 'NOT_CONNECTED') return { connected: false };
      throw err;
    }
  },

  'POST /api/spotify/play': async (req) => {
    const { id, volume } = await readBody(req);
    if (!/^[A-Za-z0-9]{22}$/.test(id || '')) throw Object.assign(new Error('Bad track id'), { status: 400 });
    await app.ensure(store.getSettings().spotifyExePath);
    if (Number.isFinite(volume)) await app.call('setVolume', Math.max(0, Math.min(1, volume)));
    const uri = 'spotify:track:' + id;
    await app.call('play', uri);
    return app.waitForTrack(uri);
  },

  'POST /api/spotify/control': async (req) => {
    const { action, value } = await readBody(req);
    if (action === 'pause') return { ok: await app.call('pause') };
    if (action === 'resume') return { ok: await app.call('resume') };
    if (action === 'seek') return { ok: await app.call('seek', Math.max(0, Math.round(value) || 0)) };
    if (action === 'volume') return { ok: await app.call('setVolume', Math.max(0, Math.min(1, Number(value) || 0))) };
    throw Object.assign(new Error('Unknown action'), { status: 400 });
  },

  // Restart Spotify with Maestro support (only ever on the user's request).
  'POST /api/spotify/restart': async () => {
    await app.restart(store.getSettings().spotifyExePath);
    return app.status(store.getSettings().spotifyExePath);
  },

  'POST /api/spotify/autostart': async (req) => {
    const { enable } = await readBody(req);
    return app.setAutostart(!!enable);
  },

  'GET /api/settings': () => store.publicSettings(),
  'PUT /api/settings': async (req) => store.updateSettings(await readBody(req)),

  'GET /api/playlists': () => store.listPlaylists(),
  'POST /api/playlists': async (req) => store.savePlaylist(await readBody(req)),
};

// Spotify-app states the UI knows how to handle (offer a restart, open settings, ...).
const APP_ERRORS = new Set(['NEEDS_RESTART', 'NOT_CONNECTED', 'NO_SPOTIFY', 'NO_AUTOSTART', 'UNSUPPORTED']);

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    return serveStatic(req, res, pathname);
  }
  if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Forbidden' });

  try {
    const del = pathname.match(/^\/api\/playlists\/([\w-]+)$/);
    if (del && req.method === 'DELETE') {
      store.deletePlaylist(del[1]);
      return send(res, 200, { ok: true });
    }
    const route = routes[`${req.method} ${pathname}`];
    if (!route) return send(res, 404, { error: 'Not found' });
    send(res, 200, await route(req, url));
  } catch (err) {
    // Errors we raise ourselves carry a 4xx status; anything from an upstream site is a 502.
    const status = APP_ERRORS.has(err.code) ? 409 : err.status && err.body === undefined ? err.status : 502;
    if (status >= 500) console.error(`[${req.method} ${pathname}]`, err.message, err.body || '');
    send(res, status, { error: err.message, code: err.code });
  }
}

// ---- boot -----------------------------------------------------------------

function openWindow(url) {
  if (process.platform !== 'win32') return launch(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]).catch(() => {});
  // An Edge "app" window feels like a real desktop player; fall back to the default browser.
  const edge = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
  ].find((p) => fs.existsSync(p));
  // A dedicated profile means our flags apply even if Edge is already open, and lets
  // YouTube autoplay when a Spotify track hands over to a YouTube one.
  const args = [
    '--app=' + url,
    '--window-size=1280,820',
    '--user-data-dir=' + path.join(store.DATA_DIR, 'edge-profile'),
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  launch(edge || url, edge ? args : []).catch((err) => console.log(`Open ${url} in your browser (${err.message})`));
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => send(res, 500, { error: err.message }));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Maestro already seems to be running on port ${PORT} — opening it.`);
    if (!process.argv.includes('--no-open')) openWindow(`http://localhost:${PORT}`);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Maestro is running at ${url}  (Ctrl+C to quit)`);
  if (!process.argv.includes('--no-open')) openWindow(url);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    app.close();
    process.exit(0);
  });
}
