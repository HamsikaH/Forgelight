/**
 * Forgelight extension entry point: wires the event bus, context engine, review UI, editor MCP
 * server, TrueForge registration, agent runner, agent panel and inline edit together.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ApplyRecord, ForgeConfig, ForgeEvent, PanelToExtension, ProposedChange, ReviewResult, RunOutcome, RunRequest } from './contracts';
import { RepoContextEngine } from './context/retrieval';
import { DecisionStore, RunTracker } from './decisions';
import { ForgeEventBus } from './events';
import { registerFunctionAsk } from './assist/functionAsk';
import { registerInstantChecks } from './assist/instantChecks';
import { registerMenu } from './assist/menu';
import { registerInlineEdit } from './inline/inlineEdit';
import { EditorMcpServer, type EditorMcpEndpoint } from './mcp/server';
import { AgentPanelProvider } from './panel/agentPanel';
import { computeHunks } from './review/hunks';
import { ReviewController, type RunRevertReport } from './review/reviewController';
import { CommandGuard } from './safety/commandGuard';
import { AgentRunner } from './trueforge/runner';
import { TrueForgeSetup, type AgentDefinition } from './trueforge/setup';
import { ShadowVerifier } from './verify/shadow';
import { PanelCommandGate, VscodeWorkspaceIO, readConfig } from './vscodeHost';

const RUNNING_KEY = 'forgelight.running';
const INVALIDATE_DEBOUNCE_MS = 750;
const CANCEL_HINT = process.platform === 'darwin' ? 'Esc or ⌘⌥⌫' : 'Esc or Ctrl+Alt+Backspace';

let instance: Forgelight | undefined;

/** Returned from activate() so integration tests can start a run without the UI. */
export interface ForgelightApi {
  run(req: RunRequest): Promise<StartResult>;
  /**
   * Integration tests only (no model involved): review `proposedText` for a file hunk by hunk, the
   * same way propose_edit is reviewed, then apply the accepted hunks. `id` is the change id the
   * forgelight.acceptHunk / rejectHunk commands take. `runId` (default 0) is the run the applied
   * change is recorded under; a file that does not exist yet is proposed as a new file.
   */
  reviewProposal(opts: ReviewProposalOptions): Promise<ReviewProposalResult>;
  /**
   * Feature 2: revert every file a run changed (default: the newest run with applied edits, like
   * 'Forgelight: Revert Last Run'). Resolves with the records reverted, newest first.
   */
  revertRun(runId?: number): Promise<ApplyRecord[]>;
}

export interface ReviewProposalOptions {
  id: string;
  absPath: string;
  proposedText: string;
  runId?: number;
}

export interface ReviewProposalResult {
  hunks: number;
  result: ReviewResult;
  record?: ApplyRecord;
}

export async function activate(context: vscode.ExtensionContext): Promise<ForgelightApi | undefined> {
  try {
    const f = new Forgelight(context);
    instance = f;
    await f.start();
    return {
      run: (req) => f.startRun(req),
      reviewProposal: (opts) => f.reviewProposal(opts),
      revertRun: (runId) => f.revertRun(runId ?? f.lastRunWithEdits, false),
    };
  } catch (err) {
    void vscode.window.showErrorMessage(`Forgelight failed to start: ${errText(err)}`);
    return undefined;
  }
}

export async function deactivate(): Promise<void> {
  const f = instance;
  instance = undefined;
  await f?.shutdown();
}

interface Registration {
  trueforgeUrl: string;
  mcpUrl: string;
  token: string;
  tools: string[];
  missingModels: string[];
}

export type StartResult = { outcome: RunOutcome } | { error: string };

class Forgelight {
  private readonly output = vscode.window.createOutputChannel('Forgelight');
  private readonly bus = new ForgeEventBus();
  private readonly decisions = new DecisionStore();
  private readonly runs = new RunTracker();
  private readonly io = new VscodeWorkspaceIO();
  private readonly contextEngine = new RepoContextEngine(this.io);
  private readonly review = new ReviewController(this.bus);
  private readonly commandGate: PanelCommandGate;
  private readonly mcp: EditorMcpServer;
  private readonly runner: AgentRunner;
  private readonly panel: AgentPanelProvider;

  private setup: TrueForgeSetup;
  private agentDef: AgentDefinition | undefined;
  private inlineDef: AgentDefinition | undefined;
  private registered: Registration | undefined;
  private inflight: Promise<Registration> | undefined;
  /** True from a start request until its run settles (covers the registration step). */
  private busy = false;
  private readonly invalidateTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.setup = new TrueForgeSetup(readConfig().trueforgeUrl);
    this.commandGate = new PanelCommandGate(this.bus, () => this.panel.reveal(true));
    this.mcp = new EditorMcpServer({
      io: this.io,
      context: this.contextEngine,
      bus: this.bus,
      decisions: this.decisions,
      runs: this.runs,
      review: this.review,
      apply: this.review,
      commandTimeoutSec: () => readConfig().commandTimeoutSec,
      onCommandOutput: (chunk) => this.output.append(chunk),
    });
    // Getters: the TrueForge URL and the agent definitions can change after construction.
    const self = this;
    this.runner = new AgentRunner({
      config: readConfig,
      bus: this.bus,
      decisions: this.decisions,
      runs: this.runs,
      review: this.review,
      commands: this.commandGate,
      io: this.io,
      context: this.contextEngine,
      // Feature 1: shadow test runs while a change is under review (raw output -> Forgelight output channel)
      verifier: new ShadowVerifier(this.io, { config: readConfig, onOutput: (chunk) => this.output.append(chunk) }),
      // Feature 5: risk badge, hard blocks and optional auto-approval for run_command
      guard: new CommandGuard(),
      get setup() {
        return self.setupFor(readConfig().trueforgeUrl);
      },
      get agentDefinition() {
        if (!self.agentDef) throw new Error('The agent definition (agent/forgelight.agent.json) could not be loaded; see the Forgelight output.');
        return self.agentDef;
      },
      get inlineAgentDefinition() {
        return self.inlineDef;
      },
    });
    this.panel = new AgentPanelProvider(context.extensionUri, this.bus, { onMessage: (m) => this.onPanelMessage(m) }, () => ({
      running: this.runner.running,
      models: readConfig().models,
      trueforgeUrl: readConfig().trueforgeUrl,
      mcpUrl: this.mcp.current?.url,
    }));
  }

  async start(): Promise<void> {
    const { context } = this;
    context.subscriptions.push(this.output, this.panel, this.commandGate, { dispose: () => this.clearInvalidateTimers() });
    this.review.register(context);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(AgentPanelProvider.viewId, this.panel, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.commands.registerCommand('forgelight.cancel', () => this.runner.cancel()),
      vscode.commands.registerCommand('forgelight.openSession', () => this.openSession()),
      vscode.commands.registerCommand('forgelight.setup', () => this.setupCommand()),
      vscode.commands.registerCommand('forgelight.focusPanel', () => this.panel.reveal(false)),
      vscode.commands.registerCommand('forgelight.revertLastRun', () => this.revertRun(this.review.lastRunWithEdits, true)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.invalidateDoc(doc.uri, 0)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) this.invalidateDoc(e.document.uri, INVALIDATE_DEBOUNCE_MS);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.contextEngine.invalidate()),
      vscode.workspace.onDidChangeConfiguration((e) => this.onConfigChanged(e)),
    );
    registerInlineEdit(context, {
      io: this.io,
      isRunning: () => this.busy || this.runner.running,
      run: (req) => this.startRun(req),
      revealPanel: () => this.panel.reveal(true),
      onDidChangeReviewing: this.review.onDidChangeReviewing,
    });
    // Live assist: the menu of actions and keys (F1), the instant Python check (F2), and the
    // on-demand function check and overview (F3, F4), which are ordinary agent-mode runs.
    registerMenu(context);
    registerInstantChecks(context, { relativePath: (p) => this.io.relativePath(p), root: () => this.io.root });
    registerFunctionAsk(context, {
      relativePath: (p) => this.io.relativePath(p),
      isRunning: () => this.busy || this.runner.running,
      run: (req) => this.startRun(req),
      revealPanel: () => this.panel.reveal(true),
    });
    const offBus = this.bus.on((ev) => this.onBusEvent(ev));
    context.subscriptions.push({ dispose: offBus });
    void vscode.commands.executeCommand('setContext', RUNNING_KEY, false);
    // Shadow copies left behind by a crashed extension host (Feature 1)
    void ShadowVerifier.sweepStale().then(
      (n) => n > 0 && this.log(`Removed ${n} stale shadow test ${n === 1 ? 'copy' : 'copies'}.`),
      () => undefined,
    );

    [this.agentDef, this.inlineDef] = await Promise.all([
      this.loadAgentDefinition('forgelight.agent.json', true),
      this.loadAgentDefinition('forgelight-inline.agent.json', false),
    ]);
    try {
      const ep = await this.startMcp();
      this.log(`Editor MCP server listening on ${ep.url}`);
    } catch (err) {
      this.warn(`Forgelight could not start its editor MCP server: ${errText(err)}`);
    }
    this.panel.postState();
    // Registration talks to TrueForge; do it in the background so activation stays fast.
    void this.register().then(
      (reg) => this.reportRegistration(reg, false),
      (err) => this.warn(errText(err)),
    );
  }

  async shutdown(): Promise<void> {
    try {
      await this.runner.cancel();
    } catch {
      // best effort
    }
    await this.mcp.stop().catch(() => undefined);
  }

  // -------------------------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------------------------

  async startRun(req: RunRequest): Promise<StartResult> {
    if (this.busy || this.runner.running) {
      return { error: `Forgelight is already running a request. Cancel it (${CANCEL_HINT}) before starting another one.` };
    }
    if (!this.io.hasWorkspace) return { error: 'Open a folder first: Forgelight works on the first workspace folder.' };
    this.busy = true;
    try {
      try {
        await this.ensureRegistered();
      } catch (err) {
        return { error: errText(err) };
      }
      const outcome = await this.runner.run(req);
      this.log(`Run ${outcome.runId} (${req.mode}) ${outcome.status}${outcome.model ? ` on ${outcome.model}` : ''}${outcome.message && outcome.status !== 'done' ? `: ${outcome.message}` : ''}`);
      return { outcome };
    } catch (err) {
      return { error: errText(err) };
    } finally {
      this.busy = false;
      this.panel.postState();
    }
  }

  async reviewProposal(opts: ReviewProposalOptions): Promise<ReviewProposalResult> {
    const uri = vscode.Uri.file(opts.absPath);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    const exists = !!open || (await vscode.workspace.fs.stat(uri).then(() => true, () => false));
    const originalText = open ? open.getText() : exists ? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)) : '';
    const relPath = this.io.relativePath(opts.absPath) ?? path.basename(opts.absPath);
    const change: ProposedChange = {
      id: opts.id,
      runId: opts.runId ?? 0,
      path: relPath,
      absPath: opts.absPath,
      isNewFile: !exists,
      originalText,
      proposedText: opts.proposedText,
      hunks: computeHunks(originalText, opts.proposedText, relPath, 0),
      argsKey: '',
    };
    const result = await this.review.review(change, new AbortController().signal);
    const record = await this.review.applyAccepted(change, result);
    return { hunks: change.hunks.length, result, record };
  }

  /** Run of the newest applied change that can still be undone. */
  get lastRunWithEdits(): number | undefined {
    return this.review.lastRunWithEdits;
  }

  /**
   * Feature 2: restore every file `runId` changed (newest first; files it created are deleted) and
   * report the result as a panel notice, plus a notification when asked from the command palette.
   */
  async revertRun(runId: number | undefined, toast: boolean): Promise<ApplyRecord[]> {
    const say = (level: 'info' | 'warn' | 'error', text: string) => {
      // no runId: the panel would open a placeholder card for a run it no longer shows
      this.notice(level, text);
      if (!toast) return;
      const msg = `Forgelight: ${text}`;
      if (level === 'info') void vscode.window.showInformationMessage(msg);
      else if (level === 'warn') void vscode.window.showWarningMessage(msg);
      else void vscode.window.showErrorMessage(msg);
    };
    if (runId === undefined || this.review.recordsOfRun(runId).length === 0) {
      say('info', 'Nothing to revert.');
      return [];
    }
    if (this.runs.activeRunId === runId) {
      say('warn', `Run ${runId} is still in progress. Cancel it (${CANCEL_HINT}) before reverting it.`);
      return [];
    }
    let report: RunRevertReport;
    try {
      report = await this.review.revertRunDetailed(runId);
    } catch (err) {
      say('error', `Could not revert run ${runId}: ${errText(err)}`);
      return [];
    }
    const kept = report.skipped.map((k) => `${k.path} (${k.reason})`).join('; ');
    if (report.files.length === 0) {
      if (kept) say('warn', `Run ${runId} was not reverted. Left as they are: ${kept}.`);
      else say('info', 'Nothing to revert.');
      return [];
    }
    const n = report.files.length;
    say(kept ? 'warn' : 'info', `Reverted ${n} ${n === 1 ? 'file' : 'files'} changed by run ${runId}${kept ? `. Left as they are: ${kept}` : ''}.`);
    return report.reverted;
  }

  private async onPanelMessage(msg: PanelToExtension): Promise<void> {
    switch (msg.type) {
      case 'ready':
        return;
      case 'send':
        void this.startRun({ mode: 'agent', text: msg.text }).then((res) => {
          if ('error' in res) this.notice('error', res.error);
        });
        return;
      case 'cancel':
        await this.runner.cancel();
        return;
      case 'approveCommand':
        if (!this.commandGate.resolveCommand(msg.requestId, msg.decision)) this.notice('info', 'That command request is no longer pending.');
        return;
      case 'hunk':
        if (!this.review.setHunkDecision(msg.changeId, msg.index, msg.decision)) this.notice('info', 'That review is no longer open.');
        return;
      case 'reviewAll':
        if (!this.review.setAll(msg.changeId, msg.decision)) this.notice('info', 'That review is no longer open.');
        return;
      case 'applyReview':
        if (!this.review.applyReview(msg.changeId)) this.notice('info', 'That review is no longer open.');
        return;
      case 'openSession':
        await this.openSession();
        return;
      case 'undo':
        if (this.review.undoDepth === 0) {
          this.notice('info', 'Nothing to undo.');
          return;
        }
        await this.review.undoLast(); // success shows as edit.undone; undefined = the user declined
        return;
      case 'revertRun':
        if (typeof msg.runId !== 'number') {
          this.notice('info', 'Nothing to revert.');
          return;
        }
        await this.revertRun(msg.runId, false);
        return;
    }
  }

  private onBusEvent(ev: ForgeEvent): void {
    switch (ev.type) {
      case 'run.started':
      case 'run.finished':
        void vscode.commands.executeCommand('setContext', RUNNING_KEY, ev.type === 'run.started');
        this.panel.postState();
        break;
      case 'edit.applied':
      case 'edit.undone':
        this.contextEngine.invalidate(ev.record.path);
        break;
      case 'run.reverted': {
        const paths = [...new Set(ev.records.map((r) => r.path))];
        for (const p of paths) this.contextEngine.invalidate(p);
        this.log(`Reverted run ${ev.runId}: ${paths.join(', ')}`);
        break;
      }
      case 'model.resume':
        this.log(`Run ${ev.runId}: session ${ev.sessionId} continues on ${ev.to} instead of ${ev.from}: ${ev.reason}`);
        break;
      case 'verify.finished':
        this.log(`Run ${ev.runId}: shadow tests ${ev.result.status}${ev.result.tests.length ? ` (${ev.result.tests.join(', ')})` : ''}: ${ev.result.summary}`);
        break;
      case 'model.health':
        if (ev.status === 'down' || ev.status === 'skipped') {
          this.log(`Model ${ev.model} is ${ev.status}${ev.reason ? ` (${ev.reason})` : ''}${ev.retryAt ? `; skipped until ${ev.retryAt}` : ''}`);
        }
        break;
      case 'model.retry':
        this.log(`Model ${ev.model} failed (${ev.reason}); retry ${ev.attempt} in ${ev.delayMs} ms`);
        break;
      case 'model.fallback':
        this.log(`Falling back from ${ev.from} to ${ev.to}: ${ev.reason}`);
        break;
      case 'notice':
        if (ev.level !== 'info') this.log(`[${ev.level}] ${ev.text}`);
        break;
      default:
        break;
    }
  }

  private async openSession(): Promise<void> {
    const url = this.runner.currentSessionUrl;
    if (!url) {
      void vscode.window.showInformationMessage('Forgelight: there is no TrueForge session yet. Send a request first.');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  // -------------------------------------------------------------------------------------------
  // TrueForge registration
  // -------------------------------------------------------------------------------------------

  private setupFor(url: string): TrueForgeSetup {
    if (this.setup.baseUrl !== url.replace(/\/+$/, '')) this.setup = new TrueForgeSetup(url);
    return this.setup;
  }

  private async startMcp(): Promise<EditorMcpEndpoint> {
    const port = readConfig().mcpPort;
    try {
      return await this.mcp.start(port);
    } catch (err) {
      if (port === 0) throw err;
      this.log(`Could not listen on port ${port} (${errText(err)}); using a free port.`);
      return this.mcp.start(0);
    }
  }

  private isRegisteredFor(cfg: ForgeConfig, ep: EditorMcpEndpoint | undefined): boolean {
    const r = this.registered;
    return !!r && !!ep && r.trueforgeUrl === cfg.trueforgeUrl && r.mcpUrl === ep.url && r.token === ep.token;
  }

  private async ensureRegistered(): Promise<void> {
    if (this.inflight) await this.inflight.catch(() => undefined);
    const cfg = readConfig();
    if (!this.isRegisteredFor(cfg, this.mcp.current)) {
      await this.register();
      return;
    }
    // Something else (e.g. the headless harness) may have re-pointed the shared registration.
    const remoteUrl = await this.setupFor(cfg.trueforgeUrl).registeredMcpUrl();
    if (remoteUrl !== this.mcp.current?.url) await this.register();
  }

  /** Register the MCP server and agents with TrueForge; calls are serialized. */
  private async register(): Promise<Registration> {
    while (this.inflight) await this.inflight.catch(() => undefined);
    const p = this.doRegister();
    this.inflight = p;
    try {
      return await p;
    } finally {
      if (this.inflight === p) this.inflight = undefined;
    }
  }

  private async doRegister(): Promise<Registration> {
    const cfg = readConfig();
    const setup = this.setupFor(cfg.trueforgeUrl);
    const ep = this.mcp.current ?? (await this.startMcp());
    if (!(await setup.health())) {
      throw new Error(
        `TrueForge is not reachable at ${cfg.trueforgeUrl}. Start it with scripts/start-trueforge.sh, then run 'Forgelight: Re-register MCP Server and Agent with TrueForge'.`,
      );
    }
    const tools = await setup.registerMcpServer(ep.url, ep.token);
    this.log(`Registered MCP server with TrueForge (${tools.length} tools: ${tools.join(', ')})`);
    // Runs send their own agent spec; the registered agents only make Forgelight visible in TrueForge.
    for (const def of [this.agentDef, this.inlineDef]) {
      if (!def) continue;
      try {
        const { created } = await setup.registerAgent(def, cfg.models[0]);
        this.log(`${created ? 'Created' : 'Updated'} TrueForge agent "${def.name}" (model ${cfg.models[0]})`);
      } catch (err) {
        this.log(`Could not register the TrueForge agent "${def.name}": ${errText(err)}`);
      }
    }
    let missingModels: string[] = [];
    try {
      const available = await setup.listModels();
      missingModels = cfg.models.filter((m) => !available.includes(m));
    } catch (err) {
      this.log(`Could not list TrueForge models: ${errText(err)}`);
    }
    const reg: Registration = { trueforgeUrl: cfg.trueforgeUrl, mcpUrl: ep.url, token: ep.token, tools, missingModels };
    this.registered = reg;
    this.panel.postState();
    return reg;
  }

  private reportRegistration(reg: Registration, announce: boolean): void {
    if (reg.missingModels.length) {
      this.warn(
        `TrueForge at ${reg.trueforgeUrl} has no model named ${reg.missingModels.map((m) => `"${m}"`).join(', ')}. ` +
          'Add it (node scripts/setup-models.mjs) or change the forgelight.models setting.',
      );
    }
    if (announce) {
      void vscode.window.showInformationMessage(`Forgelight: registered ${reg.tools.length} editor tools (${reg.mcpUrl}) with TrueForge at ${reg.trueforgeUrl}.`);
    }
  }

  private async setupCommand(): Promise<void> {
    try {
      const reg = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Forgelight: registering with TrueForge…' },
        async () => {
          await this.restartMcpIfPortChanged();
          return this.register();
        },
      );
      this.reportRegistration(reg, true);
    } catch (err) {
      void vscode.window.showErrorMessage(`Forgelight: ${errText(err)}`);
    }
  }

  /** Apply a changed forgelight.mcpPort (only while no run is using the server). */
  private async restartMcpIfPortChanged(): Promise<void> {
    const want = readConfig().mcpPort;
    const ep = this.mcp.current;
    if (ep && (want === 0 || ep.port === want)) return;
    if (this.busy || this.runner.running) return;
    await this.mcp.stop();
    this.registered = undefined;
    const next = await this.startMcp();
    this.log(`Editor MCP server listening on ${next.url}`);
  }

  private onConfigChanged(e: vscode.ConfigurationChangeEvent): void {
    if (!e.affectsConfiguration('forgelight')) return;
    // Feature 3: a new model list (or breaker setting) starts with a clean circuit breaker
    if (e.affectsConfiguration('forgelight.models') || e.affectsConfiguration('forgelight.circuitBreakerMinutes')) this.resetModelHealth();
    this.panel.postState();
    const portChanged = e.affectsConfiguration('forgelight.mcpPort');
    if (!portChanged && !e.affectsConfiguration('forgelight.trueforgeUrl') && !e.affectsConfiguration('forgelight.models')) return;
    if (portChanged && (this.busy || this.runner.running)) {
      void vscode.window.showInformationMessage(
        "Forgelight: the new MCP port applies after the current run. Run 'Forgelight: Re-register MCP Server and Agent with TrueForge' then.",
      );
    }
    void this.restartMcpIfPortChanged()
      .then(() => this.register())
      .then(
        (reg) => this.reportRegistration(reg, false),
        (err) => this.warn(errText(err)),
      );
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  private async loadAgentDefinition(file: string, required: boolean): Promise<AgentDefinition | undefined> {
    const uri = vscode.Uri.joinPath(this.context.extensionUri, 'agent', file);
    try {
      const raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) as Partial<AgentDefinition>;
      if (typeof raw.name !== 'string' || !raw.manifest || typeof raw.manifest !== 'object') {
        throw new Error('expected {"name", "description", "manifest"}');
      }
      return { name: raw.name, description: typeof raw.description === 'string' ? raw.description : '', manifest: raw.manifest };
    } catch (err) {
      const msg = `Could not load agent/${file}: ${errText(err)}`;
      if (required) this.warn(msg);
      else this.log(msg);
      return undefined;
    }
  }

  private invalidateDoc(uri: vscode.Uri, delayMs: number): void {
    if (uri.scheme !== 'file') return;
    const rel = this.io.relativePath(uri.fsPath);
    if (!rel) return;
    clearTimeout(this.invalidateTimers.get(rel));
    if (delayMs === 0) {
      this.invalidateTimers.delete(rel);
      this.contextEngine.invalidate(rel);
      return;
    }
    this.invalidateTimers.set(
      rel,
      setTimeout(() => {
        this.invalidateTimers.delete(rel);
        this.contextEngine.invalidate(rel);
      }, delayMs),
    );
  }

  private clearInvalidateTimers(): void {
    for (const t of this.invalidateTimers.values()) clearTimeout(t);
    this.invalidateTimers.clear();
  }

  private resetModelHealth(): void {
    try {
      this.runner.resetHealth();
    } catch (err) {
      this.log(`Could not reset model health: ${errText(err)}`);
    }
  }

  private notice(level: 'info' | 'warn' | 'error', text: string): void {
    this.bus.emit({ type: 'notice', level, text });
  }

  /** Warning toast + panel notice (the bus listener also logs it). */
  private warn(text: string): void {
    this.notice('warn', text);
    void vscode.window.showWarningMessage(`Forgelight: ${text}`);
  }

  private log(line: string): void {
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
