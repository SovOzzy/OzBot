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

  el.append(h('div', { class: 'cols' },
    h('section', { class: 'card' }, h('h2', {}, 'Right now'), statusBox,
      h('div', { class: 'actions' }, chanSel, joinBtn, leaveBtn)),
    h('section', { class: 'card' }, h('h2', {}, 'Talk'), text,
      h('div', { class: 'actions' }, voiceSel, sayBtn, speakBtn))));

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
      s.channel ? [h('dt', {}, 'People there'), h('dd', {}, String(s.humans))] : null,
      s.channel ? [h('dt', {}, 'Next random line'), h('dd', {}, s.nextTalkAt ? `in ${Math.max(0, Math.round((s.nextTalkAt - Date.now()) / 60000 * 10) / 10)} min` : 'random talk off')] : null,
      h('dt', {}, 'Queue'), h('dd', {}, s.speaking ? `speaking, ${s.queue} waiting` : `${s.queue} waiting`),
      s.last ? [h('dt', {}, 'Last said'), h('dd', {}, `“${s.last.text}” (${s.last.voice}, ${api.ago(s.last.at)})`)] : null,
      s.markov ? null : [h('dt', {}, 'Note'), h('dd', {}, 'Markov chat is off: no random sentences, /say still works.')]].flat().filter(Boolean));
  });
}
