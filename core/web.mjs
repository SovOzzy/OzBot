// Dashboard web server. Binds to localhost only and is reached through `tailscale serve` (tailnet only), same
// access rules as OzVPS: the request must use a known Host and, when it came through Tailscale, carry an allowed
// Tailscale-User-Login (defaults to the owner of this machine). Header-less requests only from localhost.
import { createServer } from 'node:http';
import { readFile, stat, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, extname } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.wav': 'audio/wav' };

const CORE_FIELDS = [
  { key: 'guildId', type: 'select', label: 'Server', help: 'The Discord server OzBot works in.', options: [] },
  { key: 'statusText', type: 'text', label: 'Status text', help: 'Shown under the bot’s name in the member list.', maxLength: 120 },
];

export function startWeb({ root, cfg, bot, modules, tts, log, version }) {
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

  async function sendFile(res, path, { remove = false, type } = {}) {
    try {
      const st = await stat(path);
      res.writeHead(200, { 'content-type': type ?? TYPES[extname(path)] ?? 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store' });
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
    // or { fn, raw?: true (unparsed request, for uploads), always?: true (works while the module is off) }. Result { file, remove, type } streams a file.
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
      if ((m = url.pathname.match(/^\/modules\/([a-z0-9-]+)\/panel\.js$/))) {
        const mod = modules.get(m[1]);
        return mod?.hasPanel ? sendFile(res, join(mod.dir, 'panel.js')) : json(res, 404, { error: 'No panel' });
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
