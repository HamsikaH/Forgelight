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
  let prevT = 0;
  for (const { t, event, state } of items) {
    const gap = Math.min(Math.max(0, t - prevT) / speed, 1200);
    prevT = t;
    if (gap > 4) await new Promise((r) => setTimeout(r, gap));
    // A line {"t":0,"state":{"models":[...]}} sets the header state (model chain) for the replay.
    if (state && typeof state === 'object') {
      if (Array.isArray(state.models)) models = state.models.map(String);
      send({ type: 'state', running: !!state.running, models, trueforgeUrl: 'http://localhost:8790', mcpUrl: 'http://127.0.0.1:7341/mcp' });
      window.__replay.done++;
      continue;
    }
    if (!event) continue;
    if (event.type === 'run.started') send({ type: 'state', running: true, models, trueforgeUrl: 'http://localhost:8790' });
    send({ type: 'event', event });
    if (event.type === 'run.finished') send({ type: 'state', running: false, models, trueforgeUrl: 'http://localhost:8790' });
    window.__replay.done++;
    bar.textContent = `preview ${window.__replay.done}/${items.length} · ${(t / 1000).toFixed(1)}s · ${event.type}`;
    if (stopAt && event.type === stopAt) {
      bar.textContent += ' (stopped)';
      return;
    }
  }
  bar.textContent += ' · end';
  document.body.dataset.replay = 'done';
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
