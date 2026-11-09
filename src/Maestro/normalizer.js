// Runs inside the YouTube and SoundCloud player frames (MainForm.cs adds it to every frame in the window).
// Measures how loud the current track really is and turns it up or down to match Spotify's level. Spotify's own audio
// never passes through a web page, so it can't be changed here; Spotify normalizes to about -14 LUFS by itself.

(() => {
  if (window === window.top || window.parent !== window.top) return;
  if (location.ancestorOrigins[0] !== 'https://maestro.app') return;
  if (!/^(www\.youtube(-nocookie)?\.com|w\.soundcloud\.com)$/.test(location.hostname)) return;

  const TARGET = -14; // LUFS
  const MIN_GAIN = -18; // dB
  const MAX_GAIN = 9; // dB; quieter tracks stay a little quiet instead of being pushed into the limiter
  const BLOCK_MS = 350; // about the length of the analyser window, so each block is new audio
  const FAST_BLOCKS = 3; // about 1 s of sound, enough to know a track is too loud
  const SETTLE_BLOCKS = 10; // about 3.5 s of sound before trusting a track's own measurement enough to boost it
  const RECENT_BLOCKS = 9; // about 3 s
  const LOUD_MARGIN = 6; // LU; how far above the target a passage may go before it's turned down right away
  const NEW_TRACK_MS = 1000; // the previous track can still be playing for a moment after a change
  const LIMITER_MAKEUP = 0.57; // dB; Chromium's compressor always adds this much for these settings
  const MAX_BLOCKS = 6000; // about 35 min; long mixes are measured over their most recent part
  const PRIOR_KEY = 'maestro.normalizer.prior';

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const fromDb = (db) => Math.pow(10, db / 20);

  let enabled = false;
  let volume = 1; // the app's slider, 0..1
  let media = null; // the element playing now
  let ctx = null;
  let chain = null;
  let blocks = []; // loudness of each measured block of this track, as linear power
  let prior = Number(localStorage.getItem(PRIOR_KEY)) || 0; // what recent tracks needed, for the seconds before this one is known
  let gainDb = prior;
  let applied = 1; // the gain last sent to the audio graph
  let trackId = null;
  let listenFrom = 0; // when to start measuring the current track

  // SoundCloud's player builds its own audio graph, and an element can only have one source node. So the takeover point
  // is the last step instead: whatever a page connects to the speakers gets sent through the normalizer.
  const nativeCreate = AudioContext.prototype.createMediaElementSource;
  const nativeConnect = AudioNode.prototype.connect;
  const nativeDisconnect = AudioNode.prototype.disconnect;
  const sources = new WeakMap(); // element -> its source node
  const speakers = new Map(); // node connected to the speakers -> where it's really connected

  AudioContext.prototype.createMediaElementSource = function (el) {
    const source = nativeCreate.call(this, el);
    sources.set(el, source);
    return source;
  };
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (!(dest instanceof AudioDestinationNode)) return nativeConnect.call(this, dest, ...rest);
    if (!speakers.has(this)) {
      speakers.set(this, dest);
      nativeConnect.call(this, dest);
      if (chain && enabled && this.context === ctx) reroute(this, chain.input);
    }
    return dest;
  };
  AudioNode.prototype.disconnect = function (...args) {
    if (speakers.has(this) && (!args.length || args[0] === this.context.destination)) {
      const to = speakers.get(this);
      speakers.delete(this);
      if (args.length) return nativeDisconnect.call(this, to);
    }
    return nativeDisconnect.apply(this, args);
  };

  function reroute(node, to) {
    const from = speakers.get(node);
    if (from === to) return;
    nativeDisconnect.call(node, from);
    nativeConnect.call(node, to);
    speakers.set(node, to);
  }

  function route() {
    if (!chain) return;
    for (const node of speakers.keys()) {
      if (node.context === ctx) reroute(node, enabled ? chain.input : ctx.destination);
    }
  }

  function buildChain() {
    const wire = (...nodes) => nodes.slice(1).forEach((n, i) => nativeConnect.call(nodes[i], n));
    const input = ctx.createGain();
    const gain = ctx.createGain();
    applied = gain.gain.value = fromDb(gainDb - LIMITER_MAKEUP);
    // Catches the peaks of tracks that get boosted.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    wire(input, gain, limiter, ctx.destination);

    // ITU BS.1770 K-weighting, the filter behind LUFS: bass counts less, treble counts more.
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 38.13;
    highpass.Q.value = -6.02; // a Q of 0.5, which Web Audio takes in dB for this filter type
    highpass.channelCount = 2;
    highpass.channelCountMode = 'explicit';
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 1681.97;
    shelf.gain.value = 4;
    const splitter = ctx.createChannelSplitter(2);
    const meters = [ctx.createAnalyser(), ctx.createAnalyser()];
    wire(input, highpass, shelf, splitter);
    meters.forEach((m, i) => {
      m.fftSize = 16384;
      nativeConnect.call(splitter, m, i);
    });
    chain = { input, gain, meters, data: new Float32Array(16384) };
    setInterval(measure, BLOCK_MS);
  }

  // Web Audio outputs silence for cross-origin media without CORS, and that can't be undone, so only take over safe sources.
  const readable = (el) => (el.currentSrc || el.src || '').startsWith('blob:') || el.crossOrigin != null;

  function attach(el) {
    media = el;
    const source = sources.get(el);
    if (!enabled || (!source && !readable(el))) return;
    if (!ctx) ctx = source ? source.context : new AudioContext();
    if (!chain) buildChain();
    if (ctx.state === 'suspended') ctx.resume();
    if (!source) {
      const own = nativeCreate.call(ctx, el);
      sources.set(el, own);
      own.connect(ctx.destination);
    }
    route();
  }

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const toLufs = (power) => -0.691 + 10 * Math.log10(power);

  function integratedLufs() {
    const relative = mean(blocks) * 0.1; // ignore blocks 10 LU below the average: silences and fade-outs
    return toLufs(mean(blocks.filter((p) => p >= relative)));
  }

  // YouTube publishes each video's loudness. It's better than measuring: right from the first second, and for the whole
  // track rather than the part heard so far. The response still describes the previous video for a moment after a change.
  function publishedLufs() {
    try {
      const response = document.getElementById('movie_player').getPlayerResponse();
      if (response.videoDetails.videoId !== trackId) return null;
      const { trackAbsoluteLoudnessLkfs: absolute, perceptualLoudnessDb: perceptual } = response.playerConfig.audioConfig;
      const lufs = absolute ?? perceptual;
      return Number.isFinite(lufs) ? lufs : null;
    } catch {
      return null;
    }
  }

  const gainFor = (lufs) => clamp(TARGET - lufs, MIN_GAIN, MAX_GAIN);

  function measuredGain() {
    const gain = gainFor(integratedLufs());
    // Turn a loud track down as soon as it's heard, but be sure before turning one up.
    const early = blocks.length < SETTLE_BLOCKS ? Math.min(prior, gain) : gain;
    // A soft intro says little about what follows, so a much louder passage is pulled back without waiting for the average.
    return Math.min(early, gainFor(toLufs(mean(blocks.slice(-RECENT_BLOCKS))) - LOUD_MARGIN));
  }

  function applyGain(fixedSeconds) {
    // YouTube lowers loud videos by scaling the element's volume. The measurement replaces that, so it's undone here.
    const trim = media && media.volume >= 0.01 ? clamp(volume / media.volume, 0.25, 4) : 1;
    const value = fromDb(gainDb - LIMITER_MAKEUP) * trim;
    if (Math.abs(value - applied) < 0.005) return;
    const seconds = fixedSeconds ?? (value < applied ? 0.3 : 1);
    applied = value;
    chain.gain.gain.setTargetAtTime(value, ctx.currentTime, seconds);
  }

  function measure() {
    if (!enabled || !media || !sources.has(media) || sources.get(media).context !== ctx) return;
    if (media.paused || media.muted || media.volume < 0.01) return;
    const published = publishedLufs();
    if (published !== null) {
      gainDb = gainFor(published);
      applyGain();
      return;
    }
    if (performance.now() < listenFrom) return;
    let power = 0;
    for (const meter of chain.meters) {
      meter.getFloatTimeDomainData(chain.data);
      power += chain.data.reduce((a, s) => a + s * s, 0) / chain.data.length;
    }
    power /= media.volume * media.volume; // the player's volume is applied before this point, and must not count
    if (toLufs(power) >= -70) {
      blocks.push(power);
      if (blocks.length > MAX_BLOCKS) blocks.shift();
    }
    if (blocks.length >= FAST_BLOCKS) gainDb = measuredGain();
    applyGain();
  }

  function newTrack(id) {
    if (blocks.length >= SETTLE_BLOCKS * 3) {
      prior = prior * 0.7 + gainDb * 0.3;
      try {
        localStorage.setItem(PRIOR_KEY, String(prior));
      } catch {}
    }
    blocks = [];
    gainDb = prior;
    trackId = String(id);
    listenFrom = performance.now() + NEW_TRACK_MS;
    if (chain) applyGain(0.1);
  }

  // A problem in here must never get in the way of the music.
  const tryAttach = (el) => {
    try {
      attach(el);
    } catch (err) {
      console.warn('Maestro normalizer:', err);
    }
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    tryAttach(this);
    return play.apply(this, args);
  };
  document.addEventListener('playing', (e) => tryAttach(e.target), true);

  window.addEventListener('message', (e) => {
    const msg = e.data && e.data.maestroNormalizer;
    if (e.source !== window.parent || e.origin !== 'https://maestro.app' || typeof msg !== 'object' || !msg) return;
    if (typeof msg.volume === 'number') volume = msg.volume;
    if (msg.newTrack) newTrack(msg.newTrack);
    if (typeof msg.enabled === 'boolean' && msg.enabled !== enabled) {
      enabled = msg.enabled;
      if (media) tryAttach(media);
      route();
    }
  });
  window.parent.postMessage({ maestroNormalizer: 'ready' }, 'https://maestro.app');

  // For checking on it from DevTools.
  window.__maestroNormalizer = () => ({ enabled, volume, gainDb, prior, blocks: blocks.length, lufs: blocks.length ? integratedLufs() : null });
})();
