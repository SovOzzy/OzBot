// SQLite-backed settings + state. One file: data/ozbot.db. Modules get their own tables (prefix with their id).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'ozbot.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const getQ = db.prepare('SELECT value FROM kv WHERE key = ?');
  const setQ = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const delQ = db.prepare('DELETE FROM kv WHERE key = ?');
  return {
    db,
    get(key, fallback = undefined) {
      const row = getQ.get(key);
      if (!row) return fallback;
      try { return JSON.parse(row.value); } catch { return fallback; }
    },
    set(key, value) { setQ.run(key, JSON.stringify(value)); },
    delete(key) { delQ.run(key); },
    close() { db.close(); },
  };
}
