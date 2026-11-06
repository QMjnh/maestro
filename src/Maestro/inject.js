// Runs inside the Spotify desktop app's page (sent over the DevTools Protocol by SpotifyApp.cs).
// Defines window.__maestro once per page load, using the app's internal "platform" object
// (found via React props) - the same object Spotify's own UI uses.

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
