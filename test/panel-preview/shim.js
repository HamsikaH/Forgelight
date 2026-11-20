// Stub of the VS Code webview API for the panel preview.
(function () {
  const params = new URLSearchParams(location.search);
  if (params.get('theme') === 'light') {
    document.getElementById('theme-light').media = 'all';
  }
  // &width=420 emulates a sidebar of that width (headless Chrome cannot make its window narrower than 500px).
  const width = Number(params.get('width'));
  if (width > 0) {
    document.documentElement.style.width = width + 'px';
    document.documentElement.style.overflow = 'hidden';
  }
  let state;
  window.__posted = [];
  window.acquireVsCodeApi = () => ({
    postMessage(msg) {
      window.__posted.push(msg);
      console.log('[panel → extension]', JSON.stringify(msg));
    },
    getState: () => state,
    setState: (s) => {
      state = s;
    },
  });

  // Surface render errors in the page itself (red box + body[data-errors]) so headless checks
  // (--dump-dom, screenshots) catch them without a devtools console.
  window.__errors = [];
  function report(text) {
    window.__errors.push(text);
    document.body.dataset.errors = String(window.__errors.length);
    let box = document.getElementById('preview-errors');
    if (!box) {
      box = document.createElement('pre');
      box.id = 'preview-errors';
      box.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:100;margin:0;padding:4px 6px;max-height:40vh;overflow:auto;' +
        'background:#5a1d1d;color:#fff;font:11px/1.35 Menlo,monospace;white-space:pre-wrap;';
      document.body.appendChild(box);
    }
    box.textContent += text + '\n';
  }
  const origError = console.error.bind(console);
  console.error = (...args) => {
    origError(...args);
    report('console.error: ' + args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  window.addEventListener('error', (e) => report('error: ' + (e.error && e.error.stack ? e.error.stack : e.message)));
  window.addEventListener('unhandledrejection', (e) => report('unhandledrejection: ' + String(e.reason && e.reason.stack ? e.reason.stack : e.reason)));
})();
