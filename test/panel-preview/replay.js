// Replays a recorded ForgeEvent stream (JSON lines {t, event}) into the panel, as the extension would.
(async function () {
  const params = new URLSearchParams(location.search);
  const file = params.get('events');
  const speed = Math.max(0.1, Number(params.get('speed') || 20));
  const stopAt = params.get('stopAt'); // optional event type to stop after, e.g. review.opened
  let models = (params.get('models') || 'ollama/qwen3-6-35b').split(',');
  const bar = document.getElementById('preview-bar');
  const send = (msg) => window.postMessage(msg, '*');

  send({ type: 'state', running: false, models, trueforgeUrl: 'http://localhost:8790', mcpUrl: 'http://127.0.0.1:7341/mcp' });
  if (!file) {
    bar.textContent = 'preview: no ?events= file (idle panel)';
    return;
  }
  const text = await (await fetch(file)).text();
  const items = text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  window.__replay = { total: items.length, done: 0 };
  // &checks=1: after every DOM change, record any moment where something that must stay visible
  // is hidden: a card waiting for a decision, the streaming text or thought, or a banner.
  if (params.get('checks')) {
    const seen = new Set();
    window.__violations = [];
    const shown = (n) => n.getClientRects().length > 0;
    const flag = (what, node) => {
      const key = what + '|' + (node.textContent || '').slice(0, 60);
      if (seen.has(key)) return;
      seen.add(key);
      window.__violations.push({ what, at: window.__replay.done, text: (node.textContent || '').slice(0, 100) });
    };
    new MutationObserver(() => {
      for (const c of document.querySelectorAll('.card.review:not(.closed), .card.approval:not(.resolved)')) if (!shown(c) || c.classList.contains('compact')) flag('pending card hidden', c);
      for (const s of document.querySelectorAll('.md.streaming, details.thinking .spinner')) if (!shown(s)) flag('streaming block hidden', s);
      for (const b of document.querySelectorAll('.banner')) if (!shown(b)) flag('banner hidden', b);
    }).observe(document.getElementById('log'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'open'] });
  }
  // Events carry their recorded time (`at`), as the extension's do, so durations match the recording.
  // &asHistory=1 sends everything at once with hour-old times, like the extension's replay on 'ready'.
  const asHistory = !!params.get('asHistory');
  const base = (asHistory ? Date.now() - 3600000 : Date.now()) - (items.length ? items[0].t || 0 : 0);
  let prevT = 0;
  for (const { t, event, state } of items) {
    const gap = Math.min(Math.max(0, t - prevT) / speed, 1200);
    prevT = t;
    if (gap > 4 && !asHistory) await new Promise((r) => setTimeout(r, gap));
    // A line {"t":0,"state":{"models":[...]}} sets the header state (model chain) for the replay.
    if (state && typeof state === 'object') {
      if (Array.isArray(state.models)) models = state.models.map(String);
      send({ type: 'state', running: !!state.running, models, trueforgeUrl: 'http://localhost:8790', mcpUrl: 'http://127.0.0.1:7341/mcp' });
      window.__replay.done++;
      continue;
    }
    if (!event) continue;
    if (event.type === 'run.started') send({ type: 'state', running: true, models, trueforgeUrl: 'http://localhost:8790' });
    send({ type: 'event', event, at: base + (t || 0) });
    if (event.type === 'run.finished') send({ type: 'state', running: false, models, trueforgeUrl: 'http://localhost:8790' });
    window.__replay.done++;
    bar.textContent = `preview ${window.__replay.done}/${items.length} · ${(t / 1000).toFixed(1)}s · ${event.type}`;
    // &stopAfter=N freezes the replay after N lines (to look at a run mid-step).
    if ((stopAt && event.type === stopAt) || (params.get('stopAfter') && window.__replay.done >= Number(params.get('stopAfter')))) {
      bar.textContent += ' (stopped)';
      return;
    }
  }
  bar.textContent += ' · end';
  document.body.dataset.replay = 'done';
  // With &checks=1, a summary for headless runs (chrome --headless --virtual-time-budget=… --dump-dom).
  if (window.__violations) {
    await new Promise((r) => setTimeout(r, 400));
    const q = (s) => document.querySelectorAll(s).length;
    const pre = document.createElement('pre');
    pre.id = 'preview-checks';
    pre.hidden = true;
    pre.textContent = JSON.stringify({
      violations: window.__violations,
      errors: window.__errors || [],
      runHeights: Array.from(document.querySelectorAll('.run')).map((r) => Math.round(r.getBoundingClientRect().height)),
      steps: q('.step'),
      liveSteps: q('.step.live'),
      compactCards: q('.card.compact'),
      openGroups: q('.group.open'),
      banners: Array.from(document.querySelectorAll('.banner')).map((b) => b.className.replace('banner ', '') + ': ' + b.textContent.slice(0, 70)),
      finish: Array.from(document.querySelectorAll('.finish-card')).map((c) => c.innerText.replace(/\n+/g, ' | ').slice(0, 260)),
    });
    document.body.appendChild(pre);
  }
  // &scrollTop=N scrolls the transcript after the replay (to screenshot a region of a long run).
  if (params.get('scrollTop') !== null) {
    await new Promise((r) => setTimeout(r, 300));
    const tr = document.getElementById('transcript');
    tr.dispatchEvent(new Event('scroll'));
    tr.scrollTop = Number(params.get('scrollTop')) || 0;
  }
  // &debug=1: report the viewport and any element that sticks out to the right (horizontal overflow).
  if (params.get('debug')) {
    await new Promise((r) => setTimeout(r, 400));
    const vw = document.getElementById('app').getBoundingClientRect().right;
    const wide = [];
    for (const node of document.querySelectorAll('#app *')) {
      const r = node.getBoundingClientRect();
      if (r.width && r.right > vw + 0.5 && !node.closest('.diff, pre')) {
        wide.push(node.tagName.toLowerCase() + '.' + String(node.className && node.className.baseVal !== undefined ? node.className.baseVal : node.className).replace(/\s+/g, '.') + ' right=' + Math.round(r.right));
      }
    }
    const info = 'innerWidth=' + innerWidth + ' clientWidth=' + vw + ' app=' + Math.round(document.getElementById('app').getBoundingClientRect().width) + ' overflow=' + wide.length;
    document.body.dataset.layout = info;
    const pre = document.createElement('pre');
    pre.id = 'preview-layout';
    pre.hidden = true;
    pre.textContent = info + '\n' + wide.slice(0, 40).join('\n');
    document.body.appendChild(pre);
  }
})();
