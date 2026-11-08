'use strict';
/* Maestro — one queue, three engines (YouTube iframe + Spotify desktop + SoundCloud widget). */

// ===========================================================================
// Utilities
// ===========================================================================

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);

function fmt(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function totalDuration(items) {
  const ms = items.reduce((a, i) => a + (i.duration || 0), 0);
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} hr ${min % 60} min` : `${min} min`;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { code: data.code, status: res.status });
  return data;
}

function toast(msg, { error = false, ms = 3500 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

function looksLikeUrl(s) {
  return (
    /^(https?:\/\/|spotify:)/i.test(s.trim()) ||
    /^(www\.|open\.spotify\.com|youtu\.be|(m\.|music\.)?youtube\.com|(on\.)?soundcloud\.com|m\.soundcloud\.com)/i.test(s.trim())
  );
}

// Same loose comparison the server uses to tell whether Spotify is on "our" track.
function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+[-–]\s+.*$/, '')
    .replace(/\s*[([].*?[)\]]/g, '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}
function titleMatches(a, b) {
  const x = normTitle(a);
  const y = normTitle(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

// ===========================================================================
// Icons
// ===========================================================================

const ICONS = {
  play: '<path d="M7 4.5v15l13-7.5z"/>',
  pause: '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>',
  next: '<path d="M5 4.5v15l10-7.5zM17 4h2.5v16H17z"/>',
  prev: '<path d="M19 4.5v15L9 12zM4.5 4H7v16H4.5z"/>',
  shuffle:
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M16 4h4v4M4 20 20 4M20 16v4h-4M15 15l5 5M4 4l5 5"/>',
  repeat:
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4"/>',
  repeatOne:
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4"/><path d="M11 10h2v6h-2z"/>',
  home: '<path d="M12 3 3 10.5V21h6v-6h6v6h6V10.5z"/>',
  chevronLeft: '<path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7"/>',
  chevronRight: '<path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>',
  refresh:
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M20 11a8 8 0 0 0-14.3-4L4 9M4 4v5h5M4 13a8 8 0 0 0 14.3 4L20 15M20 20v-5h-5"/>',
  search:
    '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15zM16 16l5 5"/>',
  queue: '<path d="M3 5h13v2H3zM3 11h13v2H3zM3 17h9v2H3zM17 13.5v7l5-3.5z"/>',
  plus: '<path d="M11 4h2v16h-2zM4 11h16v2H4z"/>',
  settings:
    '<path fill="none" stroke="currentColor" stroke-width="2" d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  volume: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/>',
  mute: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 9l5 6M21 9l-5 6"/>',
  more: '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>',
  addQueue: '<path d="M3 5h13v2H3zM3 11h9v2H3zM3 17h9v2H3zM17 12h2v3h3v2h-3v3h-2v-3h-3v-2h3z"/>',
  close: '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/>',
  spotify:
    '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.6 14.4a.6.6 0 0 1-.9.2c-2.4-1.4-5.3-1.8-8.8-1a.6.6 0 1 1-.3-1.2c3.8-.9 7-.5 9.7 1.1.3.2.4.6.3.9zm1.2-2.7a.8.8 0 0 1-1 .3c-2.7-1.7-6.9-2.2-10.1-1.2a.8.8 0 1 1-.5-1.5c3.7-1.1 8.3-.6 11.4 1.4.4.2.5.7.2 1zm.1-2.8C14.7 9 9.4 8.8 6.3 9.7a.9.9 0 1 1-.5-1.8c3.5-1.1 9.4-.9 13.1 1.3a.9.9 0 0 1-1 1.6z"/>',
  youtube:
    '<path d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2C2 8.8 2 12 2 12s0 3.2.4 4.8a2.5 2.5 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8c.4-1.6.4-4.8.4-4.8s0-3.2-.4-4.8zM10 15V9l5.2 3z"/>',
  soundcloud: '<path d="M6 17h12.5a3.5 3.5 0 0 0 .4-7 6 6 0 0 0-11.5-1.6A4.5 4.5 0 0 0 6 17z"/>',
  trash: '<path d="M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 12H7z"/>',
  info: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/>',
};

function icon(name, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
function hydrateIcons(root = document) {
  for (const el of $$('[data-icon]', root)) el.innerHTML = icon(el.dataset.icon, +el.dataset.size || 20);
}
function setIcon(btn, name) {
  btn.querySelector('[data-icon]').innerHTML = icon(name);
}
const SOURCE_LABEL = { spotify: 'Spotify', youtube: 'YouTube', soundcloud: 'SoundCloud' };
const ALL_SOURCES = ['spotify', 'youtube', 'soundcloud'];
function sourceLabel(source) {
  return SOURCE_LABEL[source] || source;
}
function sourceBadge(source) {
  return `<span class="badge ${source}">${icon(source, 12)}${sourceLabel(source)}</span>`;
}
function sourceSummary(items) {
  const n = { spotify: 0, youtube: 0, soundcloud: 0 };
  for (const i of items) if (i.source in n) n[i.source]++;
  return `${n.spotify} Spotify / ${n.youtube} YouTube / ${n.soundcloud} SoundCloud`;
}
function itemLink(item) {
  if (item.source === 'spotify') return `https://open.spotify.com/track/${item.id}`;
  if (item.source === 'soundcloud') return item.url || `https://soundcloud.com/search/sounds?q=${encodeURIComponent(item.title)}`;
  return `https://www.youtube.com/watch?v=${item.id}`;
}

// ===========================================================================
// State
// ===========================================================================

// 'duet.state' is the key from before the app was renamed.
const saved = JSON.parse(localStorage.getItem('maestro.state') || localStorage.getItem('duet.state') || '{}');

const state = {
  view: { name: 'home' },
  playlists: [],
  collection: null, // the playlist opened from a home page card
  home: {
    chart: null, // null = not loaded yet
    featured: null,
    mixes: null,
    recommended: null,
    ytPicks: null, // songs
    scPicks: null,
    ytLists: null, // playlists
    scLists: null,
    spotify: null, // your own Spotify home feed, as rows of cards
    at: 0,
    ...JSON.parse(localStorage.getItem('maestro.home') || '{}'),
  },
  search: { q: '', filter: 'all', results: { spotify: null, youtube: null, soundcloud: null }, resolved: null, busy: false },
  status: null,
};

const P = {
  queue: Array.isArray(saved.queue) ? saved.queue : [],
  index: Number.isInteger(saved.index) ? saved.index : -1,
  shuffle: !!saved.shuffle,
  repeat: ['off', 'all', 'one'].includes(saved.repeat) ? saved.repeat : 'off',
  volume: Number.isFinite(saved.volume) ? saved.volume : 80,
  muted: !!saved.muted,
  unshuffled: Array.isArray(saved.unshuffled) ? saved.unshuffled : null,
  autoplay: ['off', 'same', 'both'].includes(saved.autoplay) ? saved.autoplay : 'same', // keep going with recommendations

  engine: null, // 'youtube' | 'spotify' | 'soundcloud' | null — what is currently loaded
  loaded: false, // has the current item actually been started this session?
  playing: false,
  loading: false,
  position: 0,
  duration: 0,
  token: 0, // bumps on every track change to cancel stale async work
  counted: false, // has the current play been added to the listening history?
};
if (P.index >= P.queue.length) P.index = P.queue.length - 1;

function persist() {
  localStorage.setItem(
    'maestro.state',
    JSON.stringify({
      queue: P.queue,
      index: P.index,
      shuffle: P.shuffle,
      repeat: P.repeat,
      volume: P.volume,
      muted: P.muted,
      unshuffled: P.unshuffled,
      autoplay: P.autoplay,
    }),
  );
}

const current = () => P.queue[P.index] || null;
const toEntry = (item, auto = false) => ({
  qid: uid(),
  source: item.source,
  id: item.id,
  title: item.title,
  artist: item.artist,
  art: item.art,
  duration: item.duration ?? null,
  ...(item.url ? { url: item.url } : {}),
  ...(auto ? { auto: true } : {}), // added by autoplay, not by you
});

// ===========================================================================
// YouTube engine
// ===========================================================================

const YT_STATE = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
let yt = null;
let ytReady = null;

function loadYouTube() {
  ytReady = new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => {
      yt = new YT.Player('ytPlayer', {
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
        events: {
          onReady: () => {
            yt.setVolume(P.volume);
            if (P.muted) yt.mute();
            resolve(yt);
          },
          onStateChange: onYouTubeState,
          onError: onYouTubeError,
        },
      });
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => toast('Could not load the YouTube player — are you offline?', { error: true, ms: 6000 });
    document.head.append(s);
  });
}

function onYouTubeState(e) {
  if (P.engine !== 'youtube') return;
  if (e.data === YT_STATE.PLAYING) {
    P.playing = true;
    P.loading = false;
    P.duration = yt.getDuration() * 1000 || P.duration;
    const item = current();
    if (item && !item.duration && P.duration) item.duration = Math.round(P.duration);
  } else if (e.data === YT_STATE.PAUSED) {
    P.playing = false;
  } else if (e.data === YT_STATE.ENDED) {
    P.playing = false;
    onTrackEnded();
  }
  renderPlayer();
}

function onYouTubeError(e) {
  if (P.engine !== 'youtube') return;
  const item = current();
  const why = { 2: 'invalid video', 5: 'player error', 100: 'video not found', 101: 'embedding disabled', 150: 'embedding disabled' }[e.data] || 'error ' + e.data;
  toast(`Can't play “${item?.title || 'video'}” on YouTube (${why}) — skipping.`, { error: true, ms: 5000 });
  P.loading = false;
  P.playing = false;
  setTimeout(() => next({ auto: true }), 600);
}

// ===========================================================================
// Spotify engine (desktop app via local server)
// ===========================================================================

const sp = {
  pollTimer: null,
  endTimer: null,
  sawMatch: false,
  lastSync: 0,
};

function spotifyStop() {
  clearTimeout(sp.pollTimer);
  clearTimeout(sp.endTimer);
  sp.pollTimer = sp.endTimer = null;
}

async function spotifyControl(action, extra = {}) {
  try {
    return await api('/api/spotify/control', { method: 'POST', body: { action, ...extra } });
  } catch (err) {
    toast(err.message, { error: true });
    return null;
  }
}

const spotifyVolume = () => (P.muted ? 0 : P.volume / 100);

async function spotifyStart(item, token) {
  spotifyStop();
  sp.sawMatch = false;
  P.loading = true;
  setNote('Starting in your Spotify app…');
  renderPlayer();
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await api('/api/spotify/play', { method: 'POST', body: { id: item.id, volume: spotifyVolume() } });
      break;
    } catch (err) {
      if (token !== P.token) return;
      if (err.code === 'NEEDS_RESTART' && attempt === 0 && (await restartSpotify())) continue;
      P.loading = false;
      setNote(err.message);
      toast(err.message, { error: true, ms: 6000 });
      renderPlayer();
      return;
    }
  }
  if (token !== P.token) return;
  P.loading = false;
  setNote('');
  if (res.state) applySpotifyState(res.state, item);
  renderPlayer();
  spotifyPoll(token);
}

function applySpotifyState(s, item) {
  // Exact URI, or the same song under a regional ("relinked") URI.
  const matches = !!s.uri && (s.uri === 'spotify:track:' + item.id || titleMatches(s.title, item.title));
  if (matches) {
    sp.sawMatch = true;
    P.playing = !!s.playing;
    P.position = s.position;
    P.duration = s.duration || item.duration || 0;
    sp.lastSync = performance.now();
    setNote(P.playing ? '' : 'Paused');
  }
  return matches;
}

async function spotifyPoll(token) {
  const item = current();
  if (token !== P.token || P.engine !== 'spotify' || !item) return;
  let delay = 700;
  try {
    const s = await api('/api/spotify/state');
    if (token !== P.token) return;
    if (!s.connected) {
      P.playing = false;
      setNote('Spotify was closed. Press play to reopen it.');
      P.loaded = false; // next play restarts the track (and Spotify)
      renderPlayer();
      return;
    }
    const matches = applySpotifyState(s, item);

    if (!matches && sp.sawMatch && s.uri) {
      // Spotify moved on by itself (track finished, or user hit next in Spotify / media keys).
      spotifyStop();
      return onTrackEnded();
    }
    // Hand over a moment before the song ends so Spotify's autoplay never kicks in.
    const remaining = P.duration - P.position;
    if (matches && P.playing && P.duration > 0) {
      if (remaining < 4000) delay = 250;
      if (remaining < 2500 && !sp.endTimer) {
        sp.endTimer = setTimeout(() => {
          if (token !== P.token) return;
          spotifyStop();
          onTrackEnded();
        }, Math.max(0, remaining - 350));
      }
    } else if (sp.endTimer) {
      clearTimeout(sp.endTimer); // paused near the end
      sp.endTimer = null;
    }
    renderPlayer();
  } catch {
    delay = 2500;
  }
  if (token === P.token && P.engine === 'spotify') sp.pollTimer = setTimeout(() => spotifyPoll(token), delay);
}

// ===========================================================================
// SoundCloud engine (official widget iframe, audio only)
// ===========================================================================

let sc = null;
let scApi = null;
let scBound = false;

function loadSoundCloud() {
  scApi = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://w.soundcloud.com/player/api.js';
    s.onload = () => resolve();
    s.onerror = () => {
      toast('Could not load the SoundCloud player — are you offline?', { error: true, ms: 6000 });
      reject(new Error('SoundCloud player failed to load'));
    };
    document.head.append(s);
  });
}

function widgetUrl(id, autoplay) {
  const u = new URL('https://w.soundcloud.com/player/');
  u.searchParams.set('url', 'https://api.soundcloud.com/tracks/' + id);
  u.searchParams.set('auto_play', autoplay ? 'true' : 'false');
  u.searchParams.set('hide_related', 'true');
  u.searchParams.set('show_comments', 'false');
  u.searchParams.set('visual', 'false');
  u.searchParams.set('single_active', 'false');
  return u.href;
}

function bindSoundCloudEvents() {
  if (scBound) return;
  scBound = true;
  sc.bind(SC.Widget.Events.PLAY, () => {
    if (P.engine !== 'soundcloud') return;
    P.playing = true;
    P.loading = false;
    sc.getDuration((d) => {
      if (P.engine !== 'soundcloud') return;
      P.duration = d || P.duration;
      const item = current();
      if (item && !item.duration && P.duration) item.duration = Math.round(P.duration);
      renderPlayer();
    });
    renderPlayer();
  });
  sc.bind(SC.Widget.Events.PAUSE, () => {
    if (P.engine !== 'soundcloud') return;
    P.playing = false;
    renderPlayer();
  });
  sc.bind(SC.Widget.Events.FINISH, () => {
    if (P.engine !== 'soundcloud') return;
    P.playing = false;
    onTrackEnded();
  });
  sc.bind(SC.Widget.Events.PLAY_PROGRESS, (e) => {
    if (P.engine !== 'soundcloud') return;
    P.position = e.currentPosition || 0;
  });
  if (SC.Widget.Events.ERROR) {
    sc.bind(SC.Widget.Events.ERROR, () => {
      if (P.engine !== 'soundcloud') return;
      const item = current();
      toast(`Can't play “${item?.title || 'track'}” on SoundCloud — skipping.`, { error: true, ms: 5000 });
      P.loading = false;
      P.playing = false;
      setTimeout(() => next({ auto: true }), 600);
    });
  }
}

async function soundCloudStart(item, token, autoplay) {
  try {
    await scApi;
  } catch {
    P.loading = false;
    P.loaded = false;
    renderPlayer();
    return;
  }
  if (token !== P.token) return;
  const url = 'https://api.soundcloud.com/tracks/' + item.id;
  P.loading = autoplay;
  renderPlayer();
  if (!sc) {
    const iframe = $('#scPlayer');
    iframe.src = widgetUrl(item.id, autoplay);
    sc = SC.Widget(iframe);
    bindSoundCloudEvents();
    await new Promise((resolve) => sc.bind(SC.Widget.Events.READY, resolve));
    if (token !== P.token) return;
    sc.setVolume(P.muted ? 0 : P.volume);
  } else {
    sc.load(url, {
      auto_play: autoplay,
      callback() {
        if (token !== P.token) return;
        sc.setVolume(P.muted ? 0 : P.volume);
      },
    });
  }
  if (autoplay) {
    setTimeout(() => {
      if (token !== P.token || P.engine !== 'soundcloud' || !P.loading) return;
      const cur = current();
      toast(`Can't play “${cur?.title || 'track'}” on SoundCloud — skipping.`, { error: true, ms: 5000 });
      P.loading = false;
      next({ auto: true });
    }, 12000);
  }
}

// ===========================================================================
// Unified player
// ===========================================================================

function stopEngine(nextSource) {
  if (P.engine === 'spotify') {
    spotifyStop();
    // Only pause Spotify when switching away from it; Spotify→Spotify just swaps the URI.
    if (nextSource !== 'spotify' && P.playing) spotifyControl('pause');
  } else if (P.engine === 'youtube' && yt && nextSource !== 'youtube') {
    yt.stopVideo?.();
  } else if (P.engine === 'soundcloud' && sc && nextSource !== 'soundcloud') {
    sc.pause();
  }
}

async function playIndex(i, { autoplay = true } = {}) {
  const item = P.queue[i];
  if (!item) return;
  const token = ++P.token;
  stopEngine(item.source);
  P.index = i;
  P.engine = item.source;
  P.loaded = autoplay;
  P.playing = false;
  P.position = 0;
  P.duration = item.duration || 0;
  P.counted = false;
  setNote('');
  persist();
  renderAll();

  if (item.source === 'youtube') {
    await ytReady;
    if (token !== P.token) return;
    P.loading = autoplay;
    if (autoplay) yt.loadVideoById(item.id);
    else yt.cueVideoById(item.id);
    renderPlayer();
  } else if (item.source === 'soundcloud') {
    await soundCloudStart(item, token, autoplay);
    renderPlayer();
  } else if (autoplay) {
    await spotifyStart(item, token);
  }
  topUpAutoplay();
}

function onTrackEnded() {
  if (P.repeat === 'one') return playIndex(P.index);
  next({ auto: true });
}

async function next({ auto = false } = {}) {
  if (!P.queue.length) return;
  if (P.index < P.queue.length - 1) return playIndex(P.index + 1);
  if (P.repeat === 'all') return playIndex(0);
  if (autoplayOn()) {
    const at = P.index;
    await topUpAutoplay();
    if (P.index === at && P.index < P.queue.length - 1) return playIndex(P.index + 1);
  }
  if (!auto) return playIndex(0);
  // End of queue.
  stopEngine(null);
  P.playing = false;
  P.loaded = false;
  renderPlayer();
}

function prev() {
  if (!P.queue.length) return;
  if (P.loaded && P.position > 3000) return seek(0);
  playIndex(Math.max(0, P.index - 1));
}

function togglePlay() {
  const item = current();
  if (!item) {
    if (P.queue.length) playIndex(0);
    return;
  }
  if (!P.loaded) return playIndex(P.index);
  if (P.engine === 'youtube') {
    if (P.playing) yt.pauseVideo();
    else yt.playVideo();
  } else if (P.engine === 'spotify') {
    spotifyControl(P.playing ? 'pause' : 'resume');
    P.playing = !P.playing;
    sp.lastSync = performance.now();
    renderPlayer();
  } else if (P.engine === 'soundcloud' && sc) {
    P.playing ? sc.pause() : sc.play();
  }
}

function seek(ms) {
  if (!P.loaded || !current()) return;
  ms = Math.max(0, Math.min(ms, P.duration || ms));
  P.position = ms;
  sp.lastSync = performance.now();
  if (P.engine === 'youtube') yt.seekTo(ms / 1000, true);
  else if (P.engine === 'soundcloud' && sc) sc.seekTo(ms);
  else if (P.engine === 'spotify') {
    clearTimeout(sp.endTimer);
    sp.endTimer = null;
    spotifyControl('seek', { value: ms });
  }
  renderProgress();
}

let spotifyVolumeTimer = null;
function pushSpotifyVolume() {
  // Only while a Spotify track is active, so moving the slider never launches Spotify.
  if (P.engine !== 'spotify' || !P.loaded) return;
  clearTimeout(spotifyVolumeTimer);
  spotifyVolumeTimer = setTimeout(() => spotifyControl('volume', { value: spotifyVolume() }), 120);
}

function setVolume(v) {
  P.volume = Math.round(Math.max(0, Math.min(100, v)));
  P.muted = P.volume === 0 ? P.muted : false;
  if (yt?.setVolume) {
    yt.setVolume(P.volume);
    if (!P.muted) yt.unMute();
  }
  if (sc?.setVolume) sc.setVolume(P.muted ? 0 : P.volume);
  pushSpotifyVolume();
  persist();
  renderVolume();
}

function toggleMute() {
  P.muted = !P.muted;
  if (yt?.mute) P.muted ? yt.mute() : yt.unMute();
  if (sc?.setVolume) sc.setVolume(P.muted ? 0 : P.volume);
  pushSpotifyVolume();
  persist();
  renderVolume();
}

// ---- queue operations -------------------------------------------------------

function addToQueue(items, { playNext = false } = {}) {
  const entries = items.map((i) => toEntry(i));
  // Your songs go ahead of autoplay's, like in Spotify.
  const firstAuto = P.queue.findIndex((e, i) => i > P.index && e.auto);
  const at = playNext && P.index >= 0 ? P.index + 1 : firstAuto >= 0 ? firstAuto : P.queue.length;
  P.queue.splice(at, 0, ...entries);
  if (P.unshuffled) P.unshuffled.push(...entries);
  if (P.index < 0) P.index = 0;
  persist();
  renderAll();
  return at;
}

function playNow(items) {
  dropUpcomingAutoplay(); // they were picked for what was playing before; refill from the new song
  const at = addToQueue(items, { playNext: true });
  playIndex(P.index < 0 ? 0 : at);
}

/** Replace the queue with a list (e.g. a playlist) and start at `start`. */
function playList(items, start = 0, { shuffle = false } = {}) {
  if (!items.length) return;
  let entries = items.map((i) => toEntry(i));
  P.unshuffled = null;
  radio.gen++;
  if (shuffle) {
    P.shuffle = true;
    P.unshuffled = entries.slice();
    entries = shuffled(entries);
    start = 0;
  } else if (P.shuffle) {
    P.unshuffled = entries.slice();
    const first = entries.splice(start, 1);
    entries = [...first, ...shuffled(entries)];
    start = 0;
  }
  P.queue = entries;
  playIndex(start);
}

function removeFromQueue(i) {
  const [removed] = P.queue.splice(i, 1);
  if (P.unshuffled) P.unshuffled = P.unshuffled.filter((e) => e.qid !== removed.qid);
  if (i < P.index) P.index--;
  else if (i === P.index) {
    if (P.queue.length) {
      const wasPlaying = P.playing;
      P.index = Math.min(P.index, P.queue.length - 1);
      if (wasPlaying) playIndex(P.index);
      else {
        stopEngine(null);
        P.loaded = false;
        P.engine = null;
      }
    } else {
      stopEngine(null);
      Object.assign(P, { index: -1, engine: null, loaded: false, playing: false, position: 0, duration: 0 });
    }
  }
  persist();
  renderAll();
}

function moveInQueue(from, to) {
  if (from === to) return;
  const cur = current();
  const [e] = P.queue.splice(from, 1);
  delete e.auto; // placed by you now
  P.queue.splice(to, 0, e);
  P.index = P.queue.indexOf(cur);
  persist();
  renderAll();
}

function clearQueue() {
  const cur = current();
  P.queue = cur ? [cur] : [];
  P.index = cur ? 0 : -1;
  P.unshuffled = P.shuffle ? P.queue.slice() : null;
  radio.gen++;
  persist();
  renderAll();
  topUpAutoplay();
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toggleShuffle() {
  P.shuffle = !P.shuffle;
  const cur = current();
  if (P.shuffle) {
    P.unshuffled = P.queue.slice();
    const before = P.queue.slice(0, P.index + 1);
    P.queue = [...before, ...shuffled(P.queue.slice(P.index + 1))];
  } else if (P.unshuffled) {
    const live = new Set(P.queue.map((e) => e.qid));
    const restored = P.unshuffled.filter((e) => live.has(e.qid));
    const seen = new Set(restored.map((e) => e.qid));
    P.queue = [...restored, ...P.queue.filter((e) => !seen.has(e.qid))];
    P.unshuffled = null;
  }
  P.index = cur ? P.queue.indexOf(cur) : -1;
  persist();
  renderAll();
}

function cycleRepeat() {
  P.repeat = { off: 'all', all: 'one', one: 'off' }[P.repeat];
  persist();
  renderPlayer();
  topUpAutoplay();
}

// ---- autoplay -----------------------------------------------------------------
// When the queue runs low, add recommendations (Spotify radio / YouTube Mix / SoundCloud related) seeded from
// the newest track in the queue, so the music keeps drifting on like Spotify's autoplay.

const AUTOPLAY_AHEAD = 3; // refill when fewer than this many tracks are left
const AUTOPLAY_BATCH = 10;
// failed: seeds that gave nothing, so we don't retry them in a loop.
// gen: bumps whenever upcoming picks are thrown away, so an in-flight fetch doesn't add stale ones.
const radio = { busy: null, failed: new Set(), gen: 0 };

const autoplayOn = () => P.autoplay !== 'off' && P.repeat !== 'all';

/** First credited artist. */
function primaryArtist(item) {
  return String(item.artist || '').split(/,|&|\s(?:feat|ft|x)\.?\s/i)[0];
}

/** Loose "same song by the same artist" key, so a song isn't recommended again (or once per service). */
function songKey(item) {
  const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');
  let t = String(item.title || '');
  if (item.source === 'youtube' || item.source === 'soundcloud') {
    const parts = t.split(/\s+[-–|]\s+/); // "Artist - Title (Official Video)"
    if (parts.length > 1) t = parts[1];
  } else {
    t = t.replace(/\s+[-–]\s+.*$/, ''); // "Title - Remastered 2011"
  }
  t = norm(t.replace(/\s*[([].*?[)\]]/g, '').replace(/\s(feat|ft)\.?\s.*$/i, ''));
  // First credited artist; YouTube channels look like "DaftPunkVEVO" / "Daft Punk - Topic".
  const artist = norm(primaryArtist(item)).replace(/(vevo|official|topic)$/, '');
  return t && t + '|' + artist;
}

function topUpAutoplay() {
  if (!autoplayOn() || P.index < 0 || P.queue.length - 1 - P.index >= AUTOPLAY_AHEAD) return Promise.resolve();
  const gen = radio.gen;
  radio.busy ??= fetchRecommendations().finally(() => {
    radio.busy = null;
    renderAll();
    if (gen !== radio.gen) topUpAutoplay();
  });
  renderAll();
  return radio.busy;
}

async function fetchRecommendations() {
  const gen = radio.gen;
  const seeds = [P.queue[P.queue.length - 1], current()].filter((s, i, a) => s && a.indexOf(s) === i && !radio.failed.has(s.source + s.id));
  for (const seed of seeds) {
    let items;
    try {
      const q = new URLSearchParams({ source: seed.source, id: seed.id, title: seed.title, artist: seed.artist, mix: P.autoplay });
      ({ items } = await api('/api/radio?' + q));
    } catch (err) {
      radio.failed.add(seed.source + seed.id);
      toast('Autoplay: ' + err.message, { error: true });
      continue;
    }
    if (gen !== radio.gen) return;
    const seen = new Set(P.queue.map((e) => e.source + e.id));
    const keys = new Set(P.queue.map(songKey));
    const fresh = [];
    for (const item of items) {
      const key = songKey(item);
      if (seen.has(item.source + item.id) || (key && keys.has(key))) continue;
      seen.add(item.source + item.id);
      keys.add(key);
      fresh.push(toEntry(item, true));
      if (fresh.length >= AUTOPLAY_BATCH) break;
    }
    if (!fresh.length) {
      radio.failed.add(seed.source + seed.id);
      continue;
    }
    P.queue.push(...fresh);
    if (P.unshuffled) P.unshuffled.push(...fresh);
    persist();
    return;
  }
}

function setAutoplay(mode) {
  P.autoplay = mode;
  radio.failed.clear();
  dropUpcomingAutoplay(); // re-pick with the new mode (or stop)
  persist();
  renderAll();
  topUpAutoplay();
}

function dropUpcomingAutoplay() {
  radio.gen++;
  const keep = (e, i) => i <= P.index || !e.auto;
  const before = P.queue.length;
  const live = P.queue.filter(keep);
  if (live.length === before) return;
  const gone = new Set(P.queue.filter((e, i) => !keep(e, i)).map((e) => e.qid));
  P.queue = live;
  if (P.unshuffled) P.unshuffled = P.unshuffled.filter((e) => !gone.has(e.qid));
}

// ===========================================================================
// Playlists
// ===========================================================================

async function loadPlaylists() {
  try {
    state.playlists = await api('/api/playlists');
  } catch (err) {
    toast('Could not load playlists: ' + err.message, { error: true });
  }
  renderSidebar();
  paintHome();
}

async function savePlaylist(pl) {
  const savedPl = await api('/api/playlists', { method: 'POST', body: pl });
  const i = state.playlists.findIndex((p) => p.id === savedPl.id);
  if (i >= 0) state.playlists[i] = savedPl;
  else state.playlists.push(savedPl);
  renderSidebar();
  if (state.view.name === 'playlist' && state.view.id === savedPl.id) renderMain();
  paintHome();
  return savedPl;
}

async function createPlaylist(items = [], suggested = '') {
  const name = await ask('New playlist', suggested || `My mix #${state.playlists.length + 1}`);
  if (!name) return null;
  const pl = await savePlaylist({ name, items: items.map(stripEntry) });
  toast(`Created “${pl.name}”`);
  return pl;
}

async function addToPlaylist(pl, items) {
  await savePlaylist({ ...pl, items: [...pl.items, ...items.map(stripEntry)] });
  toast(`Added ${items.length === 1 ? '“' + items[0].title + '”' : items.length + ' tracks'} to ${pl.name}`);
}

function stripEntry({ qid, auto, ...rest }) {
  return rest;
}

// ===========================================================================
// Rendering — player bar & now playing
// ===========================================================================

function setNote(text) {
  $('#npNote').innerHTML = text ? icon('info', 16) + `<span>${esc(text)}</span>` : '';
}

function renderPlayer() {
  const item = current();
  const src = item?.source || '';
  $('.player').className = 'player ' + src;
  $('#plTitle').textContent = item?.title || '';
  $('#plArtist').textContent = item?.artist || '';
  const art = $('#plArt');
  if (item?.art) art.src = item.art;
  else art.removeAttribute('src');
  $('#sourceChip').innerHTML = item ? sourceBadge(item.source) : '';

  const playBtn = $('#btnPlay');
  setIcon(playBtn, P.playing ? 'pause' : 'play');
  playBtn.classList.toggle('loading', P.loading);
  $('#btnShuffle').classList.toggle('on', P.shuffle);
  $('#btnRepeat').classList.toggle('on', P.repeat !== 'off');
  setIcon($('#btnRepeat'), P.repeat === 'one' ? 'repeatOne' : 'repeat');
  $('#btnRepeat').title = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: one' }[P.repeat];
  $('#btnPrev').disabled = $('#btnNext').disabled = !P.queue.length;

  // Now-playing panel
  const np = $('#nowPlaying');
  np.className = 'nowplaying ' + (P.engine === 'youtube' ? 'youtube' : item ? 'art' : '');
  const npArt = $('#npArt');
  if (!item?.art) npArt.removeAttribute('src');
  else if (npArt.getAttribute('src') !== item.art) npArt.src = item.art;
  $('#npTitle').textContent = item?.title || '';
  $('#npArtist').textContent = item?.artist || '';
  const upcoming = P.queue.slice(P.index + 1, P.index + 4);
  $('#npNext').innerHTML = upcoming.length
    ? `<div class="list-label">${upcoming[0].auto ? 'Next up · Autoplay' : 'Next up'}</div><ul class="tracks">${upcoming.map((e, k) => trackRow(e, { ctx: 'queue', index: P.index + 1 + k, compact: true, actions: false, badge: false })).join('')}</ul>`
    : radio.busy
      ? '<div class="list-label">Finding recommendations…</div>'
      : '';

  if (item && 'mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.title,
      artist: item.artist,
      artwork: item.art ? [{ src: item.art, sizes: '512x512' }] : [],
    });
  }
  document.title = item && P.playing ? `${item.title} · ${item.artist} — Maestro` : 'Maestro';
  renderProgress();
  renderVolume();
}

function livePosition() {
  if (P.engine === 'youtube' && yt?.getCurrentTime && P.loaded) return yt.getCurrentTime() * 1000;
  if (P.engine === 'spotify' && P.playing) return P.position + (performance.now() - sp.lastSync);
  return P.position;
}

let dragging = null;
function renderProgress() {
  const pos = dragging?.el === $('#progress') ? dragging.value * P.duration : Math.min(livePosition(), P.duration || Infinity);
  if (P.engine === 'youtube' && yt?.getDuration) P.duration = yt.getDuration() * 1000 || P.duration;
  const pct = P.duration ? Math.min(100, (pos / P.duration) * 100) : 0;
  $('#progressFill').style.width = pct + '%';
  $('#timeCur').textContent = fmt(pos);
  $('#timeDur').textContent = fmt(P.duration);
}

function renderVolume() {
  $('#volumeFill').style.width = (P.muted ? 0 : P.volume) + '%';
  setIcon($('#btnMute'), P.muted || P.volume === 0 ? 'mute' : 'volume');
}

// ===========================================================================
// Rendering — sidebar
// ===========================================================================

function renderSidebar() {
  for (const b of $$('.nav-item[data-view]')) b.classList.toggle('active', state.view.name === b.dataset.view);
  $('#queueCount').textContent = P.queue.length || '';
  const nav = $('#playlistNav');
  nav.innerHTML = state.playlists.length
    ? state.playlists
        .map(
          (p) => `<li><button data-pl="${esc(p.id)}" class="${state.view.name === 'playlist' && state.view.id === p.id ? 'active' : ''}">
            <span class="name">${esc(p.name)}</span><span class="n">${p.items.length}</span></button></li>`,
        )
        .join('')
    : '<li class="empty">No playlists yet</li>';
  renderStatus();
}

function spotifyStatusText() {
  const s = state.status?.spotify;
  if (!s) return ['', 'Spotify: checking…'];
  if (!s.supported) return ['warn', 'Spotify control needs Windows'];
  if (s.connected) return ['ok', 'Spotify connected'];
  if (s.needsLogin) return ['warn clickable', 'Log in to Spotify'];
  if (s.needsRestart) return ['warn clickable', 'Spotify needs a restart — fix'];
  if (s.exe) return ['', 'Spotify opens when needed'];
  return ['warn', 'Spotify app not found'];
}

function renderStatus() {
  const [cls, text] = spotifyStatusText();
  for (const el of [$('#spotifyStatus'), $('#settingsSpotifyStatus')]) {
    el.className = 'status ' + cls;
    el.textContent = text;
  }
  const auto = state.status?.spotify?.autostart;
  const box = $('#autostartToggle');
  box.checked = !!auto?.enabled;
  box.disabled = !auto?.exists;
  box.closest('label').title = auto?.exists ? '' : "Turn on “Open Spotify automatically” in Spotify's settings first.";
}

/** Close and reopen Spotify with Maestro support. Asks first. */
async function restartSpotify() {
  const ok = await confirmDialog(
    'Restart Spotify?',
    'Spotify is open without Maestro support. Maestro will close it and reopen it minimized so it can connect. Anything playing in Spotify will stop.',
    'Restart Spotify',
  );
  if (!ok) return false;
  toast('Restarting Spotify…');
  try {
    state.status = { ...state.status, spotify: await api('/api/spotify/restart', { method: 'POST' }) };
    renderStatus();
    toast('Spotify connected');
    return true;
  } catch (err) {
    toast(err.message, { error: true, ms: 6000 });
    refreshStatus();
    return false;
  }
}

async function refreshStatus() {
  try {
    state.status = await api('/api/status');
  } catch {
    state.status = null;
  }
  renderStatus();
  if (state.status?.spotify?.connected && !spotifyHomeDone) loadSpotifyHome();
}

// ===========================================================================
// Rendering — track rows
// ===========================================================================

/**
 * ctx: 'results' | 'queue' | 'playlist' — decides what clicking does.
 * index: position in the list being rendered.
 */
function trackRow(item, { ctx, index, compact = false, actions = true, numbered = false, badge = true }) {
  const cur = current();
  const isCurrent = ctx === 'queue' ? index === P.index : cur && cur.source === item.source && cur.id === item.id;
  const remove = ctx === 'queue' || ctx === 'playlist';
  return `<li class="track ${item.source}${isCurrent ? ' current' : ''}${compact || !numbered ? ' compact' : ''}"
      data-ctx="${ctx}" data-index="${index}" draggable="true" tabindex="-1">
    ${numbered && !compact ? `<span class="num">${index + 1}</span>` : ''}
    <img class="art" src="${esc(item.art)}" alt="" loading="lazy" />
    <div class="meta"><div class="t-title" title="${esc(item.title)}">${esc(item.title)}</div><div class="t-artist">${esc(item.artist)}</div></div>
    ${badge ? sourceBadge(item.source) : '<span></span>'}
    <span class="dur">${item.duration ? fmt(item.duration) : ''}</span>
    <div class="row-actions">${
      actions
        ? `<button class="icon-btn small" data-act="play" title="Play">${icon('play', 16)}</button>
           ${ctx !== 'queue' ? `<button class="icon-btn small" data-act="queue" title="Add to queue">${icon('addQueue', 16)}</button>` : ''}
           ${remove ? `<button class="icon-btn small" data-act="remove" title="Remove">${icon('close', 16)}</button>` : ''}
           <button class="icon-btn small" data-act="more" title="More">${icon('more', 16)}</button>`
        : ''
    }</div>
  </li>`;
}

/** Resolve a rendered row back to its item (and the list it lives in). */
function rowContext(row) {
  const ctx = row.dataset.ctx;
  const index = +row.dataset.index;
  let list = [];
  if (ctx === 'queue') list = P.queue;
  else if (ctx === 'playlist') list = state.playlists.find((p) => p.id === state.view.id)?.items || [];
  else if (ctx === 'results') list = resultList(row.dataset.list || row.closest('[data-list]')?.dataset.list);
  return { ctx, index, list, item: list[index] };
}

function resultList(name) {
  if (name === 'resolved') return state.search.resolved?.items || [];
  if (name === 'collection') return state.collection?.items || [];
  if (name?.startsWith('home:')) return homeSongs(name.slice(5));
  return state.search.results[name] || [];
}

function onRowActivate(row, act) {
  const { ctx, index, list, item } = rowContext(row);
  if (!item) return;
  if (act === 'play') {
    if (ctx === 'queue') playIndex(index);
    else if (ctx === 'playlist' || list === state.collection?.items) playList(list, index);
    else playNow([item]);
  } else if (act === 'queue') {
    addToQueue([item]);
    toast(`Added “${item.title}” to queue`);
  } else if (act === 'remove') {
    if (ctx === 'queue') removeFromQueue(index);
    else if (ctx === 'playlist') {
      const pl = state.playlists.find((p) => p.id === state.view.id);
      savePlaylist({ ...pl, items: pl.items.filter((_, i) => i !== index) });
    }
  } else if (act === 'more') {
    const btn = row.querySelector('[data-act="more"]');
    openTrackMenu(btn.getBoundingClientRect(), { ctx, index, item });
  }
}

// ===========================================================================
// Context menu
// ===========================================================================

function openMenu(rect, entries) {
  const menu = $('#menu');
  menu.innerHTML = entries
    .map((e, i) => (e === '-' ? '<hr>' : e.label && !e.run ? `<div class="label">${esc(e.label)}</div>` : `<button data-i="${i}">${esc(e.text)}</button>`))
    .join('');
  menu.hidden = false;
  const { innerWidth: W, innerHeight: H } = window;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = Math.min(rect.left, W - mw - 8) + 'px';
  menu.style.top = (rect.bottom + mh + 8 > H ? Math.max(8, rect.top - mh - 4) : rect.bottom + 4) + 'px';
  menu.onclick = (ev) => {
    const b = ev.target.closest('button[data-i]');
    if (!b) return;
    closeMenu();
    entries[+b.dataset.i].run();
  };
}
function closeMenu() {
  $('#menu').hidden = true;
}

function openTrackMenu(rect, { ctx, index, item }) {
  const entries = [
    { text: 'Play next', run: () => (addToQueue([item], { playNext: true }), toast('Playing next')) },
    { text: 'Add to queue', run: () => (addToQueue([item]), toast('Added to queue')) },
    '-',
    { label: 'Add to playlist' },
    ...state.playlists
      .filter((p) => !(ctx === 'playlist' && p.id === state.view.id))
      .map((p) => ({ text: p.name, run: () => addToPlaylist(p, [item]) })),
    { text: '+ New playlist…', run: () => createPlaylist([item], item.title) },
    '-',
    {
      text: { spotify: 'Open in Spotify', youtube: 'Open on YouTube', soundcloud: 'Open on SoundCloud' }[item.source] || 'Open',
      run: () => window.open(itemLink(item), '_blank'),
    },
    { text: 'Copy link', run: () => navigator.clipboard.writeText(itemLink(item)).then(() => toast('Link copied')) },
  ];
  if (ctx === 'queue') entries.splice(0, 2, { text: 'Remove from queue', run: () => removeFromQueue(index) });
  openMenu(rect, entries);
}

// ===========================================================================
// Rendering — main views
// ===========================================================================

const TRACK_EL = '.track, .song-card';

function go(view) {
  state.view = view;
  renderSidebar();
  renderMain();
  $('#main').scrollTop = 0;
  if (view.name === 'home') loadHome();
}

function renderMain() {
  const v = state.view;
  if (v.name === 'home') renderHomeView();
  else if (v.name === 'queue') renderQueueView();
  else if (v.name === 'playlist') renderPlaylistView();
  else if (v.name === 'collection') renderCollectionView();
  else renderSearchView();
}

function renderAll() {
  renderSidebar();
  renderPlayer();
  // Avoid wiping the search box while typing, or the home page's scroll positions.
  if (!['search', 'home', 'collection'].includes(state.view.name)) renderMain();
  else for (const row of $$(`#main :is(${TRACK_EL})`)) row.classList.toggle('current', isRowCurrent(row));
}

function isRowCurrent(row) {
  const { item } = rowContext(row);
  const cur = current();
  return !!(item && cur && cur.source === item.source && cur.id === item.id);
}

// ---- home -------------------------------------------------------------------

const HOME_TTL = 6 * 3600 * 1000;
const LISTEN_MS = 15000; // a play counts once you've heard this much, so skipped and unplayable tracks don't
const LISTENS_MAX = 200;
const HOME_SEEDS = 5;

// Newest first; one entry per song with a play count.
const listens = JSON.parse(localStorage.getItem('maestro.listens') || '[]');

function countListen() {
  const item = current();
  if (P.counted || !item || !P.playing || livePosition() < LISTEN_MS) return;
  P.counted = true;
  const i = listens.findIndex((e) => e.source === item.source && e.id === item.id);
  const plays = i >= 0 ? listens.splice(i, 1)[0].plays : 0;
  listens.unshift({ ...stripEntry(item), plays: plays + 1 });
  listens.length = Math.min(listens.length, LISTENS_MAX);
  localStorage.setItem('maestro.listens', JSON.stringify(listens));
}

/** The name to show for a song's artist; YouTube channels look like "DaftPunkVEVO" / "Daft Punk - Topic" / "Daft Punk Official". */
function artistName(item) {
  return primaryArtist(item).replace(/\s+-\s+Topic$|VEVO$|\s+Official$/i, '').trim();
}

/** One song each from the artists you like most: songs you've played, then your playlists and queue (worth less). */
function homeSeeds() {
  const pool = [
    ...listens.slice(0, 50).map((e) => [e, e.plays * 3]),
    ...[...P.queue.filter((e) => !e.auto), ...state.playlists.flatMap((p) => p.items)].map((e) => [e, 1]),
  ];
  const artists = [];
  for (const [e, score] of pool) {
    const name = artistName(e);
    if (!name) continue;
    const key = name.toLowerCase();
    // The same artist can be "Den" on Spotify and "Den Vau" on YouTube.
    const a = artists.find((x) => x.key === key || x.key.startsWith(key + ' ') || key.startsWith(x.key + ' '));
    if (!a) artists.push({ name, key, songs: [e], score });
    else {
      a.score += score;
      a.songs.push(e);
      if (key.length < a.key.length) Object.assign(a, { name, key });
    }
  }
  // Your two favourites always count; the rest rotate, and so does the song, so New picks gives something new.
  const ranked = artists.sort((a, b) => b.score - a.score);
  return [...ranked.slice(0, 2), ...shuffled(ranked.slice(2, 12)).slice(0, HOME_SEEDS - 2)].map((a) => ({
    name: a.name,
    seed: a.songs[Math.floor(Math.random() * a.songs.length)],
  }));
}

/** Nothing to go on yet: no listening, playlists, or Spotify feed. Only then do the global lists appear. */
const homeIsCold = () => !state.home.spotify?.length && !homeSeeds().length;
const spotifyRows = () => (state.home.spotify || []).filter((r) => !r.quick);

function homeSongs(shelf) {
  if (shelf === 'recent') return listens.slice(0, 20);
  return state.home[shelf] || [];
}

/** Playlist cards for a shelf: your playlists and mixes carry their items; the rest load `url` when opened. */
function homeCards(shelf) {
  const h = state.home;
  const noSpotify = state.status?.spotify && !state.status.spotify.exe;
  if (shelf === 'own') {
    return state.playlists.map((p) => ({ own: p.id, title: p.name, subtitle: `${p.items.length} track${p.items.length === 1 ? '' : 's'}`, items: p.items }));
  }
  if (shelf.startsWith('feed:')) return spotifyRows()[+shelf.slice(5)]?.cards || [];
  if (shelf === 'featured') return noSpotify || !homeIsCold() ? [] : h.featured || [];
  if (shelf === 'mixes') return h.mixes || [];
  if (shelf === 'ytLists' || shelf === 'scLists') return h[shelf] || [];
  // The six tiles at the top: a few of Spotify's shortcuts and your mixes, then whatever is there to fill them.
  const shortcuts = (h.spotify || []).find((r) => r.quick)?.cards || [];
  return [...shortcuts.slice(0, 3), ...homeCards('mixes').slice(0, 3), ...homeCards('own').filter((c) => c.items.length), ...shortcuts.slice(3), ...homeCards('featured')].slice(0, 6);
}

function paintHome() {
  if (state.view.name === 'home') renderHomeView();
}

let homeLoading = false;
let homeTried = false; // has a load finished this session?
let spotifyHomeBusy = false;
let spotifyHomeDone = false; // Spotify may still be starting when Maestro opens, so this retries once it connects
const saveHome = () => localStorage.setItem('maestro.home', JSON.stringify(state.home));
const resolved = new Map(); // url -> pending or finished /api/resolve, so a card only loads once

async function loadHome({ force = false } = {}) {
  const h = state.home;
  const seeds = homeSeeds();
  const stale = Date.now() - h.at > HOME_TTL;
  if (homeLoading || !(force || stale || (seeds.length && !(h.mixes?.length && h.ytPicks)))) return;
  homeLoading = true;
  resolved.clear();
  paintHome();

  const fill = async (key, path) => {
    try {
      h[key] = (await api(path)).items;
    } catch {
      h[key] ??= [];
    }
    paintHome();
  };
  await Promise.all([
    ...(seeds.length ? [] : [fill('chart', '/api/home/chart'), fill('featured', '/api/home/featured')]),
    loadPlaylistPicks(seeds),
    loadMixes(seeds),
    loadSpotifyHome(),
  ]);
  homeLoading = false;
  homeTried = true;
  if (h.chart?.length || h.featured?.length || h.ytLists?.length || h.scLists?.length || h.mixes?.length || h.spotify?.length) h.at = Date.now();
  saveHome();
  paintHome();
}

async function loadSpotifyHome() {
  if (spotifyHomeBusy) return;
  spotifyHomeBusy = true;
  const h = state.home;
  try {
    const r = await api('/api/home/spotify');
    if (r.connected) {
      h.spotify = r.items;
      spotifyHomeDone = true;
    } else h.spotify ??= [];
  } catch {
    h.spotify ??= [];
    spotifyHomeDone = true;
  }
  spotifyHomeBusy = false;
  saveHome();
  paintHome();
}

// Artists are spelled differently per service ("Den Vau Official" / "denvau"), so recommendations compare titles only.
const titleKey = (t) => songKey(t).split('|')[0];

/** Take turns between lists, keeping what `keep` accepts. */
function roundRobin(lists, keep = () => true) {
  const all = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const l of lists) if (i < l.length && keep(l[i])) all.push(l[i]);
  return all;
}

/** YouTube and SoundCloud playlists for each artist you like. */
async function loadPlaylistPicks(seeds) {
  const h = state.home;
  const found = await Promise.all(seeds.map((s) => api('/api/home/playlists?q=' + encodeURIComponent(s.name)).then((r) => r.items, () => [])));
  const seen = new Set();
  const all = roundRobin(found, (c) => !seen.has(c.url) && seen.add(c.url));
  if (all.length || !seeds.length) {
    h.ytLists = all.filter((c) => c.source === 'youtube').slice(0, 24);
    h.scLists = all.filter((c) => c.source === 'soundcloud').slice(0, 24);
  }
  h.ytLists ??= [];
  h.scLists ??= [];
  paintHome();
}

async function loadMixes(seeds) {
  const h = state.home;
  const picks = await Promise.all(
    seeds.map(async ({ name, seed }) => {
      try {
        const q = new URLSearchParams({ source: seed.source, id: seed.id, title: seed.title, artist: seed.artist });
        return { name, seed, ...(await api('/api/home/radio?' + q)).lists };
      } catch {
        return null;
      }
    }),
  ).then((all) => all.filter(Boolean));

  const mixes = picks
    .map(({ name, seed, spotify, youtube, soundcloud }) => {
      const seen = new Set();
      const items = roundRobin([spotify, youtube, soundcloud], (t) => {
        const key = titleKey(t) || t.source + t.id;
        return !seen.has(key) && seen.add(key);
      });
      return { title: `${name} Mix`, subtitle: `Based on ${seed.title}`, items: items.slice(0, 50) };
    })
    .filter((m) => m.items.length);
  if (mixes.length || !seeds.length) h.mixes = mixes;
  else h.mixes ??= [];

  // Songs you haven't played yet. A song found on two services only shows up once.
  const taken = new Set(listens.map(titleKey));
  const fresh = (t) => {
    const key = titleKey(t);
    if (key && taken.has(key)) return false;
    if (key) taken.add(key);
    return true;
  };
  const pool = { spotify: [], youtube: [], soundcloud: [] };
  for (const t of roundRobin(picks.flatMap((p) => [p.spotify, p.youtube, p.soundcloud]), fresh)) pool[t.source].push(t);

  const TOP = 8; // from each service, in the first row; the rest fill the per-service rows
  if (picks.length || !seeds.length) {
    h.recommended = roundRobin([pool.spotify, pool.youtube, pool.soundcloud].map((l) => l.slice(0, TOP)));
    h.ytPicks = pool.youtube.slice(TOP, TOP + 24);
    h.scPicks = pool.soundcloud.slice(TOP, TOP + 24);
  }
  h.recommended ??= [];
  h.ytPicks ??= [];
  h.scPicks ??= [];
  paintHome();
}

function coverHtml(items) {
  const arts = [...new Set(items.map((i) => i.art).filter(Boolean))];
  if (!arts.length) return `<div class="cover empty">${icon('queue', 36)}</div>`;
  const shown = arts.length >= 4 ? arts.slice(0, 4) : arts.slice(0, 1);
  return `<div class="cover${shown.length > 1 ? ' collage' : ''}">${shown.map((a) => `<img src="${esc(a)}" alt="" loading="lazy" draggable="false" />`).join('')}</div>`;
}

const cardItems = (c) => c.items || [{ art: c.art }];
const cardPlay = (c) => (c.items && !c.items.length ? '' : `<button class="card-play" data-card-play title="Play">${icon('play', 18)}<span class="spin"></span></button>`);

function songCard(item, shelf, index) {
  const cur = current();
  const on = cur && cur.source === item.source && cur.id === item.id;
  return `<div class="card song-card ${item.source}${on ? ' current' : ''}" data-ctx="results" data-list="home:${shelf}" data-index="${index}" draggable="true" title="${esc(item.title)}">
    <div class="cover-wrap">${coverHtml([item])}${cardPlay(item)}</div>
    <div class="card-title">${esc(item.title)}</div>
    <div class="card-sub"><span class="src ${item.source}">${icon(item.source, 12)}</span><span>${esc(item.artist)}</span></div>
  </div>`;
}

function playlistCard(c, shelf, index) {
  return `<div class="card" data-card="${shelf}" data-index="${index}" title="${esc(c.title)}">
    <div class="cover-wrap">${coverHtml(cardItems(c))}${cardPlay(c)}</div>
    <div class="card-title">${esc(c.title)}</div>
    <div class="card-sub">${c.source ? `<span class="src ${c.source}">${icon(c.source, 12)}</span>` : ''}<span>${esc(c.subtitle)}</span></div>
  </div>`;
}

const SKELETON = '<div class="card skeleton"><div class="cover"></div><div class="card-title">&nbsp;</div><div class="card-sub">&nbsp;</div></div>'.repeat(8);

/** One titled, sideways-scrolling row. Hidden when empty, and a placeholder while its first load runs. */
function shelf(title, name, cards, { pending = false } = {}) {
  if (!cards.length && !pending) return '';
  return `<section class="shelf">
    <div class="shelf-head">
      <h2>${esc(title)}</h2>
      <div class="shelf-nav">
        <button class="icon-btn small" data-shelf-scroll="-1" title="Back">${icon('chevronLeft', 16)}</button>
        <button class="icon-btn small" data-shelf-scroll="1" title="More">${icon('chevronRight', 16)}</button>
      </div>
    </div>
    <div class="shelf-row" data-shelf="${name}">${cards.length ? cards.join('') : SKELETON}</div>
  </section>`;
}

function syncShelfArrows(row) {
  const [back, more] = $$('[data-shelf-scroll]', row.closest('.shelf'));
  const room = row.scrollWidth - row.clientWidth;
  back.disabled = row.scrollLeft <= 1;
  more.disabled = row.scrollLeft >= room - 1;
  row.closest('.shelf').classList.toggle('fits', room <= 1);
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function renderHomeView() {
  const h = state.home;
  const main = $('#main');
  const scrolled = new Map($$('.shelf-row', main).map((r) => [r.dataset.shelf, r.scrollLeft]));
  const songs = (name) => homeSongs(name).map((it, i) => songCard(it, name, i));
  const cards = (name) => homeCards(name).map((c, i) => playlistCard(c, name, i));
  const first = (key) => homeLoading && h[key] === null;
  const cold = homeIsCold();
  const hasSeeds = homeSeeds().length > 0;
  const shelves = [
    shelf('Recommended songs', 'recommended', songs('recommended'), { pending: first('recommended') && hasSeeds }),
    shelf('Mixes for you', 'mixes', cards('mixes'), { pending: first('mixes') && hasSeeds }),
    shelf('YouTube picks for you', 'ytPicks', songs('ytPicks'), { pending: first('ytPicks') && hasSeeds }),
    shelf('SoundCloud picks for you', 'scPicks', songs('scPicks'), { pending: first('scPicks') && hasSeeds }),
    shelf('YouTube playlists for you', 'ytLists', cards('ytLists'), { pending: first('ytLists') && hasSeeds }),
    shelf('SoundCloud playlists for you', 'scLists', cards('scLists'), { pending: first('scLists') && hasSeeds }),
    shelf('From your Spotify', 'feed', [], { pending: first('spotify') && !!state.status?.spotify?.connected }),
    ...spotifyRows().map((r, i) => shelf(r.title, 'feed:' + i, cards('feed:' + i))),
    shelf('Recently played', 'recent', songs('recent')),
    shelf('Your playlists', 'own', cards('own')),
    cold ? shelf('Trending songs', 'chart', songs('chart'), { pending: first('chart') }) : '',
    cold ? shelf('Popular playlists', 'featured', cards('featured'), { pending: first('featured') }) : '',
  ].join('');
  const quick = homeCards('quick');
  const nothing = homeTried && !homeLoading && !quick.length && !shelves;

  main.innerHTML = `
    <div class="home">
      <div class="home-head">
        <h1>${greeting()}</h1>
        <button class="btn ghost" id="homeRefresh" ${homeLoading ? 'disabled' : ''}>${icon('refresh', 16)} New picks</button>
      </div>
      <div class="quick-grid">${quick
        .map(
          (c, i) => `<div class="quick" data-card="quick" data-index="${i}" title="${esc(c.title)}">
            ${coverHtml(cardItems(c))}<span class="quick-title">${esc(c.title)}</span>${cardPlay(c)}
          </div>`,
        )
        .join('')}</div>
      ${shelves}
      ${nothing ? `<div class="placeholder"><h2>Couldn't load recommendations</h2><div>Check your connection, then choose New picks to try again.</div></div>` : ''}
    </div>`;
  for (const row of $$('.shelf-row', main)) {
    row.scrollLeft = scrolled.get(row.dataset.shelf) || 0;
    syncShelfArrows(row);
  }
}

let cardSeq = 0;

/** Open a playlist card, or start playing it if `play`. */
async function activateCard(el, play) {
  const card = homeCards(el.dataset.card)[+el.dataset.index];
  if (!card) return;
  if (card.own && !play) return go({ name: 'playlist', id: card.own });
  const seq = ++cardSeq;
  let r = { title: card.title, items: card.items };
  if (!card.items) {
    el.classList.add('busy');
    try {
      if (!resolved.has(card.url)) {
        const url = card.url;
        resolved.set(url, api('/api/resolve', { method: 'POST', body: { url } }).catch((err) => (resolved.delete(url), Promise.reject(err))));
      }
      r = await resolved.get(card.url);
    } catch (err) {
      el.classList.remove('busy');
      if (seq === cardSeq) toast(err.message, { error: true, ms: 5000 });
      return;
    }
    el.classList.remove('busy');
    if (seq !== cardSeq) return;
  }
  if (!r.items.length) return toast('No playable tracks found in that playlist.', { error: true });
  if (play) return playList(r.items, 0);
  state.collection = { ...r, title: card.title };
  go({ name: 'collection' });
}

function renderCollectionView() {
  const c = state.collection;
  if (!c) return go({ name: 'home' });
  $('#main').innerHTML = `
    <div class="view-head">
      <h1>${esc(c.title)}</h1>
      <div class="sub">${c.items.length} tracks${c.truncated ? ' (first 100)' : ''} · ${totalDuration(c.items)} · ${sourceSummary(c.items)}</div>
      <div class="actions">
        <button class="btn primary" id="cPlay">${icon('play', 16)} Play</button>
        <button class="btn ghost" id="cShuffle">${icon('shuffle', 16)} Shuffle</button>
        <button class="btn ghost" id="cQueue">Add to queue</button>
        <button class="btn ghost" id="cSave">Save as playlist</button>
      </div>
    </div>
    <div class="view-body">
      <ul class="tracks" data-list="collection">${c.items.map((it, i) => trackRow(it, { ctx: 'results', index: i, numbered: true })).join('')}</ul>
    </div>`;
  $('#cPlay').onclick = () => playList(c.items, 0);
  $('#cShuffle').onclick = () => playList(c.items, 0, { shuffle: true });
  $('#cQueue').onclick = () => (addToQueue(c.items), toast(`Added ${c.items.length} tracks to queue`));
  $('#cSave').onclick = () => createPlaylist(c.items, c.title);
}

// ---- search ---------------------------------------------------------------

function renderSearchView() {
  const s = state.search;
  $('#main').innerHTML = `
    <div class="view-head">
      <form class="search-box${s.busy ? ' busy' : ''}" id="searchForm">
        ${icon('search', 18)}
        <input id="q" placeholder="Search songs — or paste a Spotify, YouTube, or SoundCloud link" value="${esc(s.q)}" autocomplete="off" spellcheck="false" />
        <div class="spin"></div>
      </form>
      <div class="seg" id="filter">
        ${['all', ...ALL_SOURCES].map((f) => `<button data-f="${f}" class="${s.filter === f ? 'on' : ''}">${{ all: 'All', ...SOURCE_LABEL }[f]}</button>`).join('')}
      </div>
    </div>
    <div class="view-body" id="searchBody"></div>`;
  renderSearchBody();
  const input = $('#q');
  if (!s.q) input.focus();
}

function renderSearchBody() {
  const s = state.search;
  const body = $('#searchBody');
  if (!body) return;
  $('#searchForm')?.classList.toggle('busy', s.busy);

  if (s.resolved) {
    const r = s.resolved;
    body.innerHTML = `
      <div class="col-title">${sourceBadge(r.items[0]?.source || 'youtube')} ${esc(r.title)} <span class="sub" style="color:var(--muted);font-weight:400">· ${r.items.length} track${r.items.length === 1 ? '' : 's'}${r.truncated ? ' (first 100)' : ''}</span></div>
      <div class="actions" style="margin: 0 8px 12px">
        <button class="btn primary" id="rPlay">${icon('play', 16)} Play all</button>
        <button class="btn ghost" id="rQueue">Add to queue</button>
        <button class="btn ghost" id="rSave">Save as playlist</button>
      </div>
      <ul class="tracks" data-list="resolved">${r.items.map((it, i) => trackRow(it, { ctx: 'results', index: i, numbered: r.items.length > 1 })).join('')}</ul>`;
    $('#rPlay').onclick = () => playList(r.items, 0);
    $('#rQueue').onclick = () => (addToQueue(r.items), toast(`Added ${r.items.length} tracks to queue`));
    $('#rSave').onclick = () => createPlaylist(r.items, r.title);
    return;
  }

  const has = ALL_SOURCES.some((src) => s.results[src]);
  if (!has && !s.busy) {
    body.innerHTML = `<div class="placeholder">
      <h2>Play Spotify, YouTube, and SoundCloud in one queue</h2>
      <div>Search all three at once, or paste any link.</div>
      <div class="tips">
        <div>${sourceBadge('spotify')} &nbsp;open.spotify.com/track/… · /album/… · /playlist/…</div>
        <div>${sourceBadge('youtube')} &nbsp;youtube.com/watch?v=… · youtu.be/… · playlist?list=…</div>
        <div>${sourceBadge('soundcloud')} &nbsp;soundcloud.com/…/… · /sets/… · on.soundcloud.com/…</div>
        <div style="color:var(--dim);margin-top:6px">Tip: drag tracks onto a playlist in the sidebar. Space = play/pause.</div>
      </div></div>`;
    return;
  }

  const col = (source) => {
    const r = s.results[source];
    let inner;
    if (r === null) inner = `<div class="col-msg">${s.busy ? 'Searching…' : ''}</div>`;
    else if (r.error) {
      const fix =
        r.code === 'NEEDS_RESTART'
          ? '<br><button class="btn ghost" data-restart-spotify>Restart Spotify</button>'
          : r.code === 'NO_SPOTIFY'
            ? '<br><button class="btn ghost" data-open-settings>Open settings</button>'
            : '';
      inner = `<div class="col-msg">${esc(r.error)}${fix}</div>`;
    } else if (!r.length) inner = '<div class="col-msg">No results.</div>';
    else inner = `<ul class="tracks" data-list="${source}">${r.map((it, i) => trackRow(it, { ctx: 'results', index: i, badge: false })).join('')}</ul>`;
    return `<section><div class="col-title">${icon(source, 18)} ${sourceLabel(source)}</div>${inner}</section>`;
  };
  const sources = s.filter === 'all' ? ALL_SOURCES : [s.filter];
  body.innerHTML = `<div class="cols ${sources.length === 1 ? 'single' : ''}">${sources.map(col).join('')}</div>`;
}

let searchSeq = 0;
async function runSearch(q) {
  const s = state.search;
  s.q = q.trim();
  const seq = ++searchSeq;
  if (!s.q) {
    s.results = { spotify: null, youtube: null, soundcloud: null };
    s.resolved = null;
    s.busy = false;
    return renderSearchBody();
  }

  if (looksLikeUrl(s.q)) {
    s.busy = true;
    renderSearchBody();
    try {
      const r = await api('/api/resolve', { method: 'POST', body: { url: s.q } });
      if (seq !== searchSeq) return;
      if (!r.items.length) throw new Error('No playable tracks found at that link.');
      s.resolved = r;
    } catch (err) {
      if (seq !== searchSeq) return;
      toast(err.message, { error: true, ms: 5000 });
    }
    s.busy = false;
    return renderSearchBody();
  }

  s.resolved = null;
  const sources = s.filter === 'all' ? ALL_SOURCES : [s.filter];
  s.results = { spotify: null, youtube: null, soundcloud: null };
  s.busy = true;
  renderSearchBody();
  await Promise.all(
    sources.map(async (source) => {
      let res;
      try {
        res = (await api(`/api/search?source=${source}&q=${encodeURIComponent(s.q)}`)).items;
      } catch (err) {
        res = { error: err.message, code: err.code };
      }
      if (seq !== searchSeq) return;
      s.results[source] = res;
      renderSearchBody();
    }),
  );
  if (seq !== searchSeq) return;
  s.busy = false;
  renderSearchBody();
}

// ---- queue ------------------------------------------------------------------

function renderQueueView() {
  const cur = current();
  const after = P.queue.slice(P.index + 1);
  const before = P.queue.slice(0, Math.max(0, P.index));
  $('#main').innerHTML = `
    <div class="view-head">
      <h1>Queue</h1>
      <div class="sub">${P.queue.length} tracks · ${totalDuration(P.queue)} · ${sourceSummary(P.queue)}</div>
      <div class="actions">
        <button class="btn ghost" id="qSave" ${P.queue.length ? '' : 'disabled'}>Save as playlist</button>
        <button class="btn ghost danger" id="qClear" ${P.queue.length > 1 ? '' : 'disabled'}>Clear queue</button>
        <div class="autoplay-pick" title="When your queue runs out, keep playing recommendations">
          <span>Autoplay</span>
          <div class="seg" id="autoplayMode">
            ${['off', 'same', 'both'].map((m) => `<button data-m="${m}" class="${P.autoplay === m ? 'on' : ''}">${{ off: 'Off', same: 'Same app', both: 'All apps' }[m]}</button>`).join('')}
          </div>
        </div>
      </div>
      ${P.autoplay !== 'off' && P.repeat === 'all' ? '<div class="sub">Autoplay is paused while Repeat all is on.</div>' : ''}
    </div>
    <div class="view-body">
      ${
        !P.queue.length
          ? '<div class="placeholder">Your queue is empty. Add songs from Search or a playlist.</div>'
          : `${cur ? `<div class="list-label">Now playing</div><ul class="tracks sortable">${trackRow(cur, { ctx: 'queue', index: P.index })}</ul>` : ''}
             ${upcomingGroups(after)}
             ${radio.busy ? '<div class="list-label">Finding recommendations…</div>' : ''}
             ${before.length ? `<div class="list-label">Played</div><ul class="tracks sortable">${before.map((e, k) => trackRow(e, { ctx: 'queue', index: k })).join('')}</ul>` : ''}`
      }
    </div>`;
  $('#qSave').onclick = () => createPlaylist(P.queue);
  $('#qClear').onclick = clearQueue;
  for (const b of $$('#autoplayMode button')) b.onclick = () => setAutoplay(b.dataset.m);
}

/** Upcoming tracks, split into runs of your picks ("Next up") and autoplay's ("Autoplay"). */
function upcomingGroups(after) {
  const groups = [];
  after.forEach((e, k) => {
    const auto = !!e.auto;
    if (!groups.length || groups.at(-1).auto !== auto) groups.push({ auto, rows: [] });
    groups.at(-1).rows.push(trackRow(e, { ctx: 'queue', index: P.index + 1 + k }));
  });
  return groups
    .map((g) => `<div class="list-label">${g.auto ? 'Autoplay · recommended for you' : 'Next up'}</div><ul class="tracks sortable">${g.rows.join('')}</ul>`)
    .join('');
}

// ---- playlist -----------------------------------------------------------------

function renderPlaylistView() {
  const pl = state.playlists.find((p) => p.id === state.view.id);
  if (!pl) return go({ name: 'home' });
  $('#main').innerHTML = `
    <div class="view-head">
      <h1>${esc(pl.name)}</h1>
      <div class="sub">${pl.items.length} tracks · ${totalDuration(pl.items)} · ${sourceSummary(pl.items)}</div>
      <div class="actions">
        <button class="btn primary" id="plPlay" ${pl.items.length ? '' : 'disabled'}>${icon('play', 16)} Play</button>
        <button class="btn ghost" id="plShuffle" ${pl.items.length ? '' : 'disabled'}>${icon('shuffle', 16)} Shuffle</button>
        <button class="btn ghost" id="plQueue" ${pl.items.length ? '' : 'disabled'}>Add to queue</button>
        <button class="btn ghost" id="plRename">Rename</button>
        <button class="btn ghost danger" id="plDelete">Delete</button>
      </div>
    </div>
    <div class="view-body">
      ${
        pl.items.length
          ? `<ul class="tracks sortable">${pl.items.map((it, i) => trackRow(it, { ctx: 'playlist', index: i, numbered: true })).join('')}</ul>`
          : '<div class="placeholder">This playlist is empty.<br>Use the ⋯ menu on any track, or drag tracks onto the playlist name.</div>'
      }
    </div>`;
  $('#plPlay').onclick = () => playList(pl.items, 0);
  $('#plShuffle').onclick = () => playList(pl.items, 0, { shuffle: true });
  $('#plQueue').onclick = () => (addToQueue(pl.items), toast(`Added ${pl.items.length} tracks to queue`));
  $('#plRename').onclick = async () => {
    const name = await ask('Rename playlist', pl.name);
    if (name) savePlaylist({ ...pl, name });
  };
  $('#plDelete').onclick = async () => {
    if (!(await confirmDialog('Delete playlist?', `“${pl.name}” will be removed. The songs stay on Spotify, YouTube, and SoundCloud.`, 'Delete'))) return;
    await api('/api/playlists/' + pl.id, { method: 'DELETE' });
    state.playlists = state.playlists.filter((p) => p.id !== pl.id);
    go({ name: 'home' });
  };
}

// ===========================================================================
// Dialogs
// ===========================================================================

function confirmDialog(title, text, okLabel = 'OK') {
  const dlg = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok');
  });
}

function ask(title, value = '') {
  const dlg = $('#promptDialog');
  $('#promptTitle').textContent = title;
  const input = $('#promptInput');
  input.value = value;
  dlg.returnValue = '';
  dlg.showModal();
  input.select();
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? input.value.trim() : null);
  });
}

async function openSettings() {
  const form = $('#settingsForm');
  try {
    const s = await api('/api/settings');
    for (const [k, v] of Object.entries(s)) {
      const el = form.elements[k];
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v;
    }
  } catch (err) {
    toast(err.message, { error: true });
  }
  $('#exePathInput').placeholder = state.status?.spotify?.exe || 'Auto-detect (%APPDATA%\\Spotify\\Spotify.exe)';
  const dlg = $('#settingsDialog');
  dlg.returnValue = '';
  dlg.showModal();
  refreshStatus();
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'save') return;
    const body = Object.fromEntries(new FormData(form));
    for (const el of form.querySelectorAll('input[type=checkbox][name]')) body[el.name] = el.checked;
    try {
      await api('/api/settings', { method: 'PUT', body });
      toast('Settings saved');
      refreshStatus();
      // Re-run a failed Spotify search (e.g. after fixing the exe path).
      if (state.search.q && state.search.results.spotify?.error) runSearch(state.search.q);
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
}

// ===========================================================================
// Drag and drop (reorder + drop on sidebar playlists)
// ===========================================================================

let drag = null;

function setupDragAndDrop() {
  const main = $('#main');

  document.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.(TRACK_EL);
    if (!row) return;
    const { ctx, index, item } = rowContext(row);
    if (!item) return;
    drag = { ctx, index, item, row };
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', item.title);
  });
  document.addEventListener('dragend', () => {
    drag?.row.classList.remove('dragging');
    $$('.drop-before, .drop-after, .drop').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop'));
    drag = null;
  });

  const clearMarks = () => $$('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  const target = (e) => {
    const row = e.target.closest('.sortable .track');
    if (!row || !drag || row.dataset.ctx !== drag.ctx || drag.ctx === 'results') return null;
    const r = row.getBoundingClientRect();
    return { row, after: e.clientY > r.top + r.height / 2 };
  };
  main.addEventListener('dragover', (e) => {
    const t = target(e);
    clearMarks();
    if (!t) return;
    e.preventDefault();
    t.row.classList.add(t.after ? 'drop-after' : 'drop-before');
  });
  main.addEventListener('drop', (e) => {
    const t = target(e);
    clearMarks();
    if (!t) return;
    e.preventDefault();
    const from = drag.index;
    let to = +t.row.dataset.index + (t.after ? 1 : 0);
    if (to > from) to--;
    if (drag.ctx === 'queue') moveInQueue(from, to);
    else if (drag.ctx === 'playlist') {
      const pl = state.playlists.find((p) => p.id === state.view.id);
      const items = pl.items.slice();
      const [it] = items.splice(from, 1);
      items.splice(to, 0, it);
      savePlaylist({ ...pl, items });
    }
  });

  const nav = $('#playlistNav');
  nav.addEventListener('dragover', (e) => {
    const b = e.target.closest('button[data-pl]');
    $$('.drop', nav).forEach((el) => el !== b && el.classList.remove('drop'));
    if (!b || !drag) return;
    e.preventDefault();
    b.classList.add('drop');
  });
  nav.addEventListener('dragleave', (e) => e.target.closest?.('button[data-pl]')?.classList.remove('drop'));
  nav.addEventListener('drop', (e) => {
    const b = e.target.closest('button[data-pl]');
    if (!b || !drag) return;
    e.preventDefault();
    b.classList.remove('drop');
    const pl = state.playlists.find((p) => p.id === b.dataset.pl);
    if (pl) addToPlaylist(pl, [drag.item]);
  });
}

// ===========================================================================
// Wiring
// ===========================================================================

function setupBar(el, { onSeek, onInput }) {
  const valueAt = (e) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    dragging = { el, value: valueAt(e) };
    onInput?.(dragging.value);
    renderProgress();
  });
  el.addEventListener('pointermove', (e) => {
    if (dragging?.el !== el) return;
    dragging.value = valueAt(e);
    onInput?.(dragging.value);
    renderProgress();
  });
  el.addEventListener('pointerup', (e) => {
    if (dragging?.el !== el) return;
    const v = valueAt(e);
    dragging = null;
    onSeek(v);
  });
}

function wire() {
  hydrateIcons();

  // Sidebar
  $('.sidebar').addEventListener('click', (e) => {
    const nav = e.target.closest('[data-view]');
    if (nav) return go({ name: nav.dataset.view });
    const pl = e.target.closest('[data-pl]');
    if (pl) return go({ name: 'playlist', id: pl.dataset.pl });
  });
  $('#newPlaylist').onclick = async () => {
    const pl = await createPlaylist();
    if (pl) go({ name: 'playlist', id: pl.id });
  };
  $('#openSettings').onclick = openSettings;
  $('#spotifyStatus').onclick = () => {
    const s = state.status?.spotify;
    if (s?.needsRestart) restartSpotify();
    else if (s?.needsLogin) api('/api/spotify/show', { method: 'POST' }).catch((err) => toast(err.message, { error: true }));
  };
  $('#restartSpotify').onclick = restartSpotify;
  $('#autostartToggle').onchange = async (e) => {
    try {
      const autostart = await api('/api/spotify/autostart', { method: 'POST', body: { enable: e.target.checked } });
      state.status.spotify.autostart = autostart;
      toast(autostart.enabled ? 'Spotify will start with Maestro support from now on' : 'Spotify startup entry restored');
    } catch (err) {
      toast(err.message, { error: true });
    }
    renderStatus();
  };
  for (const b of $$('[data-close]')) b.onclick = () => b.closest('dialog').close('cancel');

  // Player bar
  $('#btnPlay').onclick = togglePlay;
  $('#btnNext').onclick = () => next();
  $('#btnPrev').onclick = prev;
  $('#btnShuffle').onclick = toggleShuffle;
  $('#btnRepeat').onclick = cycleRepeat;
  $('#btnMute').onclick = toggleMute;
  setupBar($('#progress'), { onSeek: (v) => seek(v * P.duration) });
  setupBar($('#volume'), { onSeek: (v) => setVolume(v * 100), onInput: (v) => setVolume(v * 100) });

  // Main area (delegated)
  const main = $('#main');
  let debounce;
  main.addEventListener('input', (e) => {
    if (e.target.id !== 'q') return;
    clearTimeout(debounce);
    const q = e.target.value;
    // Links resolve right away on paste; text searches wait for a pause in typing.
    debounce = setTimeout(() => runSearch(q), looksLikeUrl(q) ? 0 : 450);
  });
  main.addEventListener('submit', (e) => {
    if (e.target.id !== 'searchForm') return;
    e.preventDefault();
    clearTimeout(debounce);
    runSearch($('#q').value);
  });
  main.addEventListener('click', (e) => {
    const f = e.target.closest('#filter [data-f]');
    if (f) {
      state.search.filter = f.dataset.f;
      $$('#filter button').forEach((b) => b.classList.toggle('on', b === f));
      if (state.search.q && !state.search.resolved) runSearch(state.search.q);
      else renderSearchBody();
      return;
    }
    if (e.target.closest('#homeRefresh')) return loadHome({ force: true });
    const arrow = e.target.closest('[data-shelf-scroll]');
    if (arrow) {
      const row = $('.shelf-row', arrow.closest('.shelf'));
      return row.scrollBy({ left: +arrow.dataset.shelfScroll * row.clientWidth * 0.9, behavior: 'smooth' });
    }
    const card = e.target.closest('[data-card]');
    if (card) return activateCard(card, !!e.target.closest('[data-card-play]'));
    const song = e.target.closest('.song-card');
    if (song) return onRowActivate(song, 'play');
    if (e.target.closest('[data-open-settings]')) return openSettings();
    if (e.target.closest('[data-restart-spotify]')) {
      return restartSpotify().then((ok) => ok && state.search.q && runSearch(state.search.q));
    }
    const act = e.target.closest('[data-act]');
    const row = e.target.closest('.track');
    if (act && row) return onRowActivate(row, act.dataset.act);
  });
  main.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.track');
    if (row && !e.target.closest('[data-act]')) onRowActivate(row, 'play');
  });
  main.addEventListener('scroll', (e) => e.target.classList?.contains('shelf-row') && syncShelfArrows(e.target), true);
  main.addEventListener('contextmenu', (e) => {
    const row = e.target.closest(TRACK_EL);
    if (!row) return;
    e.preventDefault();
    const { ctx, index, item } = rowContext(row);
    if (item) openTrackMenu({ left: e.clientX, top: e.clientY, bottom: e.clientY }, { ctx, index, item });
  });

  // "Next up" in the now-playing panel
  $('#npNext').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.track');
    if (row) playIndex(+row.dataset.index);
  });

  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#menu')) closeMenu();
  });
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', () => {
    closeMenu();
    $$('.shelf-row').forEach(syncShelfArrows);
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest('input, textarea, [contenteditable]');
    if (e.key === 'Escape') closeMenu();
    if (typing) return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowRight' && (e.ctrlKey || e.metaKey)) next();
    else if (e.key === 'ArrowLeft' && (e.ctrlKey || e.metaKey)) prev();
    else if (e.key === 'ArrowRight' && e.shiftKey) seek(livePosition() + 10000);
    else if (e.key === 'ArrowLeft' && e.shiftKey) seek(livePosition() - 10000);
    else if (e.key === '/' || (e.key === 'k' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      if (state.view.name !== 'search') go({ name: 'search' });
      $('#q')?.focus();
      $('#q')?.select();
    }
  });

  // Hardware media keys while the YouTube side is playing in this window.
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('nexttrack', () => next());
    navigator.mediaSession.setActionHandler('previoustrack', prev);
  }

  setupDragAndDrop();
}

// ===========================================================================
// Boot
// ===========================================================================

function boot() {
  wire();
  loadYouTube();
  loadSoundCloud();
  renderAll();
  renderMain();
  loadPlaylists().then(() => loadHome());
  refreshStatus().then(paintHome);
  setInterval(() => P.engine !== 'spotify' && refreshStatus(), 15000);
  setInterval(() => {
    if (P.loaded && !dragging) renderProgress();
    countListen();
  }, 250);

  // Restore the last track (cued, not playing).
  if (current()?.source === 'youtube' || current()?.source === 'soundcloud') playIndex(P.index, { autoplay: false });

  // Deep link: /?q=some+song
  const q = new URLSearchParams(location.search).get('q');
  if (q) {
    go({ name: 'search' });
    $('#q').value = q;
    runSearch(q);
  }
}

boot();
