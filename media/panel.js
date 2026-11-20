/* Forgelight agent panel webview. Vanilla JS: renders ExtensionToPanel messages, posts PanelToExtension. */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const isMac = document.body.dataset.platform === 'darwin';

  // ------------------------------------------------------------------ icons

  const ICONS = {
    logo: '<path d="M8 1.3l1.5 3.5 3.8.5-2.9 2.6.9 4.1L8 10l-3.3 2 .9-4.1-2.9-2.6 3.8-.5z"/><path d="M8 10v4.7"/>',
    file: '<path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
    symbol:
      '<path d="M5.5 2.5c-1.3 0-2 .6-2 1.8v1.6c0 .9-.5 1.6-1.5 2.1 1 .5 1.5 1.2 1.5 2.1v1.6c0 1.2.7 1.8 2 1.8"/>' +
      '<path d="M10.5 2.5c1.3 0 2 .6 2 1.8v1.6c0 .9.5 1.6 1.5 2.1-1 .5-1.5 1.2-1.5 2.1v1.6c0 1.2-.7 1.8-2 1.8"/>',
    folder: '<path d="M1.5 3.5h4.3l1.5 1.5h7.2v8.5h-13z"/>',
    tree:
      '<rect x="5.5" y="1.5" width="5" height="3.5" rx=".5"/><rect x="1.5" y="11" width="5" height="3.5" rx=".5"/>' +
      '<rect x="9.5" y="11" width="5" height="3.5" rx=".5"/><path d="M8 5v3M4 11V8h8v3"/>',
    layers: '<path d="M8 1.5l6.5 3.5L8 8.5 1.5 5z"/><path d="M1.5 8L8 11.5 14.5 8"/><path d="M1.5 11L8 14.5 14.5 11"/>',
    pencil: '<path d="M11 2l3 3-8.5 8.5L2 14l.5-3.5z"/><path d="M9.5 3.5l3 3"/>',
    terminal: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6l2 2-2 2M8.5 10.5h3"/>',
    branch:
      '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/>' +
      '<path d="M4.5 5v6M11.5 7c0 2.5-2 3-5.5 4.2"/>',
    tool: '<path d="M10.5 1.8a3.5 3.5 0 0 0-3.9 4.7L2 11.1 4.9 14l4.6-4.6a3.5 3.5 0 0 0 4.7-3.9l-2 2-2.3-.6-.6-2.3z"/>',
    check: '<path d="M3 8.5L6.5 12 13 4.5"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    dash: '<path d="M4 8h8"/>',
    warn: '<path d="M8 1.8L15 14H1z"/><path d="M8 6.5v3.5M8 12v.01"/>',
    info: '<circle cx="8" cy="8" r="6.5"/><path d="M8 7.5v4M8 5v.01"/>',
    error: '<circle cx="8" cy="8" r="6.5"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>',
    stopCircle: '<circle cx="8" cy="8" r="6.5"/><rect x="5.7" y="5.7" width="4.6" height="4.6" rx=".5"/>',
    swap: '<path d="M2 5h10L9.5 2.5M14 11H4l2.5 2.5"/>',
    undo: '<path d="M5.5 3L2.5 6l3 3"/><path d="M2.5 6h7a4 4 0 0 1 0 8H7"/>',
    external: '<path d="M9.5 2H14v4.5"/><path d="M14 2L7.5 8.5"/><path d="M12 9.5V14H2V4h4.5"/>',
    stop: '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/>',
    send: '<path d="M2 8.5L14 2l-3.5 12-2.5-5z"/><path d="M8 9l6-7"/>',
    chev: '<path d="M6 4l4 4-4 4"/>',
    shield: '<path d="M8 1.5l5.5 2v4c0 3.4-2.3 5.8-5.5 7-3.2-1.2-5.5-3.6-5.5-7v-4z"/>',
    beaker: '<path d="M5.5 1.5h5M6.5 1.5v4.3L2.7 12.6a1.3 1.3 0 0 0 1.1 1.9h8.4a1.3 1.3 0 0 0 1.1-1.9L9.5 5.8V1.5"/><path d="M4.4 10h7.2"/>',
    history: '<path d="M2.5 8a5.5 5.5 0 1 0 1.7-4"/><path d="M2.3 1.8v2.7H5"/><path d="M8 5v3.2l2.2 1.4"/>',
    scan:
      '<path d="M1.5 5V3a1.5 1.5 0 0 1 1.5-1.5h2M11 1.5h2A1.5 1.5 0 0 1 14.5 3v2M14.5 11v2a1.5 1.5 0 0 1-1.5 1.5h-2M5 14.5H3A1.5 1.5 0 0 1 1.5 13v-2"/>' +
      '<path d="M4.5 6h7M4.5 8h5M4.5 10h6"/>',
    link:
      '<path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2.4-2.4a2.8 2.8 0 0 0-4-4l-1 1"/><path d="M9.2 6.8a2.8 2.8 0 0 0-4 0L2.8 9.2a2.8 2.8 0 0 0 4 4l1-1"/>',
    thought: '<path d="M2.5 3.5h11v7.5h-6l-3 2.5V11h-2z"/><path d="M5.5 7.2h.01M8 7.2h.01M10.5 7.2h.01"/>',
    copy: '<rect x="5.5" y="5.5" width="8" height="9" rx="1.2"/><path d="M10.5 5.5V2.8a1.3 1.3 0 0 0-1.3-1.3H3.8a1.3 1.3 0 0 0-1.3 1.3v7.4a1.3 1.3 0 0 0 1.3 1.3h1.7"/>',
    flag: '<path d="M3 14.5V2"/><path d="M3 2.5h9l-2 3 2 3H3"/>',
  };
  const iconCache = new Map();

  /** A fresh SVG icon element. */
  function ic(name, extraClass) {
    const key = name + '|' + (extraClass || '');
    let tpl = iconCache.get(key);
    if (!tpl) {
      const t = document.createElement('template');
      t.innerHTML =
        '<svg class="ic ' + (extraClass || '') + '" viewBox="0 0 16 16" aria-hidden="true">' + (ICONS[name] || ICONS.tool) + '</svg>';
      tpl = t.content.firstChild;
      iconCache.set(key, tpl);
    }
    return tpl.cloneNode(true);
  }

  const TOOLS = {
    retrieve_context: { label: 'Retrieve context', icon: 'layers' },
    read_file: { label: 'Read file', icon: 'file' },
    search_code: { label: 'Search code', icon: 'search' },
    find_symbol: { label: 'Find symbol', icon: 'symbol' },
    list_files: { label: 'List files', icon: 'folder' },
    repo_map: { label: 'Repo map', icon: 'tree' },
    propose_edit: { label: 'Propose edit', icon: 'pencil' },
    run_command: { label: 'Run command', icon: 'terminal' },
    create_sub_agent: { label: 'Create subagent', icon: 'branch' },
  };

  /** Canonical tool key; tolerates server prefixes such as "forgelight-editor__read_file". */
  function toolKey(name) {
    const n = String(name || '').toLowerCase();
    if (TOOLS[n]) return n;
    for (const k of Object.keys(TOOLS)) if (n.endsWith(k)) return k;
    return n;
  }

  // ---------------------------------------------------------------- helpers

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function button(label, cls, onClick, title) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function code(text) {
    return el('code', '', text);
  }

  /**
   * Make `root` expandable via `trigger` (toggles the 'open' class). A flip by the user marks
   * `root` as touched, so automatic folding leaves it alone afterwards.
   */
  function makeToggle(root, trigger, onOpen, onFlip) {
    const flip = () => {
      const open = !root.classList.contains('open');
      root.classList.toggle('open', open);
      root.dataset.touched = '1';
      trigger.setAttribute('aria-expanded', String(open));
      if (open && onOpen) onOpen();
      if (onFlip) onFlip(open);
    };
    trigger.setAttribute('aria-expanded', String(root.classList.contains('open')));
    trigger.addEventListener('click', flip);
    if (trigger.tagName !== 'BUTTON') {
      trigger.tabIndex = 0;
      trigger.setAttribute('role', 'button');
      trigger.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          flip();
        }
      });
    }
  }

  /** Open or close a makeToggle root from code (not a user action). */
  function setOpen(root, trigger, open) {
    root.classList.toggle('open', open);
    if (trigger) trigger.setAttribute('aria-expanded', String(open));
  }

  /**
   * Small icon counters ("[file] 4  [search] 2"), shared by step heads, sub-agent heads and the
   * finish card. `counts` is [[icon, n, title], …]; zero counts are skipped.
   */
  function countChips(counts) {
    const out = [];
    for (const [icon, n, title] of counts) {
      if (!n) continue;
      const c = el('span', 'cnt');
      const shown = el('span', '', String(n));
      shown.setAttribute('aria-hidden', 'true');
      // Screen readers get the words ("4 files read"), not a bare number.
      c.append(ic(icon), shown, el('span', 'sr-only', title));
      c.title = title;
      out.push(c);
    }
    return out;
  }

  const numberFormat = new Intl.NumberFormat();
  function fmtInt(n) {
    return numberFormat.format(Math.round(Number(n) || 0));
  }

  function fmtSecs(ms) {
    const s = Math.max(0, ms) / 1000;
    if (s < 10) return s.toFixed(1) + 's';
    if (s < 60) return Math.round(s) + 's';
    const m = Math.floor(s / 60);
    return m + 'm ' + String(Math.round(s - m * 60)).padStart(2, '0') + 's';
  }

  function oneLine(text, max) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function firstLine(text, max) {
    const line = String(text || '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return oneLine(line || '', max);
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  /** Finite number or 0 (event fields can be missing or malformed). */
  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function str(v) {
    return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
  }

  /** Compact token count: 640, 9.8k, 21.4k, 128k. */
  function fmtK(n) {
    const v = Math.max(0, Math.round(num(n)));
    if (v < 1000) return String(v);
    if (v < 100000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return Math.round(v / 1000) + 'k';
  }

  function fmtPct(p) {
    return (p > 0 && p < 10 ? p.toFixed(1) : String(Math.round(p))) + '%';
  }

  /** "14:05" from an ISO timestamp ('' when it does not parse). */
  function fmtClock(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function fmtLatency(ms) {
    const v = num(ms);
    return v < 1000 ? Math.round(v) + ' ms' : fmtSecs(v);
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // --------------------------------------------------------- light markdown

  /** Inline markdown on raw text: escapes first, then `code`, **bold** and *italic*. */
  function mdInline(text) {
    const spans = [];
    let s = escapeHtml(text).replace(/`([^`\n]+)`/g, (_, c) => {
      spans.push(c);
      return '\u0000' + (spans.length - 1) + '\u0000';
    });
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    // *italic*: the asterisks hug the text, so "2 * 3 * 4" and a*b*c stay as they are.
    s = s.replace(/(^|[^*\w])\*([^*\s](?:[^*\n]*?[^*\s])?)\*(?![*\w])/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, n) => '<code>' + (spans[Number(n)] || '') + '</code>');
  }

  /** One table cell row: "| a | b |" -> ["a", "b"] (a backslash-escaped \\| stays in the cell). */
  function tableCells(line) {
    const t = line.trim().replace(/^\|/, '').replace(/(^|[^\\])\|$/, '$1');
    return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  }
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  /** Nested <ul>/<ol> from [{indent, type, start, text}]: an item indented 2+ columns deeper nests. */
  function listHtml(items) {
    let html = '';
    const stack = []; // open lists: {indent, type}
    const open = (it) => {
      const start = it.type === 'ol' && it.start > 1 ? ' start="' + it.start + '"' : '';
      html += '<' + it.type + start + '>';
      stack.push({ indent: it.indent, type: it.type });
    };
    for (const it of items) {
      while (stack.length && it.indent + 1 < stack[stack.length - 1].indent) html += '</li></' + stack.pop().type + '>';
      const top = stack[stack.length - 1];
      if (!top || it.indent >= top.indent + 2) open(it);
      else if (top.type !== it.type) {
        html += '</li></' + stack.pop().type + '>';
        open(it);
      } else html += '</li>';
      html += '<li>' + mdInline(it.text);
    }
    while (stack.length) html += '</li></' + stack.pop().type + '>';
    return html;
  }

  /** Safe light markdown: fences, headings (as bold lines), nested bullet/numbered lists, tables, paragraphs, line breaks. */
  function renderMarkdown(src) {
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    let list = null; // [{indent, type, start, text}]
    const flushPara = () => {
      if (para.length) out.push('<p>' + para.map(mdInline).join('<br>') + '</p>');
      para = [];
    };
    const flushList = () => {
      // Numbering follows the source ("2." after nested bullets stays 2, as in CommonMark).
      if (list) out.push(listHtml(list));
      list = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        flushPara();
        flushList();
        const body = [];
        i++;
        // An unterminated fence (still streaming) runs to the end of the text.
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
        out.push('<pre><code>' + escapeHtml(body.join('\n')) + '</code></pre>');
        continue;
      }
      if (!line.trim()) {
        flushPara();
        flushList();
        continue;
      }
      // A GFM table: a row with pipes followed by a separator row (|---|:--:|).
      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && (lines[i + 1].includes('|') || line.trim().startsWith('|'))) {
        flushPara();
        flushList();
        const head = tableCells(line);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(tableCells(lines[i++]));
        i--;
        const cell = (tag, c) => '<' + tag + '>' + mdInline(c) + '</' + tag + '>';
        const body = rows.map((r) => '<tr>' + head.map((_, k) => cell('td', r[k] || '')).join('') + '</tr>').join('');
        out.push('<div class="md-table"><table><thead><tr>' + head.map((c) => cell('th', c)).join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>');
        continue;
      }
      const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
      if (heading) {
        flushPara();
        flushList();
        out.push('<div class="md-h">' + mdInline(heading[1]) + '</div>');
        continue;
      }
      const item = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
      if (item) {
        flushPara();
        const type = /\d/.test(item[2]) ? 'ol' : 'ul';
        const indent = item[1].replace(/\t/g, '    ').length;
        if (!list) list = [];
        list.push({ indent, type, start: type === 'ol' ? parseInt(item[2], 10) || 1 : 1, text: item[3] });
        continue;
      }
      if (list && /^\s{2,}\S/.test(line)) {
        list[list.length - 1].text += ' ' + line.trim();
        continue;
      }
      flushList();
      para.push(line);
    }
    flushPara();
    flushList();
    return out.join('');
  }

  // ------------------------------------------------------------------ state

  const S = {
    running: false,
    models: [],
    trueforgeUrl: '',
    mcpUrl: '',
    activeModel: '',
    failed: new Set(),
    fellBack: false,
    lastError: false,
    session: false,
    undoable: 0,
    runStartedAt: 0,
    cancelRequested: false,
    cancelTimer: 0,
    /** model -> { status: 'ok'|'down'|'unknown'|'skipped', reason, retryAt, latencyMs } (Feature 3). */
    health: new Map(),
  };
  const runs = new Map(); // runId -> run
  const reviews = new Map(); // changeId -> review card
  const approvals = new Map(); // requestId -> approval card
  /** changeId -> { started, result }: shadow test state that may arrive before/after its review card. */
  const verifies = new Map();
  /** "runId|from|to" -> model-switch banner, so a fallback + resume for one switch show one banner. */
  const switches = new Map();
  let lastRun = null;

  const $ = (id) => document.getElementById(id);
  const ui = {
    mark: $('brand-mark'),
    dot: $('status-dot'),
    statusText: $('status-text'),
    openSession: $('open-session'),
    undo: $('undo'),
    chain: $('model-chain'),
    transcript: $('transcript'),
    empty: $('empty'),
    log: $('log'),
    jump: $('jump'),
    input: $('input'),
    send: $('send'),
    hint: $('hint'),
  };

  function post(msg) {
    vscode.postMessage(msg);
  }

  // ---------------------------------------------------- rendering pipeline

  const queue = [];
  const dirty = new Set();
  let scheduled = false;
  let stick = true;
  /** A review/approval card that opened in this batch: brought into view if it is still open. */
  let reveal = null;
  /**
   * Motion (5) never plays for history (rule 6). Two gates: `animReady` opens after the first
   * 350 ms without new messages once rendering has finished, and `liveBatch` is false for a batch
   * that carries events emitted more than 2 s ago (the extension's replay on 'ready'), however
   * late that replay arrives. Each node gets its entrance once, when it is first inserted
   * (class fl-in, removed when the animation ends), so nothing already on screen re-animates.
   */
  let animReady = false;
  let animTimer = 0;
  let liveBatch = true;
  function armAnim() {
    if (animReady) return;
    clearTimeout(animTimer);
    animTimer = setTimeout(() => {
      animReady = true;
    }, 350);
  }
  /** True while rendering events as they happen (animate, and let decisions be seen first). */
  function liveNow() {
    return animReady && liveBatch;
  }
  const ANIM_SEL = '.card, .banner, .step, .tool, .group, .user-msg, .sysrow';
  const seenNodes = new WeakSet();
  new MutationObserver((records) => {
    const animate = liveNow();
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!(n instanceof Element)) continue;
        const list = n.matches(ANIM_SEL) ? [n] : [];
        for (const d of n.querySelectorAll(ANIM_SEL)) list.push(d);
        for (const e of list) {
          if (seenNodes.has(e)) continue; // moved, not new
          seenNodes.add(e);
          if (animate) e.classList.add('fl-in');
        }
      }
    }
  }).observe(ui.log, { childList: true, subtree: true });
  ui.log.addEventListener('animationend', (e) => {
    if (e.animationName === 'fl-rise' && e.target instanceof Element) e.target.classList.remove('fl-in');
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    queue.push(m);
    schedule();
  });

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(flush);
    // rAF is paused while the view is hidden; keep the transcript current anyway.
    setTimeout(flush, 150);
  }

  function flush() {
    if (!scheduled) return;
    scheduled = false;
    const batch = queue.splice(0);
    const now = Date.now();
    liveBatch = !batch.some((m) => m.type === 'event' && typeof m.at === 'number' && now - m.at > 2000);
    for (const m of batch) {
      try {
        if (m.type === 'state') onState(m);
        else if (m.type === 'event' && m.event && typeof m.event.type === 'string') {
          onEvent(m.event, typeof m.at === 'number' ? m.at : Date.now());
        }
      } catch (err) {
        console.error('[forgelight] could not render', m && m.event ? m.event.type : m.type, err);
      }
    }
    for (const block of dirty) block.render();
    dirty.clear();
    // The quiet window starts when rendering has finished, not before a long batch.
    if (batch.length) armAnim();
    renderHeader();
    if (stick) scrollToBottom();
    else if (batch.length) ui.jump.hidden = false;
    // A card placed mid-transcript (under its tool row) must not open out of sight.
    if (reveal && reveal.isOpen()) reveal.el.scrollIntoView({ block: 'nearest' });
    reveal = null;
  }

  function scrollToBottom() {
    ui.transcript.scrollTop = ui.transcript.scrollHeight;
  }

  ui.transcript.addEventListener('scroll', () => {
    const t = ui.transcript;
    stick = t.scrollHeight - t.scrollTop - t.clientHeight < 40;
    if (stick) ui.jump.hidden = true;
  });

  ui.jump.addEventListener('click', () => {
    stick = true;
    ui.jump.hidden = true;
    scrollToBottom();
  });

  // ------------------------------------------------------------ run/thread

  function getRun(runId, at) {
    let run = runs.get(runId);
    if (run) return run;
    const root = el('section', 'run');
    // Placeholder head: replaced by run.started (absent only if replay history was trimmed).
    const head = el('div', 'run-meta', 'Earlier events of this run are not shown.');
    const meta = el('div', 'run-meta');
    const modelEl = el('span');
    const sessionEl = el('span');
    meta.append(modelEl, sessionEl);
    meta.hidden = true;
    const body = el('div', 'thread-body');
    root.append(head, meta, body);
    ui.log.appendChild(root);
    run = {
      id: runId,
      root,
      head,
      meta,
      modelEl,
      sessionEl,
      body,
      startedAt: at,
      finished: false,
      threads: new Map(),
      tools: new Map(),
      cards: [],
      appliedPaths: new Set(),
      appliedCount: 0,
      /** changeId -> { path, createdFile, undone, reverted } (Feature 2: revert the whole run). */
      applied: new Map(),
      revert: null,
      reverted: false,
      /** Feature 4: per-run context usage. */
      ctx: { calls: 0, subCalls: 0, inTotal: 0, outTotal: 0, peakPct: 0, peakTokens: 0, latestMain: null, latest: null },
      /** The request text (for the finish card's copied summary). */
      text: '',
      /** changeId -> hunks of its review ({index, added, removed}), to count the accepted lines. */
      changes: new Map(),
      /** The finish card of a run that ended with status 'done'. */
      finishCard: null,
      /** This run's TrueForge session (run.session). */
      sessionId: '',
    };
    run.threads.set('main', newThread('main', body, null));
    runs.set(runId, run);
    if (!lastRun || runId >= lastRun.id) lastRun = run;
    ui.empty.hidden = true;
    return run;
  }

  function newThread(id, body, group) {
    return {
      id,
      body,
      group,
      statusEl: null,
      titleEl: null,
      headEl: null,
      sumEl: null,
      startAt: 0,
      endAt: 0,
      messages: new Map(),
      reasoning: new Map(),
      activeText: null,
      activeReasoning: null,
      /** The open step (1c) that collects thoughts, narration and reads. */
      step: null,
      finished: false,
    };
  }

  function getThread(run, threadId, title, at) {
    const tid = threadId || 'main';
    let th = run.threads.get(tid);
    if (th) return th;
    const main = run.threads.get('main');
    breakStep(main, at);
    const group = el('div', 'group open');
    const head = el('div', 'group-head');
    const iconWrap = el('span', 'tool-icon');
    iconWrap.append(ic('branch'));
    const titleEl = el('span', 'group-title', title || tid);
    const sumEl = el('span', 'group-sum');
    const statusEl = el('span', 'tool-status');
    statusEl.append(el('span', 'spinner'));
    head.append(ic('chev', 'chev'), iconWrap, el('span', 'group-kind', 'Subagent'), titleEl, sumEl, statusEl);
    const body = el('div', 'thread-body');
    group.append(head, body);
    makeToggle(group, head);
    main.body.appendChild(group);
    th = newThread(tid, body, group);
    th.titleEl = titleEl;
    th.statusEl = statusEl;
    th.headEl = head;
    th.sumEl = sumEl;
    th.startAt = num(at);
    run.threads.set(tid, th);
    return th;
  }

  // ----------------------------------------------------------- steps (1c)

  /** Exploration tools: their rows fold into the current step with thoughts and narration. */
  const STEP_TOOLS = new Set(['read_file', 'search_code', 'find_symbol', 'list_files', 'repo_map', 'create_sub_agent']);
  const STEP_KIND = { read_file: 'read', search_code: 'search', find_symbol: 'search', list_files: 'list', repo_map: 'list', create_sub_agent: 'sub' };

  function stepCounts(n) {
    return [
      ['file', n.read, plural(n.read, 'file') + ' read'],
      ['search', n.search, n.search + (n.search === 1 ? ' search' : ' searches')],
      ['folder', n.list, n.list + (n.list === 1 ? ' listing' : ' listings')],
      ['branch', n.sub, plural(n.sub, 'sub-agent') + ' started'],
      ['thought', n.thought, plural(n.thought, 'thought')],
    ];
  }

  /** "Read 4 files, searched 2×": the label of a step whose model wrote no sentence. */
  function countsSentence(n) {
    const parts = [];
    if (n.read) parts.push('read ' + plural(n.read, 'file'));
    if (n.search) parts.push('searched ' + (n.search === 1 ? 'once' : n.search + '×'));
    if (n.list) parts.push('listed files');
    if (n.sub) parts.push('started ' + (n.sub === 1 ? 'a sub-agent' : n.sub + ' sub-agents'));
    if (!parts.length) return n.thought ? 'Thought it through' : 'Worked';
    const s = parts.join(', ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /** First line of the step's last sentence, without markdown markers, about 90 characters. */
  function stepSentence(st) {
    for (let i = st.texts.length - 1; i >= 0; i--) {
      const raw = st.texts[i].raw;
      if (!raw || !raw.trim()) continue;
      let line = firstLine(raw.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d{1,3}[.)]\s+|>\s*)/gm, '').replace(/\*\*/g, ''), 90);
      // An odd backtick count (cut mid-span) would show a stray backtick.
      if ((line.match(/`/g) || []).length % 2) line = line.replace(/`(?=[^`]*$)/, '');
      if (line) return line;
    }
    return '';
  }

  function newStep(at) {
    const root = el('div', 'step live');
    const head = el('div', 'step-head');
    const label = el('span', 'step-label', 'Working…');
    const meta = el('span', 'step-meta');
    head.append(ic('chev', 'chev'), label, meta);
    const body = el('div', 'step-body');
    root.append(head, body);
    makeToggle(root, head);
    const st = {
      el: root,
      body,
      startAt: num(at),
      lastAt: num(at),
      endAt: 0,
      live: true,
      texts: [],
      /** Blocks and rows inside (their `.step` points back here while they are folded in). */
      refs: [],
      n: { read: 0, search: 0, list: 0, sub: 0, thought: 0 },
      refresh() {
        meta.replaceChildren(...countChips(stepCounts(this.n)));
        // A failure is never folded away silently (rule 4).
        const failed = body.querySelectorAll('.tool.failed').length;
        if (failed) meta.append(el('span', 'step-fail', failed + ' failed'));
        if (this.live) {
          label.textContent = 'Working…';
          label.title = '';
          return;
        }
        const sentence = stepSentence(this);
        if (sentence) label.innerHTML = mdInline(sentence);
        else label.textContent = countsSentence(this.n);
        label.title = sentence || '';
        const ms = this.endAt - this.startAt;
        if (ms >= 500) meta.append(el('span', 'step-time', fmtSecs(ms)));
      },
    };
    return st;
  }

  /** Append a thought, a narration block or an exploration tool row to the thread's open step. */
  function stepAppend(th, node, at, kind, ref) {
    if (!th.step) {
      th.step = newStep(at);
      th.body.appendChild(th.step.el);
    }
    const st = th.step;
    st.body.appendChild(node);
    st.lastAt = Math.max(st.lastAt, num(at));
    if (kind === 'text') st.texts.push(ref);
    else if (kind === 'thought') st.n.thought++;
    else if (STEP_KIND[kind]) st.n[STEP_KIND[kind]]++;
    if (ref) {
      ref.step = st;
      st.refs.push(ref);
    }
    st.refresh();
  }

  /** Note activity inside a live step (a delta or a late result), for its duration. */
  function touchStep(st, at) {
    if (st && st.live) st.lastAt = Math.max(st.lastAt, num(at));
  }

  /**
   * End the thread's open step before something that must stay visible is appended (a card's
   * tool row, a sub-agent group, a banner, the run footer). It folds to one line. At the end of a
   * thread or run (`final`), a closing text block is moved out first so the answer stays visible.
   */
  function endStep(th, at, final) {
    const st = th && th.step;
    if (!st) return;
    th.step = null;
    st.live = false;
    st.endAt = Math.max(st.lastAt, num(at));
    const last = st.body.lastElementChild;
    const lastText = st.texts.length ? st.texts[st.texts.length - 1] : null;
    if (final && lastText && last === lastText.el) {
      st.el.after(last);
      st.texts.pop();
      lastText.step = null;
    }
    const kids = Array.from(st.body.children);
    // Nothing to fold: one item, or only the agent talking. Leave it as it is.
    if (kids.length <= 1 || kids.every((k) => k.classList.contains('md'))) {
      for (const r of st.refs) r.step = null;
      // A moved row is not new: re-inserting it must not replay its entrance.
      for (const k of kids) k.classList.remove('fl-in');
      st.el.replaceWith(...kids);
      return;
    }
    st.el.classList.remove('live');
    st.refresh();
  }

  /** Cards that still wait for a decision; never inside anything folded (rule 3). */
  const PENDING_CARDS = '.card.review:not(.closed), .card.approval:not(.resolved)';
  /** Cards kept open as evidence (a refused command); a sub-agent holding one does not fold. */
  const EVIDENCE_CARDS = '.card.approval.denied, .card.approval.blocked';

  /** "11 reads · 4 searches · 48s" in a finished sub-agent's head. */
  function paintGroupSummary(th, at) {
    if (!th.sumEl) return;
    const n = { read: 0, search: 0, list: 0, edit: 0, cmd: 0 };
    for (const row of th.body.querySelectorAll('.tool')) {
      const k = row.dataset.key;
      if (k === 'read_file') n.read++;
      else if (k === 'search_code' || k === 'find_symbol' || k === 'retrieve_context') n.search++;
      else if (k === 'list_files' || k === 'repo_map') n.list++;
      else if (k === 'propose_edit') n.edit++;
      else if (k === 'run_command') n.cmd++;
    }
    const nodes = countChips([
      ['file', n.read, plural(n.read, 'file') + ' read'],
      ['search', n.search, n.search + (n.search === 1 ? ' search' : ' searches')],
      ['folder', n.list, n.list + (n.list === 1 ? ' listing' : ' listings')],
      ['pencil', n.edit, plural(n.edit, 'edit') + ' proposed'],
      ['terminal', n.cmd, plural(n.cmd, 'command')],
    ]);
    // A failure inside a folded sub-agent shows on its head (rule 4).
    const failed = th.body.querySelectorAll('.tool.failed').length;
    if (failed) nodes.push(el('span', 'step-fail', failed + ' failed'));
    if (at !== undefined) th.endAt = num(at);
    const ms = num(th.endAt) - th.startAt;
    if (th.startAt && ms >= 500) nodes.push(el('span', 'step-time', fmtSecs(ms)));
    th.sumEl.replaceChildren(...nodes);
  }

  /**
   * End a thread's open step before appending something that must stay visible, keeping a text
   * block that is still streaming out of the fold (rule 2): it moves after the step and goes on
   * receiving its deltas there.
   */
  function breakStep(th, at) {
    const streaming = !!th.activeText;
    settle(th);
    endStep(th, at, streaming);
  }

  /** End the streaming indicators of a thread before something else is appended to it. */
  function settle(th, keep) {
    if (th.activeReasoning && th.activeReasoning !== keep) {
      th.activeReasoning.finish();
      th.activeReasoning = null;
    }
    if (th.activeText && th.activeText !== keep) {
      th.activeText.finish();
      th.activeText = null;
    }
  }

  function finishThread(th, completed, at) {
    settle(th);
    endStep(th, at, true);
    th.finished = true;
    if (th.group && th.statusEl) {
      th.group.classList.add('done');
      th.statusEl.replaceChildren(ic(completed ? 'check' : 'dash'));
      paintGroupSummary(th, at);
      // 1a: a finished sub-agent folds to its head and savings footer, unless the user opened or
      // closed it by hand, or it still holds a card that waits for a decision.
      if (!th.group.dataset.touched && !th.group.querySelector(PENDING_CARDS + ', ' + EVIDENCE_CARDS)) setOpen(th.group, th.headEl, false);
    }
  }

  /** Where run-less rows (notices, undo) go: the latest run, or the top level. */
  function looseTarget(runId, at) {
    if (typeof runId === 'number') {
      const run = getRun(runId, at);
      const main = run.threads.get('main');
      breakStep(main, at);
      return main.body;
    }
    if (lastRun) {
      breakStep(lastRun.threads.get('main'), at);
      return lastRun.body;
    }
    ui.empty.hidden = true;
    return ui.log;
  }

  /**
   * Insert a card right after its own tool row (`toolCallId`), else after the latest tool row of
   * `kind` that has no card yet, else at the end of the run.
   */
  function placeCard(run, kind, node, toolCallId) {
    const own = toolCallId ? run.tools.get(toolCallId) : null;
    if (own && !own.hasCard) {
      own.hasCard = true;
      own.el.after(node);
      return;
    }
    const rows = Array.from(run.tools.values());
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.key === kind && !row.hasCard) {
        row.hasCard = true;
        row.el.after(node);
        return;
      }
    }
    const main = run.threads.get('main');
    breakStep(main);
    main.body.appendChild(node);
  }

  // ---------------------------------------------------------------- blocks

  function userMessage(text, mode) {
    const box = el('div', 'user-msg');
    const body = el('div', 'user-body');
    if (mode === 'inline') body.append(el('span', 'mode', 'Inline edit'));
    const re = /(^|\s)(@[\w./:\-]+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      const start = m.index + m[1].length;
      if (start > last) body.append(text.slice(last, start));
      body.append(el('span', 'mention', m[2]));
      last = start + m[2].length;
    }
    if (last < text.length) body.append(text.slice(last));
    box.append(body);
    // A long request (Check this function sends the function's code) shows its first lines.
    const lines = text.split('\n').length;
    if (lines > 8) {
      box.classList.add('long');
      const more = button('', 'link-btn user-more', () => {
        const open = box.classList.toggle('expanded');
        more.textContent = open ? 'Show less' : 'Show all ' + lines + ' lines';
        more.setAttribute('aria-expanded', String(open));
      });
      more.textContent = 'Show all ' + lines + ' lines';
      more.setAttribute('aria-expanded', 'false');
      box.append(more);
    }
    return box;
  }

  function textBlock() {
    const node = el('div', 'md streaming');
    return {
      el: node,
      raw: '',
      render() {
        node.innerHTML = renderMarkdown(this.raw);
      },
      finish() {
        node.classList.remove('streaming');
      },
    };
  }

  function reasoningBlock() {
    const node = el('details', 'thinking');
    node.open = true; // stream visibly while thinking; finish() collapses it
    const summary = el('summary');
    const spin = el('span', 'spinner');
    const label = el('span', '', 'Thinking…');
    const tok = el('span', 'tok');
    summary.append(ic('chev', 'chev'), spin, label, tok);
    const pre = el('pre');
    node.append(summary, pre);
    return {
      el: node,
      raw: '',
      pending: '',
      render() {
        if (this.pending) {
          // Measure before appending: follow the tail unless the user scrolled up inside the block.
          // (A closed block has zero sizes, so atEnd is true and the scroll is a no-op.)
          const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
          pre.append(this.pending);
          this.pending = '';
          if (atEnd) pre.scrollTop = pre.scrollHeight;
        }
        tok.textContent = '· ~' + fmtInt(Math.ceil(this.raw.length / 4)) + ' tokens';
      },
      finish() {
        spin.remove();
        label.textContent = 'Thought';
        node.open = false; // a finished thought collapses to 'Thought · ~N tokens'
      },
    };
  }

  function toolRow(name, args) {
    const key = toolKey(name);
    const meta = TOOLS[key];
    const root = el('div', 'tool pending');
    root.dataset.key = key;
    const head = el('div', 'tool-head');
    const iconWrap = el('span', 'tool-icon');
    iconWrap.append(ic(meta ? meta.icon : 'tool'));
    const nameEl = el('span', 'tool-name', meta ? meta.label : name || 'tool');
    nameEl.title = name || '';
    const argsEl = el('span', 'tool-args');
    const status = el('span', 'tool-status');
    status.append(el('span', 'spinner'));
    // Small status chip (Feature 1: shadow test state of a propose_edit call).
    const chip = el('span', 'tool-chip');
    chip.hidden = true;
    head.append(ic('chev', 'chev'), iconWrap, nameEl, argsEl, chip, status);
    const resultLine = el('div', 'tool-result-line');
    resultLine.hidden = true;
    const detail = el('div', 'tool-detail');
    root.append(head, resultLine, detail);

    const row = {
      el: root,
      key,
      args: '',
      result: null,
      done: false,
      hasCard: false,
      setArgs(text) {
        this.args = String(text || '');
        argsEl.textContent = oneLine(this.args, 200);
        argsEl.title = this.args.slice(0, 2000);
        if (root.classList.contains('open')) renderDetail();
      },
      setResult(preview) {
        this.done = true;
        this.result = String(preview || '');
        const trimmed = this.result.trim();
        let failed = /^(error|failed|exception|traceback)\b/i.test(trimmed);
        const declined = /^(denied|rejected|cancel|not applied|not run)/i.test(trimmed);
        let line = firstLine(this.result, 160);
        // run_command: "$ cmd\nexit code: N\n<output>"; show the exit code and the last output line
        const exit = this.key === 'run_command' ? /^exit code: (\S+)/m.exec(this.result) : null;
        if (exit) {
          failed = exit[1] !== '0';
          const rest = this.result.slice(exit.index + exit[0].length).split('\n').map((l) => l.trim()).filter(Boolean);
          const last = rest.length ? rest[rest.length - 1] : '';
          line = oneLine('exit ' + exit[1] + (last ? ' · ' + last : ''), 160);
        }
        this.status = failed ? 'failed' : declined ? 'stopped' : 'done';
        this.summary = line;
        root.classList.remove('pending', 'done', 'failed', 'stopped');
        root.classList.add(this.status);
        status.replaceChildren(ic(failed ? 'x' : declined ? 'dash' : 'check'));
        resultLine.textContent = line ? '↳ ' + line : '↳ (no output)';
        resultLine.hidden = false;
        if (root.classList.contains('open')) renderDetail();
      },
      stop() {
        if (this.done) return;
        this.done = true;
        this.status = 'stopped';
        root.classList.remove('pending');
        root.classList.add('stopped');
        status.replaceChildren(ic('dash'));
        resultLine.textContent = '↳ no result (run ended)';
        resultLine.hidden = false;
      },
      setChip(kind, text, title) {
        chip.className = 'tool-chip ' + kind;
        chip.replaceChildren();
        if (kind === 'running') chip.append(el('span', 'spinner mini'));
        else chip.append(ic(kind === 'passed' ? 'check' : kind === 'failed' ? 'x' : kind === 'error' ? 'warn' : 'dash'));
        chip.append(text);
        chip.title = title || '';
        chip.hidden = false;
      },
    };
    function renderDetail() {
      const pre = (t) => el('pre', 'box', t);
      detail.replaceChildren(
        el('div', 'label', 'Arguments'),
        pre(row.args || '(none)'),
        el('div', 'label', 'Result'),
        pre(row.result === null ? (row.done ? '(none)' : 'Running…') : row.result || '(empty)'),
      );
    }
    makeToggle(root, head, renderDetail);
    row.setArgs(args);
    return row;
  }

  function banner(kind, iconName, text, sub) {
    const b = el('div', 'banner ' + kind);
    const body = el('div');
    body.append(el('div', '', text));
    for (const line of Array.isArray(sub) ? sub : [sub]) if (line) body.append(el('div', 'sub', line));
    b.append(ic(iconName), body);
    return b;
  }

  /** Retry banners that still say "Retrying in …"; see settleRetries(). */
  const liveRetries = [];
  function settleRetries(cancelled) {
    for (const r of liveRetries.splice(0)) r.textEl.textContent = cancelled ? r.cancelled : r.done;
  }

  function sysRow(iconName, cls, parts) {
    const row = el('div', 'sysrow ' + (cls || ''));
    row.append(ic(iconName));
    const span = el('span');
    for (const p of parts) span.append(p);
    row.append(span);
    return row;
  }

  function appliedRow(record) {
    const n = Array.isArray(record.hunksApplied) ? record.hunksApplied.length : 0;
    return sysRow('check', 'ok', [
      'Applied ' + plural(n, 'hunk') + ' to ',
      code(record.path),
      record.createdFile ? ' (new file)' : '',
    ]);
  }

  function undoneRow(record) {
    return sysRow('undo', '', ['Undone: ', code(record.path)]);
  }

  // ----------------------------------------------------------------- cards

  function splitPath(p) {
    const s = String(p || '');
    const i = s.lastIndexOf('/');
    return i < 0 ? ['', s] : [s.slice(0, i + 1), s.slice(i + 1)];
  }

  function fmtRanges(ranges) {
    if (!Array.isArray(ranges) || ranges.length === 0) return '';
    const parts = ranges.slice(0, 3).map((r) => (r.start === r.end ? 'L' + r.start : 'L' + r.start + '–' + r.end));
    if (ranges.length > 3) parts.push('+' + (ranges.length - 3));
    return parts.join(', ');
  }

  function contextCard(pick) {
    const files = Array.isArray(pick.files) ? pick.files : [];
    const dropped = Array.isArray(pick.dropped) ? pick.dropped : [];
    const used = Number(pick.usedTokens) || 0;
    const budget = Number(pick.budgetTokens) || 0;

    const card = el('div', 'card context');
    const head = el('div', 'card-head');
    head.append(
      ic('layers'),
      el(
        'span',
        'title',
        'Context picked — ' + plural(files.length, 'file') + ' · ' + fmtInt(used) + '/' + fmtInt(budget) + ' tokens',
      ),
    );
    card.append(head);
    if (pick.query) card.append(el('div', 'card-sub', 'for “' + oneLine(pick.query, 160) + '”'));

    const body = el('div', 'card-body');
    const pct = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;
    const label = el('div', 'budget-label');
    label.append(el('span', '', 'Budget used'), el('span', '', Math.round(pct) + '%'));
    const bar = el('div', 'budget' + (pct >= 95 ? ' full' : ''));
    const fill = el('span');
    fill.style.width = pct.toFixed(1) + '%';
    bar.append(fill);
    body.append(label, bar);

    if (files.length === 0) body.append(el('div', 'card-sub', 'No files matched this request.'));
    files.forEach((f, i) => {
      const row = el('div', 'ctx-file');
      row.title = 'score ' + (Number(f.score) || 0).toFixed(2);
      const [dir, base] = splitPath(f.path);
      const path = el('span', 'ctx-path');
      path.append(el('span', 'dir', dir), el('span', 'base', base));
      const ranges = fmtRanges(f.ranges);
      if (ranges) path.append(el('span', 'ranges', ranges));
      const meta = el('div', 'ctx-meta');
      const source = f.source === 'explicit' ? 'explicit' : 'retrieved';
      meta.append(el('span', 'badge ' + source, source));
      for (const reason of Array.isArray(f.reasons) ? f.reasons : []) meta.append(el('span', 'chip', reason));
      row.append(el('span', 'ctx-rank', '#' + (i + 1)), path, el('span', 'ctx-tokens', fmtInt(f.tokens) + ' tok'), meta);
      body.append(row);
    });

    if (dropped.length) {
      const det = el('details', 'dropped');
      det.append(el('summary', '', 'Not included (over budget) — ' + dropped.length));
      const ul = el('ul');
      for (const d of dropped) {
        const li = el('li');
        li.append(code(d.path), ' · score ' + (Number(d.score) || 0).toFixed(2) + (d.reason ? ' · ' + d.reason : ''));
        ul.append(li);
      }
      det.append(ul);
      body.append(det);
    }
    card.append(body);
    return card;
  }

  // Feature 5: command guard risk levels (CommandRisk), shown as a badge on the approval card.
  const RISKS = {
    test: { label: 'Test', title: 'Runs tests or linters' },
    read: { label: 'Read', title: 'Only inspects files' },
    write: { label: 'Write', title: 'Changes files in the workspace' },
    network: { label: 'Network', title: 'Talks to the network or installs packages' },
    destructive: { label: 'Destructive', title: 'Deletes or overwrites broadly, escalates, or leaves the workspace' },
  };

  /** Normalised CommandAssessment, or null when the event has none. */
  function readAssessment(a) {
    if (!a || typeof a !== 'object') return null;
    const risk = RISKS[a.risk] ? a.risk : '';
    // the guard prefixes hard-block reasons with "blocked: "; the card already says so
    const reasons = Array.isArray(a.reasons) ? a.reasons.map((r) => str(r).replace(/^blocked:\s*/i, '')).filter(Boolean) : [];
    return { risk, blocked: a.blocked === true, reasons };
  }

  function riskBadge(risk) {
    const meta = RISKS[risk];
    const b = el('span', 'risk ' + (meta ? risk : 'unknown'));
    b.append(ic('shield'), meta ? meta.label : 'Unrated');
    b.title = 'Command guard: ' + (meta ? meta.label.toLowerCase() + ' — ' + meta.title : 'risk not rated');
    return b;
  }

  /**
   * 1b: a resolved card folds to one line. The DOM is kept (only hidden by CSS), so later updates
   * (applied, undone, reverted, a late shadow result) still paint the hidden parts. Click or Enter
   * on the line opens the card again; a click on its head folds it back.
   */
  function compactable(card, head, line) {
    line.classList.add('card-line');
    line.tabIndex = 0;
    line.setAttribute('role', 'button');
    line.title = 'Show details';
    let enabled = false;
    const set = (on) => {
      card.classList.toggle('compact', on);
      line.setAttribute('aria-expanded', String(!on));
      if (enabled) head.setAttribute('aria-expanded', String(!on));
    };
    const byUser = (on) => {
      card.dataset.touched = '1';
      set(on);
      // Focus follows the visible control, so the keyboard never lands on a hidden one.
      (on ? line : head).focus({ preventScroll: true });
    };
    const keys = (fn) => (e) => {
      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        fn();
      }
    };
    line.addEventListener('click', () => byUser(false));
    line.addEventListener('keydown', keys(() => byUser(false)));
    head.addEventListener('click', (e) => {
      if (enabled && !card.classList.contains('compact') && !(e.target instanceof Element && e.target.closest('button'))) byUser(true);
    });
    head.addEventListener('keydown', keys(() => enabled && byUser(true)));
    return {
      /** Allow folding; fold now, or after `delay` ms so the decision is seen first. */
      enable(delay) {
        if (!enabled) {
          enabled = true;
          head.classList.add('foldable');
          head.tabIndex = 0;
          head.setAttribute('role', 'button');
          head.title = 'Fold to one line';
        }
        if (card.dataset.touched) return;
        if (delay > 0) {
          setTimeout(() => {
            if (!card.dataset.touched) set(true);
          }, delay);
        } else set(true);
      },
    };
  }

  function approvalCard(ev) {
    const assessment = readAssessment(ev.assessment);
    const card = el('div', 'card approval');
    const head = el('div', 'card-head');
    const iconWrap = el('span', 'tool-icon');
    iconWrap.append(ic('terminal'));
    const titleEl = el('span', 'title', 'Run this command?');
    head.append(iconWrap, titleEl);
    if (assessment) {
      const badge = riskBadge(assessment.risk);
      badge.classList.add('push');
      head.append(badge);
      card.classList.add('risk-' + (assessment.risk || 'unknown'));
    }
    const body = el('div', 'card-body');
    body.append(el('pre', 'box cmd', str(ev.command)));
    if (assessment && assessment.reasons.length) {
      const reasons = el('div', 'risk-reasons');
      for (const r of assessment.reasons) reasons.append(el('span', 'chip', r));
      body.append(reasons);
    }
    const cwd = el('div', 'cwd');
    const where = str(ev.cwd).trim();
    if (!where || where === '.' || where === './') cwd.append('in the workspace folder');
    else cwd.append('in ', code(where));
    body.append(cwd);
    const foot = el('div', 'card-foot');
    const verdict = el('span', 'verdict');
    const state = { answered: false, closed: false };
    const choose = (decision) => {
      if (state.answered) return;
      state.answered = true;
      post({ type: 'approveCommand', requestId: ev.requestId, decision });
      setButtons(false);
      verdict.className = 'verdict neutral';
      verdict.textContent = 'Sent: ' + decisionLabel(decision) + '…';
    };
    const allowOnce = button('Allow once', 'btn primary', () => choose('once'));
    const allowTen = button('Allow for 10 min', 'btn', () => choose('tenMinutes'), 'Allow run_command without asking for 10 minutes');
    const deny = button('Deny', 'btn', () => choose('deny'));
    foot.append(allowOnce, allowTen, deny, verdict);
    const line = el('div');
    card.append(head, body, foot, line);
    const fold = compactable(card, head, line);
    /** The one-line form of an allowed command: verdict, risk badge, the command. */
    function paintLine(decision) {
      const cmd = el('span', 'line-main mono', oneLine(str(ev.command), 240));
      cmd.title = str(ev.command);
      line.replaceChildren(
        el('span', 'line-ic ok'),
        el('span', 'line-verdict', decision === 'auto' ? 'Auto-approved' : decision === 'tenMinutes' ? 'Allowed 10 min' : 'Allowed once'),
      );
      line.firstChild.append(ic('check'));
      if (assessment) line.append(riskBadge(assessment.risk));
      line.append(cmd, ic('chev', 'chev'));
    }
    function setButtons(enabled) {
      allowOnce.disabled = allowTen.disabled = deny.disabled = !enabled;
    }
    function blockedReason(reason) {
      const r = str(reason).replace(/^blocked:\s*/i, '') || (assessment && assessment.reasons.length ? assessment.reasons.join(', ') : '');
      return 'Blocked by command guard' + (r ? ': ' + r : '');
    }
    const api = {
      el: card,
      isOpen: () => !state.closed,
      resolve(decision, reason) {
        state.answered = state.closed = true;
        setButtons(false);
        allowOnce.hidden = allowTen.hidden = deny.hidden = true;
        card.classList.add('resolved');
        card.classList.toggle('blocked', decision === 'blocked');
        card.classList.toggle('auto', decision === 'auto');
        verdict.replaceChildren();
        if (decision === 'blocked') {
          titleEl.textContent = 'Command blocked';
          verdict.className = 'verdict bad';
          verdict.append(ic('shield'), blockedReason(reason));
        } else if (decision === 'auto') {
          const risk = assessment && RISKS[assessment.risk] ? assessment.risk : '';
          titleEl.textContent = 'Ran without asking';
          verdict.className = 'verdict ok';
          verdict.append(ic('check'), 'Auto-approved: safe ' + (risk ? risk + ' ' : '') + 'command');
          if (reason) verdict.title = str(reason);
        } else {
          verdict.className = 'verdict ' + (decision === 'deny' ? 'bad' : 'ok');
          verdict.textContent = decisionLabel(decision);
          if (reason) verdict.title = str(reason);
        }
        // Denied and blocked commands stay open: a refused command is evidence for the guard.
        card.classList.toggle('denied', decision === 'deny');
        if (decision === 'once' || decision === 'tenMinutes' || decision === 'auto') {
          paintLine(decision);
          fold.enable(decision === 'auto' || !liveNow() ? 0 : 600);
        }
      },
      expire() {
        if (state.closed) return;
        state.answered = state.closed = true;
        setButtons(false);
        card.classList.add('resolved');
        verdict.className = 'verdict neutral';
        verdict.textContent = 'Expired (run ended)';
      },
    };
    // The guard refuses these without asking; approval.resolved('blocked') may follow with the reason.
    if (assessment && assessment.blocked) api.resolve('blocked');
    return api;
  }

  function decisionLabel(decision) {
    if (decision === 'once') return 'Allowed once';
    if (decision === 'tenMinutes') return 'Allowed for 10 minutes';
    if (decision === 'auto') return 'Auto-approved';
    if (decision === 'blocked') return 'Blocked by command guard';
    return 'Denied';
  }

  const VERIFY_STATUSES = ['passed', 'failed', 'error', 'skipped', 'cancelled'];

  /**
   * Feature 1: the 'Shadow test run' line of a review card — the relevant tests, run on a temporary
   * copy of the workspace with the full proposal applied.
   */
  function verifyBox() {
    const root = el('div', 'verify');
    root.hidden = true;
    const head = el('div', 'verify-head');
    const iconWrap = el('span', 'verify-icon');
    const label = el('span', 'verify-label', 'Shadow test run');
    const text = el('span', 'verify-text');
    const note = el('span', 'verify-note');
    const toggle = button('', 'link-btn verify-toggle', () => {
      const open = !root.classList.contains('show-tail');
      root.classList.toggle('show-tail', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.replaceChildren(ic('chev', 'chev'), open ? 'Hide output' : 'Output');
    });
    toggle.hidden = true;
    head.append(iconWrap, label, text, note, toggle);
    const cmd = el('div', 'verify-cmd');
    const tail = el('pre', 'verify-tail');
    root.append(head, cmd, tail);

    function setCmd(command, tests) {
      const c = str(command);
      const t = Array.isArray(tests) ? tests.map(str).filter(Boolean) : [];
      cmd.replaceChildren();
      if (c) cmd.append(el('span', 'dollar', '$ '), c);
      else if (t.length) cmd.append(t.join(' '));
      cmd.title = [c, t.length ? 'tests: ' + t.join(', ') : ''].filter(Boolean).join('\n');
      cmd.hidden = !c && !t.length;
    }

    return {
      el: root,
      status: '',
      start(ev) {
        // A late 'started' must not overwrite a result that already arrived.
        if (this.status && this.status !== 'running') return;
        this.status = 'running';
        root.className = 'verify running';
        iconWrap.replaceChildren(el('span', 'spinner'));
        text.textContent = 'running on a shadow copy…';
        note.textContent = '';
        setCmd(ev.command, ev.tests);
        toggle.hidden = true;
        tail.textContent = '';
        root.hidden = false;
      },
      finish(r) {
        const status = VERIFY_STATUSES.includes(r.status) ? r.status : 'error';
        this.status = status;
        root.className = 'verify ' + status;
        const summary = oneLine(r.summary, 200);
        iconWrap.replaceChildren(
          ic(status === 'passed' ? 'check' : status === 'failed' ? 'x' : status === 'error' ? 'warn' : 'dash'),
        );
        if (status === 'passed') text.textContent = summary || 'tests passed';
        else if (status === 'failed') text.textContent = summary || 'tests failed';
        else if (status === 'error') text.textContent = 'could not run' + (summary ? ': ' + summary : '');
        else if (status === 'skipped') text.textContent = /^skipped\b/i.test(summary) ? summary : 'skipped' + (summary ? ': ' + summary : '');
        else text.textContent = 'cancelled';
        const dur = num(r.durationMs);
        note.textContent =
          status === 'passed' || status === 'failed' ? 'with all hunks applied' + (dur > 0 && !/\d(\.\d+)?\s*s\b/.test(summary) ? ' · ' + fmtSecs(dur) : '') : '';
        if (r.command || (Array.isArray(r.tests) && r.tests.length)) setCmd(r.command, r.tests);
        else if (status === 'skipped' || status === 'cancelled') cmd.hidden = true;
        const out = str(r.outputTail).replace(/\s+$/, '');
        tail.textContent = out;
        toggle.hidden = !out;
        root.classList.remove('show-tail');
        toggle.replaceChildren(ic('chev', 'chev'), 'Output');
        toggle.setAttribute('aria-expanded', 'false');
        root.hidden = false;
      },
      /** The run ended while the tests were still running; a late result still updates the line. */
      runEnded() {
        if (this.status !== 'running') return;
        this.status = 'stale';
        root.className = 'verify stale';
        iconWrap.replaceChildren(ic('dash'));
        text.textContent = 'no result yet (run ended)';
      },
    };
  }

  function verifyChip(status) {
    if (status === 'running') return ['running', 'testing…'];
    if (status === 'passed') return ['passed', 'tests pass'];
    if (status === 'failed') return ['failed', 'tests fail'];
    if (status === 'error') return ['error', 'test error'];
    if (status === 'skipped') return ['skipped', 'no tests'];
    if (status === 'stale') return ['skipped', 'no result'];
    if (status === 'cancelled') return ['skipped', 'cancelled'];
    return ['skipped', 'not tested'];
  }

  function reviewCard(ev) {
    const changeId = ev.changeId;
    const hunks = Array.isArray(ev.hunks) ? ev.hunks : [];
    const decisions = hunks.map(() => 'pending');
    let closed = false;
    let applying = false;
    let applyTimer = 0;

    const card = el('div', 'card review');
    const head = el('div', 'card-head');
    const iconWrap = el('span', 'tool-icon');
    iconWrap.append(ic('pencil'));
    head.append(iconWrap, el('span', 'title review-path', ev.path));
    if (ev.isNewFile) head.append(el('span', 'badge new', 'New'));
    const undoneBadge = el('span', 'badge undone', 'Undone');
    undoneBadge.hidden = true;
    head.append(undoneBadge);
    const totals = el('span', 'hunk-counts push');
    totals.append(
      el('span', 'add', '+' + hunks.reduce((a, h) => a + (Number(h.added) || 0), 0)),
      el('span', 'del', '−' + hunks.reduce((a, h) => a + (Number(h.removed) || 0), 0)),
    );
    head.append(totals);
    card.append(head);
    if (ev.explanation) card.append(el('div', 'review-expl', ev.explanation));
    const verify = verifyBox();
    card.append(verify.el);

    const list = el('div', 'hunks');
    const items = hunks.map((h, pos) => {
      const box = el('div', 'hunk pending' + (hunks.length <= 3 ? ' open' : ''));
      const hh = el('div', 'hunk-head');
      const toggle = el('button', 'collapser');
      toggle.type = 'button';
      toggle.append(ic('chev', 'chev'), 'Hunk ' + (pos + 1));
      const counts = el('span', 'hunk-counts');
      counts.append(el('span', 'add', '+' + (Number(h.added) || 0)), el('span', 'del', '−' + (Number(h.removed) || 0)));
      const stateEl = el('span', 'hunk-state', 'Pending');
      const index = typeof h.index === 'number' ? h.index : pos;
      const accept = button('Accept', 'btn small ok', () => decide(pos, 'accepted'));
      const reject = button('Reject', 'btn small no', () => decide(pos, 'rejected'));
      const actions = el('span', 'hunk-actions');
      actions.append(accept, reject);
      hh.append(toggle, el('span', 'hunk-range', h.header || ''), counts, stateEl, actions);
      const diff = el('pre', 'diff');
      for (const line of String(h.preview || '').split('\n')) {
        const c = line.charAt(0);
        const kind = c === '+' ? 'add' : c === '-' ? 'del' : c === '…' ? 'more' : 'ctx';
        const ln = el('span', 'ln ' + kind);
        if (kind === 'more') ln.textContent = line;
        else ln.append(el('span', 'sign', c === '+' || c === '-' ? c : ' '), line.slice(1) || ' ');
        diff.append(ln);
      }
      box.append(hh, diff);
      box.addEventListener('animationend', (e) => {
        if (e.animationName === 'fl-wash') box.classList.remove('just');
      });
      makeToggle(box, toggle);
      list.append(box);
      return { box, stateEl, accept, reject, index };
    });
    card.append(list);

    const foot = el('div', 'card-foot');
    const acceptAll = button('Accept all', 'btn', () => all('accepted'));
    const rejectAll = button('Reject all', 'btn', () => all('rejected'));
    const tally = el('span', 'tally push');
    const apply = button('Apply', 'btn primary', () => {
      if (closed || applying) return;
      applying = true;
      post({ type: 'applyReview', changeId });
      paint();
      // If the extension never closes the review (e.g. an error), let the user try again.
      clearTimeout(applyTimer);
      applyTimer = setTimeout(() => {
        applying = false;
        paint();
      }, 6000);
    }, 'Write the accepted hunks to disk');
    foot.append(acceptAll, rejectAll, tally, apply);
    card.append(foot);
    const outcome = el('div', 'outcome');
    outcome.hidden = true;
    card.append(outcome);
    const line = el('div');
    card.append(line);
    const fold = compactable(card, head, line);
    let outcomeKind = '';

    /** The one-line form of a closed review: outcome, path, hunks, lines, shadow test chip. */
    function paintLine() {
      if (!closed) return;
      let accepted = 0;
      let added = 0;
      let removed = 0;
      hunks.forEach((h, i) => {
        if (decisions[i] !== 'accepted') return;
        accepted++;
        added += Number(h.added) || 0;
        removed += Number(h.removed) || 0;
      });
      const icon = el('span', 'line-ic ' + outcomeKind);
      icon.append(ic(outcomeKind === 'ok' ? 'check' : outcomeKind === 'bad' ? 'x' : 'dash'));
      const [dir, base] = splitPath(ev.path);
      const path = el('span', 'line-main mono');
      path.append(el('span', 'dir', dir), el('span', 'base', base));
      path.title = str(ev.path);
      line.replaceChildren(icon, path);
      if (ev.isNewFile) line.append(el('span', 'badge new', 'New'));
      if (!undoneBadge.hidden) line.append(el('span', 'badge undone', undoneBadge.textContent));
      const what =
        outcomeKind === 'ok' ? accepted + '/' + plural(hunks.length, 'hunk') : outcomeKind === 'bad' ? 'rejected' : outcome.textContent.startsWith('Review cancelled') ? 'cancelled' : 'closed';
      line.append(el('span', 'line-note', what));
      if (accepted) {
        const counts = el('span', 'hunk-counts');
        counts.append(el('span', 'add', '+' + added), el('span', 'del', '−' + removed));
        line.append(counts);
      }
      if (verify.status) {
        const [kind, text] = verifyChip(verify.status);
        const chip = el('span', 'tool-chip ' + kind);
        chip.append(kind === 'running' ? el('span', 'spinner mini') : ic(kind === 'passed' ? 'check' : kind === 'failed' ? 'x' : kind === 'error' ? 'warn' : 'dash'), text);
        chip.title = 'Shadow test run';
        line.append(chip);
      }
      line.append(ic('chev', 'chev'));
    }

    function decide(pos, decision) {
      if (closed || applying) return;
      decisions[pos] = decision;
      paint();
      post({ type: 'hunk', changeId, index: items[pos].index, decision });
    }

    function all(decision) {
      if (closed || applying) return;
      decisions.fill(decision);
      paint();
      post({ type: 'reviewAll', changeId, decision });
    }

    function paint() {
      let accepted = 0;
      let rejected = 0;
      items.forEach((it, i) => {
        const d = decisions[i];
        if (d === 'accepted') accepted++;
        if (d === 'rejected') rejected++;
        it.box.classList.toggle('accepted', d === 'accepted');
        it.box.classList.toggle('rejected', d === 'rejected');
        it.box.classList.toggle('pending', d === 'pending');
        // A short green wash on the moment a hunk is accepted (not when it is shown again later).
        if (d === 'accepted' && it.prev && it.prev !== 'accepted' && liveNow()) it.box.classList.add('just');
        it.prev = d;
        it.stateEl.textContent = d === 'accepted' ? 'Accepted' : d === 'rejected' ? 'Rejected' : 'Pending';
        it.accept.classList.toggle('on', d === 'accepted');
        it.reject.classList.toggle('on', d === 'rejected');
        it.accept.setAttribute('aria-pressed', String(d === 'accepted'));
        it.reject.setAttribute('aria-pressed', String(d === 'rejected'));
        it.accept.disabled = it.reject.disabled = closed || applying;
      });
      const pending = items.length - accepted - rejected;
      tally.textContent = accepted + ' accepted · ' + rejected + ' rejected' + (pending ? ' · ' + pending + ' pending' : '');
      apply.textContent = applying ? 'Applying…' : 'Apply ' + accepted + '/' + items.length;
      acceptAll.disabled = rejectAll.disabled = apply.disabled = closed || applying;
    }

    function setDecisions(ds) {
      if (!Array.isArray(ds)) return;
      items.forEach((_, i) => {
        if (ds[i] === 'accepted' || ds[i] === 'rejected' || ds[i] === 'pending') decisions[i] = ds[i];
      });
      paint();
    }

    function finishWith(kind, text, note) {
      closed = true;
      applying = false;
      clearTimeout(applyTimer);
      foot.hidden = true;
      card.classList.add('closed');
      outcome.className = 'outcome ' + kind;
      outcome.replaceChildren(ic(kind === 'ok' ? 'check' : kind === 'bad' ? 'x' : 'dash'), el('span', '', text));
      if (note) outcome.append(el('span', 'sub', '· ' + note));
      outcome.hidden = false;
      outcomeKind = kind;
      paint();
      paintLine();
      fold.enable(liveNow() ? 600 : 0);
    }

    paint();
    return {
      el: card,
      isOpen: () => !closed,
      setDecisions,
      close(result) {
        const r = result || {};
        setDecisions(r.decisions);
        const accepted = Array.isArray(r.accepted) ? r.accepted.length : decisions.filter((d) => d === 'accepted').length;
        const total = items.length;
        if (r.cancelled) finishWith('neutral', 'Review cancelled — nothing written', r.note);
        else if (accepted === 0) finishWith('bad', 'All hunks rejected — nothing written', r.note);
        else finishWith('ok', 'Accepted ' + accepted + ' of ' + plural(total, 'hunk'), r.note);
      },
      applied(record) {
        // Before the one-line form, which stays the card's last child.
        line.before(appliedRow(record));
      },
      undone(record) {
        undoneBadge.textContent = 'Undone';
        undoneBadge.hidden = false;
        line.before(undoneRow(record));
        paintLine();
      },
      reverted() {
        undoneBadge.textContent = 'Reverted';
        undoneBadge.hidden = false;
        paintLine();
      },
      /** Repaint the one-line form (after a shadow test result). */
      refresh: paintLine,
      verify,
      expire() {
        if (!closed) finishWith('neutral', 'Review closed (run ended)');
        verify.runEnded();
      },
    };
  }

  // ------------------------------------------------------ verify (Feature 1)

  /** The tool row of a call, looked up in its run (or any run when runId is missing). */
  function findTool(runId, toolCallId) {
    if (!toolCallId) return null;
    if (typeof runId === 'number' && runs.has(runId)) return runs.get(runId).tools.get(toolCallId) || null;
    for (const run of runs.values()) if (run.tools.has(toolCallId)) return run.tools.get(toolCallId);
    return null;
  }

  /** Show the latest shadow-test state of a change on its review card and its propose_edit row. */
  function applyVerify(changeId) {
    const st = verifies.get(changeId);
    if (!st) return;
    const card = reviews.get(changeId);
    if (card) {
      if (st.result) card.verify.finish(st.result);
      else if (st.started) {
        card.verify.start(st.started);
        if (st.stale) card.verify.runEnded();
      }
      card.refresh();
    }
    const row = findTool(st.runId, changeId);
    if (row) {
      const status = st.result ? (VERIFY_STATUSES.includes(st.result.status) ? st.result.status : 'error') : st.stale ? 'stale' : 'running';
      const [kind, text] = verifyChip(status);
      const detail = st.result ? oneLine(st.result.summary, 160) || status : st.stale ? 'no result (run ended)' : 'running';
      row.setChip(kind, text, 'Shadow test run: ' + detail);
    }
  }

  // ------------------------------------------------ revert a run (Feature 2)

  /** Files a run changed that are still applied: path -> true when the run created the file. */
  function liveFiles(run) {
    const files = new Map();
    for (const a of run.applied.values()) {
      // Oldest record first, so a file the run created stays marked as created.
      if (!a.undone && !a.reverted && a.path && !files.has(a.path)) files.set(a.path, a.createdFile);
    }
    return files;
  }

  function runFoot(run) {
    if (!run.footEl) {
      run.footEl = el('div', 'run-foot');
      const main = run.threads.get('main');
      breakStep(main);
      main.body.appendChild(run.footEl);
    }
    return run.footEl;
  }

  function revertControl(run) {
    const row = el('div', 'revert-row');
    const btn = el('button', 'btn revert-btn');
    btn.type = 'button';
    btn.title = 'Restore every file this run changed (newest first); files it created are deleted';
    const hint = el('span', 'revert-hint', 'Restores every file this run changed; files it created are deleted.');
    row.append(btn, hint);
    let count = 0;
    let pending = false;
    let done = false;
    let doneLabel = 'Run reverted';
    let timer = 0;
    const paint = () => {
      btn.replaceChildren(ic('history'), done ? doneLabel : pending ? 'Reverting…' : 'Revert this run (' + plural(count, 'file') + ')');
      btn.disabled = done || pending || count === 0;
      hint.hidden = done;
    };
    btn.addEventListener('click', () => {
      if (done || pending || count === 0) return;
      pending = true;
      post({ type: 'revertRun', runId: run.id });
      // If the extension never answers (e.g. an error), let the user try again.
      clearTimeout(timer);
      timer = setTimeout(() => {
        pending = false;
        paint();
      }, 8000);
      paint();
    });
    return {
      el: row,
      update(n) {
        count = n;
        row.hidden = n === 0 && !done;
        paint();
      },
      done(label) {
        done = true;
        if (label) doneLabel = label;
        pending = false;
        clearTimeout(timer);
        row.hidden = false;
        paint();
      },
      /** A revert that skipped files (Cancel in a modal, a failed write): offer the rest again. */
      retry(n) {
        pending = false;
        clearTimeout(timer);
        count = n;
        row.hidden = false;
        paint();
      },
    };
  }

  /** Show/refresh the 'Revert this run (N files)' button once the run finished with applied edits. */
  function refreshRevert(run) {
    if (!run.finished || typeof run.id !== 'number') return;
    const n = liveFiles(run).size;
    if (!run.revert) {
      if (n === 0 || run.reverted) return;
      run.revert = revertControl(run);
      // A finished run's revert button lives on its finish card (3); otherwise in the run footer.
      if (run.finishCard) run.finishCard.actions.prepend(run.revert.el);
      else runFoot(run).append(run.revert.el);
    }
    if (!run.reverted) run.revert.update(n);
    if (run.finishCard) run.finishCard.paintFiles();
  }

  /** The last test command of a run (by guard rating, else the last command) with its result. */
  function lastTestRow(run) {
    let lastCmd = null;
    let lastTest = null;
    for (const row of run.tools.values()) {
      if (row.key !== 'run_command' || !row.done || row.status === 'stopped') continue;
      lastCmd = row;
      if (row.risk === 'test') lastTest = row;
    }
    return lastTest || lastCmd;
  }

  /** Accepted line counts of an applied record ({added, removed}), or null when unknown. */
  function appliedLines(run, record) {
    const hunks = run.changes.get(str(record.changeId));
    if (!hunks || !Array.isArray(record.hunksApplied)) return null;
    let added = 0;
    let removed = 0;
    for (const idx of record.hunksApplied) {
      const h = hunks.find((x) => x.index === idx);
      if (!h) return null;
      added += h.added;
      removed += h.removed;
    }
    return { added, removed };
  }

  /**
   * 3: one card for a run that ended 'done': files changed, checks, context, the agent's closing
   * message, and Revert / Open in TrueForge / Copy summary. Never green over a failing test.
   */
  function finishCard(run, ev, elapsed) {
    const card = el('div', 'card finish-card');
    const head = el('div', 'card-head');
    const headIc = el('span', 'finish-ic');
    const title = el('span', 'title');
    const model = el('span', 'finish-model push', str(ev.model) || S.activeModel || '');
    head.append(headIc, title, model);
    const filesEl = el('div', 'finish-files');
    const checks = el('div', 'finish-checks');
    const actions = el('div', 'card-foot finish-actions');
    card.append(head, filesEl, checks);

    // Checks: the last test command, then the shadow runs of this run's changes.
    const test = lastTestRow(run);
    let warn = false;
    let warnText = '';
    const checkLines = [];
    if (test) {
      const failed = test.status === 'failed';
      warn = failed;
      const row = el('div', 'finish-check ' + (failed ? 'bad' : 'ok'));
      let cmd = str(test.args).replace(/^\$\s*/, '');
      if (cmd.startsWith('{')) {
        try {
          cmd = str(JSON.parse(cmd).command) || cmd;
        } catch (_) {
          /* a preview that is not JSON: shown as it is */
        }
      }
      // Only a command the guard rated 'test' is called a test run.
      const what = test.risk === 'test' ? 'Last test run' : 'Last command';
      row.append(ic(failed ? 'x' : 'check'), el('span', 'what', what + (failed ? ' failed' : ' passed')));
      if (failed) warnText = what.toLowerCase() + ' failed';
      const detail = el('span', 'detail mono', oneLine(cmd, 120));
      detail.title = cmd + (test.summary ? '\n' + test.summary : '');
      row.append(detail);
      checks.append(row);
      checkLines.push((failed ? 'FAILED ' : 'passed ') + cmd + (test.summary ? ' (' + test.summary + ')' : ''));
    }
    const shadow = { passed: 0, failed: 0, other: 0 };
    let lastShadow = '';
    for (const st of verifies.values()) {
      if (st.runId !== run.id || !st.result) continue;
      const s = st.result.status;
      if (s === 'passed') shadow.passed++;
      else if (s === 'failed') shadow.failed++;
      else shadow.other++;
      lastShadow = s;
    }
    const shadowTotal = shadow.passed + shadow.failed + shadow.other;
    if (shadowTotal) {
      // No test command ran: the last shadow result is the best evidence we have.
      if (!test && lastShadow === 'failed') {
        warn = true;
        warnText = 'last shadow test run failed';
      }
      const parts = [];
      if (shadow.passed) parts.push(shadow.passed + ' passed');
      if (shadow.failed) parts.push(shadow.failed + ' failed');
      if (shadow.other) parts.push(shadow.other + ' not run');
      const text = plural(shadowTotal, 'shadow test run') + ': ' + parts.join(', ');
      const row = el('div', 'finish-check ' + (lastShadow === 'passed' ? 'ok' : lastShadow === 'failed' ? 'bad' : 'neutral'));
      row.append(ic('beaker'), el('span', 'what', text));
      row.title = 'Tests run on a sandboxed copy with each proposal applied, before review';
      checks.append(row);
      checkLines.push(text);
    }
    if (run.ctx.calls) {
      const row = el('div', 'finish-check ctx');
      row.append(ic('scan'), el('span', 'what', 'Context X-ray: ' + runTotalsText(run.ctx)));
      checks.append(row);
    }
    if (!checks.childElementCount) checks.hidden = true;

    card.classList.toggle('warn', warn);
    headIc.append(ic(warn ? 'warn' : 'check'));
    title.textContent = 'Done in ' + elapsed + (warn ? ' · ' + warnText : '');
    if (ev.message) card.append(el('div', 'finish-msg', str(ev.message)));

    const sessionBtn = button('', 'btn', () => post({ type: 'openSession' }), "Open this run's session in TrueForge");
    sessionBtn.append(ic('external'), 'Open in TrueForge');
    sessionBtn.hidden = !run.sessionId || lastRun !== run;
    const copyBtn = button('', 'btn', () => {
      copyText(summary());
      copyBtn.replaceChildren(ic('check'), 'Copied');
      setTimeout(() => copyBtn.replaceChildren(ic('copy'), 'Copy summary'), 1600);
    }, 'Copy a plain-text summary of this run');
    copyBtn.append(ic('copy'), 'Copy summary');
    actions.append(sessionBtn, copyBtn);
    card.append(actions);

    /**
     * Files this run changed, with "new" and accepted +/- lines. The line counts are shown only
     * when every file was edited once: a second edit of a file (often after a command such as
     * `git checkout` changed it outside the review) makes a sum misleading, and we do not estimate.
     */
    function fileStats() {
      const files = new Map();
      let exact = true;
      for (const a of run.applied.values()) {
        if (!a.path) continue;
        let f = files.get(a.path);
        if (f) exact = false;
        else files.set(a.path, (f = { created: a.createdFile, added: 0, removed: 0, known: true, live: false, gone: 'Reverted' }));
        if (!a.undone && !a.reverted) f.live = true;
        else if (a.undone && !a.reverted) f.gone = 'Undone';
        if (a.lines) {
          f.added += a.lines.added;
          f.removed += a.lines.removed;
        } else exact = false;
      }
      if (!exact) for (const f of files.values()) f.known = false;
      return files;
    }
    function paintFiles() {
      const files = fileStats();
      filesEl.replaceChildren();
      if (!files.size) {
        filesEl.append(el('div', 'finish-none', 'No edits applied'));
        return;
      }
      for (const [p, f] of files) {
        const row = el('div', 'finish-file' + (f.live ? '' : ' gone'));
        const [dir, base] = splitPath(p);
        const path = el('span', 'mono path');
        path.append(el('span', 'dir', dir), el('span', 'base', base));
        path.title = p;
        row.append(ic('file'), path);
        if (f.created) row.append(el('span', 'badge new', 'New'));
        if (!f.live) row.append(el('span', 'badge undone', f.gone));
        if (f.known) {
          const counts = el('span', 'hunk-counts push');
          counts.append(el('span', 'add', '+' + f.added), el('span', 'del', '−' + f.removed));
          row.append(counts);
        }
        filesEl.append(row);
      }
    }
    function summary() {
      const out = ['Forgelight run: done in ' + elapsed + (model.textContent ? ' on ' + model.textContent : '')];
      if (run.text) out.push('Request: ' + run.text);
      const files = fileStats();
      if (files.size) {
        out.push('Files changed:');
        for (const [p, f] of files) {
          out.push('- ' + p + (f.created ? ' (new)' : '') + (f.known ? ' +' + f.added + ' -' + f.removed : '') + (f.live ? '' : ' (' + f.gone.toLowerCase() + ')'));
        }
      } else out.push('No edits applied.');
      for (const c of checkLines) out.push('Check: ' + c);
      if (run.ctx.calls) out.push('Context: ' + runTotalsText(run.ctx));
      return out.join('\n');
    }
    paintFiles();
    return { el: card, actions, paintFiles, sessionBtn };
  }

  /** Clipboard: the webview API where allowed, and the extension (vscode.env.clipboard) too. */
  function copyText(text) {
    post({ type: 'copy', text });
    try {
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => undefined);
    } catch (_) {
      /* the extension copies it */
    }
  }

  function revertedBanner(records, kept) {
    // ApplyRecords arrive newest first; the oldest record of a path says whether the run created it.
    const files = new Map();
    for (const r of records.slice().reverse()) {
      const p = str(r.path);
      if (p && !files.has(p)) files.set(p, r.createdFile === true);
    }
    const b = el('div', 'banner revert');
    const body = el('div');
    b.append(ic('history'), body);
    const keptAny = !!(kept && kept.length);
    if (files.size === 0) {
      body.append(el('div', '', keptAny ? 'Nothing was reverted.' : 'Nothing to revert: no applied changes of this run were left.'));
      if (!keptAny) return b;
    } else {
      const title = el('div');
      title.append(el('strong', '', 'Reverted run: '), 'restored ' + plural(files.size, 'file'));
      body.append(title);
      const ul = el('ul', 'revert-files');
      for (const [p, created] of files) {
        const li = el('li');
        li.append(code(p));
        if (created) li.append(el('span', 'sub', ' — deleted (created by this run)'));
        ul.append(li);
      }
      body.append(ul);
    }
    if (keptAny) {
      const note = el('div', 'sub');
      note.append('Kept ' + plural(kept.length, 'file') + ' this run changed (not reverted): ');
      kept.forEach((p, i) => {
        if (i) note.append(', ');
        note.append(code(p));
      });
      body.append(note);
    }
    return b;
  }

  // ------------------------------------------- model health/switch (Feature 3)

  const HEALTH = ['ok', 'down', 'unknown', 'skipped'];

  function healthTitle(h) {
    if (!h) return 'health unknown (not called yet)';
    const retry = fmtClock(h.retryAt);
    if (h.status === 'ok') return 'healthy' + (h.latencyMs !== undefined ? ' · ' + fmtLatency(h.latencyMs) + ' latency' : '');
    if (h.status === 'down') return 'down' + (h.reason ? ': ' + oneLine(h.reason, 160) : '') + (retry ? ' · retry after ' + retry : '');
    if (h.status === 'skipped') return 'skipped (circuit open)' + (retry ? ' · retry after ' + retry : '') + (h.reason ? ' · ' + oneLine(h.reason, 160) : '');
    return 'health unknown' + (h.reason ? ': ' + oneLine(h.reason, 160) : '');
  }

  /** One banner per model switch: a plain fallback, or 'Session kept' once model.resume confirms it. */
  function modelSwitch(from, to) {
    const root = el('div', 'banner');
    const sw = {
      el: root,
      fallback: false,
      resume: false,
      reason: '',
      sessionId: '',
      paint() {
        const body = el('div');
        if (this.resume) {
          root.className = 'banner resume';
          const title = el('div');
          title.append(el('strong', '', 'Session kept: '), 'switched ', code(from), ' → ', code(to), ' mid-task; continuing with full history');
          body.append(title);
          const why = (this.fallback ? 'Automatic fallback' : '') + (this.reason ? (this.fallback ? ' · ' : 'Reason: ') + oneLine(this.reason, 240) : '');
          if (why) body.append(el('div', 'sub', why));
          if (this.sessionId) body.append(el('div', 'sub', 'Same TrueForge session ' + this.sessionId.slice(0, 8) + ' — the conversation was not restarted'));
          root.replaceChildren(ic('link'), body);
        } else {
          root.className = 'banner blue';
          body.append(el('div', '', from + ' unavailable → switched to ' + to + ' automatically'));
          if (this.reason) body.append(el('div', 'sub', 'Reason: ' + oneLine(this.reason, 240)));
          root.replaceChildren(ic('swap'), body);
        }
      },
    };
    return sw;
  }

  /** Record a fallback or resume; merges with the other half of the same switch if it was already shown. */
  function noteSwitch(kind, ev, at) {
    const from = str(ev.from);
    const to = str(ev.to);
    const runId = typeof ev.runId === 'number' ? ev.runId : undefined;
    const key = String(runId) + '|' + from + '|' + to;
    let sw = switches.get(key);
    if (!sw || sw[kind]) {
      sw = modelSwitch(from, to);
      switches.set(key, sw);
      looseTarget(runId, at).appendChild(sw.el);
    }
    sw[kind] = true;
    if (!sw.reason && ev.reason) sw.reason = str(ev.reason);
    if (ev.sessionId) sw.sessionId = str(ev.sessionId);
    sw.paint();
  }

  function markSwitched(ev, at) {
    const from = str(ev.from);
    const to = str(ev.to);
    if (from) S.failed.add(from);
    if (to) S.activeModel = to;
    S.fellBack = true;
    if (typeof ev.runId === 'number' && to) {
      const run = getRun(ev.runId, at);
      run.modelEl.textContent = to;
      run.meta.hidden = false;
    }
  }

  // ---------------------------------------------- context X-ray (Feature 4)

  // usage.inputTokensBreakdown keys (TrueForge), in prompt order; unknown keys get the extra colors.
  const XRAY_KEYS = [
    { key: 'harness', label: 'harness', color: 'var(--fl-x-harness)' },
    { key: 'instructions', label: 'instructions', color: 'var(--fl-x-instructions)' },
    { key: 'toolDefinitions', label: 'tool definitions', color: 'var(--fl-x-tools)' },
    { key: 'skills', label: 'skills', color: 'var(--fl-x-skills)' },
    { key: 'messages', label: 'messages', color: 'var(--fl-x-messages)' },
  ];
  const XRAY_ALIASES = { tool_definitions: 'toolDefinitions', tools: 'toolDefinitions', system: 'instructions', history: 'messages' };
  const XRAY_EXTRA = ['var(--fl-x-extra1)', 'var(--fl-x-extra2)', 'var(--fl-x-extra3)'];

  function humanize(key) {
    return String(key)
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .trim();
  }

  function xraySegments(input, breakdown) {
    const values = new Map();
    if (breakdown && typeof breakdown === 'object' && !Array.isArray(breakdown)) {
      for (const k of Object.keys(breakdown)) {
        const n = num(breakdown[k]);
        if (n <= 0) continue;
        const canon = XRAY_ALIASES[k] || k;
        values.set(canon, (values.get(canon) || 0) + n);
      }
    }
    const segs = [];
    for (const s of XRAY_KEYS) {
      if (values.has(s.key)) segs.push({ label: s.label, color: s.color, tokens: values.get(s.key) });
    }
    let extra = 0;
    for (const [k, n] of values) {
      if (XRAY_KEYS.some((s) => s.key === k)) continue;
      segs.push({ label: humanize(k) || 'other', color: XRAY_EXTRA[extra++ % XRAY_EXTRA.length], tokens: n });
    }
    const sum = segs.reduce((a, s) => a + s.tokens, 0);
    if (segs.length === 0) {
      if (input > 0) segs.push({ label: 'input (no breakdown)', color: 'var(--fl-x-messages)', tokens: input });
    } else if (input - sum >= Math.max(1, input * 0.005)) {
      segs.push({ label: 'other', color: 'var(--fl-x-other)', tokens: input - sum });
    }
    return segs;
  }

  function threadTitle(run, tid) {
    if (tid === 'main') return 'main agent';
    const th = run.threads.get(tid);
    return (th && th.titleEl && th.titleEl.textContent) || 'sub-agent';
  }

  function addUsage(run, ev) {
    const c = run.ctx;
    const tid = str(ev.threadId) || 'main';
    const input = Math.max(0, num(ev.inputTokens));
    const segments = xraySegments(input, ev.breakdown);
    const call = {
      threadId: tid,
      title: threadTitle(run, tid),
      model: str(ev.model),
      input,
      output: Math.max(0, num(ev.outputTokens)),
      contextLength: num(ev.contextLength) > 0 ? num(ev.contextLength) : 0,
      segments,
      total: Math.max(input, segments.reduce((a, s) => a + s.tokens, 0)),
    };
    c.calls++;
    if (tid !== 'main') c.subCalls++;
    c.inTotal += call.input;
    c.outTotal += call.output;
    if (call.contextLength) c.peakPct = Math.max(c.peakPct, (call.total / call.contextLength) * 100);
    c.peakTokens = Math.max(c.peakTokens, call.total);
    c.latest = call;
    if (tid === 'main') c.latestMain = call;
    if (run.xraySumEl) paintXraySum(run);
  }

  function runTotalsText(c) {
    return (
      plural(c.calls, 'call') +
      (c.subCalls ? ' (' + c.subCalls + ' sub-agent)' : '') +
      ' · peak ' +
      (c.peakPct ? fmtPct(c.peakPct) : fmtK(c.peakTokens) + ' tokens') +
      ' · ' +
      fmtK(c.inTotal) +
      ' in / ' +
      fmtK(c.outTotal) +
      ' out'
    );
  }

  /** The per-run 'Context X-ray' summary line in the run footer. */
  function paintXraySum(run) {
    if (!run.xraySumEl) {
      run.xraySumEl = el('div', 'sysrow xray-sum');
      runFoot(run).prepend(run.xraySumEl);
    }
    const span = el('span');
    span.append(el('strong', '', 'Context X-ray: '), runTotalsText(run.ctx));
    run.xraySumEl.replaceChildren(ic('scan'), span);
  }

  /** Coloured segments of one model call, as spans sized against `denom`. */
  function xraySegs(bar, call, denom) {
    for (const s of call.segments) {
      const seg = el('span');
      seg.style.width = ((s.tokens / denom) * 100).toFixed(2) + '%';
      seg.style.background = s.color;
      seg.title = s.label + ': ' + fmtInt(s.tokens) + ' tokens';
      bar.append(seg);
    }
  }

  /**
   * Sticky strip under the header: the latest main-thread call of the current run. It starts
   * closed (7): the head carries the numbers and a small bar; it opens by itself once when the
   * context passes 75 %, and remembers the user's choice.
   */
  const xray = {
    el: el('div', 'xray'),
    run: null,
    render() {
      const root = this.el;
      const run = this.run;
      root.hidden = !run;
      if (!run) return;
      const c = run.ctx;
      const call = c.latestMain || c.latest;
      const head = el('div', 'xray-head');
      head.append(ic('chev', 'chev'), ic('scan', 'xray-ic'), el('span', 'xray-title', 'Context X-ray'));
      const nodes = [head];
      if (!call) {
        head.append(el('span', 'xray-wait', 'fills in when the first model call ends…'));
      } else {
        const numEl = el('span', 'xray-num');
        let pct = 0;
        if (call.contextLength) {
          pct = (call.total / call.contextLength) * 100;
          // Full numbers, and a short form that narrow sidebars show instead.
          const full = el('span', 'wide-only');
          full.append(el('strong', '', fmtInt(call.total)), ' / ' + fmtInt(call.contextLength) + ' tokens (' + fmtPct(pct) + ')');
          const short = el('span', 'narrow-only');
          short.append(el('strong', '', fmtK(call.total)), ' / ' + fmtK(call.contextLength) + ' (' + fmtPct(pct) + ')');
          numEl.append(full, short);
        } else {
          numEl.append(el('strong', '', fmtInt(call.total)), ' tokens in');
        }
        numEl.classList.toggle('warn', pct >= 75 && pct < 90);
        numEl.classList.toggle('full', pct >= 90);
        // The strip follows the main agent; name the thread only while it shows a sub-agent's call.
        if (call.threadId !== 'main') head.append(el('span', 'xray-thread', call.title));
        const denom = call.contextLength ? Math.max(call.contextLength, call.total) : Math.max(1, call.total);
        // While closed, a small bar in the head hints at the breakdown.
        const mini = el('span', 'xray-mini');
        xraySegs(mini, call, denom);
        head.append(mini, numEl);
        head.title = 'Latest ' + call.title + ' call' + (call.model ? ' on ' + call.model : '') + ' · ' + fmtInt(call.output) + ' output tokens';
        // Once, for live usage only (not a replayed history), and remembered with the view state.
        if (pct >= 75 && !prefs.xrayAutoOpened && liveNow()) {
          prefs.xrayAutoOpened = true;
          prefs.xrayOpen = true;
          persist();
          root.classList.add('open');
        }

        const bar = el('div', 'xray-bar' + (call.contextLength ? '' : ' nolimit'));
        xraySegs(bar, call, denom);
        nodes.push(bar);

        const legend = el('div', 'xray-legend');
        for (const s of call.segments) {
          const k = el('span', 'xray-key');
          const sw = el('span', 'sw');
          sw.style.background = s.color;
          k.append(sw, s.label + ' ', el('span', 'n', fmtK(s.tokens)));
          legend.append(k);
        }
        const out = el('span', 'xray-key out');
        out.append('→ ', el('span', 'n', fmtK(call.output)), ' out');
        legend.append(out);
        nodes.push(legend);

        const totals = el('div', 'xray-totals');
        totals.append(el('span', 'who', 'This run: '), runTotalsText(c));
        totals.title = 'Bar: latest ' + call.title + ' call' + (call.model ? ' on ' + call.model : '') + '. Totals: every model call of this run, sub-agents included.';
        nodes.push(totals);
      }
      root.replaceChildren(...nodes);
      makeToggle(root, head, null, (open) => {
        prefs.xrayOpen = open;
        persist();
      });
    },
  };

  // ----------------------------------------- sub-agent savings (Feature 4)

  function setSavings(th, ev) {
    const read = Math.max(0, num(ev.contextTokens));
    const returned = Math.max(0, num(ev.returnedTokens));
    const title = str(ev.title) || (th.titleEl && th.titleEl.textContent) || 'Sub-agent';
    if (!th.footEl) {
      th.footEl = el('div', 'group-foot');
      th.group.append(th.footEl);
    }
    const span = el('span');
    span.append(
      el('strong', '', title),
      ' read ~',
      el('strong', '', fmtK(read)),
      ' tokens of context, returned ~',
      el('strong', '', fmtK(returned)),
      ' to the main agent',
    );
    th.footEl.replaceChildren(ic('scan'), span);
    if (read > 0 && returned < read) {
      const saved = Math.round((1 - returned / read) * 100);
      const badge = el('span', 'savings', '−' + saved + '%');
      badge.title = 'Context kept out of the main agent: ~' + fmtInt(read - returned) + ' tokens';
      th.footEl.append(badge);
    }
  }

  // ---------------------------------------------------------------- events

  function onEvent(ev, at) {
    // New model output after a retry means the retry went through.
    if (liveRetries.length && (ev.type === 'assistant.delta' || ev.type === 'reasoning.delta' || ev.type === 'tool.call' || ev.type === 'context.usage')) settleRetries();
    switch (ev.type) {
      case 'run.started': {
        const run = getRun(ev.runId, at);
        run.startedAt = at;
        run.text = String(ev.text || '');
        const head = userMessage(String(ev.text || ''), ev.mode);
        run.head.replaceWith(head);
        run.head = head;
        run.modelEl.textContent = ev.model || '';
        run.meta.hidden = !ev.model;
        S.activeModel = ev.model || S.activeModel;
        S.failed.clear();
        S.fellBack = false;
        S.lastError = false;
        S.running = true;
        S.runStartedAt = at;
        stick = true;
        // 'Open in TrueForge' opens the current session: only the newest run's finish card offers it.
        for (const other of runs.values()) if (other !== run && other.finishCard) other.finishCard.sessionBtn.hidden = true;
        // The X-ray strip follows the newest run once the feature has reported anything.
        if (xray.run && xray.run !== run && run.id >= xray.run.id) {
          xray.run = run;
          dirty.add(xray);
        }
        renderComposer();
        break;
      }
      case 'run.session': {
        const run = getRun(ev.runId, at);
        S.session = true;
        if (ev.model) {
          S.activeModel = ev.model;
          run.modelEl.textContent = ev.model;
        }
        run.sessionEl.textContent = ev.sessionId ? '· TrueForge session ' + String(ev.sessionId).slice(0, 8) : '';
        if (ev.sessionId) run.sessionId = str(ev.sessionId);
        run.sessionEl.title = ev.sessionUrl || '';
        run.meta.hidden = false;
        break;
      }
      case 'assistant.delta': {
        const th = getThread(getRun(ev.runId, at), ev.threadId, undefined, at);
        let block = th.messages.get(ev.messageId);
        if (!block) {
          settle(th);
          block = textBlock();
          th.messages.set(ev.messageId, block);
          stepAppend(th, block.el, at, 'text', block);
          th.activeText = block;
        } else touchStep(block.step, at);
        block.raw += ev.text || '';
        dirty.add(block);
        break;
      }
      case 'reasoning.delta': {
        const th = getThread(getRun(ev.runId, at), ev.threadId, undefined, at);
        let block = th.reasoning.get(ev.messageId);
        if (!block) {
          settle(th);
          block = reasoningBlock();
          th.reasoning.set(ev.messageId, block);
          stepAppend(th, block.el, at, 'thought', block);
          th.activeReasoning = block;
        } else touchStep(block.step, at);
        block.raw += ev.text || '';
        block.pending += ev.text || '';
        dirty.add(block);
        break;
      }
      case 'tool.call': {
        const run = getRun(ev.runId, at);
        const th = getThread(run, ev.threadId, undefined, at);
        const existing = run.tools.get(ev.toolCallId);
        if (existing) {
          existing.setArgs(ev.argsPreview);
          break;
        }
        settle(th);
        const row = toolRow(ev.name, ev.argsPreview);
        run.tools.set(ev.toolCallId, row);
        // Exploration folds into the current step; a call that owns a card ends it (rule 3).
        if (STEP_TOOLS.has(row.key)) stepAppend(th, row.el, at, row.key, row);
        else {
          endStep(th, at);
          th.body.appendChild(row.el);
        }
        break;
      }
      case 'tool.result': {
        const run = getRun(ev.runId, at);
        let row = run.tools.get(ev.toolCallId);
        if (!row) {
          const th = getThread(run, ev.threadId, undefined, at);
          settle(th);
          endStep(th, at);
          row = toolRow('tool', '');
          run.tools.set(ev.toolCallId, row);
          th.body.appendChild(row.el);
        }
        row.setResult(ev.preview);
        // A late failure inside a folded step or finished sub-agent must show on its line (rule 4).
        if (row.step) {
          touchStep(row.step, at);
          row.step.refresh();
        }
        const doneGroup = row.el.closest('.group.done');
        if (doneGroup) for (const t of run.threads.values()) if (t.group === doneGroup) paintGroupSummary(t);
        break;
      }
      case 'thread.started': {
        const th = getThread(getRun(ev.runId, at), ev.threadId, ev.title, at);
        if (th.titleEl && ev.title) th.titleEl.textContent = ev.title;
        break;
      }
      case 'thread.finished': {
        const run = getRun(ev.runId, at);
        const th = run.threads.get(ev.threadId || 'main');
        if (th && th.group) finishThread(th, true, at);
        break;
      }
      case 'context.picked': {
        const run = getRun(ev.runId, at);
        placeCard(run, 'retrieve_context', contextCard(ev.pick || {}));
        break;
      }
      case 'approval.command': {
        const run = getRun(ev.runId, at);
        // The guard's rating tells the finish card which command was the last test run.
        const own = ev.toolCallId ? run.tools.get(ev.toolCallId) : null;
        if (own && ev.assessment && typeof ev.assessment === 'object') own.risk = str(ev.assessment.risk);
        const card = approvalCard(ev);
        approvals.set(ev.requestId, card);
        run.cards.push(card);
        placeCard(run, 'run_command', card.el, ev.toolCallId);
        reveal = card;
        break;
      }
      case 'approval.resolved': {
        const card = approvals.get(ev.requestId);
        if (card) card.resolve(ev.decision, ev.reason);
        break;
      }
      case 'review.opened': {
        const run = getRun(ev.runId, at);
        const card = reviewCard(ev);
        reviews.set(ev.changeId, card);
        run.changes.set(
          str(ev.changeId),
          (Array.isArray(ev.hunks) ? ev.hunks : []).map((h, i) => ({
            index: typeof h.index === 'number' ? h.index : i,
            added: Number(h.added) || 0,
            removed: Number(h.removed) || 0,
          })),
        );
        run.cards.push(card);
        // changeId is the propose_edit tool call id
        placeCard(run, 'propose_edit', card.el, ev.changeId);
        reveal = card;
        if (verifies.has(ev.changeId)) applyVerify(ev.changeId);
        break;
      }
      case 'verify.started': {
        const id = str(ev.changeId);
        if (!id) break;
        // A new shadow run for the change replaces any earlier result.
        verifies.set(id, { runId: ev.runId, started: ev, result: null, stale: false });
        applyVerify(id);
        break;
      }
      case 'verify.finished': {
        const r = ev.result && typeof ev.result === 'object' ? ev.result : null;
        const id = r ? str(r.changeId) : '';
        if (!id) break;
        const st = verifies.get(id) || { runId: ev.runId, started: null };
        if (typeof st.runId !== 'number') st.runId = ev.runId;
        st.result = r;
        verifies.set(id, st);
        applyVerify(id); // also when the review card has already closed
        break;
      }
      case 'review.updated': {
        const card = reviews.get(ev.changeId);
        if (card) card.setDecisions(ev.decisions);
        break;
      }
      case 'review.closed': {
        const card = reviews.get(ev.changeId);
        if (card) card.close(ev.result);
        break;
      }
      case 'edit.applied': {
        const record = ev.record || {};
        S.undoable++;
        const runId = typeof ev.runId === 'number' ? ev.runId : typeof record.runId === 'number' ? record.runId : undefined;
        if (typeof runId === 'number') {
          const run = getRun(runId, at);
          run.appliedCount++;
          if (record.path) run.appliedPaths.add(String(record.path));
          run.applied.set(str(record.changeId) || '#' + run.applied.size, {
            path: str(record.path),
            createdFile: record.createdFile === true,
            undone: false,
            reverted: false,
            lines: appliedLines(run, record),
          });
          refreshRevert(run);
        }
        const card = reviews.get(record.changeId);
        if (card) card.applied(record);
        else looseTarget(runId, at).appendChild(appliedRow(record));
        break;
      }
      case 'edit.undone': {
        const record = ev.record || {};
        S.undoable = Math.max(0, S.undoable - 1);
        const id = str(record.changeId);
        let run = typeof record.runId === 'number' ? runs.get(record.runId) : null;
        if (!run || !run.applied.has(id)) run = Array.from(runs.values()).find((r) => r.applied.has(id)) || null;
        if (run) {
          run.applied.get(id).undone = true;
          refreshRevert(run);
        }
        const card = reviews.get(record.changeId);
        if (card) card.undone(record);
        looseTarget(undefined, at).appendChild(undoneRow(record));
        break;
      }
      case 'run.reverted': {
        const records = Array.isArray(ev.records) ? ev.records.filter((r) => r && typeof r === 'object') : [];
        S.undoable = Math.max(0, S.undoable - records.length);
        const run = typeof ev.runId === 'number' ? runs.get(ev.runId) : undefined;
        if (!run) {
          // A run this panel never showed (e.g. trimmed history): just report it.
          looseTarget(undefined, at).appendChild(revertedBanner(records));
          break;
        }
        for (const r of records) {
          const a = run.applied.get(str(r.changeId));
          if (a) a.reverted = true;
          const card = reviews.get(r.changeId);
          if (card) card.reverted();
        }
        // Only what was actually reverted is marked; a file the user chose to keep (Cancel in the
        // 'Restore?' modal) or that failed to write still has the run's edits: offer it again.
        const kept = [...liveFiles(run).keys()];
        run.reverted = kept.length === 0;
        if (run.revert) {
          if (kept.length) run.revert.retry(kept.length);
          else run.revert.done(records.length ? '' : 'Nothing to revert');
        }
        const node = revertedBanner(records, kept);
        if (run.finishCard) {
          run.finishCard.paintFiles();
          run.finishCard.el.after(node);
        } else if (run.revert) run.revert.el.after(node);
        else if (run.footEl) run.footEl.append(node);
        else looseTarget(run.id, at).appendChild(node);
        break;
      }
      case 'model.retry': {
        S.activeModel = ev.model || S.activeModel;
        const secs = (Number(ev.delayMs) || 0) / 1000;
        const delay = secs < 10 ? secs.toFixed(1) : String(Math.round(secs));
        settleRetries(); // an earlier retry ran (and failed again)
        const failed = 'Model ' + ev.model + ' failed (' + oneLine(ev.reason, 200) + ').';
        const b = banner('amber', 'warn', failed + ' Retrying in ' + delay + 's… (attempt ' + ev.attempt + ')');
        looseTarget(ev.runId, at).appendChild(b);
        // Rewritten in the past tense once the run moves on: new model output, a switch, or the end.
        const textEl = b.lastChild && b.lastChild.firstChild;
        if (textEl) {
          liveRetries.push({
            textEl,
            done: failed + ' Retried after ' + delay + 's (attempt ' + ev.attempt + ').',
            cancelled: failed + ' The run was cancelled before the retry.',
          });
        }
        break;
      }
      case 'model.fallback': {
        settleRetries();
        markSwitched(ev, at);
        noteSwitch('fallback', ev, at);
        break;
      }
      case 'model.resume': {
        settleRetries();
        markSwitched(ev, at);
        noteSwitch('resume', ev, at);
        if (typeof ev.runId === 'number' && ev.sessionId) {
          const run = getRun(ev.runId, at);
          run.sessionEl.textContent = '· TrueForge session ' + String(ev.sessionId).slice(0, 8) + ' (kept)';
          run.meta.hidden = false;
        }
        break;
      }
      case 'model.health': {
        const name = str(ev.model);
        if (!name) break;
        const latency = Number(ev.latencyMs);
        if (ev.status === 'ok') settleRetries();
        S.health.set(name, {
          status: HEALTH.includes(ev.status) ? ev.status : 'unknown',
          reason: str(ev.reason),
          retryAt: str(ev.retryAt),
          latencyMs: Number.isFinite(latency) && latency >= 0 ? latency : undefined,
        });
        break;
      }
      case 'context.usage': {
        if (typeof ev.runId !== 'number') break;
        const run = getRun(ev.runId, at);
        addUsage(run, ev);
        if (!xray.run || run.id >= xray.run.id) xray.run = run;
        if (xray.run === run) dirty.add(xray);
        break;
      }
      case 'subagent.savings': {
        const tid = str(ev.threadId);
        if (typeof ev.runId !== 'number' || !tid || tid === 'main') break;
        const run = getRun(ev.runId, at);
        const known = run.threads.has(tid);
        const th = getThread(run, tid, str(ev.title) || undefined, at);
        if (!known) finishThread(th, true, at); // reported without thread events: the sub-agent is done
        if (th.group) setSavings(th, ev);
        break;
      }
      case 'notice': {
        const kind = ev.level === 'error' ? 'red' : ev.level === 'warn' ? 'amber' : 'neutral';
        const iconName = ev.level === 'error' ? 'error' : ev.level === 'warn' ? 'warn' : 'info';
        looseTarget(ev.runId, at).appendChild(banner(kind, iconName, String(ev.text || '')));
        break;
      }
      case 'run.finished':
        settleRetries(ev.status === 'cancelled');
        finishRun(ev, at);
        break;
      default:
        break;
    }
  }

  function finishRun(ev, at) {
    const run = getRun(ev.runId, at);
    const elapsed = fmtSecs(at - run.startedAt);
    if (!run.finished) {
      run.finished = true;
      for (const th of run.threads.values()) {
        if (th.group && !th.finished) finishThread(th, false, at);
        else {
          settle(th);
          endStep(th, at, true);
        }
      }
      for (const row of run.tools.values()) row.stop();
      for (const card of run.cards) card.expire();
      const main = run.threads.get('main');
      const n = run.appliedCount;
      let node;
      if (ev.status === 'done') {
        // 3: one finish card replaces the Done banner, the X-ray summary row and the revert row.
        run.finishCard = finishCard(run, ev, elapsed);
        node = run.finishCard.el;
      } else {
        const outcome = n
          ? plural(n, 'edit') + ' accepted earlier ' + (n === 1 ? 'stays' : 'stay') + ' applied (Undo is available).'
          : 'No edits were applied; unaccepted proposals were discarded.';
        if (ev.status === 'error') {
          node = banner('red', 'error', 'Run failed after ' + elapsed, [ev.message || '', outcome]);
        } else {
          node = banner('neutral', 'stopCircle', 'Cancelled after ' + elapsed, [ev.message && ev.message !== 'Cancelled.' ? ev.message : '', outcome]);
        }
      }
      main.body.appendChild(node);
      // Run footer (error / cancelled): context X-ray totals and 'Revert this run (N files)'.
      if (run.ctx.calls && !run.finishCard) paintXraySum(run);
      refreshRevert(run);
      for (const [id, st] of verifies) {
        if (st.runId === run.id && !st.result && !st.stale) {
          st.stale = true;
          applyVerify(id);
        }
      }
    }
    if (ev.model) {
      S.activeModel = ev.model;
      run.modelEl.textContent = ev.model;
    }
    if (lastRun === run) {
      S.running = false;
      S.lastError = ev.status === 'error';
    }
    clearCancel();
    renderComposer();
  }

  // ---------------------------------------------------------------- header

  let headerSig = '';
  function renderHeader() {
    const sig = JSON.stringify([
      S.models,
      S.activeModel,
      Array.from(S.failed),
      S.fellBack,
      S.running,
      S.lastError,
      S.session,
      S.undoable,
      Array.from(S.health),
    ]);
    if (sig === headerSig) return;
    headerSig = sig;

    const status = S.running ? 'running' : S.lastError ? 'error' : 'idle';
    ui.dot.className = 'status-dot ' + status;
    ui.dot.title = status === 'running' ? 'Running' : status === 'error' ? 'Last run failed' : 'Idle';
    updateStatusText();

    const chain = S.models.slice();
    if (S.activeModel && !chain.includes(S.activeModel)) chain.push(S.activeModel);
    const active = S.activeModel || chain[0];
    ui.chain.replaceChildren();
    if (chain.length === 0) ui.chain.append(el('span', 'model', 'no models configured'));
    chain.forEach((name, i) => {
      if (i > 0) ui.chain.append(el('span', 'chain-arrow', '→'));
      const h = S.health.get(name);
      const hs = h ? h.status : 'unknown';
      const chip = el('span', 'model h-' + hs + (name === active ? ' active' : '') + (S.failed.has(name) ? ' failed' : ''));
      // Feature 3: health dot per model (ok / down / skipped by the circuit breaker / unknown).
      chip.append(el('span', 'hdot ' + hs));
      const nameEl = el('span', 'mname');
      const slash = name.lastIndexOf('/');
      if (slash > 0) nameEl.append(el('span', 'prov', name.slice(0, slash + 1)), name.slice(slash + 1));
      else nameEl.textContent = name;
      chip.append(nameEl);
      const retry = h ? fmtClock(h.retryAt) : '';
      if (hs === 'down') chip.append(el('span', 'hnote', retry ? 'down · retry ' + retry : 'down'));
      else if (hs === 'skipped') chip.append(el('span', 'hnote', retry ? 'skipped · retry ' + retry : 'skipped'));
      chip.title =
        name + (i === 0 ? ' (primary)' : ' (fallback ' + i + ')') + (S.failed.has(name) ? ' — failed' : '') + '\nHealth: ' + healthTitle(h);
      ui.chain.append(chip);
    });
    if (S.fellBack) ui.chain.append(el('span', 'fallback-badge', '↪ fallback'));

    ui.openSession.hidden = !S.session;
    ui.undo.replaceChildren(ic('undo'), el('span', 'wide', 'Undo'));
    if (S.undoable > 0) ui.undo.append(el('span', 'count-badge', S.undoable));
  }

  function updateStatusText() {
    // The '.wide' prefixes are hidden in narrow sidebars; the dot color still carries the status.
    if (S.running) ui.statusText.replaceChildren(el('span', 'wide', 'Running · '), fmtSecs(Date.now() - S.runStartedAt));
    else if (S.lastError) ui.statusText.replaceChildren(el('span', 'wide', 'Last run '), 'failed');
    else ui.statusText.textContent = 'Idle';
  }

  setInterval(() => {
    if (S.running) updateStatusText();
  }, 1000);

  const EXAMPLES = [
    'Explain how this project is organised and where its entry points are',
    'Find a function without tests and add a focused test for it',
    'Look for an unhandled error path and propose a fix with a test',
  ];

  /** The welcome screen's status row (rebuilt on every state message). */
  let connRow = null;

  /**
   * 6a: brand, one line, example prompts, live status of the three parts, the keys. Built once,
   * so a state message does not take keyboard focus away from an example button; only the status
   * row is repainted.
   */
  function renderEmpty() {
    const box = ui.empty;
    if (!connRow) buildEmpty(box);
    paintConn();
  }

  function buildEmpty(box) {
    box.replaceChildren();
    const hero = el('div', 'hero');
    const mark = el('span', 'brand-mark big');
    mark.append(ic('logo'));
    const words = el('div');
    words.append(el('h2', '', 'Forgelight'), el('p', '', 'A coding agent on TrueForge. You see what it reads and approve every hunk before it touches disk.'));
    hero.append(mark, words);
    box.append(hero);

    const ex = el('div', 'examples');
    ex.append(el('div', 'examples-label', 'Try'));
    for (const text of EXAMPLES) {
      const b = button('', 'example', () => {
        ui.input.value = text;
        autosize();
        saveDraft();
        renderComposer();
        ui.input.focus();
        ui.input.setSelectionRange(text.length, text.length);
      }, 'Put this in the input (it is not sent)');
      b.append(ic('chev', 'chev'), el('span', '', text));
      ex.append(b);
    }
    box.append(ex);

    connRow = el('div', 'conn-row');
    box.append(connRow);

    const keys = el('div', 'keys-row');
    const key = (k, text) => {
      const s = el('span');
      s.append(el('kbd', '', k), ' ' + text);
      keys.append(s);
    };
    key(isMac ? '⌥⌘/' : 'Ctrl+Alt+/', 'all actions and keys');
    key(isMac ? '⌥⌘E' : 'Ctrl+Alt+E', 'edit the selection');
    key(isMac ? '⌥⌘X' : 'Ctrl+Alt+X', 'check a function');
    key('Esc', 'cancel');
    key('@', 'mention a file');
    box.append(keys);
  }

  function paintConn() {
    // Green only for what the host really reports; otherwise a neutral dot.
    const primary = S.models[0] || '';
    const h = primary ? S.health.get(primary) : null;
    const status = connRow;
    status.replaceChildren();
    const part = (label, state, tip) => {
      const p = el('span', 'conn-part');
      p.append(el('span', 'hdot ' + state), label);
      p.title = tip;
      status.append(p);
    };
    part('TrueForge', S.session ? 'ok' : 'unknown', (S.trueforgeUrl || 'no address') + (S.session ? ' · a session was created' : ' · connects on the first request'));
    part('Editor tools', S.mcpUrl ? 'ok' : 'unknown', S.mcpUrl ? 'MCP server listening at ' + S.mcpUrl : 'MCP server not reported yet');
    part(
      'Model',
      h ? (h.status === 'ok' ? 'ok' : h.status === 'down' ? 'down' : h.status === 'skipped' ? 'skipped' : 'unknown') : 'unknown',
      primary ? primary + ' · ' + healthTitle(h) : 'No model configured (setting forgelight.models)',
    );
  }

  // -------------------------------------------------------------- composer

  const saved = vscode.getState() || {};
  let lastSent = typeof saved.lastSent === 'string' ? saved.lastSent : '';
  ui.input.value = typeof saved.draft === 'string' ? saved.draft : '';
  /** Per-view preferences kept in the webview state (the X-ray strip open or closed). */
  const prefs = { xrayOpen: saved.xrayOpen === true, xrayAutoOpened: saved.xrayAutoOpened === true };

  function persist() {
    vscode.setState({ draft: ui.input.value, lastSent, xrayOpen: prefs.xrayOpen, xrayAutoOpened: prefs.xrayAutoOpened });
  }

  function saveDraft() {
    persist();
  }

  function autosize() {
    ui.input.style.height = 'auto';
    ui.input.style.height = Math.min(ui.input.scrollHeight, 160) + 'px';
  }

  function renderComposer() {
    const running = S.running;
    // 5: the busy bar under the header and the breathing input box follow this class.
    document.body.classList.toggle('fl-running', running);
    ui.send.classList.toggle('cancel', running);
    ui.send.replaceChildren(
      ic(running ? 'stop' : 'send', running ? 'fill' : ''),
      running ? (S.cancelRequested ? 'Cancelling…' : 'Cancel') : 'Send',
    );
    ui.send.title = running ? 'Cancel the run (Esc)' : 'Send (Enter)';
    ui.send.disabled = running ? S.cancelRequested : !ui.input.value.trim();
  }

  function sendMessage() {
    const text = ui.input.value.trim();
    if (!text || S.running) return;
    post({ type: 'send', text });
    lastSent = text;
    ui.input.value = '';
    autosize();
    saveDraft();
    stick = true;
    renderComposer();
  }

  function cancelRun() {
    if (!S.running || S.cancelRequested) return;
    post({ type: 'cancel' });
    S.cancelRequested = true;
    clearTimeout(S.cancelTimer);
    // Re-arm the button if the run somehow keeps going.
    S.cancelTimer = setTimeout(() => {
      S.cancelRequested = false;
      renderComposer();
    }, 4000);
    renderComposer();
  }

  function clearCancel() {
    S.cancelRequested = false;
    clearTimeout(S.cancelTimer);
  }

  function onState(m) {
    S.running = !!m.running;
    S.models = Array.isArray(m.models) ? m.models.map(String) : [];
    S.trueforgeUrl = typeof m.trueforgeUrl === 'string' ? m.trueforgeUrl : '';
    S.mcpUrl = typeof m.mcpUrl === 'string' ? m.mcpUrl : '';
    if (!S.running) clearCancel();
    else if (!S.runStartedAt) S.runStartedAt = Date.now();
    renderComposer();
    renderEmpty();
  }

  ui.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      sendMessage();
    } else if (e.key === 'Escape' && S.running) {
      e.preventDefault();
      cancelRun();
    } else if (e.key === 'ArrowUp' && !ui.input.value && lastSent) {
      e.preventDefault();
      ui.input.value = lastSent;
      autosize();
      renderComposer();
    }
  });
  ui.input.addEventListener('input', () => {
    autosize();
    saveDraft();
    renderComposer();
  });
  ui.send.addEventListener('click', () => (S.running ? cancelRun() : sendMessage()));
  ui.openSession.addEventListener('click', () => post({ type: 'openSession' }));
  ui.undo.addEventListener('click', () => post({ type: 'undo' }));

  // ------------------------------------------------------------------ init

  ui.mark.append(ic('logo'));
  // Feature 4: the Context X-ray strip lives in the (non-scrolling) header, hidden until the first usage.
  xray.el.hidden = true;
  if (prefs.xrayOpen) xray.el.classList.add('open');
  const headerEl = document.getElementById('header') || document.body;
  headerEl.appendChild(xray.el);
  // 5: a thin bar under the header slides while a run is active.
  headerEl.appendChild(el('div', 'busy-bar'));
  armAnim();
  ui.openSession.append(ic('external'), el('span', 'wide', 'Open in '), 'TrueForge');
  const kbd = (t) => el('kbd', '', t);
  const hint = (keys, text) => {
    const s = el('span');
    s.append(kbd(keys), ' ' + text);
    ui.hint.append(s);
  };
  hint('Enter', 'send');
  hint('Shift+Enter', 'newline');
  hint('Esc', 'cancel');
  hint(isMac ? '⌥⌘E' : 'Ctrl+Alt+E', 'inline edit');
  hint(isMac ? '⌥⌘/' : 'Ctrl+Alt+/', 'all keys');

  renderEmpty();
  renderHeader();
  renderComposer();
  autosize();
  post({ type: 'ready' });
})();
