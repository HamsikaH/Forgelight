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

  /** Make `root` expandable via `trigger` (toggles the 'open' class). */
  function makeToggle(root, trigger, onOpen) {
    const flip = () => {
      const open = !root.classList.contains('open');
      root.classList.toggle('open', open);
      trigger.setAttribute('aria-expanded', String(open));
      if (open && onOpen) onOpen();
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

  /** Inline markdown on raw text: escapes first, then `code` and **bold**. */
  function mdInline(text) {
    const spans = [];
    let s = escapeHtml(text).replace(/`([^`\n]+)`/g, (_, c) => {
      spans.push(c);
      return '\u0000' + (spans.length - 1) + '\u0000';
    });
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, n) => '<code>' + (spans[Number(n)] || '') + '</code>');
  }

  /** Safe light markdown: fences, headings (as bold lines), bullet/numbered lists, paragraphs, line breaks. */
  function renderMarkdown(src) {
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    let list = null;
    const flushPara = () => {
      if (para.length) out.push('<p>' + para.map(mdInline).join('<br>') + '</p>');
      para = [];
    };
    const flushList = () => {
      // Keep the source numbering ("2." after nested bullets stays 2, as in CommonMark).
      const start = list && list.type === 'ol' && list.start > 1 ? ' start="' + list.start + '"' : '';
      if (list) out.push('<' + list.type + start + '>' + list.items.map((t) => '<li>' + mdInline(t) + '</li>').join('') + '</' + list.type + '>');
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
      const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
      if (heading) {
        flushPara();
        flushList();
        out.push('<div class="md-h">' + mdInline(heading[1]) + '</div>');
        continue;
      }
      const item = /^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
      if (item) {
        flushPara();
        const type = /\d/.test(item[1]) ? 'ol' : 'ul';
        if (!list || list.type !== type) {
          flushList();
          list = { type, items: [], start: type === 'ol' ? parseInt(item[1], 10) || 1 : 1 };
        }
        list.items.push(item[2]);
        continue;
      }
      if (list && /^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += ' ' + line.trim();
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
    };
    run.threads.set('main', newThread('main', body, null));
    runs.set(runId, run);
    if (!lastRun || runId >= lastRun.id) lastRun = run;
    ui.empty.hidden = true;
    return run;
  }

  function newThread(id, body, group) {
    return { id, body, group, statusEl: null, titleEl: null, messages: new Map(), reasoning: new Map(), activeText: null, activeReasoning: null, finished: false };
  }

  function getThread(run, threadId, title) {
    const tid = threadId || 'main';
    let th = run.threads.get(tid);
    if (th) return th;
    const main = run.threads.get('main');
    settle(main);
    const group = el('div', 'group open');
    const head = el('div', 'group-head');
    const iconWrap = el('span', 'tool-icon');
    iconWrap.append(ic('branch'));
    const titleEl = el('span', 'group-title', title || tid);
    const statusEl = el('span', 'tool-status');
    statusEl.append(el('span', 'spinner'));
    head.append(ic('chev', 'chev'), iconWrap, el('span', 'group-kind', 'Subagent'), titleEl, statusEl);
    const body = el('div', 'thread-body');
    group.append(head, body);
    makeToggle(group, head);
    main.body.appendChild(group);
    th = newThread(tid, body, group);
    th.titleEl = titleEl;
    th.statusEl = statusEl;
    run.threads.set(tid, th);
    return th;
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

  function finishThread(th, completed) {
    settle(th);
    th.finished = true;
    if (th.group && th.statusEl) {
      th.group.classList.add('done');
      th.statusEl.replaceChildren(ic(completed ? 'check' : 'dash'));
    }
  }

  /** Where run-less rows (notices, undo) go: the latest run, or the top level. */
  function looseTarget(runId, at) {
    if (typeof runId === 'number') {
      const run = getRun(runId, at);
      const main = run.threads.get('main');
      settle(main);
      return main.body;
    }
    if (lastRun) {
      settle(lastRun.threads.get('main'));
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
    settle(main);
    main.body.appendChild(node);
  }

  // ---------------------------------------------------------------- blocks

  function userMessage(text, mode) {
    const box = el('div', 'user-msg');
    if (mode === 'inline') box.append(el('span', 'mode', 'Inline edit'));
    const re = /(^|\s)(@[\w./:\-]+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      const start = m.index + m[1].length;
      if (start > last) box.append(text.slice(last, start));
      box.append(el('span', 'mention', m[2]));
      last = start + m[2].length;
    }
    if (last < text.length) box.append(text.slice(last));
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
        root.classList.remove('pending');
        root.classList.add(failed ? 'failed' : declined ? 'stopped' : 'done');
        status.replaceChildren(ic(failed ? 'x' : declined ? 'dash' : 'check'));
        resultLine.textContent = line ? '↳ ' + line : '↳ (no output)';
        resultLine.hidden = false;
        if (root.classList.contains('open')) renderDetail();
      },
      stop() {
        if (this.done) return;
        this.done = true;
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
    cwd.append('in ', code(ev.cwd || '.'));
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
    card.append(head, body, foot);
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
      paint();
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
        card.append(appliedRow(record));
      },
      undone(record) {
        undoneBadge.textContent = 'Undone';
        undoneBadge.hidden = false;
        card.append(undoneRow(record));
      },
      reverted() {
        undoneBadge.textContent = 'Reverted';
        undoneBadge.hidden = false;
      },
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
      settle(main);
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
      runFoot(run).append(run.revert.el);
    }
    if (!run.reverted) run.revert.update(n);
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

  /** Sticky strip under the header: the latest main-thread call of the current run. */
  const xray = {
    el: el('div', 'xray open'),
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
        head.append(el('span', 'xray-wait', 'waiting for the first model call…'));
      } else {
        const numEl = el('span', 'xray-num');
        let pct = 0;
        if (call.contextLength) {
          pct = (call.total / call.contextLength) * 100;
          numEl.append(el('strong', '', fmtInt(call.total)), ' / ' + fmtInt(call.contextLength) + ' tokens (' + fmtPct(pct) + ')');
        } else {
          numEl.append(el('strong', '', fmtInt(call.total)), ' tokens in');
        }
        numEl.classList.toggle('warn', pct >= 75 && pct < 90);
        numEl.classList.toggle('full', pct >= 90);
        // The strip follows the main agent; name the thread only while it shows a sub-agent's call.
        if (call.threadId !== 'main') head.append(el('span', 'xray-thread', call.title));
        head.append(numEl);
        head.title = 'Latest ' + call.title + ' call' + (call.model ? ' on ' + call.model : '') + ' · ' + fmtInt(call.output) + ' output tokens';

        const bar = el('div', 'xray-bar' + (call.contextLength ? '' : ' nolimit'));
        const denom = call.contextLength ? Math.max(call.contextLength, call.total) : Math.max(1, call.total);
        for (const s of call.segments) {
          const seg = el('span');
          seg.style.width = ((s.tokens / denom) * 100).toFixed(2) + '%';
          seg.style.background = s.color;
          seg.title = s.label + ': ' + fmtInt(s.tokens) + ' tokens';
          bar.append(seg);
        }
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
      makeToggle(root, head);
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
    switch (ev.type) {
      case 'run.started': {
        const run = getRun(ev.runId, at);
        run.startedAt = at;
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
        run.sessionEl.title = ev.sessionUrl || '';
        run.meta.hidden = false;
        break;
      }
      case 'assistant.delta': {
        const th = getThread(getRun(ev.runId, at), ev.threadId);
        let block = th.messages.get(ev.messageId);
        if (!block) {
          settle(th);
          block = textBlock();
          th.messages.set(ev.messageId, block);
          th.body.appendChild(block.el);
          th.activeText = block;
        }
        block.raw += ev.text || '';
        dirty.add(block);
        break;
      }
      case 'reasoning.delta': {
        const th = getThread(getRun(ev.runId, at), ev.threadId);
        let block = th.reasoning.get(ev.messageId);
        if (!block) {
          settle(th);
          block = reasoningBlock();
          th.reasoning.set(ev.messageId, block);
          th.body.appendChild(block.el);
          th.activeReasoning = block;
        }
        block.raw += ev.text || '';
        block.pending += ev.text || '';
        dirty.add(block);
        break;
      }
      case 'tool.call': {
        const run = getRun(ev.runId, at);
        const th = getThread(run, ev.threadId);
        const existing = run.tools.get(ev.toolCallId);
        if (existing) {
          existing.setArgs(ev.argsPreview);
          break;
        }
        settle(th);
        const row = toolRow(ev.name, ev.argsPreview);
        run.tools.set(ev.toolCallId, row);
        th.body.appendChild(row.el);
        break;
      }
      case 'tool.result': {
        const run = getRun(ev.runId, at);
        let row = run.tools.get(ev.toolCallId);
        if (!row) {
          const th = getThread(run, ev.threadId);
          settle(th);
          row = toolRow('tool', '');
          run.tools.set(ev.toolCallId, row);
          th.body.appendChild(row.el);
        }
        row.setResult(ev.preview);
        break;
      }
      case 'thread.started': {
        const th = getThread(getRun(ev.runId, at), ev.threadId, ev.title);
        if (th.titleEl && ev.title) th.titleEl.textContent = ev.title;
        break;
      }
      case 'thread.finished': {
        const run = getRun(ev.runId, at);
        const th = run.threads.get(ev.threadId || 'main');
        if (th && th.group) finishThread(th, true);
        break;
      }
      case 'context.picked': {
        const run = getRun(ev.runId, at);
        placeCard(run, 'retrieve_context', contextCard(ev.pick || {}));
        break;
      }
      case 'approval.command': {
        const run = getRun(ev.runId, at);
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
        if (run.revert) run.revert.el.after(node);
        else if (run.footEl) run.footEl.append(node);
        else looseTarget(run.id, at).appendChild(node);
        break;
      }
      case 'model.retry': {
        S.activeModel = ev.model || S.activeModel;
        const secs = (Number(ev.delayMs) || 0) / 1000;
        const delay = secs < 10 ? secs.toFixed(1) : String(Math.round(secs));
        looseTarget(ev.runId, at).appendChild(
          banner(
            'amber',
            'warn',
            'Model ' + ev.model + ' failed (' + oneLine(ev.reason, 200) + '). Retrying in ' + delay + 's… (attempt ' + ev.attempt + ')',
          ),
        );
        break;
      }
      case 'model.fallback': {
        markSwitched(ev, at);
        noteSwitch('fallback', ev, at);
        break;
      }
      case 'model.resume': {
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
        const th = getThread(run, tid, str(ev.title) || undefined);
        if (!known) finishThread(th, true); // reported without thread events: the sub-agent is done
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
        if (th.group && !th.finished) finishThread(th, false);
        else settle(th);
      }
      for (const row of run.tools.values()) row.stop();
      for (const card of run.cards) card.expire();
      const main = run.threads.get('main');
      const paths = Array.from(run.appliedPaths);
      const n = run.appliedCount;
      let node;
      if (ev.status === 'done') {
        const changed = paths.length ? 'Changed ' + plural(paths.length, 'file') + ': ' + paths.join(', ') : 'No edits applied';
        node = banner('green', 'check', 'Done in ' + elapsed + (ev.model ? ' · ' + ev.model : ''), [changed, ev.message || '']);
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
      // Run footer: context X-ray totals and 'Revert this run (N files)'.
      if (run.ctx.calls) paintXraySum(run);
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

  function renderEmpty() {
    const box = ui.empty;
    box.replaceChildren();
    box.append(el('h2', '', 'Forgelight'));
    box.append(
      el(
        'p',
        '',
        'A coding agent whose loop runs on TrueForge. It shows every file it reads and why, and every hunk it wants to write, before anything touches disk.',
      ),
    );
    const ul = el('ul');
    const item = (title, parts) => {
      const li = el('li');
      li.append(el('strong', '', title + ' '));
      for (const p of parts) li.append(p);
      ul.append(li);
    };
    item('Agent:', ['describe a change below. Forgelight gathers context, edits across files and asks you to review each hunk.']);
    item('Inline edit:', ['select code and press ', el('kbd', '', isMac ? '⌘⌥E' : 'Ctrl+Alt+E'), '.']);
    item('Context:', ['mention ', code('@path/to/file.py'), ' or ', code('@symbol'), '.']);
    item('Undo:', ['every applied change can be undone from the header.']);
    box.append(ul);
    const conn = el('div', 'conn');
    conn.append(el('span', '', 'TrueForge'), code(S.trueforgeUrl || '—'));
    if (S.mcpUrl) conn.append(el('span', '', 'Editor MCP'), code(S.mcpUrl));
    conn.append(el('span', '', 'Models'), code(S.models.length ? S.models.join(' → ') : '—'));
    box.append(conn);
  }

  // -------------------------------------------------------------- composer

  const saved = vscode.getState() || {};
  let lastSent = typeof saved.lastSent === 'string' ? saved.lastSent : '';
  ui.input.value = typeof saved.draft === 'string' ? saved.draft : '';

  function saveDraft() {
    vscode.setState({ draft: ui.input.value, lastSent });
  }

  function autosize() {
    ui.input.style.height = 'auto';
    ui.input.style.height = Math.min(ui.input.scrollHeight, 160) + 'px';
  }

  function renderComposer() {
    const running = S.running;
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
  (document.getElementById('header') || document.body).appendChild(xray.el);
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
  hint(isMac ? '⌘⌥E' : 'Ctrl+Alt+E', 'inline edit on a selection');

  renderEmpty();
  renderHeader();
  renderComposer();
  autosize();
  post({ type: 'ready' });
})();
