// Recording sessions for training data. Each clip is a 22,050 Hz mono 16-bit WAV made in the browser and stored in
// data/recordings/<session>/ as it is recorded. Finishing builds <session>.zip (dataset/wavs + metadata.csv), ready
// for trainer/import.sh. The page deletes the session when you leave; anything left over is removed after 12 h.
import { mkdir, readdir, readFile, writeFile, rm, stat, open, rename } from 'node:fs/promises';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { writeZip } from '../../core/zip.mjs';

const SETS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'prompts.json'), 'utf8')).sets;
const MAX_AGE = 12 * 3600e3;
const MAX_CLIP = 4e6;          // ~90 s at 22.05 kHz 16-bit mono
const SESSION = /^[0-9a-f-]{36}$/;
const httpError = (code, msg) => Object.assign(new Error(msg), { code });

const root = (ctx) => join(ctx.tts.voiceDir, '..', 'recordings');
const zipName = (m) => `ozbot-voice-${m.voice}-set${m.set ?? 1}.zip`;
const clipName = (i) => `utt${String(i + 1).padStart(5, '0')}.wav`;

function dir(ctx, session) {
  if (!SESSION.test(String(session ?? ''))) throw httpError(400, 'Bad session');
  const d = join(root(ctx), session);
  if (!existsSync(join(d, 'meta.json'))) throw httpError(404, 'That recording session no longer exists');
  return d;
}

async function meta(d) { return JSON.parse(await readFile(join(d, 'meta.json'), 'utf8')); }

export async function cleanupRecordings(ctx, { all = false } = {}) {
  const r = root(ctx);
  if (!existsSync(r)) return;
  for (const name of await readdir(r)) {
    const p = join(r, name);
    const st = await stat(p).catch(() => null);
    if (st && (all || Date.now() - st.mtimeMs > MAX_AGE)) { await rm(p, { recursive: true, force: true }); ctx.log(`removed old recording ${name}`); }
  }
}

async function clipInfo(d) {
  const names = (await readdir(d)).filter((f) => /^utt\d{5}\.wav$/.test(f));
  let bytes = 0;
  for (const f of names) bytes += (await stat(join(d, f))).size;
  return { indexes: names.map((f) => Number(f.slice(3, 8)) - 1).sort((a, b) => a - b), seconds: Math.round(Math.max(0, bytes - names.length * 44) / 44100) };
}

export const recorderRoutes = {
  'GET rec-sets': { always: true, fn: () => ({ sets: SETS.map((x) => ({ id: x.id, name: x.name, count: x.prompts.length })) }) },

  'POST rec-start': { always: true, fn: async (ctx, { body }) => {
    await cleanupRecordings(ctx);
    const voice = String(body.voice ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30);
    if (!voice) throw httpError(400, 'Give the voice a short name (letters, numbers, _)');
    const set = SETS.find((x) => x.id === Number(body.set)) ?? SETS[0];
    const session = randomUUID();
    const d = join(root(ctx), session);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'meta.json'), JSON.stringify({ voice, set: set.id, created: Date.now(), prompts: set.prompts }));
    ctx.log(`recording session started for "${voice}" (set ${set.id})`);
    return { session, voice, set: set.id, setName: set.name, prompts: set.prompts };
  } },

  'GET rec-status': { always: true, fn: async (ctx, { query }) => {
    const d = dir(ctx, query.session);
    const m = await meta(d);
    return { voice: m.voice, ...(await clipInfo(d)), zip: existsSync(`${d}.zip`) };
  } },

  'PUT rec-clip': { always: true, raw: true, fn: async (ctx, { req, query }) => {
    const d = dir(ctx, query.session);
    const i = Number(query.index);
    const { prompts } = await meta(d);
    if (!Number.isInteger(i) || i < 0 || i >= prompts.length) throw httpError(400, 'Bad prompt number');
    const tmp = join(d, `.part-${i}`);
    let size = 0;
    const guard = async function* (src) { for await (const c of src) { size += c.length; if (size > MAX_CLIP) throw httpError(413, 'Clip too long'); yield c; } };
    await pipeline(req, guard, createWriteStream(tmp));
    const fh = await open(tmp, 'r');
    const { buffer } = await fh.read(Buffer.alloc(44), 0, 44, 0);
    await fh.close();
    const ok = buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE'
      && buffer.readUInt16LE(22) === 1 && buffer.readUInt32LE(24) === 22050 && buffer.readUInt16LE(34) === 16;
    if (!ok) { await rm(tmp, { force: true }); throw httpError(400, 'Clip must be a 22,050 Hz mono 16-bit WAV'); }
    await rename(tmp, join(d, clipName(i)));
    await rm(`${d}.zip`, { force: true }); // any earlier zip is now out of date
    return { ok: true, ...(await clipInfo(d)) };
  } },

  'POST rec-finish': { always: true, fn: async (ctx, { body }) => {
    const d = dir(ctx, body.session);
    const m = await meta(d);
    const { indexes, seconds } = await clipInfo(d);
    if (indexes.length < 10) throw httpError(400, 'Record at least 10 sentences first');
    const lines = indexes.map((i) => `${clipName(i)}|${m.prompts[i]}`);
    const readme = [
      `OzBot voice recordings: "${m.voice}", prompt set ${m.set ?? 1}, ${indexes.length} sentences, about ${Math.round(seconds / 60)} min.`,
      '', 'On your PC (WSL), from the OzBot trainer folder:',
      `  ./import.sh ${m.voice} /path/to/this.zip              (first session)`,
      `  ./import.sh ${m.voice} /path/to/this.zip --append     (adding to earlier sessions)`,
      `  ./train.sh ${m.voice}          (add --fresh after --append, to retrain on all sets)`, `  ./export.sh ${m.voice}`, '',
      'dataset/metadata.csv = file|text (already matches what was read, so no Whisper step is needed).', '',
    ].join('\n');
    await writeZip(`${d}.zip`, [
      { name: 'README.txt', data: readme },
      { name: 'dataset/metadata.csv', data: lines.join('\n') + '\n' },
      ...indexes.map((i) => ({ name: `dataset/wavs/${clipName(i)}`, path: join(d, clipName(i)) })),
    ]);
    const size = (await stat(`${d}.zip`)).size;
    ctx.log(`recording "${m.voice}" packed: ${indexes.length} clips, ${(size / 1e6).toFixed(1)} MB`);
    return { ok: true, clips: indexes.length, seconds, sizeMB: +(size / 1e6).toFixed(1), download: zipName(m) };
  } },

  'GET rec-download': { always: true, fn: async (ctx, { query }) => {
    const d = dir(ctx, query.session);
    const m = await meta(d);
    if (!existsSync(`${d}.zip`)) throw httpError(404, 'Press Finish first');
    return { file: `${d}.zip`, type: 'application/zip', downloadName: zipName(m) };
  } },

  // Called on leaving the page (navigator.sendBeacon) or by the Delete button.
  'POST rec-discard': { always: true, fn: async (ctx, { body }) => {
    if (!SESSION.test(String(body.session ?? ''))) throw httpError(400, 'Bad session');
    const d = join(root(ctx), body.session);
    const existed = existsSync(d);
    await rm(d, { recursive: true, force: true });
    await rm(`${d}.zip`, { force: true });
    if (existed) ctx.log('recording session deleted');
    return { ok: true };
  } },
};
