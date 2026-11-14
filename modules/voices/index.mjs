// Voice profiles: a profile per installed Piper voice (display name + speaking settings), uploads, previews.
// Provides the "voices" service: speak text -> wav file.
import { createWriteStream } from 'node:fs';
import { rename, unlink, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const KEY = 'voices:profiles';
const NAME = /^[A-Za-z0-9_.-]{1,120}$/;
const DEFAULT_PROFILE = { name: '', lengthScale: 1, noiseScale: 0.667, noiseW: 0.8, speaker: '', volume: 1 };
const httpError = (code, msg) => Object.assign(new Error(msg), { code });

function profiles(ctx) { return ctx.store.get(KEY, {}); }

function list(ctx) {
  const p = profiles(ctx);
  const def = ctx.settings.defaultVoice;
  return ctx.tts.listVoices().map((v) => ({ ...v, profile: { ...DEFAULT_PROFILE, name: prettyName(v.id), ...p[v.id] }, isDefault: v.id === def }));
}

function prettyName(id) {
  const m = id.match(/^([a-z]{2})_([A-Z]{2})-(.+?)-(x_low|low|medium|high)$/);
  return m ? `${m[3].replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} (${m[1]}-${m[2]})` : id;
}

// profileId '' -> default voice; falls back to any installed voice.
function resolve(ctx, id) {
  const voices = ctx.tts.listVoices().filter((v) => v.hasConfig && !v.invalid);
  const pick = voices.find((v) => v.id === id) ?? voices.find((v) => v.id === ctx.settings.defaultVoice) ?? voices[0];
  if (!pick) return null;
  const p = { ...DEFAULT_PROFILE, ...profiles(ctx)[pick.id] };
  let speaker = null;
  if (pick.speakers?.length) {
    // speaker names come from speaker_id_map in the .onnx.json; Piper wants the numeric id
    const cfg = ctx.voiceConfigs?.[pick.id];
    speaker = cfg?.speaker_id_map?.[p.speaker] ?? 0;
  }
  return { voice: pick.id, name: p.name || prettyName(pick.id), lengthScale: p.lengthScale, noiseScale: p.noiseScale, noiseW: p.noiseW, speaker, volume: p.volume };
}

async function loadConfigs(ctx) {
  ctx.voiceConfigs = {};
  for (const v of ctx.tts.listVoices()) {
    if (!v.speakers?.length) continue;
    try { ctx.voiceConfigs[v.id] = JSON.parse(await readFile(join(ctx.tts.voiceDir, v.file + '.json'), 'utf8')); } catch {}
  }
}

async function speak(ctx, text, id) {
  const r = resolve(ctx, id);
  if (!r) throw new Error('No voices installed');
  const out = await ctx.tts.synth(text, r);
  return { ...out, voice: r.voice, name: r.name };
}

async function receiveUpload(ctx, req, file) {
  const isJson = file.endsWith('.onnx.json');
  if (!NAME.test(file) || !(isJson || file.endsWith('.onnx'))) throw httpError(400, 'File must be named <voice>.onnx or <voice>.onnx.json');
  const limit = isJson ? 2e6 : (ctx.config.maxUploadMB ?? 300) * 1e6;
  if (Number(req.headers['content-length'] ?? 0) > limit) throw httpError(413, 'File too large');
  const tmp = join(ctx.tts.voiceDir, `.upload-${randomUUID()}`);
  let size = 0;
  try {
    const guard = async function* (src) { for await (const c of src) { size += c.length; if (size > limit) throw httpError(413, 'File too large'); yield c; } };
    await pipeline(req, guard, createWriteStream(tmp));
    if (isJson) {
      let j; try { j = JSON.parse(await readFile(tmp, 'utf8')); } catch { throw httpError(400, 'That .json is not valid JSON'); }
      if (!j.phoneme_id_map || !j.audio?.sample_rate) throw httpError(400, 'That .json is not a Piper voice config (no phoneme_id_map / audio.sample_rate)');
    } else {
      const fh = await open(tmp, 'r');
      const { buffer } = await fh.read(Buffer.alloc(1), 0, 1, 0);
      await fh.close();
      if (size < 1e6 || buffer[0] !== 0x08) throw httpError(400, 'That does not look like an .onnx model');
    }
    await rename(tmp, join(ctx.tts.voiceDir, file));
    const id = file.replace(/\.onnx(\.json)?$/, '');
    await ctx.tts.unload(id);
    await loadConfigs(ctx);
    ctx.log(`uploaded ${file} (${(size / 1e6).toFixed(1)} MB)`);
    return { ok: true, id, name: file, sizeMB: +(size / 1e6).toFixed(1), complete: Boolean(ctx.tts.modelPath(id)) };
  } finally { unlink(tmp).catch(() => {}); }
}

export default {
  async start(ctx) {
    await loadConfigs(ctx);
    ctx.provide('voices', {
      list: () => list(ctx),
      resolve: (id) => resolve(ctx, id),
      speak: (text, id) => speak(ctx, text, id),
    });
  },

  async settingsChanged() {},

  routes: {
    'GET list': { always: true, fn: (ctx) => ({ voices: list(ctx), default: ctx.settings.defaultVoice }) },
    'PUT profile': { always: true, fn: (ctx, { body }) => {
      const id = String(body.id ?? '');
      if (!ctx.tts.listVoices().some((v) => v.id === id)) throw httpError(404, 'Unknown voice');
      const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      const p = profiles(ctx);
      p[id] = {
        name: String(body.name ?? '').trim().slice(0, 60),
        lengthScale: num(body.lengthScale, 0.5, 2, 1),
        noiseScale: num(body.noiseScale, 0, 1.5, 0.667),
        noiseW: num(body.noiseW, 0, 1.5, 0.8),
        speaker: String(body.speaker ?? '').slice(0, 120),
        volume: num(body.volume, 0.1, 2, 1),
      };
      ctx.store.set(KEY, p);
      return { ok: true, voices: list(ctx) };
    } },
    'POST preview': { always: true, fn: async (ctx, { body }) => {
      const text = String(body.text ?? '').trim().slice(0, 300) || 'Hello, this is how I sound. Pretty good, right?';
      const out = await speak(ctx, text, String(body.id ?? ''));
      return { file: out.path, remove: true, type: 'audio/wav' };
    } },
    'PUT upload': { raw: true, always: true, fn: (ctx, { req, query }) => receiveUpload(ctx, req, String(query.file ?? '')) },
    'POST delete': { always: true, fn: async (ctx, { body }) => {
      const id = String(body.id ?? '');
      if (!NAME.test(id)) throw httpError(400, 'Bad voice id');
      if (ctx.tts.listVoices().length <= 1) throw httpError(409, 'Keep at least one voice installed');
      await ctx.tts.unload(id);
      for (const f of [`${id}.onnx`, `${id}.onnx.json`]) await unlink(join(ctx.tts.voiceDir, f)).catch(() => {});
      const p = profiles(ctx); delete p[id]; ctx.store.set(KEY, p);
      ctx.log(`deleted voice ${id}`);
      return { ok: true, voices: list(ctx) };
    } },
  },

  async status(ctx) {
    const voices = ctx.tts.listVoices();
    return { installed: voices.length, incomplete: voices.filter((v) => !v.hasConfig).map((v) => v.id), worker: ctx.tts.summary() };
  },
};
