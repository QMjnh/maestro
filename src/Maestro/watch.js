// Runs on youtube.com in Maestro's hidden second browser (YouTubePage.cs), which plays the videos whose owners block
// them from playing inside other apps. Takes commands from the UI, reports the player's state back to it, and keeps
// ads out of the way, since nobody can see or skip them here.

(() => {
  if (window !== window.top || location.hostname !== 'www.youtube.com' || !window.chrome?.webview) return;

  const post = (msg) => chrome.webview.postMessage(msg);
  const player = () => document.getElementById('movie_player');
  const id = new URLSearchParams(location.search).get('v');
  if (location.pathname !== '/watch' || !id) return;

  // Ads are taken out of the video's data before YouTube's player reads it, so none are scheduled. The data arrives
  // either as ytInitialPlayerResponse, set by the page as it loads, or as JSON fetched later.
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];
  let adsRemoved = 0;
  const stripAds = (data) => {
    for (const o of [data, data?.playerResponse]) {
      if (!o || typeof o !== 'object') continue;
      for (const k of AD_KEYS) {
        if (!(k in o)) continue;
        delete o[k];
        adsRemoved++;
      }
    }
    return data;
  };
  let initialResponse;
  Object.defineProperty(window, 'ytInitialPlayerResponse', {
    configurable: true,
    get: () => initialResponse,
    set: (v) => (initialResponse = stripAds(v)),
  });
  const parse = JSON.parse;
  JSON.parse = function (...args) {
    return stripAds(parse.apply(this, args));
  };
  const json = Response.prototype.json;
  Response.prototype.json = function () {
    return json.call(this).then(stripAds);
  };

  let volume = null; // { volume, muted } from the UI
  let volumeApplied = false;
  let failed = false;
  let nudged = false;
  let inAd = false;
  const loadedAt = Date.now();

  const applyVolume = () => {
    const p = player();
    if (!volume || !p?.setVolume) return;
    p.setVolume(volume.volume);
    volume.muted ? p.mute() : p.unMute();
    volumeApplied = true;
  };

  chrome.webview.addEventListener('message', (e) => {
    const m = e.data || {};
    const p = player();
    if (m.cmd === 'volume') {
      volume = { volume: m.volume, muted: m.muted };
      applyVolume();
    } else if (!p?.playVideo) {
      return;
    } else if (m.cmd === 'play') {
      p.playVideo();
    } else if (m.cmd === 'pause') {
      p.pauseVideo();
    } else if (m.cmd === 'seek') {
      p.seekTo(m.seconds, true);
    }
  });

  // Any ad that gets through anyway (some are built into the video stream) plays silently at top speed; jumping to its
  // end instead makes YouTube stall for several seconds. When YouTube shows its Skip button, the app clicks it: YouTube
  // ignores clicks from scripts, so YouTubePage.cs sends a real one.
  let skipAsked = 0;
  const handleAd = (p, ad) => {
    const video = p.querySelector('video');
    if (ad) {
      inAd = true;
      if (video) {
        video.muted = true;
        video.playbackRate = 16;
      }
      const skip = [...p.querySelectorAll('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button')].find((el) => el.offsetParent);
      if (skip && Date.now() - skipAsked > 1000) {
        skipAsked = Date.now();
        const r = skip.getBoundingClientRect();
        post({ skipAt: { x: r.x + r.width / 2, y: r.y + r.height / 2 } });
      }
    } else if (inAd) {
      inAd = false;
      if (video) {
        video.playbackRate = 1;
        video.muted = !!volume?.muted;
      }
      applyVolume();
    }
  };

  const STATES = { '-1': 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' };
  setInterval(() => {
    // Age-restricted, private, or region-blocked videos don't play here either.
    const status = window.ytInitialPlayerResponse?.playabilityStatus;
    // So do videos where YouTube notices the ads are gone and stops playback; nobody can see its message here.
    const blocked =
      status && status.status !== 'OK'
        ? status.reason || status.status
        : document.querySelector('ytd-enforcement-message-view-model') && 'youtube.com stopped it for removing ads';
    if (blocked) {
      if (!failed) post({ id, error: blocked });
      failed = true;
      return;
    }
    const p = player();
    if (!p?.getPlayerState) return;
    if (!volumeApplied) applyVolume();
    const ad = p.classList.contains('ad-showing');
    handleAd(p, ad);
    const state = STATES[p.getPlayerState()] || 'unstarted';
    // The page normally starts the video by itself; if it hasn't after a few seconds, press play once.
    if (!nudged && (state === 'unstarted' || state === 'cued') && Date.now() - loadedAt > 4000) {
      nudged = true;
      p.playVideo();
    }
    post({
      id,
      state: ad ? 'ad' : state,
      time: ad ? 0 : p.getCurrentTime(),
      duration: ad ? 0 : p.getDuration(),
    });
  }, 250);

  post({ id, hello: true });

  // For checking on it from DevTools.
  window.__maestroWatch = () => ({ adsRemoved, inAd, volume });
})();
