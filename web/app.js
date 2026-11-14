// OzBot dashboard. No framework: hash routes (#/, #/m/<id>, #/bot), polling /api/state every 5 s.
// Module pages = header + optional module panel (modules/<id>/panel.js) + a settings form built from the manifest.

export const ICONS = {
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/><path d="M8.5 10.5h7M8.5 14h4"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  wave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h1M7 8v8M11 4v16M15 7v10M19 10v4M22 12h-1"/></svg>',
  puzzle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3h7Z"/></svg>',
  cog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
};

// ---- tiny helpers --------------------------------------------------------------------------------------
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

async function call(method, path, body, { raw } = {}) {
  const opts = { method, headers: {} };
  if (body instanceof Blob) { opts.body = body; opts.headers['content-type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const r = await fetch(path, opts);
  if (raw && r.ok) return r;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `${r.status} ${r.statusText}`), { status: r.status, fields: j.fields });
  return j;
}

export function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3000);
}

export const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`; return `${Math.round(s / 86400)} days ago`;
};
const dur = (s) => s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`;

// ---- state ---------------------------------------------------------------------------------------------
let state = null;
let guild = null;      // { guild, guilds }
let voices = null;     // [{ id, profile... }]
let pageRefresh = null; // called on every poll for the current page
const app = document.getElementById('app');
document.getElementById('cog').innerHTML = ICONS.cog;

async function loadGuild(force) { if (!guild || force) guild = await call('GET', '/api/guild').catch(() => ({ guild: null, guilds: [] })); return guild; }
async function loadVoices(force) { if (!voices || force) voices = (await call('GET', '/api/voices').catch(() => ({ voices: [] }))).voices; return voices; }

const STATUS = {
  on: ['ok', 'On'], off: ['off', 'Off'], starting: ['warn', 'Starting'], faulted: ['bad', 'Faulted, switched off'],
  blocked: ['warn', 'Waiting'], broken: ['bad', 'Failed to load'],
};
const statusPill = (m) => { const [k, t] = STATUS[m.status] ?? ['off', m.status]; return h('span', { class: `pill ${k}` }, t); };
const BOT_STATE = { online: ['ok', 'Online'], connecting: ['warn', 'Connecting'], 'no-token': ['off', 'No token'], offline: ['bad', 'Offline'], error: ['bad', 'Error'] };

function renderConn() {
  const el = document.getElementById('conn');
  el.replaceChildren();
  if (!state) return;
  const b = state.bot;
  if (b.guild) el.append(h('div', { class: 'server', title: 'Server' },
    b.guild.icon ? h('img', { src: b.guild.icon, alt: '' }) : h('div', { class: 'noicon' }), h('span', {}, b.guild.name)));
  const [k, t] = BOT_STATE[b.state] ?? ['off', b.state];
  el.append(h('span', { class: `pill ${k}`, title: b.ping != null ? `Gateway ping ${b.ping} ms` : '' }, t));
}

async function poll() {
  try { state = await call('GET', '/api/state'); }
  catch { state = state ? { ...state, bot: { ...state.bot, state: 'offline', error: 'Dashboard cannot reach OzBot' } } : null; }
  renderConn();
  pageRefresh?.();
}

function switchFor(m, onDone) {
  const sw = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(m.enabled), 'aria-label': `${m.name} on/off`, disabled: m.status === 'broken' });
  sw.addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation();
    const on = sw.getAttribute('aria-checked') !== 'true';
    sw.disabled = true;
    try {
      const d = await call('POST', `/api/modules/${m.id}/enabled`, { enabled: on });
      toast(`${m.name} ${d.status === 'on' ? 'is on' : d.status === 'blocked' ? 'is waiting for ' + d.blockedBy.join(', ') : d.status === 'faulted' ? 'failed to start' : 'is off'}`, d.status === 'faulted' ? 'bad' : '');
      await poll(); onDone?.(d);
    } catch (err) { toast(err.message, 'bad'); }
    sw.disabled = false;
  });
  return sw;
}

// ---- pages ---------------------------------------------------------------------------------------------
function botBanner() {
  const b = state?.bot;
  if (!b) return null;
  if (b.state === 'no-token') return h('div', { class: 'banner info' }, 'OzBot has no Discord token yet. ', h('a', { href: '#/bot' }, 'Add it in Bot settings'), '.');
  if (b.state === 'error') return h('div', { class: 'banner bad' }, b.error ?? 'Could not connect to Discord.', ' ', h('a', { href: '#/bot' }, 'Bot settings'));
  if (b.state === 'online' && !b.guild) return h('div', { class: 'banner warn' }, b.guildCount ? 'Pick which server OzBot works in. ' : 'OzBot is not in any server yet. ',
    h('a', { href: '#/bot' }, b.guildCount ? 'Bot settings' : 'Invite it'), '.');
  return null;
}

function pageDashboard() {
  const grid = h('div', { class: 'grid' });
  const hero = h('div', { class: 'hero' });
  const banner = h('div');
  app.replaceChildren(banner, hero, grid);
  if (!state) grid.append(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  let last = '';
  pageRefresh = () => {
    if (!state) return;
    const b = state.bot;
    const key = JSON.stringify([b.state, b.guild?.id, b.error, b.ping, state.process.rssMB, state.modules.map((m) => [m.id, m.status, m.enabled])]);
    if (key === last) return; // don't rebuild (and steal focus) when nothing changed
    last = key;
    banner.replaceChildren(botBanner() ?? '');
    hero.replaceChildren(h('h1', {}, 'Functions'),
      h('p', {}, b.state === 'online' ? `${b.user?.tag ?? 'OzBot'} · up ${dur((Date.now() - b.readyAt) / 1000)} · ${b.ping ?? '–'} ms ping · ${state.process.rssMB} MB RAM` : `${state.process.rssMB} MB RAM`));
    grid.replaceChildren(...state.modules.map((m) => {
      const tile = h('a', { class: `tile is-${m.status}`, href: `#/m/${m.id}` },
        h('div', { class: 'ico', html: ICONS[m.icon] ?? ICONS.puzzle }),
        h('div', {}, h('h2', {}, m.name), h('p', {}, (m.description ?? '').split('\n')[0])),
        h('div', { class: 'foot' }, statusPill(m), switchFor(m)));
      return tile;
    }));
  };
  pageRefresh();
}

// Settings form from manifest fields.
async function settingsForm(fields, values, onSave) {
  if (fields.some((f) => /Channel/.test(f.type))) await loadGuild(true);
  if (fields.some((f) => f.type === 'voice')) await loadVoices(true);
  const g = guild?.guild;
  const form = h('form', { novalidate: true });
  const inputs = {};
  for (const f of fields) {
    const id = `f-${f.key}`;
    const help = f.help ? h('p', { class: 'help', id: `${id}-help` }, f.help) : null;
    const err = h('div', { class: 'err', id: `${id}-err` });
    const v = values[f.key];
    let input, wrap;
    if (f.type === 'boolean') {
      input = h('button', { type: 'button', class: 'switch', role: 'switch', id, 'aria-checked': String(Boolean(v)), 'aria-describedby': help ? `${id}-help` : null,
        onclick: () => input.setAttribute('aria-checked', String(input.getAttribute('aria-checked') !== 'true')) });
      input.read = () => input.getAttribute('aria-checked') === 'true';
      wrap = h('div', { class: 'field row' }, h('label', { for: id }, f.label), input, help, err);
    } else if (f.type === 'textChannels') {
      const chans = g?.textChannels ?? [];
      const box = h('div', { class: 'chips', role: 'group', 'aria-labelledby': `${id}-l` });
      for (const c of chans) {
        box.append(h('label', { class: 'chip', title: c.canRead ? c.category : 'OzBot cannot read this channel' },
          h('input', { type: 'checkbox', value: c.id, checked: (v ?? []).includes(c.id) }), `#${c.name}`, c.canRead ? null : h('small', {}, ' (no access)')));
      }
      for (const missing of (v ?? []).filter((x) => !chans.some((c) => c.id === x))) {
        box.append(h('label', { class: 'chip' }, h('input', { type: 'checkbox', value: missing, checked: true }), `unknown ${missing}`));
      }
      if (!chans.length) box.append(h('span', { class: 'muted' }, 'Connect the bot to a server to pick channels.'));
      input = box;
      input.read = () => [...box.querySelectorAll('input:checked')].map((i) => i.value);
      wrap = h('div', { class: 'field' }, h('span', { class: 'lbl', id: `${id}-l` }, f.label), help, box, err);
    } else {
      if (f.type === 'select' || f.type === 'textChannel' || f.type === 'voiceChannel' || f.type === 'voice') {
        let opts;
        if (f.type === 'select') opts = f.options.map((o) => [o.value, o.label]);
        else if (f.type === 'voice') opts = [['', 'Default voice'], ...(voices ?? []).map((x) => [x.id, x.profile.name || x.id])];
        else {
          const list = (f.type === 'textChannel' ? g?.textChannels : g?.voiceChannels) ?? [];
          opts = [['', '(none)'], ...list.map((c) => [c.id, `${f.type === 'textChannel' ? '#' : '🔊 '}${c.name}${c.category ? ` · ${c.category}` : ''}`])];
          if (v && !list.some((c) => c.id === v)) opts.push([v, `unknown ${v}`]);
        }
        if (f.type === 'voice' && f.key === 'defaultVoice') opts = opts.filter(([val]) => val !== '');
        input = h('select', { id, 'aria-describedby': help ? `${id}-help` : null }, ...opts.map(([val, label]) => h('option', { value: String(val), selected: String(val) === String(v ?? '') }, label)));
      } else if (f.type === 'textarea') {
        input = h('textarea', { id, maxlength: f.maxLength ?? 4000 }); input.value = v ?? '';
      } else if (f.type === 'number') {
        input = h('input', { type: 'number', id, inputmode: 'decimal', min: f.min, max: f.max, step: f.step ?? 'any', value: v });
      } else {
        input = h('input', { type: 'text', id, maxlength: f.maxLength ?? 300, value: v ?? '' });
      }
      input.read = () => input.value;
      wrap = h('div', { class: 'field' }, h('label', { for: id }, f.label), help, input, err);
    }
    inputs[f.key] = { input, err };
    form.append(wrap);
  }
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save settings');
  form.append(h('div', { class: 'actions' }, save));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    for (const [k, { input, err }] of Object.entries(inputs)) { body[k] = input.read(); err.textContent = ''; }
    save.disabled = true;
    try { await onSave(body); toast('Saved'); }
    catch (err) {
      toast(err.message, 'bad');
      for (const [k, msg] of Object.entries(err.fields ?? {})) if (inputs[k]) inputs[k].err.textContent = msg;
    }
    save.disabled = false;
  });
  return form;
}

async function pageModule(id) {
  let d;
  try { d = await call('GET', `/api/modules/${id}`); } catch (e) { app.replaceChildren(h('div', { class: 'banner bad' }, e.message)); return; }
  const head = h('div', { class: 'mhead' });
  const banners = h('div');
  const panelBox = h('div', { class: 'stack' });
  const settingsCard = h('section', { class: 'card' }, h('h2', {}, 'Settings'));
  app.replaceChildren(h('a', { class: 'back', href: '#/', html: ICONS.back + ' All functions' }), head, banners, panelBox, settingsCard);

  const drawHead = () => {
    head.replaceChildren(h('div', { class: 'ico', html: ICONS[d.icon] ?? ICONS.puzzle }),
      h('div', { class: 'txt' }, h('h1', {}, d.name, statusPill(d)), h('p', {}, d.description)),
      switchFor(d, async () => { d = await call('GET', `/api/modules/${id}`); drawHead(); panelApi.emit(); }));
    banners.replaceChildren(
      botBanner() ?? '',
      d.status === 'faulted' && d.error ? h('div', { class: 'banner bad' }, h('strong', {}, 'Switched off automatically. '), d.error, ' Fix the cause, then switch it back on.') : '',
      d.status === 'blocked' ? h('div', { class: 'banner warn' }, `Waiting for ${d.blockedBy.join(', ')} to be switched on.`) : '',
      d.status === 'off' && d.enabled === false ? h('div', { class: 'banner info' }, 'This function is off. Settings still save and apply when you switch it on.') : '',
    );
  };
  drawHead();

  // panel API handed to modules/<id>/panel.js
  const listeners = new Set();
  const panelApi = {
    h, toast, ago, icons: ICONS,
    get: (name) => call('GET', `/api/m/${id}/${name}`),
    post: (name, body = {}) => call('POST', `/api/m/${id}/${name}`, body),
    put: (name, body, query = {}) => call('PUT', `/api/m/${id}/${name}?${new URLSearchParams(query)}`, body),
    fetchRaw: (name, body = {}) => call('POST', `/api/m/${id}/${name}`, body, { raw: true }),
    guild: () => loadGuild(true),
    voices: () => loadVoices(true),
    get module() { return d; },
    onUpdate(fn) { listeners.add(fn); },
    // warn(): message to show before leaving (or null = nothing to lose); leave(): runs once the user has left
    guardLeave(warn, leave) { leaveGuards.push({ warn, leave }); },
    emit() { for (const fn of listeners) { try { fn(d); } catch (e) { console.error(e); } } },
    async refresh() { d = await call('GET', `/api/modules/${id}`); drawHead(); panelApi.emit(); },
  };
  if (d.hasPanel) {
    try {
      const mod = await import(`/modules/${id}/panel.js?v=${state?.version ?? ''}`);
      await mod.render(panelBox, panelApi);
      panelApi.emit();
    } catch (e) { panelBox.append(h('div', { class: 'banner bad' }, `Panel failed to load: ${e.message}`)); }
  }
  if (d.fields?.length) {
    settingsCard.append(await settingsForm(d.fields, d.settings, async (body) => {
      d = await call('PUT', `/api/modules/${id}/settings`, body); drawHead(); panelApi.emit();
    }));
  } else settingsCard.append(h('p', { class: 'muted' }, 'Nothing to set up.'));

  let n = 0;
  pageRefresh = async () => {
    if (++n % 2) return; // every 10 s
    try { d = await call('GET', `/api/modules/${id}`); drawHead(); panelApi.emit(); } catch {}
  };
}

async function pageBot() {
  const core = await call('GET', '/api/core');
  const info = h('section', { class: 'card' });
  const tokenCard = h('section', { class: 'card' }, h('h2', {}, 'Discord token'));
  const settings = h('section', { class: 'card' }, h('h2', {}, 'Bot'));
  app.replaceChildren(h('a', { class: 'back', href: '#/', html: ICONS.back + ' All functions' }),
    h('div', { class: 'mhead' }, h('div', { class: 'ico', html: ICONS.cog }), h('div', { class: 'txt' }, h('h1', {}, 'Bot settings'),
      h('p', {}, 'Connection to Discord, which server OzBot works in and how it shows up there.'))),
    h('div', { class: 'cols' }, info, tokenCard), h('div', { style: 'height:16px' }), settings,
    h('section', { class: 'card' }, h('h2', {}, 'Channels and function settings'),
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Each function keeps its own settings (which channels to read, which voice channel to sit in…) on its own page:'),
      h('div', { class: 'actions', style: 'margin-top:0' }, ...(state?.modules ?? []).map((m) =>
        h('a', { class: 'btn', href: `#/m/${m.id}` }, h('span', { html: ICONS[m.icon] ?? ICONS.puzzle, style: 'width:18px;height:18px;display:inline-flex' }), m.name)))));

  const drawInfo = () => {
    const b = state?.bot ?? core.bot;
    const [k, t] = BOT_STATE[b.state] ?? ['off', b.state];
    info.replaceChildren(h('h2', {}, 'Status'), h('dl', { class: 'kv' },
      h('dt', {}, 'Discord'), h('dd', {}, h('span', { class: `pill ${k}` }, t)),
      b.error ? [h('dt', {}, 'Problem'), h('dd', {}, b.error)] : null,
      h('dt', {}, 'Logged in as'), h('dd', {}, b.user?.tag ?? '–'),
      h('dt', {}, 'Server'), h('dd', {}, b.guild?.name ?? (b.guildCount ? 'not chosen' : 'none')),
      h('dt', {}, 'Ping'), h('dd', {}, b.ping != null ? `${b.ping} ms` : '–'),
      h('dt', {}, 'Memory'), h('dd', {}, state ? `${state.process.rssMB} MB (bot)${state.tts.workerRunning ? ' + voice engine running' : ', voice engine asleep'}` : '–'),
      h('dt', {}, 'Version'), h('dd', {}, state?.version ?? '–')),
      b.invite ? h('div', { class: 'actions' }, h('a', { class: 'btn', href: b.invite, target: '_blank', rel: 'noopener' }, 'Invite to a server')) : '');
  };
  drawInfo();
  pageRefresh = drawInfo;

  const tok = h('input', { type: 'password', id: 'tok', autocomplete: 'off', placeholder: core.bot.hasToken ? '•••••••• (saved, paste to replace)' : 'Paste the bot token' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, core.bot.hasToken ? 'Replace token' : 'Save token');
  tokenCard.append(
    core.bot.tokenFromEnv ? h('div', { class: 'banner info' }, 'The token comes from the OZBOT_TOKEN environment variable; that one wins.') : '',
    h('form', { onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true;
      try { await call('PUT', '/api/core/token', { token: tok.value }); tok.value = ''; toast('Token saved, connecting…'); await poll(); }
      catch (err) { toast(err.message, 'bad'); }
      btn.disabled = false;
    } },
    h('div', { class: 'field' }, h('label', { for: 'tok' }, 'Bot token'),
      h('p', { class: 'help' }, 'Discord developer portal → your application → Bot → Reset Token. Also turn on “Message Content Intent” on that page.'), tok),
    h('div', { class: 'actions' }, btn)));

  settings.append(await settingsForm(core.fields, core.settings, async (body) => {
    await call('PUT', '/api/core', body); await poll(); guild = null;
  }));
}

// ---- router --------------------------------------------------------------------------------------------
let leaveGuards = [];
let currentHash = location.hash || '#/';
let ignoreHash = false;

function pendingLeaveMessage() {
  for (const g of leaveGuards) { const m = g.warn?.(); if (m) return m; }
  return null;
}
function runLeave() {
  for (const g of leaveGuards.splice(0)) { try { g.leave?.(); } catch (e) { console.error(e); } }
}
window.addEventListener('beforeunload', (e) => { if (pendingLeaveMessage()) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('pagehide', (e) => { if (!e.persisted) runLeave(); });

async function route() {
  if (ignoreHash) { ignoreHash = false; return; }
  const msg = pendingLeaveMessage();
  if (msg && !confirm(msg)) { ignoreHash = true; location.hash = currentHash; return; }
  runLeave();
  currentHash = location.hash || '#/';
  pageRefresh = null;
  const hash = location.hash || '#/';
  let m;
  window.scrollTo(0, 0);
  try {
    if ((m = hash.match(/^#\/m\/([a-z0-9-]+)/))) await pageModule(m[1]);
    else if (hash.startsWith('#/bot')) await pageBot();
    else pageDashboard();
  } catch (e) { app.replaceChildren(h('div', { class: 'banner bad' }, e.message)); }
}

window.addEventListener('hashchange', route);
await poll();
route();
setInterval(poll, 5000);
