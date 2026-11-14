// "Record a voice" on the Voice profiles page: read prompts aloud, each clip becomes a 22,050 Hz mono 16-bit WAV
// (made here in the browser), uploaded as you go; Finish packs a zip for trainer/import.sh. Leaving the page deletes
// the session from the server (with a warning first).

const RATE = 22050;
const WORKLET = `class OzRec extends AudioWorkletProcessor {
  constructor() { super(); this.on = false; this.port.onmessage = (e) => { this.on = e.data; }; }
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (this.on && ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor('oz-rec', OzRec);`;

export function mountRecorder(el, api) {
  const { h, toast } = api;
  const css = h('style', {}, `
    .rec-prompt { font-size: clamp(20px, 3.4vw, 30px); line-height: 1.35; font-weight: 650; padding: 22px; border-radius: 14px;
      background: var(--surface-2); border: 2px solid var(--border); min-height: 120px; display: flex; align-items: center; }
    .rec-prompt.live { border-color: var(--bad); box-shadow: 0 0 0 4px color-mix(in srgb, var(--bad) 18%, transparent); }
    .rec-next { color: var(--muted); font-size: 14px; margin: 8px 2px 0; }
    .rec-meter { height: 10px; border-radius: 999px; background: var(--surface-2); overflow: hidden; border: 1px solid var(--border); }
    .rec-meter i { display: block; height: 100%; width: 0; background: var(--ok); transition: width 60ms linear; }
    .rec-meter i.hot { background: var(--bad); }
    .rec-big { min-width: 150px; font-size: 17px; min-height: 52px; }
    .rec-big.live { background: var(--bad); border-color: var(--bad); color: #fff; }
    .rec-top { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
    .rec-dots { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 14px; }
    .rec-dots button { width: 12px; height: 12px; padding: 0; border-radius: 3px; border: 0; background: var(--border); cursor: pointer; }
    .rec-dots button.done { background: var(--ok); } .rec-dots button.cur { outline: 2px solid var(--accent); outline-offset: 1px; }
    .rec-msg { min-height: 1.5em; margin: 10px 0 0; font-weight: 600; }
    .rec-msg.bad { color: var(--bad); } .rec-msg.ok { color: var(--ok); }
    kbd { font: 12px ui-monospace, monospace; padding: 1px 6px; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 5px; background: var(--surface); }
  `);
  const card = h('section', { class: 'card' });
  el.append(css, card);

  let S = null; // { session, voice, prompts, done:Set, i, finished, downloaded, sizeMB, seconds }
  let audio = null; // { stream, ac, node, analyser, raf }
  let recording = null; // { chunks: [], started }
  const clips = new Map(); // index -> Blob (this page only, for playback)

  api.guardLeave(
    () => S ? (S.downloaded
      ? 'Leaving deletes these recordings from the server. You have downloaded the zip, so that is fine.'
      : 'Your recordings have not been downloaded yet. Leaving this page deletes them from the server. Leave anyway?') : null,
    () => discard(true),
  );

  function discard(beacon) {
    stopAudio();
    if (!S) return;
    const body = JSON.stringify({ session: S.session });
    if (beacon) navigator.sendBeacon('/api/m/voices/rec-discard', new Blob([body], { type: 'application/json' }));
    else api.post('rec-discard', { session: S.session }).catch(() => {});
    S = null; clips.clear();
  }

  // ---------------------------------------------------------------- start screen
  // Which sets were already recorded for a voice name, remembered in this browser only (a convenience, not storage).
  const DONE_KEY = 'ozbot.rec.done';
  const doneSets = (voice) => { try { return JSON.parse(localStorage.getItem(DONE_KEY) || '{}')[voice] ?? []; } catch { return []; } };
  const markDone = (voice, set) => {
    try { const all = JSON.parse(localStorage.getItem(DONE_KEY) || '{}'); all[voice] = [...new Set([...(all[voice] ?? []), set])]; localStorage.setItem(DONE_KEY, JSON.stringify(all)); } catch {}
  };

  async function drawStart() {
    let sets = [];
    try { sets = (await api.get('rec-sets')).sets; } catch (e) { toast(e.message, 'bad'); }
    const name = h('input', { type: 'text', id: 'rec-name', maxlength: 30, placeholder: 'e.g. oz', autocomplete: 'off' });
    const go = h('button', { class: 'btn primary', type: 'submit' }, '🎙️ Start recording');
    const setBox = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Prompt set' });
    const drawSets = () => {
      const voice = name.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
      const done = doneSets(voice);
      const current = setBox.querySelector('input:checked')?.value;
      const firstTodo = sets.find((x) => !done.includes(x.id))?.id ?? sets[0]?.id;
      setBox.replaceChildren(...sets.map((x) => h('label', { class: 'chip' },
        h('input', { type: 'radio', name: 'rec-set', value: x.id, checked: String(current ?? firstTodo) === String(x.id) }),
        x.name, done.includes(x.id) ? h('small', {}, ' ✓ recorded') : '')));
    };
    name.addEventListener('input', () => { setBox.querySelector('input:checked') && (setBox.querySelector('input:checked').checked = false); drawSets(); });
    card.replaceChildren(
      h('h2', {}, 'Record a voice for training'),
      h('p', { class: 'muted', style: 'margin-top:0' },
        'Read sentences out loud in your browser. At the end you download a zip that the trainer on your PC can use straight away (', h('code', {}, './import.sh'), '). '
        + 'Each set is 100 different sentences, about 8-10 minutes of speech. You can finish a set after 10. More sets mean a better voice: add them with ', h('code', {}, '--append'), '.'),
      h('ul', { class: 'muted', style: 'margin:0 0 14px;padding-left:20px' },
        h('li', {}, 'Quiet room, no music or TV. Use the same microphone and distance (about a hand’s width) for every set.'),
        h('li', {}, 'Talk the way you want the bot to sound: relaxed and natural, not like you’re reading.'),
        h('li', {}, 'Only record voices you have permission to use (your own, or a friend who said yes).')),
      h('form', { onsubmit: async (e) => {
        e.preventDefault(); go.disabled = true;
        try {
          const set = Number(setBox.querySelector('input:checked')?.value ?? 1);
          const r = await api.post('rec-start', { voice: name.value, set });
          S = { ...r, done: new Set(), i: 0, finished: false, downloaded: false };
          drawSession();
          await startAudio();
        } catch (err) { toast(err.message, 'bad'); }
        go.disabled = false;
      } },
      h('div', { class: 'field', style: 'padding:0;border:0' }, h('label', { for: 'rec-name' }, 'Voice name'),
        h('p', { class: 'help' }, 'Short, letters/numbers/_ only, and the same name for every set of the same voice.'), name),
      h('div', { class: 'field', style: 'border:0;padding-bottom:0' }, h('span', { class: 'lbl' }, 'Sentences'),
        h('p', { class: 'help' }, '✓ = already recorded in this browser for that voice name.'), setBox),
      h('div', { class: 'actions' }, go)));
    drawSets();
  }

  // ---------------------------------------------------------------- microphone
  async function startAudio(deviceId) {
    stopAudio();
    if (!navigator.mediaDevices?.getUserMedia) { toast('This browser cannot record audio here (needs HTTPS)', 'bad'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const ac = new AudioContext();
      await ac.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
      const src = ac.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ac, 'oz-rec');
      const analyser = ac.createAnalyser(); analyser.fftSize = 1024;
      src.connect(analyser); src.connect(node);
      node.port.onmessage = (e) => recording?.chunks.push(e.data);
      audio = { stream, ac, node, analyser };
      meterLoop();
      fillDevices(stream.getAudioTracks()[0]?.getSettings().deviceId);
      setMsg('Microphone ready. Press Record (or Space) and read the sentence.', '');
    } catch (e) {
      setMsg(e.name === 'NotAllowedError' ? 'Microphone blocked: allow it in the browser’s address bar, then press “Use microphone”.' : `Microphone error: ${e.message}`, 'bad');
    }
    syncButtons();
  }

  function stopAudio() {
    if (!audio) return;
    cancelAnimationFrame(audio.raf);
    audio.stream.getTracks().forEach((t) => t.stop());
    audio.ac.close().catch(() => {});
    audio = null; recording = null;
  }

  function meterLoop() {
    if (!audio) return;
    const buf = new Float32Array(audio.analyser.fftSize);
    audio.analyser.getFloatTimeDomainData(buf);
    let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v));
    const bar = card.querySelector('.rec-meter i');
    if (bar) { bar.style.width = `${Math.min(100, Math.sqrt(peak) * 100)}%`; bar.classList.toggle('hot', peak > 0.95); }
    audio.raf = requestAnimationFrame(meterLoop);
  }

  async function fillDevices(current) {
    const sel = card.querySelector('#rec-dev');
    if (!sel) return;
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    sel.replaceChildren(...devs.map((d, n) => h('option', { value: d.deviceId, selected: d.deviceId === current }, d.label || `Microphone ${n + 1}`)));
  }

  // ---------------------------------------------------------------- session screen
  let ui = {};
  function drawSession() {
    ui.prompt = h('div', { class: 'rec-prompt', 'aria-live': 'polite' });
    ui.next = h('p', { class: 'rec-next' });
    ui.count = h('strong');
    ui.time = h('span', { class: 'muted' });
    ui.rec = h('button', { class: 'btn primary rec-big', type: 'button', onclick: toggleRecord });
    ui.play = h('button', { class: 'btn', type: 'button', onclick: playCurrent }, '▶ Play');
    ui.prev = h('button', { class: 'btn', type: 'button', onclick: () => go(S.i - 1) }, '◀ Back');
    ui.skip = h('button', { class: 'btn', type: 'button', onclick: () => go(S.i + 1) }, 'Skip ▶');
    ui.finish = h('button', { class: 'btn', type: 'button', onclick: finish }, 'Finish & make zip');
    ui.msg = h('p', { class: 'rec-msg', role: 'status' });
    ui.dots = h('div', { class: 'rec-dots', 'aria-label': 'Sentences' });
    ui.result = h('div');
    const dev = h('select', { id: 'rec-dev', 'aria-label': 'Microphone', style: 'max-width:320px', onchange: (e) => startAudio(e.target.value) });
    card.replaceChildren(
      h('div', { class: 'rec-top' }, h('h2', { style: 'margin:0' }, `Recording “${S.voice}” · set ${S.set}`), h('span', {}, ui.count, ' ', ui.time)),
      ui.prompt, ui.next,
      h('div', { class: 'actions' }, ui.rec, ui.play, ui.prev, ui.skip),
      h('div', { class: 'actions', style: 'margin-top:12px' }, h('div', { class: 'rec-meter', style: 'flex:1;min-width:160px' }, h('i')), dev,
        h('button', { class: 'btn', type: 'button', onclick: () => startAudio(dev.value) }, 'Use microphone')),
      ui.msg,
      h('p', { class: 'muted', style: 'font-size:13px;margin:4px 0 0' }, h('kbd', {}, 'Space'), ' record / stop · ', h('kbd', {}, '←'), ' back · ', h('kbd', {}, '→'), ' skip · ', h('kbd', {}, 'P'), ' play'),
      ui.dots,
      h('div', { class: 'actions' }, ui.finish,
        h('button', { class: 'btn danger', type: 'button', onclick: () => { if (confirm('Throw away this whole recording session?')) { discard(false); drawStart(); } } }, 'Discard all')),
      ui.result);
    S.prompts.forEach((_, n) => ui.dots.append(h('button', { type: 'button', title: `Sentence ${n + 1}`, 'aria-label': `Sentence ${n + 1}`, onclick: () => go(n) })));
    show();
  }

  function show() {
    if (!S || !ui.prompt) return;
    ui.prompt.textContent = S.prompts[S.i];
    ui.next.textContent = S.i + 1 < S.prompts.length ? `Next: ${S.prompts[S.i + 1]}` : 'Last sentence!';
    ui.count.textContent = `Sentence ${S.i + 1} of ${S.prompts.length}`;
    ui.time.textContent = `· ${S.done.size} recorded${S.seconds ? ` · ${Math.floor(S.seconds / 60)}:${String(S.seconds % 60).padStart(2, '0')} of speech` : ''}`;
    [...ui.dots.children].forEach((d, n) => { d.classList.toggle('done', S.done.has(n)); d.classList.toggle('cur', n === S.i); });
    syncButtons();
  }

  function syncButtons() {
    if (!ui.rec || !S) return;
    const live = Boolean(recording);
    ui.rec.textContent = live ? '■ Stop' : S.done.has(S.i) ? '● Record again' : '● Record';
    ui.rec.classList.toggle('live', live);
    ui.prompt.classList.toggle('live', live);
    ui.rec.disabled = !audio || ui.busy;
    ui.play.disabled = live || !clips.has(S.i);
    ui.prev.disabled = live || S.i === 0;
    ui.skip.disabled = live || S.i >= S.prompts.length - 1;
    ui.finish.disabled = live || S.done.size < 10;
    ui.finish.title = S.done.size < 10 ? 'Record at least 10 sentences' : '';
  }

  function setMsg(text, kind) { if (ui.msg) { ui.msg.textContent = text; ui.msg.className = `rec-msg ${kind}`; } }

  function go(n) {
    if (recording || !S) return;
    S.i = Math.max(0, Math.min(S.prompts.length - 1, n));
    setMsg('', '');
    show();
  }

  function toggleRecord() {
    if (!audio || ui.busy) return;
    if (!recording) {
      if (audio.ac.state === 'suspended') audio.ac.resume();
      recording = { chunks: [], started: performance.now() };
      audio.node.port.postMessage(true);
      setMsg('Recording… read the sentence, then press Stop (Space).', '');
    } else {
      audio.node.port.postMessage(false);
      const rec = recording; recording = null;
      setTimeout(() => processClip(rec), 120); // let the last audio chunks arrive
    }
    syncButtons();
  }

  async function processClip(rec) {
    ui.busy = true; syncButtons();
    try {
      const raw = concat(rec.chunks);
      if (raw.length < audio.ac.sampleRate * 0.4) throw new Error('That was too short. Press Record, read the sentence, then Stop.');
      const pcm = await resample(raw, audio.ac.sampleRate);
      const { data, peak, clipped, seconds } = trim(pcm);
      if (seconds < 0.6) throw new Error('No speech heard. Check the microphone and the level bar.');
      if (peak < 0.06) throw new Error('Very quiet: move closer to the microphone or turn its input level up, then record again.');
      const wav = encodeWav(data);
      await api.put('rec-clip', wav, { session: S.session, index: S.i }).then((r) => { S.seconds = r.seconds; });
      clips.set(S.i, wav);
      S.done.add(S.i);
      const warn = clipped > 20 ? ' It was a bit loud (clipping), so maybe record it again a little further away.' : '';
      setMsg(`✓ Saved (${seconds.toFixed(1)} s).${warn}`, warn ? 'bad' : 'ok');
      if (!warn) {
        const nextTodo = S.prompts.findIndex((_, n) => n > S.i && !S.done.has(n));
        if (nextTodo >= 0) S.i = nextTodo;
        else if (S.done.size === S.prompts.length) setMsg('✓ All sentences recorded! Press “Finish & make zip”.', 'ok');
      }
    } catch (e) { setMsg(e.message, 'bad'); }
    ui.busy = false;
    show();
  }

  function playCurrent() {
    const b = clips.get(S?.i);
    if (!b) return;
    const a = new Audio(URL.createObjectURL(b));
    a.play().catch(() => {});
  }

  async function finish() {
    ui.finish.disabled = true;
    setMsg('Packing the zip…', '');
    try {
      const r = await api.post('rec-finish', { session: S.session });
      S.finished = true; S.sizeMB = r.sizeMB; S.download = r.download;
      markDone(S.voice, S.set);
      setMsg('', '');
      const link = h('a', { class: 'btn primary rec-big', href: `/api/m/voices/rec-download?session=${S.session}`, download: r.download,
        onclick: () => { S.downloaded = true; setTimeout(drawDownloaded, 400); } }, `⬇ Download ${r.download} (${r.sizeMB} MB)`);
      ui.result.replaceChildren(h('div', { class: 'banner info', style: 'margin-top:16px' },
        h('p', { style: 'margin:0 0 10px' }, `${r.clips} sentences, ${Math.round(r.seconds / 60)} min of speech.`),
        link,
        h('p', { class: 'muted', style: 'margin:10px 0 0' }, 'Recorded more after this? Press Finish again to rebuild the zip.')));
    } catch (e) { setMsg(e.message, 'bad'); }
    syncButtons();
  }

  function drawDownloaded() {
    const first = !doneSets(S.voice).some((x) => x !== S.set);
    const cmds = first
      ? `./import.sh ${S.voice} ~/Downloads/${S.download}\n./train.sh ${S.voice}\n./export.sh ${S.voice}`
      : `./import.sh ${S.voice} ~/Downloads/${S.download} --append\n./train.sh ${S.voice} --fresh\n./export.sh ${S.voice}`;
    ui.result.replaceChildren(h('div', { class: 'banner info', style: 'margin-top:16px' },
      h('p', { style: 'margin:0 0 6px;font-weight:600' }, '✓ Downloaded. Next, on your PC (WSL, in the trainer folder):'),
      h('pre', { style: 'margin:0 0 6px;white-space:pre-wrap' }, cmds),
      h('p', { class: 'muted', style: 'margin:0 0 10px' }, first
        ? 'Recording another set later? Import it with --append and train with --fresh.'
        : 'Adding to a voice you trained before: --append keeps the earlier sets, --fresh retrains on all of them.'),
      h('p', { class: 'muted', style: 'margin:0 0 10px' }, 'The copy on the server is deleted when you leave this page, or now:'),
      h('div', { class: 'actions', style: 'margin:0' },
        h('a', { class: 'btn', href: `/api/m/voices/rec-download?session=${S.session}`, download: S.download }, 'Download again'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => { discard(false); toast('Deleted from the server'); drawStart(); } }, 'Done, delete it from the server'))));
  }

  // keyboard shortcuts while a session is open (not while typing in a field)
  const onKey = (e) => {
    if (!S || !ui.prompt?.isConnected || e.target.closest?.('input, textarea, select') || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); toggleRecord(); }
    else if (e.key === 'ArrowLeft') go(S.i - 1);
    else if (e.key === 'ArrowRight') go(S.i + 1);
    else if (e.key === 'p' || e.key === 'P') playCurrent();
  };
  document.addEventListener('keydown', onKey);
  api.guardLeave(null, () => document.removeEventListener('keydown', onKey));

  drawStart();
}

// ---------------------------------------------------------------- audio helpers
function concat(chunks) {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function resample(data, from) {
  if (from === RATE) return data;
  const len = Math.ceil(data.length * RATE / from);
  const off = new OfflineAudioContext(1, len, RATE);
  const buf = off.createBuffer(1, data.length, from);
  buf.copyToChannel(data, 0);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  return (await off.startRendering()).getChannelData(0);
}

// Cut leading/trailing silence (20 ms windows), keep ~200 ms padding, remove DC offset.
function trim(pcm) {
  let mean = 0; for (const v of pcm) mean += v; mean /= pcm.length || 1;
  const win = Math.round(RATE * 0.02);
  const rms = [];
  for (let i = 0; i < pcm.length; i += win) {
    let s = 0; const end = Math.min(pcm.length, i + win);
    for (let j = i; j < end; j++) { const v = pcm[j] - mean; s += v * v; }
    rms.push(Math.sqrt(s / (end - i)));
  }
  const loud = Math.max(...rms, 0);
  const thr = Math.max(0.008, loud * 0.08);
  let a = rms.findIndex((r) => r > thr), b = rms.length - 1 - [...rms].reverse().findIndex((r) => r > thr);
  if (a < 0) return { data: new Float32Array(0), peak: 0, clipped: 0, seconds: 0 };
  const pad = Math.round(0.2 * RATE / win);
  a = Math.max(0, a - pad); b = Math.min(rms.length - 1, b + pad);
  const data = pcm.slice(a * win, Math.min(pcm.length, (b + 1) * win)).map((v) => v - mean);
  let peak = 0, clipped = 0;
  for (const v of data) { const x = Math.abs(v); if (x > peak) peak = x; if (x > 0.985) clipped++; }
  return { data, peak, clipped, seconds: data.length / RATE };
}

function encodeWav(data) {
  const buf = new ArrayBuffer(44 + data.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + data.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) { const s = Math.max(-1, Math.min(1, data[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}
