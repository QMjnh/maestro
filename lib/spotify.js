const { fetchText, extractJson } = require('./http');

const NEXT_DATA = /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s;

/** Parse open.spotify.com links and spotify: URIs. */
function parseUrl(input) {
  const s = input.trim();
  let m = s.match(/^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/);
  if (m) return { kind: m[1], id: m[2] };
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (!/(^|\.)spotify\.com$/.test(url.hostname)) return null;
  m = url.pathname.match(/\/(track|album|playlist)\/([A-Za-z0-9]{22})/);
  return m ? { kind: m[1], id: m[2] } : null;
}

function bestImage(images) {
  if (!images?.length) return '';
  const sorted = [...images].sort((a, b) => (b.maxWidth || b.width || 0) - (a.maxWidth || a.width || 0));
  return (sorted.find((i) => (i.maxWidth || i.width || 0) <= 300) || sorted[0]).url;
}

// ---- metadata via the public embed page (no credentials needed) -----------

async function embedEntity(kind, id) {
  const html = await fetchText(`https://open.spotify.com/embed/${kind}/${id}`);
  const entity = extractJson(html, NEXT_DATA)?.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new Error(`Couldn't read that Spotify ${kind}.`);
  return entity;
}

async function resolve(kind, id) {
  const e = await embedEntity(kind, id);
  if (kind === 'track') {
    return {
      title: e.name,
      items: [
        {
          source: 'spotify',
          id: e.id || id,
          title: e.name || e.title,
          artist: (e.artists || []).map((a) => a.name).join(', '),
          art: bestImage(e.visualIdentity?.image),
          duration: e.duration || null,
        },
      ],
    };
  }
  const art = bestImage(e.coverArt?.sources || e.visualIdentity?.image);
  const items = (e.trackList || [])
    .filter((t) => t.uri?.startsWith('spotify:track:'))
    .map((t) => ({
      source: 'spotify',
      id: t.uri.split(':')[2],
      title: t.title,
      artist: t.subtitle || '',
      art,
      duration: t.duration || null,
    }));
  // The embed page lists at most ~100 tracks; note it so the UI can say so.
  return { title: e.name || e.title, items, truncated: items.length >= 100 };
}

module.exports = { parseUrl, resolve };
