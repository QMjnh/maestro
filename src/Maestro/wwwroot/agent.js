'use strict';
/* Maestro for AI agents. Maestro.exe's MCP server and `agent` command (Agent.cs) send tool calls here, and each one runs
   on the same state and functions as the UI, so an agent's change shows up in the window just like a click would.
   The tools and their parameters are described in AgentTools.cs. */

// Every track an agent has been shown, so it can hand back just { source, id } and still get the art and title.
const agentSeen = new Map();

function agentOut(t, extra = {}) {
  if (!t) return null;
  agentSeen.set(trackKey(t), stripEntry({ ...t }));
  return {
    ...extra,
    source: t.source,
    id: t.id,
    title: t.title,
    artist: t.artist,
    ...(t.duration ? { durationMs: Math.round(t.duration) } : {}),
    link: itemLink(t),
  };
}

const agentList = (items, limit = Infinity) => items.slice(0, limit).map((t) => agentOut(t));
const agentNumbered = (items) => items.map((t, position) => agentOut(t, { position }));

function agentFail(msg) {
  throw new Error(msg);
}

function agentInt(v, name, max) {
  if (!Number.isInteger(v) || v < 0 || v > max) agentFail(`${name} must be a whole number from 0 to ${max}.`);
  return v;
}

function agentEnum(v, name, options) {
  if (!options.includes(v)) agentFail(`${name} must be one of: ${options.join(', ')}.`);
  return v;
}

/** A track the agent passed in, filled out from what Maestro already knows about it. */
async function agentTrack(t) {
  if (!t || typeof t !== 'object' || !ALL_SOURCES.includes(t.source) || typeof t.id !== 'string' || !t.id)
    agentFail('Each track needs a source (spotify, youtube, or soundcloud) and an id, as returned by search.');
  const key = trackKey(t);
  const known =
    agentSeen.get(key) ||
    [...P.queue, ...(state.favorites || []), ...state.playlists.flatMap((p) => p.items)].find((e) => trackKey(e) === key);
  if (known) return stripEntry({ ...known });
  if (t.title) {
    return { source: t.source, id: t.id, title: t.title, artist: t.artist || '', art: t.art || '', duration: t.durationMs ?? t.duration ?? null, ...(t.url || t.link ? { url: t.url || t.link } : {}) };
  }
  // Only an id: look it up like a pasted link.
  const link = t.url || t.link || (t.source !== 'soundcloud' && itemLink(t));
  if (!link) agentFail(`Unknown SoundCloud track ${t.id}: pass the track object from search results, or its link in urls.`);
  const r = await api('/api/resolve', { method: 'POST', body: { url: link } });
  return r.items[0] || agentFail(`Couldn't find ${t.source} track ${t.id}.`);
}

async function agentPlaylists() {
  try {
    state.playlists = await api('/api/playlists');
  } catch {} // keep what the UI already has
  return state.playlists;
}

async function agentFavorites() {
  if (!state.favorites) await loadFavorites();
  return state.favorites || agentFail('Could not load favorites: ' + state.favoritesError);
}

/** One of your Maestro playlists, by id or name. */
async function agentPlaylist(ref) {
  const s = String(ref ?? '').trim();
  const all = await agentPlaylists();
  const pl = all.find((p) => p.id === s) || all.find((p) => p.name.toLowerCase() === s.toLowerCase());
  return pl || agentFail(`No playlist called “${s}”. Your playlists: ${all.map((p) => p.name).join(', ') || 'none yet'}.`);
}

/** The tracks behind a playlist reference: a Maestro playlist, "favorites", or a home page card's ref. */
async function agentCollection(ref) {
  const s = String(ref ?? '').trim();
  if (s.toLowerCase() === 'favorites') return { title: 'Favorites', items: await agentFavorites() };
  if (s.startsWith('home:')) {
    const at = s.lastIndexOf(':');
    const card = homeCards(s.slice(5, at))[+s.slice(at + 1)] || agentFail(`No home card ${s}. Call get_home for current refs.`);
    if (card.own) return agentCollection(card.own);
    if (card.items) return { title: card.title, items: card.items };
    if (!resolved.has(card.url)) {
      const url = card.url;
      resolved.set(url, api('/api/resolve', { method: 'POST', body: { url } }).catch((err) => (resolved.delete(url), Promise.reject(err))));
    }
    return { title: card.title, items: (await resolved.get(card.url)).items };
  }
  const pl = await agentPlaylist(s);
  return { title: pl.name, items: pl.items, playlist: pl };
}

const agentPicked = (a) => !!(a.tracks?.length || a.urls?.length || a.fromPlaylist != null || a.fromQueue || a.current);

/** The tracks a tool call is about, from whichever of tracks / urls / fromPlaylist / fromQueue / current it gave. */
async function agentPick(a, { orCurrent = false } = {}) {
  const items = [];
  let title = '';
  for (const t of a.tracks || []) items.push(await agentTrack(t));
  for (const url of a.urls || []) {
    const r = await api('/api/resolve', { method: 'POST', body: { url: String(url) } });
    if (!r.items.length) agentFail(`No playable tracks found at ${url}.`);
    items.push(...r.items);
    title ||= r.title;
  }
  if (a.fromPlaylist != null) {
    const c = await agentCollection(a.fromPlaylist);
    items.push(...c.items);
    title ||= c.title;
  }
  if (a.fromQueue) items.push(...P.queue);
  if (a.current || (orCurrent && !agentPicked(a))) items.push(current() || agentFail('Nothing is playing.'));
  if (!items.length) agentFail('No tracks given. Use tracks, urls, fromPlaylist, fromQueue, or current.');
  return { items: items.map(stripEntry), title };
}

function agentStatus() {
  if (P.loading) return 'loading';
  if (P.playing) return 'playing';
  return current() && P.loaded ? 'paused' : 'stopped';
}

function agentState() {
  const s = state.status?.spotify;
  return {
    nowPlaying: agentOut(current()),
    status: agentStatus(),
    queuePosition: P.index,
    positionMs: Math.round(Math.max(0, livePosition())),
    durationMs: Math.round(P.duration || 0),
    note: $('#npNote').textContent || undefined,
    upNext: P.queue.slice(P.index + 1, P.index + 4).map((t, k) => agentOut(t, { position: P.index + 1 + k, ...(t.auto ? { autoplay: true } : {}) })),
    queueLength: P.queue.length,
    volume: P.volume,
    muted: P.muted,
    shuffle: P.shuffle,
    repeat: P.repeat,
    autoplay: P.autoplay,
    normalizeVolume: P.normalize,
    favorite: current() ? isFavorite(current()) : undefined,
    view: state.view.name,
    spotify: s ? spotifyStatusText()[1] : 'unknown',
  };
}

/** Give a track change a moment to start, then report what's playing. */
async function agentSettle(ms = 10000) {
  await sleep(400);
  for (const until = Date.now() + ms; P.loading && Date.now() < until; ) await sleep(200);
  return agentState();
}

async function agentHomeReady() {
  for (const until = Date.now() + 30000; homeLoading && Date.now() < until; ) await sleep(250);
}

const agentTools = {
  get_state: () => agentState(),

  get_queue: () => ({
    queuePosition: P.index,
    autoplay: P.autoplay,
    tracks: P.queue.map((t, position) => agentOut(t, { position, ...(position === P.index ? { current: true } : {}), ...(t.auto ? { autoplay: true } : {}) })),
  }),

  async search({ query, source = 'all', limit = 10 }) {
    const q = String(query ?? '').trim() || agentFail('query is required.');
    if (looksLikeUrl(q)) return agentTools.resolve_link({ url: q });
    agentEnum(source, 'source', ['all', ...ALL_SOURCES]);
    limit = agentInt(limit, 'limit', 25);
    const results = {};
    await Promise.all(
      (source === 'all' ? ALL_SOURCES : [source]).map(async (src) => {
        try {
          results[src] = agentList((await api(`/api/search?source=${src}&q=${encodeURIComponent(q)}`)).items, limit);
        } catch (err) {
          results[src] = { error: err.message };
        }
      }),
    );
    return results;
  },

  async resolve_link({ url }) {
    const r = await api('/api/resolve', { method: 'POST', body: { url: String(url ?? '') } });
    return { title: r.title, ...(r.truncated ? { truncated: true } : {}), tracks: agentList(r.items) };
  },

  async get_home({ refresh = false, limit = 10 }) {
    limit = agentInt(limit, 'limit', 50);
    await agentHomeReady();
    if (refresh || !homeTried) await loadHome({ force: refresh });
    await agentHomeReady();
    const songs = (title, name) => ({ title, tracks: agentList(homeSongs(name), limit) });
    const cards = (title, name) => ({
      title,
      playlists: homeCards(name)
        .slice(0, limit)
        .map((c, i) => ({
          ref: `home:${name}:${i}`,
          title: c.title,
          subtitle: c.subtitle || undefined,
          source: c.source || undefined,
          ...(c.items ? { trackCount: c.items.length } : { link: c.url }),
        })),
    });
    return {
      shelves: [
        cards('Top picks', 'quick'),
        songs('Recommended songs', 'recommended'),
        cards('Mixes for you', 'mixes'),
        songs('YouTube picks for you', 'ytPicks'),
        songs('SoundCloud picks for you', 'scPicks'),
        cards('YouTube playlists for you', 'ytLists'),
        cards('SoundCloud playlists for you', 'scLists'),
        ...spotifyRows().map((r, i) => cards(r.title, 'feed:' + i)),
        songs('Recently played', 'recent'),
        cards('Your playlists', 'own'),
        ...(homeIsCold() ? [songs('Trending songs', 'chart'), cards('Popular playlists', 'featured')] : []),
      ].filter((s) => (s.tracks || s.playlists).length),
    };
  },

  // ---- playback ----

  async play(a) {
    let { items } = await agentPick(a);
    const replace = a.replaceQueue ?? items.length > 1;
    if (replace) {
      playList(items, agentInt(a.startIndex ?? 0, 'startIndex', items.length - 1), { shuffle: !!a.shuffle });
    } else {
      if (a.shuffle) items = shuffled(items);
      playNow(items);
    }
    return agentSettle();
  },

  async play_queue_position({ position }) {
    playIndex(agentInt(position, 'position', P.queue.length - 1));
    return agentSettle();
  },

  async player_control({ action }) {
    agentEnum(action, 'action', ['play', 'pause', 'toggle', 'next', 'previous']);
    if (!P.queue.length) agentFail('The queue is empty. Use play to start something.');
    if (action === 'next') next();
    else if (action === 'previous') prev();
    else if (action === 'toggle' || (action === 'play' && !P.playing && !P.loading) || (action === 'pause' && P.playing)) togglePlay();
    return agentSettle();
  },

  async seek({ positionMs, offsetMs }) {
    if (!P.loaded || !current()) agentFail('Nothing is playing.');
    const to = Number.isFinite(positionMs) ? positionMs : Number.isFinite(offsetMs) ? livePosition() + offsetMs : agentFail('Give positionMs or offsetMs.');
    seek(to);
    await sleep(300);
    return agentState();
  },

  set_player_options(a) {
    if (a.volume !== undefined) setVolume(agentInt(a.volume, 'volume', 100));
    if (a.muted !== undefined && !!a.muted !== P.muted) toggleMute();
    if (a.shuffle !== undefined && !!a.shuffle !== P.shuffle) toggleShuffle();
    if (a.repeat !== undefined && agentEnum(a.repeat, 'repeat', ['off', 'all', 'one']) !== P.repeat) {
      P.repeat = a.repeat;
      persist();
      renderPlayer();
      topUpAutoplay();
    }
    if (a.autoplay !== undefined && agentEnum(a.autoplay, 'autoplay', ['off', 'same', 'both']) !== P.autoplay) setAutoplay(a.autoplay);
    if (a.normalizeVolume !== undefined) {
      P.normalize = !!a.normalizeVolume;
      syncNormalizer();
      persist();
    }
    return agentState();
  },

  // ---- queue ----

  async add_to_queue(a) {
    const { items } = await agentPick(a);
    const at = addToQueue(items, { playNext: !!a.playNext });
    toast(items.length === 1 ? `${a.playNext ? 'Playing next' : 'Added to queue'}: “${items[0].title}”` : `Added ${items.length} tracks to queue`);
    return { added: items.length, positions: [at, at + items.length - 1], queueLength: P.queue.length };
  },

  remove_from_queue({ positions }) {
    if (!Array.isArray(positions) || !positions.length) agentFail('positions must list queue positions from get_queue.');
    const unique = [...new Set(positions.map((p) => agentInt(p, 'position', P.queue.length - 1)))].sort((x, y) => y - x);
    for (const p of unique) removeFromQueue(p);
    return { removed: unique.length, queueLength: P.queue.length, queuePosition: P.index };
  },

  move_in_queue({ from, to }) {
    moveInQueue(agentInt(from, 'from', P.queue.length - 1), agentInt(to, 'to', P.queue.length - 1));
    return agentTools.get_queue();
  },

  clear_queue() {
    clearQueue();
    return { queueLength: P.queue.length };
  },

  // ---- favorites and playlists ----

  async list_playlists() {
    const favorites = await agentFavorites();
    const all = await agentPlaylists();
    return [{ id: 'favorites', name: 'Favorites', trackCount: favorites.length }, ...all.map((p) => ({ id: p.id, name: p.name, trackCount: p.items.length }))];
  },

  async get_playlist({ playlist }) {
    const c = await agentCollection(playlist);
    return { ...(c.playlist ? { id: c.playlist.id } : {}), name: c.title, tracks: agentNumbered(c.items) };
  },

  async set_favorite(a) {
    const { items } = await agentPick(a, { orCurrent: true });
    const favorite = a.favorite !== false;
    await agentFavorites();
    for (const item of items) if (isFavorite(item) !== favorite) await setFavorite(item, favorite);
    await favoriteWrites;
    const failed = items.filter((item) => isFavorite(item) !== favorite);
    if (failed.length) agentFail(`Couldn't update favorites for: ${failed.map((t) => t.title).join(', ')}.`);
    return { favorite, tracks: agentList(items), favoritesCount: state.favorites.length };
  },

  async create_playlist(a) {
    const name = String(a.name ?? '').trim() || agentFail('name is required.');
    const items = agentPicked(a) ? (await agentPick(a)).items : [];
    const pl = await savePlaylist({ name, items });
    toast(`Created “${pl.name}”`);
    return { id: pl.id, name: pl.name, trackCount: pl.items.length };
  },

  async add_to_playlist(a) {
    if (String(a.playlist ?? '').trim().toLowerCase() === 'favorites') return agentTools.set_favorite({ ...a, favorite: true });
    const pl = await agentPlaylist(a.playlist);
    const { items } = await agentPick(a);
    await addToPlaylist(pl, items);
    return { id: pl.id, name: pl.name, added: items.length, trackCount: pl.items.length + items.length };
  },

  async remove_from_playlist({ playlist, positions }) {
    if (!Array.isArray(positions) || !positions.length) agentFail('positions must list track positions from get_playlist.');
    if (String(playlist ?? '').trim().toLowerCase() === 'favorites') {
      const favs = await agentFavorites();
      return agentTools.set_favorite({ tracks: positions.map((p) => favs[agentInt(p, 'position', favs.length - 1)]), favorite: false });
    }
    const pl = await agentPlaylist(playlist);
    const gone = new Set(positions.map((p) => agentInt(p, 'position', pl.items.length - 1)));
    const saved = await savePlaylist({ ...pl, items: pl.items.filter((_, i) => !gone.has(i)) });
    return { id: saved.id, name: saved.name, removed: gone.size, trackCount: saved.items.length };
  },

  async move_in_playlist({ playlist, from, to }) {
    const pl = await agentPlaylist(playlist);
    const items = pl.items.slice();
    const [it] = items.splice(agentInt(from, 'from', items.length - 1), 1);
    items.splice(agentInt(to, 'to', items.length), 0, it);
    const saved = await savePlaylist({ ...pl, items });
    return { id: saved.id, name: saved.name, tracks: agentNumbered(saved.items) };
  },

  async rename_playlist({ playlist, name }) {
    const pl = await agentPlaylist(playlist);
    name = String(name ?? '').trim() || agentFail('name is required.');
    const saved = await savePlaylist({ ...pl, name });
    return { id: saved.id, name: saved.name };
  },

  async delete_playlist({ playlist }) {
    const pl = await agentPlaylist(playlist);
    await api('/api/playlists/' + pl.id, { method: 'DELETE' });
    state.playlists = state.playlists.filter((p) => p.id !== pl.id);
    if (state.view.name === 'playlist' && state.view.id === pl.id) go({ name: 'home' });
    else {
      renderSidebar();
      paintHome();
    }
    toast(`Deleted “${pl.name}”`);
    return { deleted: pl.name };
  },

  // ---- the window and settings ----

  async show_view({ view, playlist, query }) {
    agentEnum(view, 'view', ['home', 'search', 'queue', 'favorites', 'playlist']);
    if (view === 'playlist') go({ name: 'playlist', id: (await agentPlaylist(playlist)).id });
    else go({ name: view });
    if (view === 'search' && query) {
      $('#q').value = query;
      runSearch(query);
    }
    return { view };
  },

  async get_settings() {
    await refreshStatus();
    const { youtubeApiKey, ...s } = await api('/api/settings');
    return { ...s, youtubeApiKeySet: !!youtubeApiKey, normalizeVolume: P.normalize, spotify: spotifyStatusText()[1], spotifyAutostart: !!state.status?.spotify?.autostart?.enabled };
  },

  async update_settings(a) {
    const body = {};
    for (const k of ['hideSpotify', 'closeSpotifyOnExit']) if (a[k] !== undefined) body[k] = !!a[k];
    for (const k of ['spotifyExePath', 'youtubeApiKey']) if (a[k] !== undefined) body[k] = String(a[k]);
    if (a.normalizeVolume !== undefined) agentTools.set_player_options({ normalizeVolume: a.normalizeVolume });
    if (Object.keys(body).length) await api('/api/settings', { method: 'PUT', body });
    return agentTools.get_settings();
  },

  async manage_spotify({ action }) {
    agentEnum(action, 'action', ['restart', 'show_login', 'enable_autostart', 'disable_autostart']);
    if (action === 'restart') {
      toast('Restarting Spotify…');
      state.status = { ...state.status, spotify: await api('/api/spotify/restart', { method: 'POST' }) };
      renderStatus();
    } else if (action === 'show_login') {
      await api('/api/spotify/show', { method: 'POST' });
    } else {
      await api('/api/spotify/autostart', { method: 'POST', body: { enable: action === 'enable_autostart' } });
      await refreshStatus();
    }
    return { spotify: spotifyStatusText()[1], autostart: !!state.status?.spotify?.autostart?.enabled };
  },
};

window.chrome?.webview?.addEventListener('message', async (e) => {
  const call = e.data?.agent;
  if (!call) return;
  let reply;
  try {
    const tool = Object.hasOwn(agentTools, call.tool) ? agentTools[call.tool] : agentFail(`Unknown tool ${call.tool}.`);
    reply = { ok: true, result: (await tool(call.args || {})) ?? null };
  } catch (err) {
    reply = { ok: false, error: err.message || String(err) };
  }
  window.chrome.webview.postMessage({ agentReply: { id: call.id, ...reply } });
});

window.chrome?.webview?.postMessage({ agentReady: true });
