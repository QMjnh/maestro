// Drives the Spotify (SpotX) desktop app from the inside.
//
// The desktop app is a Chromium page (xpui) that is already signed in to your account.
// Started with --remote-debugging-port, it lets Maestro run code in that page over the
// Chrome DevTools Protocol, so Maestro can use the app's own player and its own search —
// no Premium, no Web API keys, and the Spotify window never jumps to the front.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { WsClient } = require('./ws');
const { launch } = require('./launch');

const IS_WINDOWS = process.platform === 'win32';
const DEBUG_PORT = Number(process.env.MAESTRO_SPOTIFY_PORT) || 9233;
const FLAG = `--remote-debugging-port=${DEBUG_PORT}`;
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appError(message, code) {
  return Object.assign(new Error(message), { code });
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// ---- code that runs inside the Spotify app ----------------------------------

// Defines window.__maestro once per page load. Everything goes through the app's internal
// "platform" object (found via React props) — the same object Spotify's own UI uses.
const BOOT = String.raw`
if (!window.__maestro || window.__maestro.v !== 1) {
  const findPlatform = () => {
    const els = [document.getElementById('main'), ...document.querySelectorAll('body *')].filter(Boolean).slice(0, 200);
    for (const el of els) {
      const key = Object.keys(el).find((k) => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
      if (!key) continue;
      let fiber = el[key];
      if (fiber && fiber.stateNode && fiber.stateNode.current) fiber = fiber.stateNode.current;
      const stack = [fiber];
      const seen = new Set();
      while (stack.length && seen.size < 50000) {
        const f = stack.pop();
        if (!f || seen.has(f)) continue;
        seen.add(f);
        const p = f.memoizedProps;
        if (p && typeof p === 'object' && p.platform && typeof p.platform.getRegistry === 'function') return p.platform;
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    }
    return null;
  };
  const P = findPlatform();
  if (!P) throw new Error('MAESTRO_NOT_READY');
  const reg = P.getRegistry();
  const get = (name) => {
    const k = [...reg._map.keys()].find((s) => String(s) === 'Symbol(' + name + ')');
    return k ? reg.resolve(k) : null;
  };
  const player = get('PlayerAPI');
  const playback = get('PlaybackAPI');
  if (!player || !playback) throw new Error('MAESTRO_NOT_READY');

  // GraphQL query hashes change between Spotify versions; read them from the app's own code.
  const hashes = {};
  const findHash = async (name) => {
    if (hashes[name]) return hashes[name];
    const re = new RegExp('"' + name + '","query","([0-9a-f]{64})"');
    const files = new Set(['/xpui-routes-search.js', '/xpui.js']);
    for (const e of performance.getEntriesByType('resource')) {
      if (/\.js(\?|$)/.test(e.name) && e.name.startsWith(location.origin)) files.add(new URL(e.name).pathname);
    }
    for (const f of files) {
      try {
        const m = (await (await fetch(f)).text()).match(re);
        if (m) return (hashes[name] = m[1]);
      } catch {}
    }
    throw new Error('Could not find Spotify search in this app version');
  };
  const image = (sources) => {
    if (!sources || !sources.length) return '';
    const s = sources.find((x) => x.width === 300) || sources[0];
    return s.url;
  };

  window.__maestro = {
    v: 1,
    state() {
      const s = player.getState();
      const it = s.item;
      const live = it && !s.isPaused && !s.isBuffering;
      let pos = s.positionAsOfTimestamp + (live ? (Date.now() - s.timestamp) * (s.speed || 1) : 0);
      if (s.duration) pos = Math.min(pos, s.duration);
      return {
        uri: it ? it.uri : null,
        title: it ? it.name : '',
        artist: it ? (it.artists || []).map((a) => a.name).join(', ') : '',
        duration: s.duration || 0,
        position: Math.max(0, Math.round(pos)),
        playing: !!it && !s.isPaused,
        buffering: !!s.isBuffering,
      };
    },
    async play(uri) {
      await player.play({ uri }, {}, {});
      return true;
    },
    pause: () => player.pause().then(() => true),
    resume: () => player.resume().then(() => true),
    seek: (ms) => player.seekTo(ms).then(() => true),
    setVolume: (v) => Promise.resolve(playback.setVolume(v)).then(() => true),
    getVolume: () => playback.getVolume(),
    async search(q, limit) {
      const hash = await findHash('searchTracks');
      const res = await P.getGraphQLLoader()(
        { name: 'searchTracks', operation: 'query', sha256Hash: hash, value: null },
        { searchTerm: q, offset: 0, limit, numberOfTopResults: 5, includeAudiobooks: false, includePreReleases: false, includeAuthors: false },
      );
      if (res && res.errors && res.errors.length) throw new Error('Spotify search failed: ' + res.errors[0].message);
      const items = (res && res.data && res.data.searchV2 && res.data.searchV2.tracksV2 && res.data.searchV2.tracksV2.items) || [];
      return items
        .map((x) => x.item && x.item.data)
        .filter((t) => t && t.uri && t.uri.startsWith('spotify:track:') && (!t.playability || t.playability.playable))
        .map((t) => ({
          source: 'spotify',
          id: t.id || t.uri.split(':')[2],
          title: t.name,
          artist: ((t.artists && t.artists.items) || []).map((a) => a.profile && a.profile.name).filter(Boolean).join(', '),
          art: image(t.albumOfTrack && t.albumOfTrack.coverArt && t.albumOfTrack.coverArt.sources),
          duration: (t.duration && t.duration.totalMilliseconds) || null,
        }));
    },
  };
}
`;

// ---- DevTools connection ------------------------------------------------------

let conn = null; // { ws, pending: Map, nextId }

async function debugTarget() {
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`, { signal: AbortSignal.timeout(1500) });
    const list = await res.json();
    return list.find((t) => t.type === 'page' && /xpui/.test(t.url)) || null;
  } catch {
    return null;
  }
}

async function connect() {
  if (conn?.ws.open) return conn;
  const target = await debugTarget();
  if (!target) return null;
  const ws = await WsClient.connect(target.webSocketDebuggerUrl);
  const c = { ws, pending: new Map(), nextId: 1 };
  ws.on('message', (text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const p = c.pending.get(msg.id);
    if (!p) return;
    c.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) return p.reject(new Error(msg.error.message));
    const r = msg.result;
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'Error in Spotify';
      return p.reject(new Error(desc.split('\n')[0].replace(/^Error: /, '')));
    }
    p.resolve(r.result?.value);
  });
  ws.on('close', () => {
    if (conn === c) conn = null;
    for (const p of c.pending.values()) {
      clearTimeout(p.timer);
      p.reject(appError('Lost connection to Spotify', 'NOT_CONNECTED'));
    }
    c.pending.clear();
  });
  conn = c;
  return c;
}

function evaluate(c, expression, timeout) {
  const id = c.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      c.pending.delete(id);
      reject(new Error('Spotify did not respond'));
    }, timeout);
    c.pending.set(id, { resolve, reject, timer });
    c.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}

/** Call a window.__maestro method inside Spotify, waiting for the app's UI if it's still loading. */
async function call(method, ...args) {
  const expr = `(async () => { ${BOOT}; return await window.__maestro[${JSON.stringify(method)}](...${JSON.stringify(args)}); })()`;
  const deadline = Date.now() + 20000;
  for (;;) {
    const c = await connect();
    if (!c) throw appError('Spotify is not connected', 'NOT_CONNECTED');
    try {
      return await evaluate(c, expr, 15000);
    } catch (err) {
      if (!/MAESTRO_NOT_READY/.test(err.message) || Date.now() > deadline) throw err;
      await sleep(500);
    }
  }
}

// ---- process management ---------------------------------------------------------

function findExe(custom) {
  const candidates = [custom, process.env.APPDATA && path.join(process.env.APPDATA, 'Spotify', 'Spotify.exe')];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

async function isRunning() {
  if (!IS_WINDOWS) return false;
  const out = await run('tasklist.exe', ['/FI', 'IMAGENAME eq Spotify.exe', '/NH']);
  return !!out && /spotify\.exe/i.test(out);
}

async function start(exePath) {
  const exe = findExe(exePath);
  if (!exe) throw appError("Couldn't find Spotify.exe — set its path in Settings.", 'NO_SPOTIFY');
  await launch(exe, [FLAG, '--minimized']);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await debugTarget()) return;
    await sleep(500);
  }
  throw appError('Spotify started but Maestro could not connect to it.', 'NOT_CONNECTED');
}

/**
 * Make sure we're connected. Starts Spotify if it isn't running.
 * If it's running without Maestro support we don't kill it unasked: NEEDS_RESTART.
 */
async function ensure(exePath) {
  if (!IS_WINDOWS) throw appError('Spotify control needs Windows.', 'UNSUPPORTED');
  if (await connect().catch(() => null)) return;
  if (await isRunning()) {
    // It may still be starting up with the flag; give it a moment.
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      if (await connect().catch(() => null)) return;
    }
    throw appError('Spotify is running without Maestro support. Restart it once so Maestro can connect.', 'NEEDS_RESTART');
  }
  await start(exePath);
  if (!(await connect())) throw appError('Could not connect to Spotify.', 'NOT_CONNECTED');
}

async function restart(exePath) {
  if (conn) conn.ws.close();
  await run('taskkill.exe', ['/IM', 'Spotify.exe', '/F']);
  for (let i = 0; i < 20 && (await isRunning()); i++) await sleep(250);
  await start(exePath);
  if (!(await connect())) throw appError('Could not connect to Spotify.', 'NOT_CONNECTED');
}

// ---- autostart (so Spotify is connectable right after login) --------------------

async function readAutostart() {
  const out = await run('reg.exe', ['query', RUN_KEY, '/v', 'Spotify']);
  const m = out && out.match(/Spotify\s+REG_SZ\s+(.+)/);
  return m ? m[1].trim() : null;
}

async function autostartStatus() {
  const cmd = IS_WINDOWS ? await readAutostart() : null;
  return { exists: !!cmd, enabled: !!cmd && cmd.includes(FLAG) };
}

async function setAutostart(enable) {
  const cmd = await readAutostart();
  if (!cmd) throw appError("Spotify isn't set to start with Windows (turn on “Open Spotify automatically” in Spotify's settings first).", 'NO_AUTOSTART');
  const base = cmd.replace(/\s*--remote-debugging-port=\d+/g, '');
  const next = enable ? `${base} ${FLAG}` : base;
  const ok = await run('reg.exe', ['add', RUN_KEY, '/v', 'Spotify', '/t', 'REG_SZ', '/d', next, '/f']);
  if (ok === null) throw new Error('Could not update the Windows startup entry.');
  return autostartStatus();
}

// ---- public API ---------------------------------------------------------------------

async function status(exePath) {
  if (!IS_WINDOWS) return { supported: false };
  const connected = !!(await connect().catch(() => null));
  const running = connected || (await isRunning());
  return {
    supported: true,
    exe: findExe(exePath),
    running,
    connected,
    needsRestart: running && !connected,
    autostart: await autostartStatus(),
  };
}

async function waitForTrack(uri, timeout = 6000) {
  const deadline = Date.now() + timeout;
  let state = null;
  while (Date.now() < deadline) {
    state = await call('state');
    if (state.uri === uri && state.playing) return { ok: true, state };
    await sleep(200);
  }
  return { ok: false, state };
}

module.exports = {
  IS_WINDOWS,
  DEBUG_PORT,
  findExe,
  status,
  ensure,
  restart,
  setAutostart,
  call,
  waitForTrack,
  close: () => conn?.ws.close(),
};
