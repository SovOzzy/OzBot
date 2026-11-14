// Voice profiles page: record training clips, upload .onnx + .onnx.json, list voices, tune, preview, delete.
import { mountRecorder } from './panel-recorder.js';

export async function render(el, api) {
  const { h, toast } = api;
  const listBox = h('div');
  const fileInput = h('input', { type: 'file', accept: '.onnx,.json', multiple: true, hidden: true });
  const drop = h('div', { class: 'drop', tabindex: 0, role: 'button', 'aria-label': 'Upload voice files' },
    h('p', { style: 'margin:0 0 6px;font-weight:600;color:var(--text)' }, 'Drop the .onnx and .onnx.json here, or click to pick them'),
    h('p', { style: 'margin:0', class: 'muted' }, 'Both files of a voice, named the same (e.g. en_GB-oz-medium.onnx + en_GB-oz-medium.onnx.json). The trainer folder makes them.'));
  const upProgress = h('div');
  drop.onclick = () => fileInput.click();
  drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); };
  fileInput.onchange = () => { upload([...fileInput.files]); fileInput.value = ''; };

  // Upload with progress (XHR, because fetch has no upload progress). JSON configs go first.
  async function upload(files) {
    files = files.filter((f) => /\.onnx(\.json)?$/.test(f.name)).sort((a, b) => b.name.endsWith('.json') - a.name.endsWith('.json'));
    if (!files.length) return toast('Pick .onnx / .onnx.json files', 'bad');
    for (const f of files) {
      const bar = h('progress', { max: 100, value: 0 });
      const label = h('p', { class: 'muted', style: 'margin:4px 0 12px' }, `${f.name} (${(f.size / 1e6).toFixed(1)} MB)`);
      upProgress.append(bar, label);
      try {
        const r = await new Promise((resolve, reject) => {
          const x = new XMLHttpRequest();
          x.open('PUT', `/api/m/voices/upload?file=${encodeURIComponent(f.name)}`);
          x.setRequestHeader('content-type', 'application/octet-stream');
          x.upload.onprogress = (e) => { if (e.lengthComputable) bar.value = (e.loaded / e.total) * 100; };
          x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch {} x.status < 300 ? resolve(j) : reject(new Error(j.error || `Upload failed (${x.status})`)); };
          x.onerror = () => reject(new Error('Upload failed (network)'));
          x.send(f);
        });
        bar.value = 100;
        label.textContent = `${f.name}: uploaded${r.complete ? ', voice ready' : ', now upload its partner file'}`;
        if (r.complete) toast(`Voice ${r.id} is ready`);
      } catch (e) { label.textContent = `${f.name}: ${e.message}`; label.className = 'err'; toast(e.message, 'bad'); }
    }
    await draw();
    setTimeout(() => upProgress.replaceChildren(), 8000);
  }

  const recBox = h('div');
  mountRecorder(recBox, api);
  el.append(recBox, h('section', { class: 'card' }, h('h2', {}, 'Add a trained voice'), drop, fileInput, upProgress),
    h('section', { class: 'card' }, h('h2', {}, 'Installed voices'), listBox));

  async function draw() {
    const { voices } = await api.get('list');
    listBox.replaceChildren(...voices.map((v) => voiceCard(v, voices.length)));
    if (!voices.length) listBox.append(h('p', { class: 'muted' }, 'No voices yet.'));
  }

  function voiceCard(v, count) {
    const p = v.profile;
    const name = h('input', { type: 'text', value: p.name, maxlength: 60, 'aria-label': 'Display name' });
    const slider = (label, key, min, max, step, hint) => {
      const out = h('span', {}, String(p[key]));
      const r = h('input', { type: 'range', min, max, step, value: p[key], oninput: () => { out.textContent = r.value; } });
      r.dataset.key = key;
      return h('label', {}, h('span', {}, `${label}: `, out, hint ? h('span', {}, ` · ${hint}`) : ''), r);
    };
    const sliders = h('div', { class: 'sliders' },
      slider('Speed', 'lengthScale', 0.5, 2, 0.05, 'higher = slower'),
      slider('Expression', 'noiseScale', 0, 1.2, 0.01, ''),
      slider('Rhythm variation', 'noiseW', 0, 1.2, 0.01, ''),
      slider('Volume', 'volume', 0.2, 2, 0.05, ''));
    const speaker = v.speakers?.length ? h('select', { 'aria-label': 'Speaker' }, ...v.speakers.map((s) => h('option', { value: s, selected: s === p.speaker }, s))) : null;
    const sample = h('input', { type: 'text', placeholder: 'Preview text (optional)', maxlength: 300, 'aria-label': 'Preview text' });
    const audio = h('audio', { controls: true, preload: 'none', style: 'width:100%;display:none' });
    const read = () => {
      const body = { id: v.id, name: name.value, speaker: speaker?.value ?? '' };
      for (const r of sliders.querySelectorAll('input[type=range]')) body[r.dataset.key] = Number(r.value);
      return body;
    };
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Save');
    save.onclick = async () => { save.disabled = true; try { await api.put('profile', read()); toast('Voice saved'); } catch (e) { toast(e.message, 'bad'); } save.disabled = false; };
    const play = h('button', { class: 'btn', type: 'button' }, '▶ Preview');
    play.onclick = async () => {
      play.disabled = true; play.textContent = 'Speaking…';
      try {
        await api.put('profile', read());
        const r = await api.fetchRaw('preview', { id: v.id, text: sample.value });
        audio.src = URL.createObjectURL(await r.blob());
        audio.style.display = 'block';
        await audio.play().catch(() => {});
      } catch (e) { toast(e.message, 'bad'); }
      play.disabled = false; play.textContent = '▶ Preview';
    };
    const del = h('button', { class: 'btn danger', type: 'button', disabled: count <= 1 }, 'Delete');
    del.onclick = async () => {
      if (!confirm(`Delete the voice ${v.id}? The files are removed from the server.`)) return;
      try { await api.post('delete', { id: v.id }); toast('Deleted'); draw(); } catch (e) { toast(e.message, 'bad'); }
    };
    return h('div', { class: 'voice' },
      h('div', { class: 'vhead' }, h('h3', {}, p.name || v.id), v.isDefault ? h('span', { class: 'tag accent' }, 'default') : '',
        h('span', { class: 'tag' }, v.id), v.language ? h('span', { class: 'tag' }, v.language) : '', v.quality ? h('span', { class: 'tag' }, v.quality) : '',
        h('span', { class: 'tag' }, `${v.sizeMB} MB`), v.hasConfig ? '' : h('span', { class: 'tag', style: 'color:var(--bad)' }, 'missing .onnx.json')),
      h('label', { class: 'field', style: 'padding:0;border:0' }, h('span', { class: 'lbl' }, 'Name'), name),
      speaker ? h('label', { class: 'field', style: 'padding:0;border:0' }, h('span', { class: 'lbl' }, 'Speaker'), speaker) : '',
      sliders, sample, audio,
      h('div', { class: 'actions', style: 'margin-top:0' }, play, save, del));
  }

  await draw();
}
