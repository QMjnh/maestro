'use strict';
/* The Agent panel: a chat with an AI agent (Claude, Codex) that controls Maestro with the same tools agents get over
   MCP. AgentChat.cs runs the agent over ACP and streams its replies here as {chat: event} messages. This file draws
   the conversation and the agent / model / effort pickers, and keeps the chat between runs. */

const chatSaved = JSON.parse(localStorage.getItem('maestro.agent') || '{}');
const chat = {
  open: !!chatSaved.open,
  agent: chatSaved.agent || 'claude-acp',
  sessionId: chatSaved.sessionId || null,
  log: Array.isArray(chatSaved.log) ? chatSaved.log : [], // { k: 'user' | 'agent' | 'tool' | 'error' | 'note', ... }
  needsHandoff: !!chatSaved.needsHandoff, // carry chat.log into the next prompt after switching agents
  prefs: chatSaved.prefs || {}, // agent id -> { config option id: value } picked by the user
  optionsCache: chatSaved.optionsCache || {}, // agent id -> its last configOptions, so the pickers work before it starts
  agents: [],
  access: null, // { level, custom, recommended, capabilities } from AgentAccess.cs
  status: 'idle', // idle | connecting | ready | install | installing | signin | error
  message: '', // what the status means right now
  signIn: null,
  needsInstall: null,
  account: '',
  configOptions: [],
  busy: false,
  sending: null, // a message waiting for the agent to start
  thinking: false,
  stream: null, // the agent message being written
  connecting: null,
  openGroups: new Set(), // tool groups the user expanded, by their first tool call id
};

const CHAT_LOG_MAX = 200;
const toolFinished = (e) => e.status === 'completed' || e.status === 'failed';
// Tool calls still marked running when Maestro last closed won't hear back.
for (const e of chat.log) if (e.k === 'tool' && !toolFinished(e)) e.status = 'completed';
const CHAT_SUGGESTIONS = ['Play something upbeat', "What's playing?", 'Queue 5 songs like this one', 'Save my queue as a playlist'];

function persistChat() {
  localStorage.setItem(
    'maestro.agent',
    JSON.stringify({
      open: chat.open,
      agent: chat.agent,
      sessionId: chat.sessionId,
      log: chat.log.slice(-CHAT_LOG_MAX),
      needsHandoff: chat.needsHandoff,
      prefs: chat.prefs,
      optionsCache: chat.optionsCache,
    }),
  );
}

// ---- config options (model, effort, ...) as the agent describes them --------------------------------------------

// Until the agent is running, show the options it had last time.
const chatOptions = () => (chat.configOptions.length ? chat.configOptions : chat.optionsCache[chat.agent] || []);
const chatOption = (category) => chatOptions().find((o) => o.category === category || o.id === category);
const optionValues = (o) => (o?.options || []).flatMap((v) => (Array.isArray(v.options) ? v.options : [v]));
const optionName = (o) => optionValues(o).find((v) => v.value === o?.currentValue)?.name || o?.currentValue || '';
const agentName = (id = chat.agent) =>
  chat.agents.find((a) => a.id === id)?.name ||
  { 'claude-acp': 'Claude', 'codex-acp': 'Codex', cursor: 'Cursor', 'antigravity-acp': 'Antigravity', opencode: 'OpenCode', gemini: 'Gemini CLI', 'github-copilot-cli': 'GitHub Copilot' }[id] ||
  id;

function setChatOptions(options) {
  chat.configOptions = options || [];
  if (chat.configOptions.length) chat.optionsCache[chat.agent] = chat.configOptions;
}

function applyChatSnapshot(r) {
  chat.account = r.account || chat.account;
  setChatOptions(r.configOptions);
  chat.busy = !!r.busy || !!chat.sending;
}

async function setChatOption(id, value, { remember = true } = {}) {
  if (chat.status !== 'ready') {
    // Not running yet: remember the pick; applyChatPrefs sets it once the agent starts.
    (chat.prefs[chat.agent] ||= {})[id] = value;
    const o = chatOptions().find((x) => x.id === id);
    if (o) o.currentValue = value;
    persistChat();
    return renderChatBar();
  }
  try {
    applyChatSnapshot(await api('/api/chat/option', { method: 'POST', body: { configId: id, value } }));
    if (remember) (chat.prefs[chat.agent] ||= {})[id] = value;
    persistChat();
  } catch (err) {
    toast(err.message, { error: true });
  }
  renderChatBar();
}

/** Bring back the model and effort the user picked last time with this agent. */
async function applyChatPrefs() {
  for (const [id, value] of Object.entries(chat.prefs[chat.agent] || {})) {
    const o = chat.configOptions.find((x) => x.id === id);
    if (o && o.currentValue !== value && optionValues(o).some((v) => v.value === value)) await setChatOption(id, value, { remember: false });
  }
}

// ---- access levels (AgentAccess.cs) ------------------------------------------------------------------------------

const ACCESS_LEVELS = [
  { id: 'minimal', name: 'Minimal', desc: 'Maestro tools only' },
  { id: 'recommended', name: 'Recommended', desc: 'Adds web search, sub-agents, and images' },
  { id: 'full', name: 'Full access', desc: 'All agent tools, without prompts' },
  { id: 'custom', name: 'Custom', desc: 'Choose specific capabilities' },
];

const accessMeta = (level) => ACCESS_LEVELS.find((l) => l.id === level) || ACCESS_LEVELS[1];
const sameSet = (a = [], b = []) => a.length === b.length && a.every((x) => b.includes(x));

async function loadChatMeta() {
  if (chat.agents.length && chat.access) return;
  const r = await api('/api/chat');
  chat.agents = r.agents || [];
  if (r.access) chat.access = r.access;
}

function accessIsRisky(level = chat.access?.level, custom = chat.access?.custom) {
  if (level === 'full') return true;
  if (level !== 'custom' || !chat.access) return false;
  return (custom || []).some((id) => chat.access.capabilities.find((c) => c.id === id)?.risky);
}

function accessSummary(level, custom = []) {
  if (level === 'minimal') return "Maestro's music tools only. No web search, files, commands, or other MCP servers.";
  if (level === 'recommended') return "Maestro's tools plus web search, sub-agents, and image generation. No files, commands, or desktop control.";
  if (level === 'full') return "The agent's full tool set (including files, commands, and your own setup), with no permission prompts.";
  const names = (chat.access?.capabilities || []).filter((c) => custom.includes(c.id)).map((c) => c.name.toLowerCase());
  return names.length ? `Maestro's tools plus: ${names.join(', ')}.` : "Maestro's music tools only (no extra capabilities selected).";
}

function renderAccessCaps(el, selected) {
  const caps = chat.access?.capabilities || [];
  const row = (c) => {
    const tag = c.agents?.length === 1 ? ` <span class="access-tag">${esc(agentName(c.agents[0]))} only</span>` : '';
    return `<label class="check"><input type="checkbox" value="${esc(c.id)}" ${selected.includes(c.id) ? 'checked' : ''} /><span>${esc(c.name)}${tag}<br /><span class="opt">${esc(c.description)}</span></span></label>`;
  };
  const safe = caps.filter((c) => !c.risky);
  const risky = caps.filter((c) => c.risky);
  el.innerHTML = safe.map(row).join('') + (risky.length ? '<div class="access-group-label">PC &amp; account access</div>' + risky.map(row).join('') : '');
}

const readAccessCaps = (el) => $$('input[type=checkbox]:checked', el).map((i) => i.value);

async function setChatAccess(level, custom) {
  const prev = chat.access;
  if (prev && prev.level === level && (level !== 'custom' || sameSet(prev.custom, custom))) return;
  const wasActive = chat.status === 'ready' || !!chat.connecting;
  const body = custom ? { level, custom } : { level };
  chat.access = await api('/api/chat/access', { method: 'POST', body });
  if (chat.busy) {
    chat.busy = false;
    chat.thinking = false;
    chat.stream = null;
    for (const e of chat.log) if (e.k === 'tool' && !toolFinished(e)) e.status = 'failed';
  }
  if (wasActive || chat.status === 'ready') {
    if (chat.connecting) await chat.connecting.catch(() => {});
    chat.status = 'idle';
    chatConnect();
  } else renderChatBar();
}

async function openAccessMenu() {
  try {
    await loadChatMeta();
  } catch (err) {
    return toast(err.message, { error: true });
  }
  const cur = chat.access?.level || 'recommended';
  const customCount = chat.access?.custom?.length || 0;
  const entries = [
    { label: 'Agent access' },
    ...ACCESS_LEVELS.filter((l) => l.id !== 'custom').map((l) => ({
      checked: cur === l.id,
      text: l.name,
      desc: l.desc,
      run: () => setChatAccess(l.id),
    })),
    '-',
    {
      checked: cur === 'custom',
      text: 'Custom…',
      desc: cur === 'custom' ? `${customCount} ${customCount === 1 ? 'capability' : 'capabilities'} on` : 'Choose specific capabilities',
      run: openCustomAccessDialog,
    },
  ];
  openMenu($('#agentAccess').getBoundingClientRect(), entries);
}

async function openCustomAccessDialog() {
  try {
    await loadChatMeta();
  } catch (err) {
    return toast(err.message, { error: true });
  }
  const caps = $('#agentAccessCaps');
  renderAccessCaps(caps, chat.access?.custom || chat.access?.recommended || []);
  const dlg = $('#agentAccessDialog');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.onclose = () => {
    if (dlg.returnValue === 'save') setChatAccess('custom', readAccessCaps(caps)).catch((err) => toast(err.message, { error: true }));
  };
}

/** Wires the Agent access section inside the main Settings modal; returns a callback to save changes. */
async function setupSettingsAccess() {
  try {
    await loadChatMeta();
  } catch {
    return null;
  }
  const seg = $('#settingsAccessSeg');
  const summary = $('#settingsAccessSummary');
  const capsEl = $('#settingsAccessCaps');
  if (!seg || !chat.access) return null;
  let draftLevel = chat.access.level;
  let draftCustom = [...(chat.access.custom || [])];
  renderAccessCaps(capsEl, draftCustom);
  const paint = () => {
    for (const b of $$('button[data-level]', seg)) {
      const on = b.dataset.level === draftLevel;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    summary.textContent = accessSummary(draftLevel, draftCustom);
    summary.classList.toggle('warn', accessIsRisky(draftLevel, draftCustom));
    capsEl.hidden = draftLevel !== 'custom';
  };
  seg.onclick = (e) => {
    const b = e.target.closest('button[data-level]');
    if (!b) return;
    draftLevel = b.dataset.level;
    paint();
  };
  capsEl.onchange = () => {
    draftCustom = readAccessCaps(capsEl);
    paint();
  };
  paint();
  return () => setChatAccess(draftLevel, draftLevel === 'custom' ? draftCustom : undefined);
}

// ---- talking to AgentChat.cs ---------------------------------------------------------------------------------------

function chatConnect({ fresh = false } = {}) {
  if (chat.connecting) return chat.connecting;
  chat.status = 'connecting';
  chat.message = `Starting ${agentName()}…`;
  chat.signIn = null;
  chat.needsInstall = null;
  chat.needsNode = false;
  renderChat();
  const target = chat.agent;
  const attempt = (async () => {
    try {
      const r = await api('/api/chat/connect', { method: 'POST', body: { agent: target, sessionId: fresh ? null : chat.sessionId } });
      if (chat.agent !== target) return false;
      if (r.needsInstall) {
        chat.status = 'install';
        chat.needsInstall = r.needsInstall;
        chat.message = '';
        return false;
      }
      if (r.signIn) {
        chat.status = 'signin';
        chat.signIn = r.signIn;
        chat.message = '';
        return false;
      }
      applyChatSnapshot(r);
      if (chat.sessionId && r.sessionId !== chat.sessionId && chat.log.some((e) => e.k === 'user')) {
        chat.needsHandoff = true;
      }
      chat.sessionId = r.sessionId;
      chat.status = 'ready';
      chat.message = '';
      await applyChatPrefs();
      return true;
    } catch (err) {
      if (chat.agent !== target) return false;
      chat.status = 'error';
      chat.message = err.message;
      chat.needsNode = !!err.node;
      return false;
    }
  })();
  chat.connecting = attempt.then((ok) => {
    chat.connecting = null;
    // The user picked another agent while this one was starting: start that one instead.
    if (chat.agent !== target) return chatConnect();
    persistChat();
    renderChat();
    return ok;
  });
  return chat.connecting;
}

async function chatInstall() {
  if (chat.status === 'installing') return;
  const target = chat.agent;
  chat.status = 'installing';
  chat.message = `Installing ${agentName(target)}…`;
  chat.needsInstall = null;
  renderChat();
  try {
    await api('/api/chat/install', { method: 'POST', body: { agent: target } });
    const entry = chat.agents.find((a) => a.id === target);
    if (entry) entry.installed = true;
    if (chat.agent === target) {
      chat.status = 'idle';
      chatConnect();
    }
  } catch (err) {
    if (chat.agent !== target) return;
    chat.status = 'error';
    chat.message = err.message;
    renderChat();
  }
}

/** Build a compact transcript of the chat so far to hand off context when switching agents. */
function buildHandoff(entries) {
  const MAX_CHARS = 12000;
  const lines = [];
  for (const e of entries) {
    if (e.k === 'user') lines.push(`User: ${e.text}`);
    else if (e.k === 'agent') lines.push(`Assistant: ${e.text}`);
    else if (e.k === 'tool') lines.push(`[Action: ${toolLabel(e)}${e.status === 'failed' ? ' (failed)' : ''}]`);
  }
  if (!lines.length) return '';
  const kept = [];
  let len = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (kept.length && len + line.length + 1 > MAX_CHARS) {
      kept.push('(earlier messages omitted)');
      break;
    }
    kept.push(line);
    len += line.length + 1;
  }
  return kept.reverse().join('\n');
}

async function chatSend(text) {
  text = text.trim();
  if (!text || chat.busy || chat.status === 'installing') return false;
  // Show the message right away; if the agent is still starting, it goes out as soon as it's up.
  const entry = { k: 'user', text };
  const send = {}; // this send, so Stop can call it off while the agent starts
  chat.log.push(entry);
  Object.assign(chat, { busy: true, sending: send, thinking: false, stream: null });
  renderChat();
  const ready = chat.status === 'ready' || (await chatConnect());
  if (chat.sending !== send) return true; // stopped while the agent was starting
  chat.sending = null;
  if (!ready) {
    chat.busy = false;
    chat.log.splice(chat.log.indexOf(entry), 1); // the card below says why; the text goes back in the box
    persistChat();
    renderChat();
    return false;
  }
  const handoff = chat.needsHandoff ? buildHandoff(chat.log.slice(0, chat.log.indexOf(entry))) : null;
  persistChat();
  try {
    await api('/api/chat/prompt', { method: 'POST', body: handoff ? { text, handoff } : { text } });
    if (handoff) {
      chat.needsHandoff = false;
      persistChat();
    }
  } catch (err) {
    chat.busy = false;
    chat.log.push({ k: 'error', text: err.message });
    renderChat();
  }
  return true;
}

function chatStop() {
  if (chat.sending) {
    chat.sending = null;
    chat.busy = false;
    chat.log.push({ k: 'note', text: 'Stopped.' });
    persistChat();
    return renderChat();
  }
  api('/api/chat/cancel', { method: 'POST' }).catch((err) => toast(err.message, { error: true }));
}

async function chatNew() {
  if (chat.busy) chatStop();
  chat.log = [];
  chat.needsHandoff = false;
  chat.stream = null;
  if (chat.status === 'ready') {
    try {
      const r = await api('/api/chat/new', { method: 'POST' });
      if (r.signIn) Object.assign(chat, { status: 'signin', signIn: r.signIn });
      else {
        applyChatSnapshot(r);
        chat.sessionId = r.sessionId;
        await applyChatPrefs();
      }
    } catch (err) {
      chat.status = 'error';
      chat.message = err.message;
    }
  } else chat.sessionId = null;
  persistChat();
  renderChat();
  $('#agentInput').focus();
}

function chatSwitchAgent(id) {
  if (id === chat.agent) return;
  if (chat.busy) chatStop();
  const hasContext = chat.log.some((e) => e.k === 'user' || e.k === 'agent');
  if (hasContext) {
    chat.needsHandoff = true;
    // Replace a trailing switch note if the user switches agents several times before messaging.
    if (chat.log.at(-1)?.handoff) chat.log.pop();
    chat.log.push({ k: 'note', handoff: true, text: `Switched to ${agentName(id)} — conversation context will carry over.` });
  }
  Object.assign(chat, {
    agent: id,
    sessionId: null,
    stream: null,
    account: '',
    configOptions: [],
    signIn: null,
    needsInstall: null,
    busy: false,
    thinking: false,
    status: 'idle',
  });
  persistChat();
  chatConnect();
}

// Events from AgentChat.cs.
window.chrome?.webview?.addEventListener('message', (e) => {
  const ev = e.data?.chat;
  if (!ev) return;
  if (ev.type === 'status') {
    if (ev.state === 'stopped') {
      Object.assign(chat, { status: 'error', message: ev.message || `${agentName()} stopped.`, busy: false, stream: null });
    } else if (ev.state === 'installing') {
      chat.status = 'installing';
      if (ev.message) chat.message = ev.message;
    } else if (ev.state === 'starting') {
      chat.status = 'connecting';
      if (ev.message) chat.message = ev.message;
    }
  } else if (ev.type === 'account') {
    chat.account = ev.account || '';
  } else if (ev.type === 'options') {
    setChatOptions(ev.configOptions);
    persistChat();
  } else if (ev.type === 'update') {
    return onChatUpdate(ev.update);
  } else if (ev.type === 'turn_end') {
    chat.busy = false;
    chat.thinking = false;
    chat.stream = null;
    for (const e of chat.log) if (e.k === 'tool' && !toolFinished(e)) e.status = ev.error || ev.stopReason === 'cancelled' ? 'failed' : 'completed';
    if (ev.error) chat.log.push({ k: 'error', text: ev.error });
    else if (ev.stopReason === 'cancelled') chat.log.push({ k: 'note', text: 'Stopped.' });
    else if (ev.stopReason === 'refusal') chat.log.push({ k: 'note', text: 'The agent declined to answer.' });
    else if (ev.stopReason === 'max_tokens' || ev.stopReason === 'max_turn_requests') chat.log.push({ k: 'note', text: 'The agent hit its limit for one reply.' });
    persistChat();
  }
  renderChat();
});

function onChatUpdate(u) {
  const kind = u.sessionUpdate;
  if (kind === 'agent_message_chunk') {
    const text = u.content?.text || '';
    if (!text || !chat.busy) return; // only replies; e.g. Codex warns about the model while resuming
    chat.thinking = false;
    if (!chat.stream) chat.log.push((chat.stream = { k: 'agent', text: '' }));
    chat.stream.text += text;
    return paintChatStream();
  }
  if (kind === 'agent_thought_chunk') {
    if (!chat.thinking) {
      chat.thinking = true;
      renderChatLog();
    }
    return;
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    let entry = chat.log.findLast((e) => e.k === 'tool' && e.id === u.toolCallId);
    if (!entry) {
      if (kind === 'tool_call_update' && !u.name && !u.title) return;
      chat.log.push((entry = { k: 'tool', id: u.toolCallId, status: 'pending' }));
    }
    if (u.name) entry.name = u.name;
    if (u.title) entry.title = u.title;
    if (u.rawInput && Object.keys(u.rawInput).length) entry.input = u.rawInput;
    if (u.status) entry.status = u.status;
    if (u.error) entry.error = String(u.error).slice(0, 300);
    chat.stream = null; // text after a tool call starts a new message
    chat.thinking = false;
  } else if (kind === 'notice' && (u.message || u.text)) {
    chat.log.push({ k: 'note', text: u.message || u.text });
  } else return;
  persistChat();
  renderChatLog();
}

// ---- describing tool calls ---------------------------------------------------------------------------------------

const quoted = (s) => `“${String(s).slice(0, 60)}”`;

/** What a tool call's track arguments refer to, in a few words. */
function describePick(a = {}) {
  if (a.tracks?.length) return quoted(a.tracks[0].title || 'a song') + (a.tracks.length > 1 ? ` and ${a.tracks.length - 1} more` : '');
  if (a.urls?.length) return a.urls.length === 1 ? 'a link' : `${a.urls.length} links`;
  if (a.fromPlaylist) return String(a.fromPlaylist).toLowerCase() === 'favorites' ? 'your Favorites' : String(a.fromPlaylist).startsWith('home:') ? 'a home page pick' : quoted(a.fromPlaylist);
  if (a.fromQueue) return 'the queue';
  return 'this song';
}

const TOOL_LABELS = {
  get_state: () => 'Checking the player',
  search: (a) => (a.query ? `Searching ${quoted(a.query)}` : 'Searching'),
  resolve_link: () => 'Opening a link',
  get_home: () => 'Looking at your home page',
  play: (a) => `Playing ${describePick(a)}`,
  player_control: (a) => ({ play: 'Resuming', pause: 'Pausing', toggle: 'Play / pause', next: 'Skipping to the next song', previous: 'Going back' })[a.action] || 'Controlling playback',
  seek: () => 'Seeking',
  set_player_options: (a) =>
    Object.entries(a)
      .map(([k, v]) => ({ volume: `volume ${v}`, muted: v ? 'mute' : 'unmute', shuffle: `shuffle ${v ? 'on' : 'off'}`, repeat: `repeat ${v}`, autoplay: `autoplay ${v}`, normalizeVolume: `even volume ${v ? 'on' : 'off'}` })[k])
      .filter(Boolean)
      .join(', ')
      .replace(/^./, (c) => c.toUpperCase()) || 'Changing player options',
  get_queue: () => 'Checking the queue',
  add_to_queue: (a) => (a.playNext ? `Playing ${describePick(a)} next` : `Adding ${describePick(a)} to the queue`),
  play_queue_position: () => 'Jumping to a song in the queue',
  remove_from_queue: (a) => `Removing ${a.positions?.length === 1 ? 'a song' : `${a.positions?.length || ''} songs`} from the queue`,
  move_in_queue: () => 'Reordering the queue',
  clear_queue: () => 'Clearing the queue',
  list_playlists: () => 'Checking your playlists',
  get_playlist: (a) => `Opening ${String(a.playlist).toLowerCase() === 'favorites' ? 'Favorites' : quoted(a.playlist || 'a playlist')}`,
  set_favorite: (a) => `${a.favorite === false ? 'Unliking' : 'Liking'} ${describePick(a)}`,
  create_playlist: (a) => `Creating playlist ${quoted(a.name || '')}`,
  add_to_playlist: (a) => `Adding ${describePick(a)} to ${quoted(a.playlist || 'a playlist')}`,
  remove_from_playlist: (a) => `Removing songs from ${quoted(a.playlist || 'a playlist')}`,
  move_in_playlist: (a) => `Reordering ${quoted(a.playlist || 'a playlist')}`,
  rename_playlist: (a) => `Renaming a playlist to ${quoted(a.name || '')}`,
  delete_playlist: (a) => `Deleting ${quoted(a.playlist || 'a playlist')}`,
  show_view: (a) => (a.view ? `Showing ${a.view === 'playlist' ? quoted(a.playlist || 'a playlist') : a.view}` : 'Changing the view'),
  get_settings: () => 'Checking settings',
  update_settings: () => 'Changing settings',
  manage_spotify: (a) => ({ restart: 'Restarting Spotify', show_login: 'Opening Spotify to sign in' })[a.action] || 'Changing Spotify startup',
  WebSearch: (a) => (a.query ? `Searching the web for ${quoted(a.query)}` : 'Searching the web'),
  WebFetch: () => 'Reading a web page',
  Agent: (a) => a.description || 'Running a helper agent',
  Task: (a) => a.description || 'Running a helper agent',
};

// Claude says mcp__maestro__play or "maestro: play", Codex says mcp.maestro.play (and "Web search" for its own).
const toolKey = (e) =>
  e.input?.type === 'webSearch' ? 'WebSearch' : String(e.name || e.title || '').replace(/^(mcp(__|\.))?maestro(__|\s*[:.]\s*)/i, '').trim();
// Codex wraps MCP arguments as { server, tool, arguments }.
const toolArgs = (e) => (e.input?.tool && e.input.arguments ? e.input.arguments : e.input || {});

function toolLabel(e) {
  const label = TOOL_LABELS[toolKey(e)];
  try {
    if (label) return label(toolArgs(e));
  } catch {} // arguments still streaming in
  return e.title || toolKey(e) || 'Working';
}

// ---- drawing -----------------------------------------------------------------------------------------------------

/** Agent text: escaped, with **bold**, `code`, and [links](https://…); line breaks come from white-space: pre-wrap. */
function chatHtml(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

const toolState = (e) => (e.status === 'failed' ? 'failed' : e.status === 'completed' ? 'done' : 'running');
const toolMark = (state) => (state === 'running' ? '<span class="spin"></span>' : icon(state === 'done' ? 'check' : 'close', 14));

function toolRow(e) {
  const state = toolState(e);
  const label = toolLabel(e);
  return `<div class="msg tool ${state}" title="${esc(e.error || label)}">${toolMark(state)}<span class="tool-text">${esc(label)}</span></div>`;
}

/** Several tool calls in a row fold into one line that shows what's happening now; click to see them all. */
function toolGroup(tools) {
  const key = tools[0].id;
  const open = chat.openGroups.has(key);
  const running = tools.findLast((t) => toolState(t) === 'running');
  const failed = tools.filter((t) => toolState(t) === 'failed').length;
  const state = running ? 'running' : 'done';
  const text = running ? toolLabel(running) : `Used ${tools.length} tools` + (failed ? ` · ${failed} failed` : '');
  return `<div class="tool-group${open ? ' open' : ''}">
    <button type="button" class="msg tool ${state}" data-tool-group="${esc(key)}" aria-expanded="${open}">${toolMark(state)}<span class="tool-text">${esc(text)}</span><span class="tool-count">${running ? tools.length : ''}</span>${icon('chevronDown', 14)}</button>
    ${open ? `<div class="tool-list">${tools.map(toolRow).join('')}</div>` : ''}
  </div>`;
}

function chatEntry(e, i) {
  if (e.k === 'user') return `<div class="msg user">${esc(e.text)}</div>`;
  if (e.k === 'agent') return `<div class="msg reply" data-i="${i}">${chatHtml(e.text)}</div>`;
  if (e.k === 'error') return `<div class="msg error">${esc(e.text)}</div>`;
  if (e.k === 'note') return `<div class="msg note">${esc(e.text)}</div>`;
  return '';
}

function chatLogHtml() {
  let html = '';
  for (let i = 0; i < chat.log.length; i++) {
    if (chat.log[i].k !== 'tool') {
      html += chatEntry(chat.log[i], i);
      continue;
    }
    const tools = [];
    while (chat.log[i]?.k === 'tool') tools.push(chat.log[i++]);
    i--;
    html += tools.length === 1 ? toolRow(tools[0]) : toolGroup(tools);
  }
  return html;
}

function renderChatLog() {
  const log = $('#agentLog');
  if (!log) return;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  let html = '';
  if (chat.log.length) {
    html = chatLogHtml();
  } else if (chat.status !== 'signin' && chat.status !== 'install') {
    html = `<div class="agent-empty">
      <div class="agent-empty-icon">${icon('sparkle', 28)}</div>
      <h2>What do you want to hear?</h2>
      <p>Ask ${esc(agentName())} to play, queue, like, or organize your music. It can do anything you can do in Maestro.</p>
      <div class="agent-chips">${CHAT_SUGGESTIONS.map((s) => `<button class="agent-chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    </div>`;
  }
  if (chat.status === 'install' && chat.needsInstall) {
    const ni = chat.needsInstall;
    html += `<div class="agent-card"><div><strong>${esc(ni.message)}</strong></div>
      <div class="agent-card-detail">${esc(ni.detail || '')}</div>
      <div class="agent-card-actions">
        ${ni.needsNode ? '<button class="btn primary" data-open-node>Get Node.js</button>' : `<button class="btn primary" data-chat-install>${esc(ni.buttonLabel || `Install ${agentName()}`)}</button>`}
      </div></div>`;
  } else if (chat.status === 'signin' && chat.signIn) {
    html += `<div class="agent-card"><div>${esc(chat.signIn.message)}</div>
      <div class="agent-card-actions">
        ${(chat.signIn.methods || []).map((m) => `<button class="btn ghost" data-signin="${esc(m.id)}" title="${esc(m.description || '')}">${esc(m.name)}</button>`).join('')}
        <button class="btn primary" data-chat-retry>I've signed in</button>
      </div></div>`;
  } else if (chat.status === 'installing') {
    // Starting happens quietly (a message sent meanwhile waits for it); installing is something the user asked for.
    html += `<div class="msg note busy"><span class="spin"></span>${esc(chat.message)}</div>`;
  } else if (chat.status === 'error') {
    html += `<div class="agent-card error"><div>${esc(chat.message)}</div><div class="agent-card-actions">
      ${chat.needsNode ? '<button class="btn ghost" data-open-node>Get Node.js</button>' : ''}
      <button class="btn ghost" data-chat-retry>Try again</button></div></div>`;
  }
  const last = chat.log.at(-1);
  if (chat.busy && (!last || last.k === 'user' || (last.k === 'tool' && toolFinished(last)))) {
    html += `<div class="msg typing">${chat.thinking ? 'Thinking' : ''}<span></span><span></span><span></span></div>`;
  }
  log.innerHTML = html;
  if (atBottom || chat.busy) log.scrollTop = log.scrollHeight;
}

/** Streaming text only changes the last message, so update just that one. */
function paintChatStream() {
  const el = $$('#agentLog .msg.reply').at(-1);
  const i = chat.log.indexOf(chat.stream);
  if (el && +el.dataset.i === i && !$('#agentLog .msg.typing')) {
    el.innerHTML = chatHtml(chat.stream.text);
    const log = $('#agentLog');
    log.scrollTop = log.scrollHeight;
  } else renderChatLog();
}

function renderChatBar() {
  const model = chatOption('model');
  const effort = chatOption('thought_level');
  const pick = $('#agentPick');
  pick.innerHTML = `<span class="agent-pick-name">${esc(agentName())}</span>${icon('chevronDown', 14)}`;
  pick.title = `Agent: ${agentName()}`;
  const mod = $('#agentModel');
  mod.hidden = !model;
  if (model) mod.innerHTML = `<span class="agent-pick-name">${esc(optionName(model))}</span>${icon('chevronDown', 14)}`;
  mod.title = model ? `${model.name || 'Model'}: ${optionName(model)}` : '';
  const eff = $('#agentEffort');
  eff.hidden = !effort;
  if (effort) eff.innerHTML = `<span class="agent-pick-name">${effort.currentValue === 'default' ? 'Default' : esc(optionName(effort))}</span>${icon('chevronDown', 14)}`;
  eff.title = effort ? `${effort.name}: ${optionName(effort)}` : '';
  const acc = $('#agentAccess');
  const level = chat.access?.level || 'recommended';
  const meta = accessMeta(level);
  acc.innerHTML = icon('shield', 15);
  acc.classList.toggle('warn', accessIsRisky(level, chat.access?.custom));
  acc.title = `Access: ${meta.name} — ${accessSummary(level, chat.access?.custom || [])}`;
  const send = $('#agentSend');
  send.innerHTML = icon(chat.busy ? 'stop' : 'send', 16);
  send.title = chat.busy ? 'Stop' : 'Send (Enter)';
  send.classList.toggle('stop', chat.busy);
  send.disabled = !chat.busy && !$('#agentInput').value.trim();
  $('#agentAccount').textContent = chat.account || '';
}

function renderChat() {
  $('.app').classList.toggle('agent-open', chat.open);
  $('#agentPanel').hidden = !chat.open;
  $('#btnAgent').classList.toggle('on', chat.open);
  if (!chat.open) return;
  renderChatLog();
  renderChatBar();
}

async function openAgentMenu() {
  if (!chat.agents.length) {
    try { await loadChatMeta(); } catch {}
  }
  const all = chat.agents.length ? chat.agents : [{ id: chat.agent, name: agentName(), available: true, featured: true }];
  const featured = all.filter((a) => a.featured !== false);
  const extras = all.filter((a) => a.featured === false);
  const currentExtra = extras.find((a) => a.id === chat.agent);
  const shown = currentExtra ? [...featured, currentExtra] : featured;
  const entries = [
    { label: 'Agent' },
    ...shown.map((a) => ({
      checked: a.id === chat.agent,
      text: a.name,
      desc: !a.available ? a.problem : a.installed === false ? 'Not installed' : undefined,
      run: () => chatSwitchAgent(a.id),
    })),
  ];
  if (extras.length) {
    entries.push({
      text: 'More agents…',
      desc: `${extras.length} more from the ACP registry`,
      run: openMoreAgentsDialog,
    });
  }
  openMenu($('#agentPick').getBoundingClientRect(), entries);
}

function openModelMenu() {
  const model = chatOption('model');
  if (!model) return;
  const entries = [{ label: model.name || 'Model' }];
  for (const v of optionValues(model)) entries.push({ checked: v.value === model.currentValue, text: v.name || v.value, run: () => setChatOption(model.id, v.value) });
  openMenu($('#agentModel').getBoundingClientRect(), entries);
}

async function openMoreAgentsDialog() {
  try {
    await loadChatMeta();
  } catch (err) {
    return toast(err.message, { error: true });
  }
  const dlg = $('#agentMoreDialog');
  const search = $('#agentMoreSearch');
  const list = $('#agentMoreList');
  search.value = '';
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const matches = chat.agents.filter(
      (a) => !q || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q),
    );
    if (!matches.length) {
      list.innerHTML = '<div class="agent-more-empty">No matching agents.</div>';
      return;
    }
    list.innerHTML = matches
      .map(
        (a) => `<button type="button" class="agent-more-item${a.id === chat.agent ? ' active' : ''}" data-agent-id="${esc(a.id)}">
          <span class="agent-more-check">${a.id === chat.agent ? icon('check', 14) : ''}</span>
          <span class="agent-more-body">
            <span class="agent-more-name">${esc(a.name)}${!a.available ? ` <span class="access-tag">${esc(a.problem)}</span>` : a.installed === false ? ' <span class="access-tag">Not installed</span>' : ''}</span>
            ${a.description ? `<span class="agent-more-desc">${esc(a.description)}</span>` : ''}
          </span>
        </button>`,
      )
      .join('');
  };
  search.oninput = paint;
  list.onclick = (e) => {
    const b = e.target.closest('button[data-agent-id]');
    if (!b || b.disabled) return;
    dlg.close();
    chatSwitchAgent(b.dataset.agentId);
  };
  paint();
  dlg.showModal();
  search.focus();
}

function openEffortMenu() {
  const entries = [];
  for (const o of [chatOption('thought_level'), chatOption('speed')].filter(Boolean)) {
    if (entries.length) entries.push('-');
    entries.push({ label: o.name });
    if (o.type === 'boolean') entries.push({ checked: !!o.currentValue, text: 'On', run: () => setChatOption(o.id, !o.currentValue) });
    else for (const v of optionValues(o)) entries.push({ checked: v.value === o.currentValue, text: v.name || v.value, run: () => setChatOption(o.id, v.value) });
  }
  openMenu($('#agentEffort').getBoundingClientRect(), entries);
}

function toggleChat(open = !chat.open) {
  chat.open = open;
  persistChat();
  renderChat();
  if (!open) return;
  $('#agentInput').focus();
  if (chat.status === 'idle') chatConnect();
}

function sizeChatInput() {
  const input = $('#agentInput');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

function wireChat() {
  hydrateIcons($('#agentPanel'));
  $('#btnAgent').onclick = () => toggleChat();
  // Get the agent going while the pointer heads for the button; starting takes a few seconds.
  $('#btnAgent').addEventListener('pointerenter', () => chat.status === 'idle' && chatConnect());
  $('#agentClose').onclick = () => toggleChat(false);
  $('#agentNew').onclick = chatNew;
  $('#agentPick').onclick = openAgentMenu;
  $('#agentModel').onclick = openModelMenu;
  $('#agentEffort').onclick = openEffortMenu;
  $('#agentAccess').onclick = openAccessMenu;
  loadChatMeta().then(renderChatBar).catch(() => {});
  const input = $('#agentInput');
  const submit = async () => {
    if (chat.busy) return chatStop();
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    sizeChatInput();
    if (!(await chatSend(text))) input.value ||= text; // couldn't send: give it back
    renderChatBar();
  };
  $('#agentForm').onsubmit = (e) => {
    e.preventDefault();
    submit();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    sizeChatInput();
    renderChatBar();
  });
  $('#agentLog').addEventListener('click', (e) => {
    const s = e.target.closest('[data-suggest]');
    if (s) return chatSend(s.dataset.suggest);
    const g = e.target.closest('[data-tool-group]');
    if (g) {
      const key = g.dataset.toolGroup;
      if (!chat.openGroups.delete(key)) chat.openGroups.add(key);
      return renderChatLog();
    }
    if (e.target.closest('[data-chat-install]')) return chatInstall();
    if (e.target.closest('[data-chat-retry]')) return chatConnect();
    if (e.target.closest('[data-open-node]')) return window.open('https://nodejs.org/', '_blank');
    const m = e.target.closest('[data-signin]');
    if (m) {
      api('/api/chat/signin', { method: 'POST', body: { methodId: m.dataset.signin } })
        .then((r) => (r.terminal ? toast('Finish signing in in the window that opened, then choose “I’ve signed in”.', { ms: 6000 }) : chatConnect()))
        .catch((err) => toast(err.message, { error: true }));
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'j' && (e.ctrlKey || e.metaKey) && !e.altKey) {
      e.preventDefault();
      toggleChat();
    }
  });
  if (chat.open) toggleChat(true);
  else renderChat();
}

wireChat();
