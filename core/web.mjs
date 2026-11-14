// Dashboard web server. Binds to localhost only and is reached through `tailscale serve` (tailnet only), same
// access rules as OzVPS: the request must use a known Host and, when it came through Tailscale, carry an allowed
// Tailscale-User-Login (defaults to the owner of this machine). Header-less requests only from localhost.
import { createServer } from 'node:http';
import { readFile, stat, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, extname } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.wav': 'audio/wav', '.zip': 'application/zip' };

const CORE_FIELDS = [
  { key: 'guildId', type: 'select', label: 'Server', help: 'The Discord server OzBot works in.', options: [] },
  { key: 'presence', type: 'select', label: 'Online status', help: 'The dot on the bot’s picture.', options: [
    { value: 'online', label: 'Online (green)' }, { value: 'idle', label: 'Idle (yellow moon)' },
    { value: 'dnd', label: 'Do not disturb (red)' }, { value: 'invisible', label: 'Invisible (shows offline, still works)' }] },
  { key: 'activityType', type: 'select', label: 'Status line style', help: 'How the line under its name starts.', options: [
    { value: 'custom', label: 'Just the text' }, { value: 'playing', label: 'Playing …' }, { value: 'listening', label: 'Listening to …' },
    { value: 'watching', label: 'Watching …' }, { value: 'competing', label: 'Competing in …' }] },
  { key: 'statusText', type: 'text', label: 'Status text', help: 'Shown under the bot’s name in the member list. Leave empty for none.', maxLength: 120 },
  { key: 'showFunctionStatus', type: 'boolean', label: 'Let functions show what they are doing',
    help: 'While on, “Speaking as Oz” and similar replace the status text while it lasts.' },
];

// Profile images: Discord takes PNG, JPEG, GIF (animated) and WebP, up to 10 MB.
const IMAGE_MAGIC = [['image/png', [0x89, 0x50, 0x4e, 0x47]], ['image/jpeg', [0xff, 0xd8, 0xff]], ['image/gif', [0x47, 0x49, 0x46, 0x38]]];
function imageType(buf) {
  for (const [type, sig] of IMAGE_MAGIC) if (sig.every((b, i) => buf[i] === b)) return type;
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function startWeb({ root, cfg, bot, modules, tts, access, log, version }) {
  const port = Number(process.env.OZBOT_PORT || cfg.port);
  const allowedHosts = new Set([...(cfg.allowedHosts ?? []), `127.0.0.1:${port}`, `localhost:${port}`]);
  const isLocal = (h) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  let owner = null;
  execFile('tailscale', ['status', '--json'], { timeout: 5000 }, (err, out) => {
    if (err) return;
    try { const j = JSON.parse(out); owner = j.User?.[j.Self?.UserID]?.LoginName ?? null; } catch {}
  });
  const allowedLogins = () => (cfg.allowedLogins?.length ? cfg.allowedLogins : owner ? [owner] : []);

  function authorise(req) {
    const host = req.headers.host ?? '';
    if (!allowedHosts.has(host)) return [421, 'Unknown host'];
    const login = req.headers['tailscale-user-login'];
    if (login) return allowedLogins().includes(login) ? null : [403, 'Not allowed'];
    return isLocal(host) ? null : [403, 'Tailnet identity required'];
  }

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function readJson(req, limit = 1e6) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('Body too large'), { code: 413 }); chunks.push(c); }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Bad JSON'), { code: 400 }); }
  }

  async function sendFile(res, path, { remove = false, type, downloadName } = {}) {
    try {
      const st = await stat(path);
      const headers = { 'content-type': type ?? TYPES[extname(path)] ?? 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store' };
      if (downloadName) headers['content-disposition'] = `attachment; filename="${String(downloadName).replace(/[^\w.-]/g, '_')}"`;
      res.writeHead(200, headers);
      const s = createReadStream(path);
      s.pipe(res);
      if (remove) s.on('close', () => unlink(path).catch(() => {}));
    } catch { json(res, 404, { error: 'Not found' }); }
  }

  function coreView() {
    const guilds = bot.guilds();
    const fields = CORE_FIELDS.map((f) => f.key === 'guildId'
      ? { ...f, options: [{ value: '', label: guilds.length === 1 ? `Automatic (${guilds[0].name})` : 'Automatic (only server)' },
        ...guilds.map((g) => ({ value: g.id, label: g.name }))] }
      : f);
    return { fields, settings: bot.core, bot: bot.summary() };
  }

  async function api(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    let m;
    if (p === '/api/state' && method === 'GET') {
      const mem = process.memoryUsage();
      return json(res, 200, { version, bot: bot.summary(), modules: modules.list(), tts: tts.summary(),
        process: { rssMB: Math.round(mem.rss / 1e6), uptime: Math.round(process.uptime()) } });
    }
    if (p === '/api/guild' && method === 'GET') return json(res, 200, { guild: bot.guildInfo(), guilds: bot.guilds() });
    if (p === '/api/voices' && method === 'GET') {
      const profiles = bot.store.get('voices:profiles', {});
      return json(res, 200, { voices: tts.listVoices().map((v) => ({ ...v, profile: { name: profiles[v.id]?.name || v.id } })) });
    }
    if (p === '/api/core' && method === 'GET') return json(res, 200, coreView());
    if (p === '/api/core' && method === 'PUT') {
      const body = await readJson(req);
      const cur = bot.core;
      const next = { ...cur };
      if ('guildId' in body) { if (body.guildId && !/^\d{5,25}$/.test(String(body.guildId))) return json(res, 400, { error: 'Bad server id' }); next.guildId = String(body.guildId || ''); }
      if ('statusText' in body) next.statusText = String(body.statusText ?? '').slice(0, 120);
      for (const f of CORE_FIELDS.filter((f) => f.type === 'select' && f.key !== 'guildId')) {
        if (f.key in body) { if (!f.options.some((o) => o.value === body[f.key])) return json(res, 400, { error: `Bad ${f.label}` }); next[f.key] = body[f.key]; }
      }
      if ('showFunctionStatus' in body) next.showFunctionStatus = Boolean(body.showFunctionStatus);
      bot.store.set('core:settings', next);
      bot.applyPresence();
      if (next.guildId !== cur.guildId) await modules.restartAll();
      log(`core settings saved`);
      return json(res, 200, coreView());
    }
    if (p === '/api/core/token' && method === 'PUT') {
      const { token } = await readJson(req);
      if (typeof token !== 'string' || !/^[\w.-]{50,100}$/.test(token.trim())) return json(res, 400, { error: 'That does not look like a bot token' });
      await modules.stopAll();
      await bot.setToken(token);
      await modules.startAll();
      log('bot token changed');
      return json(res, 200, coreView());
    }
    if (p === '/api/core/profile' && method === 'GET') {
      const prof = await bot.profile();
      return prof ? json(res, 200, prof) : json(res, 409, { error: 'OzBot is not connected to Discord' });
    }
    // Text fields: { scope: 'global'|'server', username?, about?, nick?, bio? }
    if (p === '/api/core/profile' && method === 'PUT') {
      const body = await readJson(req);
      const scope = body.scope === 'server' ? 'server' : 'global';
      const allowed = scope === 'global' ? { username: [2, 32], about: [0, 400] } : { nick: [0, 32], bio: [0, 190] };
      const ch = {};
      for (const [k, [min, max]] of Object.entries(allowed)) {
        if (!(k in body)) continue;
        const v = String(body[k] ?? '').trim();
        if (v.length < min || v.length > max) return json(res, 400, { error: `${k} must be ${min}-${max} characters` });
        ch[k] = k === 'nick' && !v ? null : v;
      }
      if (!Object.keys(ch).length) return json(res, 400, { error: 'Nothing to change' });
      try { await bot.editProfile(scope, ch); } catch (e) { return json(res, 400, { error: e.message }); }
      log(`profile (${scope}) changed: ${Object.keys(ch).join(', ')}`);
      return json(res, 200, await bot.profile());
    }
    // Images: PUT raw bytes (or DELETE to remove) /api/core/profile/<global|server>/<avatar|banner>
    if ((m = p.match(/^\/api\/core\/profile\/(global|server)\/(avatar|banner)$/)) && (method === 'PUT' || method === 'DELETE')) {
      let value = null;
      if (method === 'PUT') {
        let size = 0; const chunks = [];
        for await (const c of req) { size += c.length; if (size > 10 * 1024 * 1024) return json(res, 413, { error: 'Images can be at most 10 MB' }); chunks.push(c); }
        const buf = Buffer.concat(chunks);
        const type = imageType(buf);
        if (!type) return json(res, 400, { error: 'Use a PNG, JPEG, GIF or WebP image' });
        value = `data:${type};base64,${buf.toString('base64')}`;
      }
      try { await bot.editProfile(m[1], { [m[2]]: value }); } catch (e) { return json(res, 400, { error: e.message }); }
      log(`profile (${m[1]}) ${m[2]} ${value ? 'changed' : 'removed'}`);
      return json(res, 200, await bot.profile());
    }
    // ---- command access: everywhere defaults + this server's rules ----
    const accessView = () => {
      const g = bot.guild();
      return { catalog: modules.commandCatalog(), global: access.global(),
        guild: g ? { id: g.id, name: g.name, config: access.guildConfig(g.id) } : null };
    };
    if (p === '/api/access' && method === 'GET') return json(res, 200, accessView());
    if (p === '/api/access/global' && method === 'PUT') {
      access.saveGlobal(await readJson(req), modules.commandPaths());
      log('access (everywhere) saved');
      return json(res, 200, accessView());
    }
    if (p === '/api/access/guild' && method === 'PUT') {
      const g = bot.guild();
      if (!g) return json(res, 409, { error: 'OzBot is not in a server yet' });
      access.saveGuild(g.id, await readJson(req), modules.commandPaths());
      modules.scheduleCommandSync(); // commands switched off for the server disappear from Discord
      log(`access (${g.name}) saved`);
      return json(res, 200, accessView());
    }
    // Names for user IDs, or find a user by ID / name in the server: GET /api/access/users?ids=1,2  or  ?q=name
    if (p === '/api/access/users' && method === 'GET') {
      if (bot.state !== 'online') return json(res, 200, { users: [] });
      const view = (u, mem) => ({ id: u.id, name: mem?.displayName ?? u.globalName ?? u.username, username: u.username,
        avatar: u.displayAvatarURL({ size: 64 }) });
      const q = (url.searchParams.get('q') ?? '').trim().replace(/^<@!?(\d+)>$/, '$1').replace(/^@/, '');
      if (q) {
        if (/^\d{5,25}$/.test(q)) {
          const u = await bot.client.users.fetch(q).catch(() => null);
          return json(res, 200, { users: u ? [view(u, bot.guild()?.members.cache.get(u.id))] : [] });
        }
        const g = bot.guild();
        const found = g ? await g.members.search({ query: q.slice(0, 32), limit: 8 }).catch(() => null) : null;
        return json(res, 200, { users: found ? [...found.values()].map((mem) => view(mem.user, mem)) : [] });
      }
      const list = (url.searchParams.get('ids') ?? '').split(',').filter((x) => /^\d{5,25}$/.test(x)).slice(0, 200);
      const users = [];
      for (const id of list) {
        const u = await bot.client.users.fetch(id).catch(() => null);
        users.push(u ? view(u, bot.guild()?.members.cache.get(id)) : { id, name: `unknown user ${id}`, username: '', avatar: null });
      }
      return json(res, 200, { users });
    }
    if ((m = p.match(/^\/api\/modules\/([a-z0-9-]+)$/)) && method === 'GET') {
      const d = await modules.detail(m[1]);
      return d ? json(res, 200, d) : json(res, 404, { error: 'Unknown module' });
    }
    if ((m = p.match(/^\/api\/modules\/([a-z0-9-]+)\/enabled$/)) && method === 'POST') {
      const { enabled } = await readJson(req);
      await modules.setEnabled(m[1], Boolean(enabled));
      log(`module ${m[1]} ${enabled ? 'on' : 'off'} (dashboard)`);
      return json(res, 200, await modules.detail(m[1]));
    }
    if ((m = p.match(/^\/api\/modules\/([a-z0-9-]+)\/settings$/)) && method === 'PUT') {
      const r = await modules.saveSettings(m[1], await readJson(req));
      if (r.errors) return json(res, 400, { error: 'Some settings are not valid', fields: r.errors });
      return json(res, 200, await modules.detail(m[1]));
    }
    // Module's own endpoints: /api/m/<id>/<name>. Route = async (ctx, { query, body, req }) => result
    // or { fn, raw?: true (unparsed request, for uploads), always?: true (works while the module is off) }. Result { file, remove, type, downloadName } streams a file.
    if ((m = p.match(/^\/api\/m\/([a-z0-9-]+)\/([a-z0-9-]+)$/))) {
      const mod = modules.get(m[1]);
      const route = mod?.impl.routes?.[`${method} ${m[2]}`];
      if (!route) return json(res, 404, { error: 'Unknown endpoint' });
      if (!mod.ctx.running && !(typeof route === 'object' && route.always)) return json(res, 409, { error: `Turn ${mod.manifest.name} on first` });
      const raw = typeof route === 'object' && route.raw;
      const fn = typeof route === 'function' ? route : route.fn;
      const body = raw || method === 'GET' ? {} : await readJson(req);
      const result = await fn(mod.ctx, { query: Object.fromEntries(url.searchParams), body, req });
      if (result?.file) return sendFile(res, result.file, result);
      return json(res, 200, result ?? { ok: true });
    }
    return json(res, 404, { error: 'Not found' });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/health') {
      return allowedHosts.has(req.headers.host ?? '') ? json(res, 200, { ok: true, bot: bot.state }) : json(res, 421, { error: 'Unknown host' });
    }
    const denied = authorise(req);
    if (denied) return json(res, denied[0], { error: denied[1] });
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return json(res, 403, { error: 'Cross-site request' });
        return await api(req, res, url);
      }
      let m;
      // panel.js plus any panel-*.js helpers it imports
      if ((m = url.pathname.match(/^\/modules\/([a-z0-9-]+)\/(panel(?:-[a-z0-9-]+)?\.js)$/))) {
        const mod = modules.get(m[1]);
        return mod?.hasPanel ? sendFile(res, join(mod.dir, m[2])) : json(res, 404, { error: 'No panel' });
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[a-z0-9_-]+\.(html|js|css|svg|png|ico)$/i.test(file)) return json(res, 404, { error: 'Not found' });
      return sendFile(res, join(root, 'web', file));
    } catch (e) {
      const code = e.code >= 400 && e.code < 600 ? e.code : 500;
      if (code >= 500) log('web error:', e.stack ?? e.message);
      if (!res.headersSent) json(res, code, { error: e.message });
      else res.end();
    }
  });
  server.requestTimeout = 15 * 60e3; // big voice uploads
  server.listen(port, process.env.OZBOT_HOST || cfg.host, () => log(`dashboard on http://${cfg.host}:${port}`));
  return server;
}
