/**
 * Agent panel: a sidebar webview that renders the ForgeEvent stream (transcript, context card,
 * hunk review, approvals, fallback banners) and forwards user actions to the extension.
 */
import * as vscode from 'vscode';
import type { ApplyRecord, CommandDecision, ExtensionToPanel, ForgeEvent, PanelToExtension } from '../contracts';
import type { ForgeEventBus } from '../events';

export interface PanelState {
  running: boolean;
  models: string[];
  trueforgeUrl: string;
  mcpUrl?: string;
}

export interface PanelHandlers {
  onMessage(msg: PanelToExtension): void | Promise<void>;
}

/** Event plus the time it was emitted, so replayed transcripts keep real elapsed times. */
interface HistoryEntry {
  event: ForgeEvent;
  at: number;
}

/** Wire format: ExtensionToPanel, with an extra emit timestamp on events (read by media/panel.js). */
type OutgoingMessage = ExtensionToPanel | (Extract<ExtensionToPanel, { type: 'event' }> & { at: number });

const MAX_HISTORY = 2000;
/** Trim in chunks so a long stream does not splice the array on every event. */
const TRIM_SLACK = 200;
const COMMAND_DECISIONS: readonly CommandDecision[] = ['once', 'tenMinutes', 'deny'];

export class AgentPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'forgelight.panel';

  private view: vscode.WebviewView | undefined;
  private viewDisposables: vscode.Disposable[] = [];
  /** True once the current webview document posted {type:'ready'}. */
  private ready = false;
  private readonly history: HistoryEntry[] = [];
  private readonly unsubscribe: () => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly bus: ForgeEventBus,
    private readonly handlers: PanelHandlers,
    private readonly getState: () => PanelState,
  ) {
    this.unsubscribe = bus.on((event) => this.onEvent(event));
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    for (const d of this.viewDisposables) d.dispose();
    this.viewDisposables = [];
    this.view = webviewView;
    this.ready = false;

    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    webviewView.webview.html = this.renderHtml(webviewView.webview, mediaRoot);

    this.viewDisposables.push(
      webviewView.webview.onDidReceiveMessage((raw: unknown) => this.onWebviewMessage(raw)),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined;
          this.ready = false;
        }
      }),
    );
  }

  /** Show and focus the panel (resolving it first if it was never opened). */
  async reveal(preserveFocus = false): Promise<void> {
    if (this.view && preserveFocus) {
      this.view.show(true);
      return;
    }
    try {
      await vscode.commands.executeCommand(`${AgentPanelProvider.viewId}.focus`);
    } catch {
      await vscode.commands.executeCommand('workbench.view.extension.forgelight');
    }
    // An unresolved view can only be opened by focusing it; hand focus back to the editor.
    if (preserveFocus) await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup').then(undefined, () => undefined);
  }

  /** Push the current header/composer state (running, model chain, URLs) to the webview. */
  postState(): void {
    if (!this.ready) return;
    this.post({ type: 'state', ...this.getState() });
  }

  dispose(): void {
    this.unsubscribe();
    for (const d of this.viewDisposables) d.dispose();
    this.viewDisposables = [];
    this.view = undefined;
    this.ready = false;
  }

  private onEvent(event: ForgeEvent): void {
    const entry = this.record(event);
    if (this.ready) this.post({ type: 'event', event: slimEvent(event), at: entry.at });
  }

  /** Append to the replay history, merging consecutive deltas of the same message. */
  private record(event: ForgeEvent): HistoryEntry {
    const at = Date.now();
    const last = this.history[this.history.length - 1];
    if (
      last &&
      (event.type === 'assistant.delta' || event.type === 'reasoning.delta') &&
      last.event.type === event.type &&
      last.event.runId === event.runId &&
      last.event.threadId === event.threadId &&
      last.event.messageId === event.messageId
    ) {
      last.event = { ...last.event, text: last.event.text + event.text };
      return last;
    }
    const entry: HistoryEntry = { event: slimEvent(event), at };
    this.history.push(entry);
    if (this.history.length > MAX_HISTORY + TRIM_SLACK) this.trimHistory();
    return entry;
  }

  /** Drop the oldest events, preferring to cut at a run boundary so no run is half-replayed. */
  private trimHistory(): void {
    let cut = this.history.length - MAX_HISTORY;
    const nextRun = this.history.findIndex((e, i) => i >= cut && e.event.type === 'run.started');
    if (nextRun > 0 && nextRun < this.history.length - 1) cut = nextRun;
    this.history.splice(0, cut);
  }

  private replay(): void {
    this.post({ type: 'state', ...this.getState() });
    for (const { event, at } of this.history) this.post({ type: 'event', event, at });
    // State again so `running` reflects now, not the replayed run.started/run.finished sequence.
    this.post({ type: 'state', ...this.getState() });
  }

  private onWebviewMessage(raw: unknown): void {
    const msg = parsePanelMessage(raw);
    if (!msg) return;
    if (msg.type === 'ready') {
      this.ready = true;
      this.replay();
    }
    if (msg.type === 'copy') {
      // The webview's own clipboard API is not reliable in every VS Code version.
      void Promise.resolve(vscode.env.clipboard.writeText(msg.text)).catch(() => undefined);
      return;
    }
    // Catches both synchronous throws and rejected promises from the handler.
    Promise.resolve()
      .then(() => this.handlers.onMessage(msg))
      .catch((err: unknown) => this.reportHandlerError(msg, err));
  }

  private reportHandlerError(msg: PanelToExtension, err: unknown): void {
    const text = err instanceof Error ? err.message : String(err);
    this.bus.emit({ type: 'notice', level: 'error', text: `Panel action "${msg.type}" failed: ${text}` });
  }

  private post(msg: OutgoingMessage): void {
    const view = this.view;
    if (!view) return;
    // postMessage rejects if the webview was disposed meanwhile; the next 'ready' replays anyway.
    Promise.resolve(view.webview.postMessage(msg)).catch(() => undefined);
  }

  private renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = makeNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.js'));
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Forgelight</title>
</head>
<body data-platform="${process.platform}">
<div id="app">
  <header id="header">
    <div class="hdr-row">
      <span class="brand"><span class="brand-mark" id="brand-mark"></span>Forgelight</span>
      <span id="status-dot" class="status-dot idle" title="Idle"></span>
      <span id="status-text" class="status-text">Idle</span>
      <span class="spacer"></span>
      <button id="open-session" class="link-btn" hidden title="Open the current session in TrueForge"></button>
      <button id="undo" class="icon-btn" title="Undo the last applied change"></button>
    </div>
    <div class="hdr-row chain-row">
      <span class="chain-label">Models</span>
      <span id="model-chain" class="model-chain"></span>
    </div>
  </header>
  <main id="transcript">
    <section id="empty" class="empty"></section>
    <div id="log"></div>
    <button id="jump" class="jump" type="button" hidden>&#8595; Jump to latest</button>
  </main>
  <footer id="composer">
    <div class="composer-box">
      <textarea id="input" rows="1" placeholder="Ask Forgelight… use @path/to/file.py or @symbol to add context" aria-label="Message Forgelight"></textarea>
      <button id="send" class="send-btn" title="Send (Enter)"></button>
    </div>
    <div id="hint" class="hint"></div>
  </footer>
</div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

/**
 * Drop payload the panel never shows: the packed context text and the full before/after file texts
 * of apply records (each can be tens of KB, and a run.reverted carries one per applied change).
 */
function slimEvent(event: ForgeEvent): ForgeEvent {
  if (event.type === 'context.picked') return { ...event, pick: { ...event.pick, packedText: '' } };
  if (event.type === 'edit.applied' || event.type === 'edit.undone') return { ...event, record: slimRecord(event.record) };
  if (event.type === 'run.reverted') return { ...event, records: Array.isArray(event.records) ? event.records.map(slimRecord) : [] };
  return event;
}

function slimRecord(record: ApplyRecord): ApplyRecord {
  return { ...record, beforeText: '', afterText: '' };
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

/** Validate a message from the webview against the PanelToExtension contract. */
function parsePanelMessage(raw: unknown): PanelToExtension | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const verdict = (v: unknown): v is 'accepted' | 'rejected' => v === 'accepted' || v === 'rejected';
  switch (m.type) {
    case 'ready':
    case 'cancel':
    case 'openSession':
    case 'undo':
      return { type: m.type };
    case 'send':
      return typeof m.text === 'string' && m.text.trim() ? { type: 'send', text: m.text } : undefined;
    case 'approveCommand':
      return str(m.requestId) && COMMAND_DECISIONS.includes(m.decision as CommandDecision)
        ? { type: 'approveCommand', requestId: m.requestId, decision: m.decision as CommandDecision }
        : undefined;
    case 'hunk':
      return str(m.changeId) && Number.isInteger(m.index) && verdict(m.decision)
        ? { type: 'hunk', changeId: m.changeId, index: m.index as number, decision: m.decision }
        : undefined;
    case 'reviewAll':
      return str(m.changeId) && verdict(m.decision) ? { type: 'reviewAll', changeId: m.changeId, decision: m.decision } : undefined;
    case 'applyReview':
      return str(m.changeId) ? { type: 'applyReview', changeId: m.changeId } : undefined;
    case 'revertRun':
      return Number.isInteger(m.runId) ? { type: 'revertRun', runId: m.runId as number } : undefined;
    case 'copy':
      return typeof m.text === 'string' && m.text.length > 0 && m.text.length <= 100_000 ? { type: 'copy', text: m.text } : undefined;
    default:
      return undefined;
  }
}
