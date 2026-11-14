// Voice chat page: where it is, join/leave, say something, speak a random sentence.
export async function render(el, api) {
  const { h, toast } = api;
  const statusBox = h('dl', { class: 'kv' });
  const chanSel = h('select', { 'aria-label': 'Voice channel' });
  const joinBtn = h('button', { class: 'btn primary', type: 'button' }, 'Join');
  const leaveBtn = h('button', { class: 'btn', type: 'button' }, 'Leave');
  const text = h('textarea', { placeholder: 'Type something for OzBot to say in voice…', maxlength: 600, 'aria-label': 'Text to say' });
  const voiceSel = h('select', { 'aria-label': 'Voice' });
  const sayBtn = h('button', { class: 'btn primary', type: 'button' }, 'Say it');
  const speakBtn = h('button', { class: 'btn', type: 'button' }, 'Random sentence');

  const run = (btn, fn) => async () => {
    btn.disabled = true;
    try { await fn(); } catch (e) { toast(e.message, 'bad'); }
    btn.disabled = false; api.refresh();
  };
  joinBtn.onclick = run(joinBtn, async () => { await api.post('join', { channelId: chanSel.value }); toast('Joined'); });
  leaveBtn.onclick = run(leaveBtn, async () => { await api.post('leave'); toast('Left voice'); });
  sayBtn.onclick = run(sayBtn, async () => { const r = await api.post('say', { text: text.value, voice: voiceSel.value }); text.value = ''; toast(`Saying: ${r.said}`); });
  speakBtn.onclick = run(speakBtn, async () => { const r = await api.post('speak', { voice: voiceSel.value }); toast(`Saying: ${r.said}`); });

  const recentBox = h('ul', { class: 'list' });
  const recentCard = h('section', { class: 'card' }, h('h2', {}, 'Recent lines'), recentBox);
  el.append(h('div', { class: 'cols' },
    h('section', { class: 'card' }, h('h2', {}, 'Right now'), statusBox,
      h('div', { class: 'actions' }, chanSel, joinBtn, leaveBtn)),
    h('section', { class: 'card' }, h('h2', {}, 'Talk'), text,
      h('div', { class: 'actions' }, voiceSel, sayBtn, speakBtn))), recentCard);

  let lastRecent = '';
  async function playLine(index, btn) {
    btn.disabled = true; btn.textContent = '…';
    try {
      const r = await api.fetchRaw('play-line', { index });
      const a = new Audio(URL.createObjectURL(await r.blob()));
      await a.play().catch(() => {});
    } catch (e) { toast(e.message, 'bad'); }
    btn.disabled = false; btn.textContent = '▶';
  }

  const g = (await api.guild()).guild;
  const home = api.module.settings?.homeChannel;
  chanSel.replaceChildren(...((g?.voiceChannels ?? []).map((c) => h('option', { value: c.id, selected: c.id === home }, `🔊 ${c.name}`))));
  if (!chanSel.options.length) chanSel.append(h('option', { value: '' }, 'No voice channels'));
  const voices = await api.voices();
  voiceSel.replaceChildren(h('option', { value: '' }, 'Voice from settings'), ...voices.map((v) => h('option', { value: v.id }, v.profile.name || v.id)));

  api.onUpdate((d) => {
    const s = d.live;
    const on = d.status === 'on';
    for (const b of [joinBtn, leaveBtn, sayBtn, speakBtn]) b.disabled = !on;
    if (!chanSel.value) joinBtn.disabled = true;
    if (!s) { statusBox.replaceChildren(h('dt', {}, 'Status'), h('dd', {}, on ? 'Loading…' : 'Switched off')); return; }
    leaveBtn.disabled = !s.channel; sayBtn.disabled = speakBtn.disabled = !s.channel;
    speakBtn.title = s.markov ? '' : 'Markov chat is off';
    if (!s.markov) speakBtn.disabled = true;
    statusBox.replaceChildren(...[
      h('dt', {}, 'Channel'), h('dd', {}, s.channel ? `🔊 ${s.channel.name}` : 'Not in voice'),
      h('dt', {}, 'Voice'), h('dd', {}, `${s.voiceName}${s.voiceMode === 'random' ? ' (random lines: random voice)' : ''}`),
      s.channel ? [h('dt', {}, 'People there'), h('dd', {}, String(s.humans))] : null,
      s.channel ? [h('dt', {}, 'Next random line'), h('dd', {}, s.nextTalkAt ? `in ${Math.max(0, Math.round((s.nextTalkAt - Date.now()) / 60000 * 10) / 10)} min` : 'random talk off')] : null,
      h('dt', {}, 'Queue'), h('dd', {}, s.speaking ? `speaking, ${s.queue} waiting` : `${s.queue} waiting`),
      s.last ? [h('dt', {}, 'Last said'), h('dd', {}, `“${s.last.text}” (${s.last.voice}, ${api.ago(s.last.at)})`)] : null,
      s.markov ? null : [h('dt', {}, 'Note'), h('dd', {}, 'Markov chat is off: no random sentences, /say still works.')]].flat().filter(Boolean));
    const key = JSON.stringify(s.recent.map((r) => r.at));
    if (key !== lastRecent) {
      lastRecent = key;
      recentBox.replaceChildren(...(s.recent.length ? s.recent.map((r, n) => {
        const play = h('button', { class: 'btn', type: 'button', title: 'Play', 'aria-label': 'Play this line', style: 'min-height:34px;padding:4px 12px' }, '▶');
        play.onclick = () => playLine(n, play);
        return h('li', { style: 'display:flex;gap:12px;align-items:flex-start' }, play,
          h('div', {}, h('div', {}, `“${r.text}”`), h('div', { class: 'muted', style: 'font-size:13px' },
            `${r.voice} · ${r.source}${r.user ? ` · ${r.user}` : ''} · ${api.ago(r.at)}`)));
      }) : [h('li', { class: 'muted' }, 'Nothing said yet since the bot started.')]));
    }
  });
}
