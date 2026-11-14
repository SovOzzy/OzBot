// Module system. Each folder in modules/ is one OzBot function:
//   manifest.json  { id, name, description (2 lines), icon, order, requires: [service], provides: [service], settings: [fields] }
//   index.mjs      export default { start(ctx), stop?(ctx), settingsChanged?(ctx, values, old), commands?, routes?, status?(ctx) }
//   panel.js       optional: extra UI on the module's dashboard page (export function render(el, api))
//
// The core owns every listener/timer a module makes (ctx.on / ctx.every / ctx.after), so turning a module off
// always cleans up, even if its own stop() is buggy. Repeated errors switch a module off automatically ("faulted").
import { readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Events, MessageFlags } from 'discord.js';
import { coerce, defaults } from './schema.mjs';

const FAULT_LIMIT = 5;            // errors ...
const FAULT_WINDOW = 10 * 60e3;   // ... within this window switch the module off

export class ModuleManager {
  constructor({ root, dataDir, store, bot, tts, log, cfg = {} }) {
    Object.assign(this, { root, dataDir, store, bot, tts, log, cfg });
    this.mods = new Map();      // id -> { manifest, impl, ctx, status, error, errors[], running, disposers[] }
    this.services = new Map();  // name -> { from, api }
    this.commandTimer = null;
    this.busy = Promise.resolve();
  }

  async load() {
    const dir = join(this.root, 'modules');
    for (const name of readdirSync(dir).sort()) {
      const mdir = join(dir, name);
      if (!existsSync(join(mdir, 'manifest.json'))) continue;
      try {
        const manifest = JSON.parse(readFileSync(join(mdir, 'manifest.json'), 'utf8'));
        if (manifest.id !== name) throw new Error(`manifest id "${manifest.id}" must match folder "${name}"`);
        const impl = (await import(pathToFileURL(join(mdir, 'index.mjs')).href)).default;
        const m = { manifest, impl, dir: mdir, status: 'off', error: null, errors: [], running: false, disposers: [],
          hasPanel: existsSync(join(mdir, 'panel.js')) };
        m.ctx = this.#makeCtx(m);
        this.mods.set(manifest.id, m);
      } catch (e) {
        this.log(`module ${name} failed to load: ${e.message}`);
        this.mods.set(name, { manifest: { id: name, name, description: 'Failed to load', settings: [] }, impl: {}, status: 'broken',
          error: e.message, errors: [], running: false, disposers: [], broken: true });
      }
    }
    this.log(`modules: ${[...this.mods.keys()].join(', ')}`);
  }

  // ---- persisted state ---------------------------------------------------------------------------------
  enabled(id) { const m = this.mods.get(id); return this.store.get(`module:${id}:enabled`, m?.manifest.enabledByDefault ?? true); }
  settings(id) {
    const m = this.mods.get(id);
    return coerce(m.manifest.settings, {}, { ...defaults(m.manifest.settings), ...this.store.get(`module:${id}:settings`, {}) }).values;
  }

  // ---- context handed to a module ------------------------------------------------------------------------
  #makeCtx(m) {
    const id = m.manifest.id;
    const mgr = this;
    const dataDir = join(this.dataDir, 'modules', id);
    const guard = (fn, where) => async (...args) => {
      if (!m.running) return;
      try { return await fn(...args); } catch (e) { mgr.#recordError(m, e, where); }
    };
    return {
      id, manifest: m.manifest, config: this.cfg, store: this.store, db: this.store.db, tts: this.tts,
      get dataDir() { mkdirSync(dataDir, { recursive: true }); return dataDir; },
      get client() { return mgr.bot.client; },
      get running() { return m.running; },
      get settings() { return mgr.settings(id); },
      guild: () => this.bot.guild(),
      log: (...a) => this.log(`[${id}]`, ...a),
      on(event, fn) {
        const g = guard(fn, `event ${event}`);
        mgr.bot.client.on(event, g);
        m.disposers.push(() => mgr.bot.client.off(event, g));
      },
      every(ms, fn) { const t = setInterval(guard(fn, 'timer'), ms); m.disposers.push(() => clearInterval(t)); return t; },
      after(ms, fn) { const t = setTimeout(guard(fn, 'timer'), ms); m.disposers.push(() => clearTimeout(t)); return t; },
      onDispose(fn) { m.disposers.push(fn); },
      provide(name, api) { mgr.services.set(name, { from: id, api }); m.disposers.push(() => mgr.services.delete(name)); },
      use(name) { return mgr.services.get(name)?.api ?? null; },
      fail: (e) => this.#recordError(m, e instanceof Error ? e : new Error(String(e)), 'module'),
    };
  }

  #recordError(m, e, where) {
    const now = Date.now();
    this.log(`[${m.manifest.id}] error in ${where}: ${e.stack ?? e.message}`);
    m.errors = m.errors.filter((t) => now - t.at < FAULT_WINDOW);
    m.errors.push({ at: now, where, message: e.message });
    if (m.errors.length >= FAULT_LIMIT) this.fault(m.manifest.id, `${FAULT_LIMIT} errors in ${FAULT_WINDOW / 60e3} min, last: ${e.message}`);
  }

  fault(id, message) {
    const m = this.mods.get(id);
    if (!m || m.status === 'faulted') return;
    this.log(`[${id}] FAULTED, switching off: ${message}`);
    this.store.set(`module:${id}:enabled`, false);
    this.store.set(`module:${id}:fault`, { at: Date.now(), message });
    this.queue(async () => { await this.#stop(m); m.status = 'faulted'; m.error = message; await this.#reconcile(); });
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------
  queue(fn) { this.busy = this.busy.then(fn).catch((e) => this.log('module manager:', e.stack ?? e.message)); return this.busy; }

  async #start(m) {
    m.disposers = []; m.errors = []; m.running = true; m.status = 'starting'; m.error = null;
    try {
      await m.impl.start?.(m.ctx);
      m.status = 'on';
      this.log(`[${m.manifest.id}] started`);
    } catch (e) {
      this.log(`[${m.manifest.id}] start failed: ${e.stack ?? e.message}`);
      await this.#stop(m);
      this.store.set(`module:${m.manifest.id}:enabled`, false);
      this.store.set(`module:${m.manifest.id}:fault`, { at: Date.now(), message: `Could not start: ${e.message}` });
      m.status = 'faulted'; m.error = `Could not start: ${e.message}`;
    }
  }

  async #stop(m) {
    if (!m.running) return;
    try { await m.impl.stop?.(m.ctx); } catch (e) { this.log(`[${m.manifest.id}] stop error: ${e.message}`); }
    m.running = false;
    for (const d of m.disposers.splice(0).reverse()) { try { d(); } catch {} }
    if (m.status !== 'faulted') m.status = 'off';
    this.log(`[${m.manifest.id}] stopped`);
  }

  // Bring running modules in line with "enabled" + dependencies, in dependency order.
  async #reconcile() {
    const order = [...this.mods.values()].filter((m) => !m.broken)
      .sort((a, b) => (a.manifest.requires?.length ?? 0) - (b.manifest.requires?.length ?? 0) || (a.manifest.order ?? 50) - (b.manifest.order ?? 50));
    for (let pass = 0; pass < 2; pass++) {
      for (const m of order) {
        const id = m.manifest.id;
        const missing = (m.manifest.requires ?? []).filter((s) => !this.services.has(s));
        const want = this.enabled(id) && missing.length === 0;
        if (want && !m.running) await this.#start(m);
        else if (!want && m.running) await this.#stop(m);
        if (!m.running && m.status !== 'faulted') {
          m.status = this.enabled(id) && missing.length ? 'blocked' : 'off';
          m.blockedBy = missing.map((s) => this.#providerName(s));
        }
      }
    }
    this.scheduleCommandSync();
  }

  #providerName(service) {
    for (const m of this.mods.values()) if (m.manifest.provides?.includes(service)) return m.manifest.name;
    return service;
  }

  startAll() { return this.queue(() => this.#reconcile()); }
  stopAll() { return this.queue(async () => { for (const m of [...this.mods.values()].reverse()) await this.#stop(m); }); }
  restartAll() { return this.queue(async () => { for (const m of [...this.mods.values()].reverse()) await this.#stop(m); await this.#reconcile(); }); }

  setEnabled(id, on) {
    const m = this.mods.get(id);
    if (!m || m.broken) throw new Error('Unknown module');
    return this.queue(async () => {
      this.store.set(`module:${id}:enabled`, Boolean(on));
      if (on) { this.store.delete(`module:${id}:fault`); if (m.status === 'faulted') { m.status = 'off'; m.error = null; } }
      await this.#reconcile();
    });
  }

  async saveSettings(id, input) {
    const m = this.mods.get(id);
    if (!m || m.broken) throw new Error('Unknown module');
    const old = this.settings(id);
    const { values, errors } = coerce(m.manifest.settings, input, old);
    if (Object.keys(errors).length) return { errors };
    this.store.set(`module:${id}:settings`, values);
    if (m.running) {
      await this.queue(async () => {
        if (m.impl.settingsChanged) {
          try { await m.impl.settingsChanged(m.ctx, values, old); } catch (e) { this.#recordError(m, e, 'settingsChanged'); }
        } else { await this.#stop(m); await this.#reconcile(); }
      });
    }
    return { values };
  }

  // ---- slash commands ------------------------------------------------------------------------------------
  // Commands are registered per server (instant), only for running modules. A module's `commands` is a list of
  // { data: <SlashCommandBuilder or JSON>, run(ctx, interaction) }.
  scheduleCommandSync() {
    clearTimeout(this.commandTimer);
    this.commandTimer = setTimeout(() => this.syncCommands().catch((e) => this.log('command sync failed:', e.message)), 1500);
  }

  async syncCommands() {
    const guild = this.bot.guild();
    if (!guild) return;
    const body = [];
    for (const m of this.mods.values()) if (m.running) for (const c of m.impl.commands ?? []) body.push(c.data.toJSON?.() ?? c.data);
    await guild.commands.set(body);
    this.log(`slash commands synced: ${body.map((c) => '/' + c.name).join(' ') || '(none)'}`);
  }

  attachInteractions() {
    this.bot.client.on(Events.InteractionCreate, async (i) => {
      if (!i.isChatInputCommand() && !i.isAutocomplete()) return;
      for (const m of this.mods.values()) {
        if (!m.running) continue;
        const cmd = (m.impl.commands ?? []).find((c) => (c.data.name ?? c.data.toJSON?.().name) === i.commandName);
        if (!cmd) continue;
        try {
          if (i.isAutocomplete()) await cmd.autocomplete?.(m.ctx, i);
          else await cmd.run(m.ctx, i);
        } catch (e) {
          this.#recordError(m, e, `/${i.commandName}`);
          if (i.isChatInputCommand()) {
            const reply = { content: 'Something went wrong with that command.', flags: MessageFlags.Ephemeral };
            (i.deferred || i.replied ? i.followUp(reply) : i.reply(reply)).catch(() => {});
          }
        }
        return;
      }
      if (i.isChatInputCommand()) i.reply({ content: 'That function is switched off right now.', flags: MessageFlags.Ephemeral }).catch(() => {});
    });
  }

  // ---- views for the dashboard ---------------------------------------------------------------------------
  #view(m) {
    const fault = this.store.get(`module:${m.manifest.id}:fault`, null);
    const { settings, ...manifest } = m.manifest;
    return {
      ...manifest, enabled: m.broken ? false : this.enabled(m.manifest.id), status: m.status,
      error: m.error ?? fault?.message ?? null, blockedBy: m.status === 'blocked' ? m.blockedBy : [],
      recentErrors: m.errors.slice(-5), hasPanel: Boolean(m.hasPanel),
    };
  }

  list() {
    return [...this.mods.values()].sort((a, b) => (a.manifest.order ?? 50) - (b.manifest.order ?? 50)).map((m) => this.#view(m));
  }

  async detail(id) {
    const m = this.mods.get(id);
    if (!m) return null;
    let status = null;
    if (m.running && m.impl.status) { try { status = await m.impl.status(m.ctx); } catch (e) { status = { error: e.message }; } }
    return { ...this.#view(m), fields: m.manifest.settings ?? [], settings: m.broken ? {} : this.settings(id), live: status };
  }

  async route(id, method, name, req) {
    const m = this.mods.get(id);
    const r = m?.impl.routes?.[`${method} ${name}`];
    if (!r) return null;
    return r;
  }

  get(id) { return this.mods.get(id); }
}
