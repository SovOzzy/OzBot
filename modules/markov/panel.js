// Markov chat page: what it has learned, sample sentences, history import, clear.
export async function render(el, api) {
  const { h, toast } = api;
  const stats = h('div', { class: 'stats' });
  const perChan = h('ul', { class: 'list' });
  const importBox = h('div');
  const out = h('div');
  const about = h('input', { type: 'text', placeholder: 'Optional word to include', maxlength: 40, 'aria-label': 'Word to include' });
  const genBtn = h('button', { class: 'btn primary', type: 'button' }, 'Make 5 sentences');
  genBtn.onclick = async () => {
    genBtn.disabled = true;
    try {
      const r = await api.post('sample', { count: 5, about: about.value });
      out.replaceChildren(...(r.sentences.length ? r.sentences.map((s) => h('div', { class: 'quote' }, s)) : [h('p', { class: 'muted' }, 'Nothing yet: it needs more messages (or that word is unknown).')]));
    } catch (e) { toast(e.message, 'bad'); }
    genBtn.disabled = false;
  };

  el.append(
    h('div', { class: 'cols' },
      h('section', { class: 'card' }, h('h2', {}, 'What it knows'), stats, h('div', { style: 'height:12px' }), perChan),
      h('section', { class: 'card' }, h('h2', {}, 'Try it'), h('div', { class: 'actions', style: 'margin-top:0' }, about, genBtn), out)),
    h('section', { class: 'card' }, h('h2', {}, 'Import older messages'),
      h('p', { class: 'muted', style: 'margin-top:0' }, 'OzBot only learns new messages by itself. Pull in history from a learning channel to get it talking straight away (about 100 messages a second).'),
      importBox),
  );

  const chanSel = h('select', { 'aria-label': 'Channel to import' });
  const limit = h('select', { 'aria-label': 'How many messages' }, ...[1000, 2000, 5000, 10000, 20000].map((n) => h('option', { value: n, selected: n === 2000 }, `last ${n.toLocaleString()}`)));
  const impBtn = h('button', { class: 'btn', type: 'button' }, 'Import');
  const progress = h('div');
  impBtn.onclick = async () => {
    impBtn.disabled = true;
    try { await api.post('backfill', { channelId: chanSel.value, limit: Number(limit.value) }); toast('Import started'); setTimeout(() => api.refresh(), 1500); }
    catch (e) { toast(e.message, 'bad'); }
    impBtn.disabled = false;
  };
  const clearBtn = h('button', { class: 'btn danger', type: 'button' }, 'Forget everything');
  clearBtn.onclick = async () => {
    if (prompt('This deletes every learned message. Type DELETE to confirm.') !== 'DELETE') return;
    try { const r = await api.post('clear', { confirm: 'DELETE' }); toast(`Deleted ${r.deleted} messages`); api.refresh(); } catch (e) { toast(e.message, 'bad'); }
  };
  importBox.append(h('div', { class: 'actions', style: 'margin-top:0' }, chanSel, limit, impBtn), progress, h('div', { class: 'actions' }, clearBtn));

  let chans = [];
  const fillChannels = async (d) => {
    const g = (await api.guild()).guild;
    const wanted = d.settings?.channels ?? [];
    chans = (g?.textChannels ?? []).filter((c) => wanted.includes(c.id));
    chanSel.replaceChildren(...(chans.length ? chans.map((c) => h('option', { value: c.id }, `#${c.name}`)) : [h('option', { value: '' }, 'Pick learning channels in Settings first')]));
  };
  await fillChannels(api.module);

  let lastChannels = '';
  let ticking = false;
  api.onUpdate((d) => {
    const live = d.live;
    const key = JSON.stringify(d.settings?.channels ?? []);
    if (key !== lastChannels) { lastChannels = key; fillChannels(d); }
    impBtn.disabled = d.status !== 'on' || Boolean(live?.backfill?.running);
    if (!live) {
      stats.replaceChildren(h('p', { class: 'muted' }, d.status === 'on' ? 'Loading…' : 'Switch it on to see stats.'));
      perChan.replaceChildren();
      return;
    }
    const n = (x) => (x ?? 0).toLocaleString();
    stats.replaceChildren(
      h('div', { class: 'stat' }, h('b', {}, n(live.stored)), h('span', {}, 'messages')),
      h('div', { class: 'stat' }, h('b', {}, n(live.states)), h('span', {}, 'word patterns')),
      h('div', { class: 'stat' }, h('b', {}, n(live.optedOut)), h('span', {}, 'opted out')));
    perChan.replaceChildren(...live.channels.map((c) => h('li', {}, `#${c.name}`, h('span', { class: 'muted' }, ` · ${n(c.messages)}`))));
    const b = live.backfill;
    progress.replaceChildren(b ? h('div', { style: 'margin-top:12px' },
      h('progress', { max: b.wanted, value: b.done }),
      h('p', { class: b.error ? 'err' : 'muted' }, `#${b.channel}: read ${n(b.done)} of ${n(b.wanted)}, learned ${n(b.stored)}${b.running ? '…' : ' (done)'}${b.error ? ` · ${b.error}` : ''}`)) : '');
    if (b?.running && !ticking) { ticking = true; setTimeout(() => { ticking = false; api.refresh(); }, 2000); }
  });
}
