// OzBot entry point: settings store -> Discord client -> TTS -> modules -> dashboard.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { Bot } from './bot.mjs';
import { TTS } from './tts.mjs';
import { ModuleManager } from './modules.mjs';
import { Access } from './access.mjs';
import { startWeb } from './web.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
const localCfg = join(root, 'config.local.json');
if (existsSync(localCfg)) Object.assign(cfg, JSON.parse(readFileSync(localCfg, 'utf8')));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const dataDir = process.env.OZBOT_DATA || join(root, 'data');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
process.on('unhandledRejection', (e) => log('unhandled rejection:', e?.stack ?? e));

const store = openStore(dataDir);
const bot = new Bot({ store, log });
const tts = new TTS({ root, dataDir, cfg: cfg.tts ?? {}, log });
const access = new Access({ store, bot, log });
const modules = new ModuleManager({ root, dataDir, store, bot, tts, log, cfg, access });
await modules.load();
modules.attachInteractions();
bot.on('client', () => modules.attachInteractions()); // new token = new client
bot.on('ready', () => modules.restartAll());           // (re)connect: modules re-read the server
bot.on('guilds', () => modules.scheduleCommandSync());

const server = startWeb({ root, cfg, bot, modules, tts, access, log, version });
await modules.startAll();
bot.start();

let stopping = false;
async function shutdown(sig) {
  if (stopping) return; stopping = true;
  log(`${sig}: shutting down`);
  setTimeout(() => process.exit(1), 8000).unref();
  server.close();
  await modules.stopAll();
  tts.shutdown('exit');
  await bot.stop();
  store.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
