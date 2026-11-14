// Text-to-speech: Piper voices (.onnx + .onnx.json) in data/voices, synthesised by one Python worker process
// (tts/worker.py) that is started on first use and stopped after it has been idle a while, so it costs no memory
// when nobody is talking. Requests are serialised: one sentence at a time keeps CPU use to a single core.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

export class TTS {
  constructor({ root, dataDir, cfg, log }) {
    this.root = root;
    this.voiceDir = join(dataDir, 'voices');
    this.tmpDir = join(dataDir, 'tmp');
    mkdirSync(this.voiceDir, { recursive: true });
    mkdirSync(this.tmpDir, { recursive: true });
    for (const f of readdirSync(this.tmpDir)) try { unlinkSync(join(this.tmpDir, f)); } catch {}
    this.idleMs = (cfg.idleExitMinutes ?? 10) * 60e3;
    this.maxLoaded = cfg.maxLoadedVoices ?? 2;
    this.python = process.env.OZBOT_PYTHON || join(root, '.venv', 'bin', 'python');
    this.log = log;
    this.proc = null; this.pending = new Map(); this.seq = 0; this.chain = Promise.resolve();
    this.idleTimer = null; this.stats = { spoken: 0, lastMs: null, startedAt: null };
  }

  // ---- voice files -----------------------------------------------------------------------------------
  listVoices() {
    const out = [];
    for (const f of readdirSync(this.voiceDir)) {
      if (!f.endsWith('.onnx')) continue;
      const id = f.slice(0, -5);
      const cfgPath = join(this.voiceDir, f + '.json');
      let meta = {};
      if (existsSync(cfgPath)) {
        try {
          const j = JSON.parse(readFileSync(cfgPath, 'utf8'));
          meta = {
            language: j.language?.name_english ?? j.espeak?.voice ?? '', quality: j.audio?.quality ?? '',
            sampleRate: j.audio?.sample_rate ?? null, speakers: j.speaker_id_map ? Object.keys(j.speaker_id_map) : [],
            dataset: j.dataset ?? '',
          };
        } catch { meta = { invalid: true }; }
      }
      out.push({ id, file: f, sizeMB: +(statSync(join(this.voiceDir, f)).size / 1e6).toFixed(1), hasConfig: existsSync(cfgPath), ...meta });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  modelPath(id) {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(id)) return null;
    const p = join(this.voiceDir, id + '.onnx');
    return existsSync(p) && existsSync(p + '.json') ? p : null;
  }

  // ---- worker --------------------------------------------------------------------------------------------
  #ensureWorker() {
    if (this.proc) return this.ready;
    if (!existsSync(this.python)) throw new Error(`Python venv missing (${this.python}). Run deploy/install.sh.`);
    this.proc = spawn(this.python, [join(this.root, 'tts', 'worker.py'), String(this.maxLoaded)], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', OMP_NUM_THREADS: '1' },
    });
    this.stats.startedAt = Date.now();
    const proc = this.proc;
    this.ready = new Promise((resolve, reject) => {
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        let msg; try { msg = JSON.parse(line); } catch { return; }
        if (msg.ready) return resolve();
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error)); }
      });
      proc.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) this.log('[tts]', s.slice(0, 500)); });
      proc.on('exit', (code) => {
        if (this.proc === proc) this.proc = null;
        reject(new Error(`TTS worker exited (${code})`));
        for (const p of this.pending.values()) p.reject(new Error(`TTS worker exited (${code})`));
        this.pending.clear();
      });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  #touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.shutdown('idle'), this.idleMs);
  }

  #request(req) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ ...req, id }) + '\n');
    });
  }

  // Returns the path of a wav file (caller deletes it, or it is cleared on next start).
  synth(text, { voice, lengthScale = 1, noiseScale = 0.667, noiseW = 0.8, speaker = null, volume = 1 } = {}) {
    const model = this.modelPath(voice);
    if (!model) return Promise.reject(new Error(`Voice "${voice}" is not installed`));
    const clean = String(text).replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!clean) return Promise.reject(new Error('Nothing to say'));
    const job = async () => {
      await this.#ensureWorker();
      this.#touch();
      const out = join(this.tmpDir, `${randomUUID()}.wav`);
      const res = await this.#request({ model, text: clean, out, length_scale: lengthScale, noise_scale: noiseScale,
        noise_w: noiseW, speaker, volume });
      this.stats.spoken++; this.stats.lastMs = res.ms;
      this.#touch();
      return { path: out, seconds: res.seconds, ms: res.ms };
    };
    const p = this.chain.then(job, job);
    this.chain = p.catch(() => {});
    return p;
  }

  async unload(voice) {
    const model = join(this.voiceDir, voice + '.onnx');
    if (this.proc) await this.#request({ op: 'unload', model }).catch(() => {});
  }

  shutdown(why = 'stop') {
    clearTimeout(this.idleTimer);
    if (!this.proc) return;
    this.log(`[tts] worker stopped (${why})`);
    this.proc.stdin.end();
    const p = this.proc;
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 3000).unref();
    this.proc = null;
  }

  summary() {
    return { workerRunning: Boolean(this.proc), workerPid: this.proc?.pid ?? null, spoken: this.stats.spoken, lastMs: this.stats.lastMs,
      voices: this.listVoices().length };
  }
}
