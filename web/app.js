// OzBot dashboard. No framework: hash routes (#/, #/m/<id>, #/bot), polling /api/state every 5 s.
// Module pages = header + optional module panel (modules/<id>/panel.js) + a settings form built from the manifest.

export const ICONS = {
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/><path d="M8.5 10.5h7M8.5 14h4"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  wave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h1M7 8v8M11 4v16M15 7v10M19 10v4M22 12h-1"/></svg>',
  quote: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4V5Z"/><path d="M9 9.5c0 1.5-.8 2.5-2 3M14.5 9.5c0 1.5-.8 2.5-2 3"/></svg>',
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
  if (fields.some((f) => /Channel/.test(f.type) || f.type === 'role')) await loadGuild(true);
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
      if (f.type === 'select' || f.type === 'textChannel' || f.type === 'voiceChannel' || f.type === 'voice' || f.type === 'role') {
        let opts;
        if (f.type === 'select') opts = f.options.map((o) => [o.value, o.label]);
        else if (f.type === 'voice') opts = [['', 'Default voice'], ...(voices ?? []).map((x) => [x.id, x.profile.name || x.id])];
        else if (f.type === 'role') {
          opts = [['', 'Everyone'], ...(g?.roles ?? []).map((r) => [r.id, `@${r.name}`])];
          if (v && !(g?.roles ?? []).some((r) => r.id === v)) opts.push([v, `unknown role ${v}`]);
        }
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

// Bot settings: Connection, then everything that applies Everywhere, then everything for one server.
async function pageBot() {
  const core = await call('GET', '/api/core');
  const info = h('section', { class: 'card' });
  const tokenCard = h('section', { class: 'card' }, h('h2', {}, 'Discord token'));
  const pick = (keys) => core.fields.filter((f) => keys.includes(f.key));
  const saveCore = async (body) => { await call('PUT', '/api/core', body); await poll(); guild = null; };

  const presence = h('section', { class: 'card' }, h('h2', {}, 'Presence'),
    h('p', { class: 'muted', style: 'margin-top:-6px' }, 'Discord shows one status for a bot in every server.'));
  const serverPick = h('section', { class: 'card' }, h('h2', {}, 'Server'));
  const globalProfile = profileCard('global');
  const serverProfile = profileCard('server');
  const acc = accessCards();
  const b = core.bot;
  const gName = b.guild?.name ?? 'this server';

  app.replaceChildren(h('a', { class: 'back', href: '#/', html: ICONS.back + ' All functions' }),
    h('div', { class: 'mhead' }, h('div', { class: 'ico', html: ICONS.cog }), h('div', { class: 'txt' }, h('h1', {}, 'Bot settings'),
      h('p', {}, 'Everything about OzBot itself. What each function does (channels, voices…) is on that function’s own page.'))),
    h('nav', { class: 'jump', 'aria-label': 'Sections' }, h('a', { href: '#/bot', onclick: jump('s-conn') }, 'Connection'),
      h('a', { href: '#/bot', onclick: jump('s-global') }, 'Everywhere'), h('a', { href: '#/bot', onclick: jump('s-server') }, `In ${gName}`)),
    h('div', { class: 'cols', id: 's-conn' }, info, tokenCard),
    scopeSection('s-global', 'globe', 'Everywhere', 'Applies in every server OzBot is in, and in DMs.',
      globalProfile.el, presence, acc.globalEl),
    scopeSection('s-server', 'server', `In ${gName}`, b.guild ? 'Only applies in this server. Admins (Manage Server) can always use every command and skip cooldowns.' : 'Invite OzBot to a server to set these.',
      serverPick, serverProfile.el, acc.serverEl),
    h('section', { class: 'card' }, h('h2', {}, 'Function settings'),
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Each function keeps its own settings (which channels to read, which voice channel to sit in…) on its own page:'),
      h('div', { class: 'actions', style: 'margin-top:0' }, ...(state?.modules ?? []).map((m) =>
        h('a', { class: 'btn', href: `#/m/${m.id}` }, h('span', { html: ICONS[m.icon] ?? ICONS.puzzle, style: 'width:18px;height:18px;display:inline-flex' }), m.name)))));

  const drawInfo = () => {
    const b = state?.bot ?? core.bot;
    const [k, t] = BOT_STATE[b.state] ?? ['off', b.state];
    info.replaceChildren(h('h2', {}, 'Connection'), h('dl', { class: 'kv' },
      h('dt', {}, 'Discord'), h('dd', {}, h('span', { class: `pill ${k}` }, t)),
      b.error ? [h('dt', {}, 'Problem'), h('dd', {}, b.error)] : null,
      h('dt', {}, 'Logged in as'), h('dd', {}, b.user?.tag ?? '–'),
      h('dt', {}, 'Server'), h('dd', {}, b.guild?.name ?? (b.guildCount ? 'not chosen' : 'none')),
      h('dt', {}, 'Ping'), h('dd', {}, b.ping != null && b.ping >= 0 ? `${b.ping} ms` : '–'),
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

  presence.append(await settingsForm(pick(['presence', 'activityType', 'statusText', 'showFunctionStatus']), core.settings, async (body) => {
    await saveCore(body); globalProfile.load(); serverProfile.load();
  }));
  serverPick.append(await settingsForm(pick(['guildId']), core.settings, async (body) => {
    const changed = body.guildId !== core.settings.guildId;
    await saveCore(body);
    if (changed) route(); // everything below belongs to the server
  }));
}

function jump(id) {
  return (e) => {
    e.preventDefault();
    const el = document.getElementById(id);
    el?.setOpen?.(true); // jumping to a collapsed section opens it
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
}

const SCOPE_ICONS = {
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3Z"/><path d="M9 10h.01M15 10h.01M9 15c1.7 1.3 4.3 1.3 6 0"/></svg>',
};
// Collapsible scope (Everywhere / In <server>). Open or closed is remembered in this browser.
const COLLAPSE_KEY = 'ozbot.bot.collapsed';
const collapsed = () => { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]')); } catch { return new Set(); } };
function scopeSection(id, icon, title, text, ...kids) {
  const body = h('div', { class: 'scope-body', id: `${id}-body` }, ...kids);
  const btn = h('button', { type: 'button', class: 'scope', 'aria-controls': `${id}-body` },
    h('span', { class: 'sico', html: SCOPE_ICONS[icon] }), h('span', { class: 'stxt' }, h('h2', {}, title), h('p', {}, text)),
    h('span', { class: 'chev', 'aria-hidden': 'true', html: ICONS.back }));
  const wrap = h('section', { class: 'scope-wrap', id, 'aria-label': title }, btn, body);
  wrap.setOpen = (open) => {
    btn.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    const set = collapsed();
    if (open) set.delete(id); else set.add(id);
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch {}
  };
  btn.onclick = () => wrap.setOpen(btn.getAttribute('aria-expanded') !== 'true');
  const startOpen = !collapsed().has(id);
  btn.setAttribute('aria-expanded', String(startOpen)); body.hidden = !startOpen;
  return wrap;
}

// ---- Profile card (one per scope): preview + editors ---------------------------------------------------------
const ACT_PREFIX = { custom: '', playing: 'Playing ', listening: 'Listening to ', watching: 'Watching ', competing: 'Competing in ' };
const DOT = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', invisible: 'Invisible' };

function profileCard(scope) {
  const el = h('section', { class: 'card' }, h('h2', {}, 'Profile'));
  const body = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  el.append(body);
  let p = null;

  const preview = () => {
    const s = scope === 'server' ? p.server : null;
    const g = p.global;
    const avatar = s?.avatar || g.avatar;
    const banner = s?.banner || g.banner;
    const pr = p.presence;
    const line = pr.text ? `${ACT_PREFIX[pr.type] ?? ''}${pr.text}` : '';
    const about = s ? (s.bio || g.about) : g.about;
    return h('div', { class: 'pv' },
      h('div', { class: 'pv-banner', style: banner ? `background-image:url("${banner}")` : g.accentColor != null ? `background:#${g.accentColor.toString(16).padStart(6, '0')}` : '' }),
      h('div', { class: 'pv-av' }, h('img', { src: avatar, alt: '' }), h('span', { class: `pv-dot ${pr.status}`, title: DOT[pr.status] })),
      h('div', { class: 'pv-body' },
        h('strong', {}, (s?.nick) || g.username), h('div', { class: 'pv-user' }, g.username, h('span', { class: 'tag' }, 'APP')),
        line ? h('div', { class: 'pv-line' }, line, pr.fromFunction ? h('small', { class: 'muted' }, ' (from a function)') : '') : '',
        about ? h('div', { class: 'pv-about' }, h('b', {}, 'About me'), h('p', {}, about)) : ''),
      h('div', { class: 'pv-cap' }, scope === 'server' ? `How people in ${s.guildName} see it` : 'How everyone else sees it'));
  };

  // Picks an image and uploads it straight away; Discord replies with the new profile.
  const imageRow = (kind, label, current, hint) => {
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true, onchange: async () => {
      const f = file.files[0]; file.value = '';
      if (!f) return;
      if (f.size > 10 * 1024 * 1024) return toast('Images can be at most 10 MB', 'bad');
      pickBtn.disabled = true; pickBtn.textContent = 'Uploading…';
      try { p = await call('PUT', `/api/core/profile/${scope}/${kind}`, f); toast(`${label} changed`); poll(); }
      catch (e) { toast(e.message, 'bad'); }
      draw();
    } });
    const pickBtn = h('button', { type: 'button', class: 'btn', onclick: () => file.click() }, current ? 'Change…' : 'Choose…');
    const remove = current ? h('button', { type: 'button', class: 'btn danger', onclick: async () => {
      remove.disabled = true;
      try { p = await call('DELETE', `/api/core/profile/${scope}/${kind}`); toast(`${label} removed`); poll(); }
      catch (e) { toast(e.message, 'bad'); }
      draw();
    } }, 'Remove') : '';
    const cls = kind === 'banner' ? 'wide' : 'round';
    return h('div', { class: 'field' }, h('span', { class: 'lbl' }, label), h('p', { class: 'help' }, hint),
      h('div', { class: 'imgrow' }, current ? h('img', { src: current, alt: '', class: cls }) : h('span', { class: `noimg ${cls}` }, 'none'), pickBtn, remove, file));
  };

  const textForm = (fields) => {
    const inputs = {};
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const changed = {};
      for (const [k, { input, initial }] of Object.entries(inputs)) if (input.value.trim() !== initial) changed[k] = input.value.trim();
      if (!Object.keys(changed).length) return toast('Nothing changed');
      if ('username' in changed && !confirm('Discord only allows about 2 username changes an hour. Change it now?')) return;
      save.disabled = true;
      try { p = await call('PUT', '/api/core/profile', { scope, ...changed }); toast('Saved'); poll(); draw(); }
      catch (err) { toast(err.message, 'bad'); save.disabled = false; }
    } });
    for (const f of fields) {
      const id = `pf-${scope}-${f.key}`;
      const input = f.long ? h('textarea', { id, maxlength: f.max, rows: 3 }) : h('input', { type: 'text', id, maxlength: f.max, placeholder: f.placeholder ?? '' });
      input.value = f.value ?? '';
      inputs[f.key] = { input, initial: (f.value ?? '').trim() };
      form.append(h('div', { class: 'field' }, h('label', { for: id }, f.label), f.help ? h('p', { class: 'help' }, f.help) : '', input));
    }
    form.append(h('div', { class: 'actions', style: 'margin-top:4px' }, save));
    return form;
  };

  const draw = () => {
    if (!p) return;
    const s = p.server, g = p.global;
    if (scope === 'server' && !s) return body.replaceChildren(h('p', { class: 'muted' }, 'OzBot isn’t in a server yet.'));
    const editors = scope === 'server'
      ? [h('p', { class: 'muted', style: 'margin-top:0' }, 'Empty fields use the Everywhere version.'),
        s.canNick ? '' : h('div', { class: 'banner warn' }, 'OzBot lacks the “Change Nickname” permission here, so the nickname can’t be set.'),
        textForm([
          { key: 'nick', label: 'Nickname', value: s.nick, max: 32, placeholder: g.username },
          { key: 'bio', label: 'About me (this server)', value: s.bio, max: 190, long: true }]),
        imageRow('avatar', 'Avatar (this server)', s.avatar, 'Square, at least 256×256. GIFs animate.'),
        imageRow('banner', 'Banner (this server)', s.banner, 'Wide, about 680×240.')]
      : [textForm([
          { key: 'username', label: 'Username', value: g.username, max: 32, help: 'Discord allows about 2 changes an hour.' },
          { key: 'about', label: 'About me', value: g.about, max: 400, long: true, help: 'Same as the app description in the developer portal.' }]),
        imageRow('avatar', 'Avatar', g.avatar, 'Square, at least 256×256. GIFs animate.'),
        imageRow('banner', 'Banner', g.banner, 'Wide, about 680×240.')];
    body.replaceChildren(h('div', { class: 'profile' }, h('div', {}, preview()), h('div', { class: 'stack-tight' }, ...editors)));
  };

  const load = async () => {
    try { p = await call('GET', '/api/core/profile'); draw(); }
    catch (e) { body.replaceChildren(h('p', { class: 'muted' }, e.status === 409 ? 'Connect OzBot to Discord to edit its profile.' : e.message)); }
  };
  load();
  return { el, load };
}

// ---- Commands: defaults everywhere, access + overrides per server ---------------------------------------------
const WHO_OPTS = [['everyone', 'Everyone'], ['roles', 'Only some roles…'], ['admins', 'Admins only'], ['off', 'Nobody (switched off)']];

function chipPicker(items, selected, { empty = 'Nothing to pick.' } = {}) {
  const box = h('div', { class: 'chips' });
  const sel = new Set(selected);
  for (const it of items) box.append(h('label', { class: 'chip' }, h('input', { type: 'checkbox', value: it.id, checked: sel.has(it.id) }), it.label));
  for (const id of selected.filter((x) => !items.some((it) => it.id === x))) box.append(h('label', { class: 'chip' }, h('input', { type: 'checkbox', value: id, checked: true }), `unknown ${id}`));
  if (!box.childElementCount) box.append(h('span', { class: 'muted' }, empty));
  box.read = () => [...box.querySelectorAll('input:checked')].map((i) => i.value);
  return box;
}

const secs = (n) => !n ? 'none' : n < 60 ? `${n} s` : n % 3600 === 0 ? `${n / 3600} h` : n % 60 === 0 ? `${n / 60} min` : `${n} s`;

function accessCards() {
  const globalEl = h('div');
  const serverEl = h('div');
  (async () => {
    let a;
    try { a = await call('GET', '/api/access'); } catch (e) { globalEl.append(h('div', { class: 'banner bad' }, e.message)); return; }
    const g = (await loadGuild(true))?.guild;
    drawGlobal(a); drawServer(a, g);
  })();

  // Rows: commands with their subcommands; `fn(row)` builds the controls for each.
  const rows = (catalog, fn) => h('div', { class: 'acl' }, ...catalog.flatMap((c) => [
    h('div', { class: 'acl-row top' }, h('div', { class: 'acl-name' }, h('code', {}, `/${c.path}`),
      h('span', { class: 'muted' }, c.description), c.running ? '' : h('span', { class: 'tag', title: `${c.module} is off` }, `${c.module} off`)),
    fn({ ...c, isSub: false, invokable: !c.subs.length })),
    ...c.subs.map((s) => h('div', { class: 'acl-row sub' }, h('div', { class: 'acl-name' }, h('code', {}, s.name), h('span', { class: 'muted' }, s.description)),
      fn({ ...s, isSub: true, parent: c.path, invokable: true }))),
  ]));

  function drawGlobal(a) {
    const inputs = {};
    const table = rows(a.catalog, (r) => {
      if (!r.invokable) return h('div', { class: 'acl-ctl muted' }, 'Set per subcommand');
      if (r.open) return h('div', { class: 'acl-ctl muted' }, 'Never limited (privacy)');
      const input = h('input', { type: 'number', min: 0, max: 86400, step: 1, inputmode: 'numeric', value: a.global.cooldowns[r.path] ?? 0, 'aria-label': `Cooldown for /${r.path} in seconds` });
      inputs[r.path] = input;
      return h('div', { class: 'acl-ctl' }, h('label', { class: 'secs' }, input, 's'));
    });
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save cooldowns');
    const ignored = userList(a.global.ignoredUsers);
    const saveIgn = h('button', { class: 'btn primary', type: 'button' }, 'Save ignored users');
    const body = () => ({ cooldowns: Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, Number(i.value) || 0])), ignoredUsers: ignored.read() });
    const submit = async (btn) => {
      btn.disabled = true;
      try { a = await call('PUT', '/api/access/global', body()); toast('Saved'); drawServer(a, guild?.guild); }
      catch (e) { toast(e.message, 'bad'); }
      btn.disabled = false;
    };
    saveIgn.onclick = () => submit(saveIgn);
    globalEl.replaceChildren(
      h('section', { class: 'card' }, h('h2', {}, 'Command cooldowns'),
        h('p', { class: 'muted', style: 'margin-top:-6px' }, 'How long each person waits between uses (seconds, 0 = no wait). A server can override these below.'),
        h('form', { onsubmit: (e) => { e.preventDefault(); submit(save); } }, table, h('div', { class: 'actions' }, save))),
      h('section', { class: 'card' }, h('h2', {}, 'Ignored users'),
        h('p', { class: 'muted', style: 'margin-top:-6px' }, 'OzBot won’t answer their commands or learn from their messages, in any server.'),
        ignored.el, h('div', { class: 'actions' }, saveIgn)));
  }

  function drawServer(a, g) {
    if (!a.guild) return serverEl.replaceChildren();
    const c = a.guild.config;
    const roles = (g?.roles ?? []).map((r) => ({ id: r.id, label: `@${r.name}` }));
    const ctl = {};
    const table = rows(a.catalog, (r) => {
      const rule = c.rules[r.path] ?? {};
      if (r.open) return h('div', { class: 'acl-ctl muted' }, 'Always allowed, so anyone can opt out');
      const opts = r.isSub ? [['inherit', `Same as /${r.parent}`], ...WHO_OPTS] : WHO_OPTS;
      const who = h('select', { 'aria-label': `Who can use /${r.path}` }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === (rule.who ?? (r.isSub ? 'inherit' : 'everyone')) }, l)));
      const picker = chipPicker(roles, rule.roles ?? [], { empty: 'No roles found.' });
      const pickWrap = h('div', { class: 'acl-roles', hidden: who.value !== 'roles' }, picker);
      who.onchange = () => { pickWrap.hidden = who.value !== 'roles'; };
      let cd = null;
      if (r.invokable) {
        const def = a.global.cooldowns[r.path] ?? 0;
        cd = h('input', { type: 'number', min: 0, max: 86400, step: 1, inputmode: 'numeric', placeholder: `${def}`, value: rule.cooldown ?? '',
          'aria-label': `Cooldown for /${r.path} in this server, empty uses ${secs(def)}`, title: `Empty = Everywhere default (${secs(def)})` });
      }
      ctl[r.path] = { who, picker, cd };
      return h('div', { class: 'acl-ctl' }, who, cd ? h('label', { class: 'secs' }, cd, 's') : h('span', { class: 'secs muted' }, ''), pickWrap);
    });
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save command access');

    const chans = (g?.textChannels ?? []).map((ch) => ({ id: ch.id, label: `#${ch.name}` }));
    const mode = h('select', { id: 'acc-chmode' }, ...[['all', 'Every channel'], ['only', 'Only these channels…'], ['except', 'Every channel except…']]
      .map(([v, l]) => h('option', { value: v, selected: v === c.channelMode }, l)));
    const chPick = chipPicker(chans, c.channels, { empty: 'No text channels found.' });
    const chWrap = h('div', { hidden: c.channelMode === 'all' }, chPick);
    mode.onchange = () => { chWrap.hidden = mode.value === 'all'; };
    const bypass = chipPicker(roles, c.bypassRoles, { empty: 'No roles found.' });
    const ignoredRoles = chipPicker(roles, c.ignoredRoles, { empty: 'No roles found.' });

    const body = () => ({
      rules: Object.fromEntries(Object.entries(ctl).map(([p, x]) => [p, { who: x.who.value, roles: x.picker.read(), cooldown: x.cd?.value ?? '' }])),
      channelMode: mode.value, channels: chPick.read(), bypassRoles: bypass.read(), ignoredRoles: ignoredRoles.read(),
    });
    const submit = async (btn) => {
      btn.disabled = true;
      try { a = await call('PUT', '/api/access/guild', body()); toast('Saved'); drawServer(a, g); }
      catch (e) { toast(e.message, 'bad'); btn.disabled = false; }
    };
    const saveBtn = (label) => { const b = h('button', { class: 'btn primary', type: 'button' }, label); b.onclick = () => submit(b); return b; };

    serverEl.replaceChildren(
      h('section', { class: 'card' }, h('h2', {}, 'Command access'),
        h('p', { class: 'muted', style: 'margin-top:-6px' }, 'Who can use each command here, and an optional cooldown just for this server (empty = the Everywhere cooldown). Switched-off commands disappear from Discord’s command list.'),
        h('div', { class: 'acl-head' }, h('span', {}, 'Command'), h('span', {}, 'Who can use it · cooldown (s)')),
        h('form', { onsubmit: (e) => { e.preventDefault(); submit(save); } }, table, h('div', { class: 'actions' }, save))),
      h('div', { class: 'cols' },
        h('section', { class: 'card' }, h('h2', {}, 'Channels'),
          h('p', { class: 'muted', style: 'margin-top:-6px' }, 'Where OzBot’s commands work. Its functions’ own channel settings still apply.'),
          h('div', { class: 'field' }, h('label', { for: 'acc-chmode' }, 'Commands work in'), mode, chWrap),
          h('div', { class: 'actions' }, saveBtn('Save channels'))),
        h('section', { class: 'card' }, h('h2', {}, 'Roles'),
          h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Skip cooldowns'), h('p', { class: 'help' }, 'People with any of these roles never wait.'), bypass),
          h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Ignore'), h('p', { class: 'help' }, 'OzBot won’t answer or learn from people with these roles.'), ignoredRoles),
          h('div', { class: 'actions' }, saveBtn('Save roles')))));
  }

  return { globalEl, serverEl };
}

// A list of users with names and avatars: add by name, @mention or ID; remove with ×.
function userList(initial) {
  let ids = [...initial];
  const names = new Map();
  const list = h('div', { class: 'chips' });
  const q = h('input', { type: 'text', placeholder: 'Name, @name or user ID', 'aria-label': 'Find a user to ignore', maxlength: 40 });
  const results = h('div', { class: 'chips' });
  const draw = () => list.replaceChildren(...(ids.length ? ids.map((id) => {
    const u = names.get(id);
    return h('span', { class: 'chip user' }, u?.avatar ? h('img', { src: u.avatar, alt: '' }) : '', u?.name ?? id,
      h('button', { type: 'button', class: 'x', 'aria-label': `Remove ${u?.name ?? id}`, onclick: () => { ids = ids.filter((x) => x !== id); draw(); } }, '×'));
  }) : [h('span', { class: 'muted' }, 'Nobody is ignored.')]));
  const find = async (e) => {
    e?.preventDefault();
    if (!q.value.trim()) return;
    const r = await call('GET', `/api/access/users?q=${encodeURIComponent(q.value.trim())}`).catch((err) => (toast(err.message, 'bad'), { users: [] }));
    results.replaceChildren(...(r.users.length ? r.users.map((u) => h('button', { type: 'button', class: 'chip user', onclick: () => {
      names.set(u.id, u); if (!ids.includes(u.id)) ids.push(u.id); results.replaceChildren(); q.value = ''; draw();
    } }, u.avatar ? h('img', { src: u.avatar, alt: '' }) : '', `Add ${u.name}`, u.username && u.username !== u.name ? h('small', {}, ` @${u.username}`) : '')) : [h('span', { class: 'muted' }, 'No one found.')]));
  };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') find(e); });
  if (ids.length) call('GET', `/api/access/users?ids=${ids.join(',')}`).then((r) => { for (const u of r.users) names.set(u.id, u); draw(); }).catch(() => {});
  draw();
  const el = h('div', { class: 'stack-tight' }, list, h('div', { class: 'finder' }, q, h('button', { type: 'button', class: 'btn', onclick: find }, 'Find')), results);
  return { el, read: () => [...ids] };
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
