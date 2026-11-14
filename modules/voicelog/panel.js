// Voice log page: is the channel set up and allowed, test post, last lines posted.
export async function render(el, api) {
  const { h, toast } = api;
  const statusBox = h('div');
  const recentBox = h('ul', { class: 'list' });
  const test = h('button', { class: 'btn primary', type: 'button' }, 'Send a test post');
  test.onclick = async () => {
    test.disabled = true;
    try { await api.post('test'); toast('Test posted, check the channel'); api.refresh(); } catch (e) { toast(e.message, 'bad'); }
    test.disabled = false;
  };
  el.append(h('div', { class: 'cols' },
    h('section', { class: 'card' }, h('h2', {}, 'Channel'), statusBox, h('div', { class: 'actions' }, test)),
    h('section', { class: 'card' }, h('h2', {}, 'Last posted'), recentBox)));

  api.onUpdate((d) => {
    const s = d.live;
    test.disabled = d.status !== 'on';
    if (!s) { statusBox.replaceChildren(h('p', { class: 'muted' }, d.status === 'on' ? 'Loading…' : 'Switched off.')); recentBox.replaceChildren(); return; }
    const p = s.permissions;
    statusBox.replaceChildren(
      p.ok ? h('p', { style: 'margin-top:0' }, '✓ Posting to ', h('strong', {}, `#${p.channel}`), ` · ${s.posted} posted since start`)
        : h('div', { class: 'banner warn', style: 'margin:0' }, p.missing?.length
          ? [`OzBot is missing `, h('strong', {}, p.missing.join(', ')), ` in #${p.channel}. Server Settings → Roles → OzBot (or the channel’s permissions) → turn it on.`]
          : p.problem),
      s.lastError ? h('div', { class: 'banner bad', style: 'margin:12px 0 0' }, `Last problem: ${s.lastError}`) : '');
    recentBox.replaceChildren(...(s.recent.length ? s.recent.map((r) => h('li', {},
      h('div', {}, `“${r.text}”`), h('div', { class: 'muted', style: 'font-size:13px' },
        `${r.voice_name ?? ''} · ${r.source ?? ''}${r.user_name ? ` · ${r.user_name}` : ''} · ${api.ago(r.at)}`)))
      : [h('li', { class: 'muted' }, 'Nothing yet.')]));
  });
}
