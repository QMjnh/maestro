const { fetchText, fetchJson, extractJson, findAll, clockToMs } = require('./http');

const YT_COOKIE = { cookie: 'SOCS=CAI; CONSENT=YES+1' }; // skip the EU consent wall
const INITIAL_DATA = /var ytInitialData = (\{.*?\});<\/script>/s;

function thumb(id) {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/** Parse any YouTube / YouTube Music URL. */
function parseUrl(input) {
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/.test(url.hostname)) return null;
  const list = url.searchParams.get('list');
  let video = url.searchParams.get('v');
  if (!video && url.hostname.endsWith('youtu.be')) video = url.pathname.slice(1).split('/')[0];
  if (!video) {
    const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
    if (m) video = m[1];
  }
  // A plain playlist link (no specific video) imports the playlist; "watch?v=..&list=.." is just the video.
  if (list && (!video || url.pathname === '/playlist')) return { kind: 'playlist', id: list };
  if (video && /^[\w-]{11}$/.test(video)) return { kind: 'video', id: video };
  return null;
}

// ---- search ---------------------------------------------------------------

async function search(q, apiKey) {
  if (apiKey) return searchApi(q, apiKey);
  return searchScrape(q);
}

async function searchScrape(q) {
  const html = await fetchText(
    'https://www.youtube.com/results?sp=EgIQAQ%253D%253D&search_query=' + encodeURIComponent(q),
    { headers: YT_COOKIE },
  );
  const data = extractJson(html, INITIAL_DATA);
  if (!data) throw new Error('Could not read YouTube search results (page format changed?)');
  return findAll(data, 'videoRenderer')
    .filter((v) => v.videoId && v.lengthText) // drop live streams
    .slice(0, 25)
    .map((v) => ({
      source: 'youtube',
      id: v.videoId,
      title: v.title?.runs?.map((r) => r.text).join('') || '',
      artist: v.ownerText?.runs?.[0]?.text || '',
      art: thumb(v.videoId),
      duration: clockToMs(v.lengthText?.simpleText),
    }));
}

function isoDurationToMs(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return null;
  return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
}

async function videosApi(ids, apiKey) {
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await fetchJson(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${ids.slice(i, i + 50).join(',')}&key=${encodeURIComponent(apiKey)}`,
    );
    for (const v of data.items || []) {
      out.push({
        source: 'youtube',
        id: v.id,
        title: v.snippet.title,
        artist: v.snippet.channelTitle.replace(/ - Topic$/, ''),
        art: thumb(v.id),
        duration: isoDurationToMs(v.contentDetails.duration),
      });
    }
  }
  return out;
}

async function searchApi(q, apiKey) {
  const data = await fetchJson(
    `https://www.googleapis.com/youtube/v3/search?part=id&type=video&maxResults=25&q=${encodeURIComponent(q)}&key=${encodeURIComponent(apiKey)}`,
  );
  return videosApi(
    (data.items || []).map((i) => i.id.videoId).filter(Boolean),
    apiKey,
  );
}

// ---- link resolution ------------------------------------------------------

async function video(id, apiKey) {
  if (apiKey) {
    const [v] = await videosApi([id], apiKey);
    if (v) return v;
  }
  try {
    const o = await fetchJson(
      'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id),
    );
    return { source: 'youtube', id, title: o.title, artist: o.author_name.replace(/ - Topic$/, ''), art: thumb(id), duration: null };
  } catch {
    // Private / embed-disabled videos have no oEmbed; still let the user try.
    return { source: 'youtube', id, title: `YouTube video ${id}`, artist: '', art: thumb(id), duration: null };
  }
}

async function playlist(id, apiKey) {
  if (apiKey) return playlistApi(id, apiKey);
  const html = await fetchText('https://www.youtube.com/playlist?list=' + encodeURIComponent(id), { headers: YT_COOKIE });
  const data = extractJson(html, INITIAL_DATA);
  if (!data) throw new Error('Could not read that YouTube playlist (is it private?)');

  const title = data.metadata?.playlistMetadataRenderer?.title || 'YouTube playlist';
  const items = [];
  // Old layout
  for (const v of findAll(data, 'playlistVideoRenderer')) {
    if (!v.videoId) continue;
    items.push({
      source: 'youtube',
      id: v.videoId,
      title: v.title?.runs?.map((r) => r.text).join('') || '',
      artist: v.shortBylineText?.runs?.[0]?.text || '',
      art: thumb(v.videoId),
      duration: v.lengthSeconds ? +v.lengthSeconds * 1000 : null,
    });
  }
  // New "lockup" layout
  for (const l of findAll(data, 'lockupViewModel')) {
    if (l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO' || !l.contentId) continue;
    const meta = l.metadata?.lockupMetadataViewModel;
    const badge = findAll(l.contentImage, 'thumbnailBadgeViewModel')[0];
    items.push({
      source: 'youtube',
      id: l.contentId,
      title: meta?.title?.content || '',
      artist: meta?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || '',
      art: thumb(l.contentId),
      duration: clockToMs(badge?.text),
    });
  }
  return { title, items };
}

async function playlistApi(id, apiKey) {
  const meta = await fetchJson(
    `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${encodeURIComponent(id)}&key=${encodeURIComponent(apiKey)}`,
  );
  const ids = [];
  let pageToken = '';
  do {
    const page = await fetchJson(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(id)}&key=${encodeURIComponent(apiKey)}${pageToken ? '&pageToken=' + pageToken : ''}`,
    );
    ids.push(...(page.items || []).map((i) => i.contentDetails.videoId));
    pageToken = page.nextPageToken || '';
  } while (pageToken && ids.length < 500);
  return { title: meta.items?.[0]?.snippet?.title || 'YouTube playlist', items: await videosApi(ids, apiKey) };
}

module.exports = { parseUrl, search, video, playlist };
