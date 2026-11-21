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
  prefs: chatSaved.prefs || {}, // agent id -> { config option id: value } picked by the user
  agents: [],
  access: null, // { level, custom, recommended, capabilities } from AgentAccess.cs
  status: 'idle', // idle | connecting | ready | signin | error
  message: '', // what the status means right now
  signIn: null,
  account: '',
  configOptions: [],
  busy: false,
  thinking: false,
  stream: null, // the agent message being written
  connecting: null,
};

const CHAT_LOG_MAX = 200;
const toolFinished = (e) => e.status === 'completed' || e.status === 'failed';
// Tool calls still marked running when Maestro last closed won't hear back.
for (const e of chat.log) if (e.k === 'tool' && !toolFinished(e)) e.status = 'completed';
const CHAT_SUGGESTIONS = ['Play something upbeat', "What's playing?", 'Queue 5 songs like this one', 'Save my queue as a playlist'];

function persistChat() {
  localStorage.setItem(
    'maestro.agent',
    JSON.stringify({ open: chat.open, agent: chat.agent, sessionId: chat.sessionId, log: chat.log.slice(-CHAT_LOG_MAX), prefs: chat.prefs }),
  );
}

// ---- config options (model, effort, ...) as the agent describes them --------------------------------------------

const chatOption = (category) => chat.configOptions.find((o) => o.category === category || o.id === category);
const optionValues = (o) => (o?.options || []).flatMap((v) => (Array.isArray(v.options) ? v.options : [v]));
const optionName = (o) => optionValues(o).find((v) => v.value === o?.currentValue)?.name || o?.currentValue || '';
const agentName = (id = chat.agent) => chat.agents.find((a) => a.id === id)?.name || { 'claude-acp': 'Claude', 'codex-acp': 'Codex' }[id] || id;

function applyChatSnapshot(r) {
  chat.account = r.account || chat.account;
  chat.configOptions = r.configOptions || [];
  chat.busy = !!r.busy;
}

async function setChatOption(id, value, { remember = true } = {}) {
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
  renderChat();
  chat.connecting = (async () => {
    try {
      await loadChatMeta();
      const a = chat.agents.find((x) => x.id === chat.agent);
      if (a && !a.available) throw Object.assign(new Error(`${a.name} needs Node.js to run. Install it, then try again.`), { node: true });
      const slow = setTimeout(() => {
        chat.message = `Starting ${agentName()}… The first time, this downloads it and can take a minute.`;
        renderChat();
      }, 4000);
      let r;
      try {
        r = await api('/api/chat/connect', { method: 'POST', body: { agent: chat.agent, sessionId: fresh ? null : chat.sessionId } });
      } finally {
        clearTimeout(slow);
      }
      if (r.signIn) {
        chat.status = 'signin';
        chat.signIn = r.signIn;
        return false;
      }
      applyChatSnapshot(r);
      if (chat.sessionId && r.sessionId !== chat.sessionId && chat.log.some((e) => e.k === 'user')) {
        chat.log.push({ k: 'note', text: "New conversation. The agent doesn't remember the messages above." });
      }
      chat.sessionId = r.sessionId;
      chat.status = 'ready';
      chat.message = '';
      await applyChatPrefs();
      return true;
    } catch (err) {
      chat.status = 'error';
      chat.message = err.message;
      chat.needsNode = !!err.node;
      return false;
    } finally {
      chat.connecting = null;
      persistChat();
      renderChat();
    }
  })();
  return chat.connecting;
}

async function chatSend(text) {
  text = text.trim();
  if (!text || chat.busy) return false;
  if (chat.status !== 'ready' && !(await chatConnect())) return false;
  chat.log.push({ k: 'user', text });
  chat.busy = true;
  chat.thinking = false;
  chat.stream = null;
  persistChat();
  renderChat();
  try {
    await api('/api/chat/prompt', { method: 'POST', body: { text } });
  } catch (err) {
    chat.busy = false;
    chat.log.push({ k: 'error', text: err.message });
    renderChat();
  }
  return true;
}

function chatStop() {
  api('/api/chat/cancel', { method: 'POST' }).catch((err) => toast(err.message, { error: true }));
}

async function chatNew() {
  if (chat.busy) chatStop();
  chat.log = [];
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
  Object.assign(chat, { agent: id, sessionId: null, log: [], stream: null, account: '', configOptions: [], status: 'idle' });
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
    } else if (ev.state === 'starting' && chat.status !== 'connecting') {
      chat.status = 'connecting';
      chat.message = ev.message;
    }
  } else if (ev.type === 'account') {
    chat.account = ev.account || '';
  } else if (ev.type === 'options') {
    chat.configOptions = ev.configOptions || [];
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
  search: (a) => `Searching ${quoted(a.query || '')}`,
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
  show_view: (a) => `Showing ${a.view === 'playlist' ? quoted(a.playlist || 'a playlist') : a.view}`,
  get_settings: () => 'Checking settings',
  update_settings: () => 'Changing settings',
  manage_spotify: (a) => ({ restart: 'Restarting Spotify', show_login: 'Opening Spotify to sign in' })[a.action] || 'Changing Spotify startup',
  WebSearch: (a) => (a.query ? `Searching the web for ${quoted(a.query)}` : 'Searching the web'),
  WebFetch: () => 'Reading a web page',
  Agent: (a) => a.description || 'Running a helper agent',
  Task: (a) => a.description || 'Running a helper agent',
};

// Claude says mcp__maestro__play or "maestro: play", Codex says mcp.maestro.play.
const toolKey = (e) => String(e.name || e.title || '').replace(/^(mcp(__|\.))?maestro(__|\s*[:.]\s*)/i, '').trim();

function toolLabel(e) {
  const label = TOOL_LABELS[toolKey(e)];
  try {
    if (label) return label(e.input || {});
  } catch {} // arguments still streaming in
  return e.title || toolKey(e) || 'Working';
}

// ---- drawing -----------------------------------------------------------------------------------------------------

/** Agent text: escaped, with **bold** and `code`; line breaks come from white-space: pre-wrap. */
function chatHtml(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

function chatEntry(e, i) {
  if (e.k === 'user') return `<div class="msg user">${esc(e.text)}</div>`;
  if (e.k === 'agent') return `<div class="msg agent" data-i="${i}">${chatHtml(e.text)}</div>`;
  if (e.k === 'error') return `<div class="msg error">${esc(e.text)}</div>`;
  if (e.k === 'note') return `<div class="msg note">${esc(e.text)}</div>`;
  if (e.k === 'tool') {
    const state = e.status === 'failed' ? 'failed' : e.status === 'completed' ? 'done' : 'running';
    const mark = state === 'running' ? '<span class="spin"></span>' : icon(state === 'done' ? 'check' : 'close', 14);
    return `<div class="msg tool ${state}" title="${esc(e.error || '')}">${mark}<span>${esc(toolLabel(e))}</span></div>`;
  }
  return '';
}

function renderChatLog() {
  const log = $('#agentLog');
  if (!log) return;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  let html;
  if (chat.status === 'signin' && chat.signIn) {
    html = `<div class="agent-card"><div>${esc(chat.signIn.message)}</div>
      <div class="agent-card-actions">
        ${(chat.signIn.methods || []).map((m) => `<button class="btn ghost" data-signin="${esc(m.id)}" title="${esc(m.description || '')}">${esc(m.name)}</button>`).join('')}
        <button class="btn primary" data-chat-retry>I've signed in</button>
      </div></div>`;
  } else if (!chat.log.length) {
    html = `<div class="agent-empty">
      <div class="agent-empty-icon">${icon('sparkle', 28)}</div>
      <h2>What do you want to hear?</h2>
      <p>Ask ${esc(agentName())} to play, queue, like, or organize your music. It can do anything you can do in Maestro.</p>
      <div class="agent-chips">${CHAT_SUGGESTIONS.map((s) => `<button class="agent-chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    </div>`;
  } else {
    html = chat.log.map(chatEntry).join('');
  }
  if (chat.status === 'connecting') html += `<div class="msg note busy"><span class="spin"></span>${esc(chat.message)}</div>`;
  else if (chat.status === 'error') {
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
  const el = $$('#agentLog .msg.agent').at(-1);
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
  pick.innerHTML = `<span class="agent-pick-name">${esc(agentName())}${model ? ` · ${esc(optionName(model))}` : ''}</span>${icon('chevronDown', 14)}`;
  pick.title = 'Choose the agent and model';
  const eff = $('#agentEffort');
  eff.hidden = !effort;
  if (effort) eff.innerHTML = `<span class="agent-pick-name">${effort.currentValue === 'default' ? 'Default effort' : esc(optionName(effort))}</span>${icon('chevronDown', 14)}`;
  eff.title = effort?.name || '';
  const acc = $('#agentAccess');
  const level = chat.access?.level || 'recommended';
  const meta = accessMeta(level);
  acc.innerHTML = `${icon('shield', 13)}<span class="agent-pick-name">${esc(meta.name)}</span>${icon('chevronDown', 14)}`;
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

function openAgentMenu() {
  const model = chatOption('model');
  const entries = [
    { label: 'Agent' },
    ...(chat.agents.length ? chat.agents : [{ id: chat.agent, name: agentName(), available: true }]).map((a) => ({
      checked: a.id === chat.agent, text: a.name + (a.available ? '' : ` (${a.problem})`),
      disabled: !a.available,
      run: () => chatSwitchAgent(a.id),
    })),
  ];
  if (model) {
    entries.push('-', { label: model.name || 'Model' });
    for (const v of optionValues(model)) entries.push({ checked: v.value === model.currentValue, text: v.name || v.value, run: () => setChatOption(model.id, v.value) });
  }
  openMenu($('#agentPick').getBoundingClientRect(), entries);
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
  $('#agentClose').onclick = () => toggleChat(false);
  $('#agentNew').onclick = chatNew;
  $('#agentPick').onclick = openAgentMenu;
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
