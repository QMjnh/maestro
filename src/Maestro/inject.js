// Runs inside the Spotify desktop app's page (sent over the DevTools Protocol by SpotifyApp.cs).
// Defines window.__maestro once per page load, using the app's internal "platform" object
// (found via React props) - the same object Spotify's own UI uses.

if (!window.__maestro || window.__maestro.v !== 3) {
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
  const playlists = get('PlaylistAPI');
  const tokens = get('TokenProvider');
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
    throw new Error('Could not find Spotify ' + name + ' in this app version');
  };
  const image = (sources) => {
    if (!sources || !sources.length) return '';
    const s = sources.find((x) => x.width === 300) || sources[0];
    return s.url;
  };

  const listItem = (t) => {
    const img = (t.album && t.album.images) || [];
    const art = (img.find((i) => i.label === 'standard') || img[0] || {}).url || '';
    return {
      source: 'spotify',
      id: t.uri.split(':')[2],
      title: t.name,
      artist: (t.artists || []).map((a) => a.name).join(', '),
      art: art.replace(/^spotify:image:/, 'https://i.scdn.co/image/'),
      duration: (t.duration && t.duration.milliseconds) || null,
    };
  };

  const plainText = (html) => new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();

  // A playlist or album from the home feed, as a Maestro card. Artists and episodes aren't playable lists.
  const homeCard = (x) => {
    const [, kind, id] = String(x.uri || '').split(':');
    if (kind !== 'playlist' && kind !== 'album') return null;
    const artists = ((x.artists && x.artists.items) || []).map((a) => a.profile && a.profile.name).filter(Boolean).join(', ');
    return {
      source: 'spotify',
      id,
      title: x.name,
      subtitle: plainText(x.description) || artists || (x.ownerV2 && x.ownerV2.data && x.ownerV2.data.name) || '',
      art: image((x.images && x.images.items && x.images.items[0] && x.images.items[0].sources) || (x.coverArt && x.coverArt.sources)),
      url: 'https://open.spotify.com/' + kind + '/' + id,
    };
  };

  window.__maestro = {
    v: 3,
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
    // Spotify's "Go to song radio" list for a track (about 50 songs).
    async radio(uri) {
      if (!playlists || !tokens) throw new Error('Spotify radio is not available in this app version');
      const { accessToken } = await tokens.loadToken();
      const res = await fetch('https://spclient.wg.spotify.com/inspiredby-mix/v2/seed_to_playlist/' + uri + '?response-format=json', {
        headers: { authorization: 'Bearer ' + accessToken },
      });
      if (!res.ok) throw new Error('Spotify radio failed (' + res.status + ')');
      const station = (await res.json()).mediaItems?.[0]?.uri;
      if (!station) return [];
      const { items } = await playlists.getContents(station, { limit: 100 });
      return items.filter((t) => t.type === 'track' && t.isPlayable && t.uri !== uri).map(listItem);
    },
    // A playlist as the signed-in user sees it, for private ones with no public page.
    async contents(uri) {
      if (!playlists) throw new Error('Spotify playlists are not available in this app version');
      const { items } = await playlists.getContents(uri, { limit: 100 });
      const meta = await playlists.getMetadata(uri).catch(() => null);
      const tracks = items.filter((t) => t.type === 'track' && t.isPlayable).map(listItem);
      return { title: (meta && meta.name) || 'Spotify playlist', items: tracks, truncated: tracks.length >= 100 };
    },
    // The signed-in user's own Spotify home feed, as titled rows of playlists and albums.
    async home() {
      const hash = await findHash('home');
      const res = await P.getGraphQLLoader()(
        { name: 'home', operation: 'query', sha256Hash: hash, value: null },
        { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, sp_t: '', facet: '', sectionItemsLimit: 12 },
      );
      if (res && res.errors && res.errors.length) throw new Error('Spotify home failed: ' + res.errors[0].message);
      const sections = (res && res.data && res.data.home && res.data.home.sectionContainer && res.data.home.sectionContainer.sections && res.data.home.sectionContainer.sections.items) || [];
      const seen = new Set();
      const rows = [];
      const leftovers = []; // Spotify sends many one-item sections ("For fans of ..."); they read better as one row
      for (const s of sections) {
        const title = (s.data && s.data.title && s.data.title.transformedLabel) || '';
        if (/recently played/i.test(title)) continue; // Maestro has its own, across all three services
        const quick = s.data && s.data.__typename === 'HomeShortsSectionData';
        const cards = ((s.sectionItems && s.sectionItems.items) || [])
          .map((i) => i.content && i.content.data && homeCard(i.content.data))
          .filter((c) => c && (quick || !seen.has(c.url)));
        if (quick) {
          rows.push({ title: '', quick: true, cards });
          continue;
        }
        cards.forEach((c) => seen.add(c.url));
        if (cards.length >= 3) rows.push({ title, cards });
        else leftovers.push(...cards);
      }
      if (leftovers.length) rows.push({ title: 'More for you', cards: leftovers });
      return rows;
    },
  };
}
