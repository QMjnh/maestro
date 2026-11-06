const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.MAESTRO_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function file(name) {
  return path.join(DATA_DIR, name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  const tmp = file(name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file(name));
}

// ---- settings -------------------------------------------------------------

const SETTING_KEYS = ['youtubeApiKey', 'spotifyExePath'];
const SECRET_KEYS = new Set(['youtubeApiKey']);

function getSettings() {
  const saved = readJson('settings.json', {});
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, typeof saved[k] === 'string' ? saved[k] : '']));
}

/** Settings as shown to the browser: secrets are reduced to "is set". */
function publicSettings() {
  const s = getSettings();
  const out = {};
  for (const k of SETTING_KEYS) out[k] = SECRET_KEYS.has(k) ? (s[k] ? '••••••••' : '') : s[k];
  return out;
}

function updateSettings(patch) {
  const s = getSettings();
  for (const k of SETTING_KEYS) {
    if (typeof patch[k] !== 'string') continue;
    // The masked placeholder means "unchanged".
    if (SECRET_KEYS.has(k) && patch[k] === '••••••••') continue;
    s[k] = patch[k].trim();
  }
  writeJson('settings.json', s);
  return publicSettings();
}

// ---- playlists ------------------------------------------------------------

function cleanItem(it) {
  return {
    source: it.source === 'spotify' ? 'spotify' : 'youtube',
    id: String(it.id),
    title: String(it.title || ''),
    artist: String(it.artist || ''),
    art: String(it.art || ''),
    duration: Number.isFinite(it.duration) ? it.duration : null,
  };
}

function listPlaylists() {
  return readJson('playlists.json', []);
}

function savePlaylist(pl) {
  const all = listPlaylists();
  const now = Date.now();
  const entry = {
    id: pl.id || crypto.randomUUID(),
    name: String(pl.name || 'Untitled playlist').slice(0, 200),
    items: Array.isArray(pl.items) ? pl.items.filter((i) => i && i.id).map(cleanItem) : [],
    updatedAt: now,
  };
  const idx = all.findIndex((p) => p.id === entry.id);
  if (idx >= 0) all[idx] = { ...all[idx], ...entry };
  else all.push({ ...entry, createdAt: now });
  writeJson('playlists.json', all);
  return all.find((p) => p.id === entry.id);
}

function deletePlaylist(id) {
  writeJson(
    'playlists.json',
    listPlaylists().filter((p) => p.id !== id),
  );
}

module.exports = { DATA_DIR, getSettings, publicSettings, updateSettings, listPlaylists, savePlaylist, deletePlaylist };
