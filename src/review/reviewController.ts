/**
 * Hunk-by-hunk review UI (VS Code only): a FIFO queue of reviews shown one at a time as a diff of
 * two virtual documents, per-hunk CodeLens + decorations (with hover links, since VS Code hides
 * CodeLens in diff editors unless `diffEditor.codeLens` is on), and undoable application of the
 * accepted hunks through WorkspaceEdit (so Cmd+Z works too).
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ApplyGate, ApplyRecord, ForgeEvent, HunkDecision, ProposedChange, ReviewGate, ReviewResult } from '../contracts';
import type { ForgeEventBus } from '../events';
import { changedLines, clampLine, decisionsToResult, layoutHunk, minimalReplace, type HunkLayout } from './hunkLayout';
import { applyHunks, computeHunks, rebaseChange, summarizeHunks } from './hunks';

const PROPOSED_SCHEME = 'forgelight-proposed';
const ORIGINAL_SCHEME = 'forgelight-original';
const REVIEWING_KEY = 'forgelight.reviewing';
const FLASH_MS = 2500;
const TAB_CLOSE_SETTLE_MS = 300;
const HOVER_COMMANDS = ['forgelight.acceptHunk', 'forgelight.rejectHunk', 'forgelight.acceptAll', 'forgelight.rejectAll', 'forgelight.applyReview'];

type FinalDecision = Exclude<HunkDecision, 'pending'>;

interface ReviewEntry {
  change: ProposedChange;
  decisions: HunkDecision[];
  layout: HunkLayout[];
  left: vscode.Uri;
  right: vscode.Uri;
  signal: AbortSignal;
  onAbort: () => void;
  resolve: (result: ReviewResult) => void;
  shown: boolean;
  settled: boolean;
}

const docKey = (uri: vscode.Uri) => `${uri.scheme}:${uri.path}`;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function cancelledResult(change: ProposedChange, note = 'run cancelled'): ReviewResult {
  return decisionsToResult(change.id, change.hunks, change.hunks.map(() => 'rejected'), { cancelled: true, note });
}

/** What reverting a run did (Feature 2). `revertRun` returns only `reverted`. */
export interface RunRevertReport {
  runId: number;
  /** Records reverted (removed from the undo stack), newest first. */
  reverted: ApplyRecord[];
  /** Workspace-relative paths of the files restored or deleted, newest first. */
  files: string[];
  /** Files left as they are: the user kept them (modal) or the revert failed. Their records stay on the undo stack. */
  skipped: Array<{ path: string; reason: string }>;
}

export class ReviewController implements ReviewGate, ApplyGate, vscode.Disposable {
  private readonly queue: ReviewEntry[] = [];
  private current: ReviewEntry | undefined;
  private seq = 0;
  /** Virtual document contents keyed by scheme:path. */
  private readonly docs = new Map<string, string>();
  private readonly undoStack: ApplyRecord[] = [];
  /** Serializes applies and undos so they never interleave on the same file. */
  private ioChain: Promise<unknown> = Promise.resolve();
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private reviewingCtx: boolean | undefined;
  private registered = false;
  private disposed = false;

  private readonly acceptedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(46, 160, 67, 0.22)',
    borderStyle: 'solid',
    borderWidth: '0 0 0 3px',
    borderColor: 'rgba(46, 160, 67, 0.9)',
    overviewRulerColor: 'rgba(46, 160, 67, 0.9)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  private readonly rejectedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    opacity: '0.4',
    textDecoration: 'line-through',
    backgroundColor: 'rgba(128, 128, 128, 0.12)',
    borderStyle: 'solid',
    borderWidth: '0 0 0 3px',
    borderColor: 'rgba(215, 58, 73, 0.9)',
    overviewRulerColor: 'rgba(215, 58, 73, 0.9)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  private readonly labelDeco = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 2em', fontStyle: 'italic' },
  });
  /** No styling: carries the hover actions on a hunk's added lines. */
  private readonly hoverDeco = vscode.window.createTextEditorDecorationType({});
  private readonly flashDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(46, 160, 67, 0.28)',
    overviewRulerColor: 'rgba(46, 160, 67, 0.9)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  constructor(private readonly bus: ForgeEventBus) {
    this.disposables.push(this.lensEmitter, this.acceptedDeco, this.rejectedDeco, this.labelDeco, this.hoverDeco, this.flashDeco);
  }

  register(context: vscode.ExtensionContext): void {
    if (this.registered || this.disposed) return;
    this.registered = true;
    const content: vscode.TextDocumentContentProvider = {
      provideTextDocumentContent: (uri) => this.docs.get(docKey(uri)) ?? '',
    };
    const lenses: vscode.CodeLensProvider = {
      onDidChangeCodeLenses: this.lensEmitter.event,
      provideCodeLenses: (doc) => this.codeLenses(doc),
    };
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, content),
      vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, content),
      vscode.languages.registerCodeLensProvider({ scheme: PROPOSED_SCHEME }, lenses),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshDecorations()),
      vscode.window.tabGroups.onDidChangeTabs((e) => this.onTabsChanged(e)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('diffEditor.codeLens') || e.affectsConfiguration('editor.codeLens')) this.refreshDecorations();
      }),
      vscode.commands.registerCommand('forgelight.acceptHunk', (id: unknown, index: unknown) => this.hunkCommand(id, index, 'accepted')),
      vscode.commands.registerCommand('forgelight.rejectHunk', (id: unknown, index: unknown) => this.hunkCommand(id, index, 'rejected')),
      vscode.commands.registerCommand('forgelight.acceptAll', (arg: unknown) => this.reviewCommand(arg, (e) => this.decideAll(e, 'accepted'))),
      vscode.commands.registerCommand('forgelight.rejectAll', (arg: unknown) => this.reviewCommand(arg, (e) => this.decideAll(e, 'rejected'))),
      vscode.commands.registerCommand('forgelight.applyReview', (arg: unknown) => this.reviewCommand(arg, (e) => this.finishReview(e))),
      vscode.commands.registerCommand('forgelight.undoLastApplied', () => this.undoCommand()),
    );
    context.subscriptions.push(this);
    this.updateContext();
  }

  // -------------------------------------------------------------------------------------------
  // ReviewGate
  // -------------------------------------------------------------------------------------------

  review(change: ProposedChange, signal: AbortSignal): Promise<ReviewResult> {
    if (signal.aborted || this.disposed) return Promise.resolve(cancelledResult(change));
    if (change.hunks.length === 0) {
      return Promise.resolve(decisionsToResult(change.id, [], [], { note: 'nothing to review: the change is empty' }));
    }
    return new Promise<ReviewResult>((resolve) => {
      // a per-review prefix keeps URIs unique when the same file has several queued reviews
      const tail = `/${++this.seq}/${change.path.replace(/^\/+/, '')}`;
      const entry: ReviewEntry = {
        change,
        decisions: change.hunks.map((): HunkDecision => 'pending'),
        layout: change.hunks.map(layoutHunk),
        left: vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: tail }),
        right: vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: tail }),
        signal,
        onAbort: () => this.discardRun(change.runId),
        resolve,
        shown: false,
        settled: false,
      };
      signal.addEventListener('abort', entry.onAbort, { once: true });
      this.queue.push(entry);
      this.showNext();
    });
  }

  discardRun(runId: number): void {
    const victims = this.queue.filter((e) => e.change.runId === runId);
    if (this.current?.change.runId === runId) victims.unshift(this.current);
    if (victims.length === 0) return;
    // settle everything first so no review of this run is shown in between
    for (const e of victims) this.settle(e, cancelledResult(e.change));
    this.showNext();
  }

  // -------------------------------------------------------------------------------------------
  // Public decisions API (agent panel)
  // -------------------------------------------------------------------------------------------

  setHunkDecision(changeId: string, index: number, decision: FinalDecision): boolean {
    const entry = this.find(changeId);
    if (!entry) return false;
    const pos = entry.change.hunks.findIndex((h) => h.index === index);
    if (pos < 0) return false;
    entry.decisions[pos] = decision;
    this.emit({ type: 'review.updated', changeId: entry.change.id, decisions: [...entry.decisions] });
    if (entry.decisions.every((d) => d !== 'pending')) {
      this.finish(entry, decisionsToResult(entry.change.id, entry.change.hunks, entry.decisions));
    } else {
      this.lensEmitter.fire();
      this.refreshDecorations();
    }
    return true;
  }

  setAll(changeId: string, decision: FinalDecision): boolean {
    const entry = this.find(changeId);
    if (!entry) return false;
    this.decideAll(entry, decision);
    return true;
  }

  /** Resolve now; hunks still pending are rejected. */
  applyReview(changeId: string): boolean {
    const entry = this.find(changeId);
    if (!entry) return false;
    this.finishReview(entry);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // ApplyGate
  // -------------------------------------------------------------------------------------------

  applyAccepted(change: ProposedChange, result: ReviewResult): Promise<ApplyRecord | undefined> {
    if (result.accepted.length === 0) return Promise.resolve(undefined);
    return this.serialize(() => this.doApply(change, result));
  }

  undoLast(): Promise<ApplyRecord | undefined> {
    return this.serialize(() => this.doUndo());
  }

  /**
   * Feature 2: restore every file the run changed, newest first, to its text from before the run's
   * first edit to it (files the run created are deleted). Same safety as undo: later edits by
   * others are kept when Forgelight's lines can be reverted on their own, otherwise a modal asks.
   */
  async revertRun(runId: number): Promise<ApplyRecord[]> {
    return (await this.revertRunDetailed(runId)).reverted;
  }

  /** revertRun plus the files that were left as they are, and why. */
  revertRunDetailed(runId: number): Promise<RunRevertReport> {
    return this.serialize(() => this.doRevertRun(runId));
  }

  /** Run of the newest applied change still on the undo stack (what "Revert Last Run" acts on). */
  get lastRunWithEdits(): number | undefined {
    return this.undoStack[this.undoStack.length - 1]?.runId;
  }

  /** Applied changes of a run that are still on the undo stack, oldest first. */
  recordsOfRun(runId: number): ApplyRecord[] {
    return this.undoStack.filter((r) => r.runId === runId);
  }

  /** Number of applied changes that can still be undone. */
  get undoDepth(): number {
    return this.undoStack.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const e of [...(this.current ? [this.current] : []), ...this.queue]) {
      this.settle(e, cancelledResult(e.change, 'Forgelight was shut down'));
    }
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const d of this.disposables.splice(0)) {
      try {
        d.dispose();
      } catch {
        // already disposed
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Queue
  // -------------------------------------------------------------------------------------------

  private showNext(): void {
    if (!this.current && !this.disposed) {
      const next = this.queue.shift();
      if (next) this.show(next);
    }
    this.lensEmitter.fire();
    this.refreshDecorations();
    this.updateContext();
  }

  private show(entry: ReviewEntry): void {
    const { change } = entry;
    this.current = entry;
    entry.shown = true;
    // left side is a snapshot of what was reviewed, even if the buffer is dirty
    this.docs.set(docKey(entry.left), change.isNewFile ? '' : change.originalText);
    this.docs.set(docKey(entry.right), change.proposedText);
    this.emit({
      type: 'review.opened',
      runId: change.runId,
      changeId: change.id,
      path: change.path,
      explanation: change.explanation,
      isNewFile: change.isNewFile,
      hunks: summarizeHunks(change.hunks),
    });
    const title = `Forgelight review: ${change.path} (${plural(change.hunks.length, 'hunk')})`;
    vscode.commands.executeCommand('vscode.diff', entry.left, entry.right, title, { preview: false }).then(
      () => {
        // resolved (e.g. cancelled) while the diff was opening: close the late tab
        if (entry.settled) void this.closeTabs(entry);
        else this.refreshDecorations();
      },
      (err: unknown) => {
        if (entry.settled) return;
        this.emit({ type: 'notice', runId: change.runId, level: 'error', text: `Could not open the review for ${change.path}: ${errText(err)}` });
        this.finish(entry, decisionsToResult(change.id, change.hunks, [], { note: 'the review could not be shown; nothing was applied' }));
      },
    );
  }

  /** Settle the entry and move on to the next review. */
  private finish(entry: ReviewEntry, result: ReviewResult): void {
    this.settle(entry, result);
    this.showNext();
  }

  private settle(entry: ReviewEntry, result: ReviewResult): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.signal.removeEventListener('abort', entry.onAbort);
    if (this.current === entry) this.current = undefined;
    const i = this.queue.indexOf(entry);
    if (i >= 0) this.queue.splice(i, 1);
    if (entry.shown) {
      void this.closeTabs(entry).finally(() => {
        this.docs.delete(docKey(entry.left));
        this.docs.delete(docKey(entry.right));
      });
      this.emit({ type: 'review.closed', changeId: entry.change.id, result });
    }
    entry.resolve(result);
  }

  private decideAll(entry: ReviewEntry, decision: FinalDecision): void {
    if (entry.settled) return;
    entry.decisions.fill(decision);
    this.emit({ type: 'review.updated', changeId: entry.change.id, decisions: [...entry.decisions] });
    this.finish(entry, decisionsToResult(entry.change.id, entry.change.hunks, entry.decisions));
  }

  private finishReview(entry: ReviewEntry, why = ''): void {
    if (entry.settled) return;
    const pending = entry.decisions.filter((d) => d === 'pending').length;
    const note = pending ? `${why}${plural(pending, 'hunk')} left undecided by the user ${pending === 1 ? 'was' : 'were'} rejected` : undefined;
    this.finish(entry, decisionsToResult(entry.change.id, entry.change.hunks, entry.decisions, { note }));
  }

  private find(changeId: string): ReviewEntry | undefined {
    if (this.current?.change.id === changeId) return this.current;
    return this.queue.find((e) => e.change.id === changeId);
  }

  private entryForUri(uri: vscode.Uri): ReviewEntry | undefined {
    const key = uri.toString();
    const all = this.current ? [this.current, ...this.queue] : this.queue;
    return all.find((e) => e.right.toString() === key || e.left.toString() === key);
  }

  private tabsFor(right: vscode.Uri): vscode.Tab[] {
    const key = right.toString();
    return vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === key);
  }

  private async closeTabs(entry: ReviewEntry): Promise<void> {
    const tabs = this.tabsFor(entry.right);
    if (tabs.length === 0) return;
    try {
      await vscode.window.tabGroups.close(tabs, true);
    } catch {
      // tab already gone
    }
  }

  /** The user closed the current review's diff tab: treat it like "apply reviewed". */
  private onTabsChanged(e: vscode.TabChangeEvent): void {
    const cur = this.current;
    if (!cur || cur.settled) return;
    const key = cur.right.toString();
    const closed = e.closed.some((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === key);
    if (!closed) return;
    // a tab moved between groups closes and reopens; only act if it is really gone
    this.later(TAB_CLOSE_SETTLE_MS, () => {
      if (this.current === cur && !cur.settled && this.tabsFor(cur.right).length === 0) this.finishReview(cur, 'review tab closed; ');
    });
  }

  private updateContext(): void {
    const reviewing = !!this.current;
    if (reviewing === this.reviewingCtx || this.disposed) return;
    this.reviewingCtx = reviewing;
    vscode.commands.executeCommand('setContext', REVIEWING_KEY, reviewing).then(undefined, () => undefined);
  }

  // -------------------------------------------------------------------------------------------
  // Per-hunk UI
  // -------------------------------------------------------------------------------------------

  private codeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const entry = doc.uri.scheme === PROPOSED_SCHEME ? this.entryForUri(doc.uri) : undefined;
    if (!entry || entry.settled) return [];
    const id = entry.change.id;
    const n = entry.layout.length;
    const out: vscode.CodeLens[] = [];
    entry.layout.forEach((l, pos) => {
      const line = clampLine(l.anchorLine, doc.lineCount);
      const range = new vscode.Range(line, 0, line, 0);
      const args = [id, l.index];
      const d = entry.decisions[pos];
      if (d === 'pending') {
        out.push(new vscode.CodeLens(range, { title: `$(check) Accept hunk ${pos + 1}/${n}`, command: 'forgelight.acceptHunk', arguments: args }));
        out.push(new vscode.CodeLens(range, { title: '$(x) Reject', command: 'forgelight.rejectHunk', arguments: args }));
      } else if (d === 'accepted') {
        out.push(new vscode.CodeLens(range, { title: '✓ Accepted (click to reject)', command: 'forgelight.rejectHunk', arguments: args }));
      } else {
        out.push(new vscode.CodeLens(range, { title: '✗ Rejected (click to accept)', command: 'forgelight.acceptHunk', arguments: args }));
      }
    });
    return out;
  }

  private refreshDecorations(): void {
    if (this.disposed) return;
    const cfg = vscode.workspace.getConfiguration();
    const lensVisible = cfg.get<boolean>('diffEditor.codeLens', false) && cfg.get<boolean>('editor.codeLens', true);
    for (const editor of vscode.window.visibleTextEditors) {
      const doc = editor.document;
      if (doc.uri.scheme !== PROPOSED_SCHEME) continue;
      const accepted: vscode.Range[] = [];
      const rejected: vscode.Range[] = [];
      const labels: vscode.DecorationOptions[] = [];
      const hovers: vscode.DecorationOptions[] = [];
      const entry = this.entryForUri(doc.uri);
      if (entry && !entry.settled) {
        const n = entry.layout.length;
        entry.layout.forEach((l, pos) => {
          const d = entry.decisions[pos];
          const hoverMessage = this.hunkHover(entry, pos);
          const anchor = clampLine(l.anchorLine, doc.lineCount);
          const tag = `hunk ${pos + 1}/${n}${l.addedLines.length ? '' : ' (deletion)'}`;
          const label =
            d === 'accepted'
              ? { contentText: `✓ ${tag} accepted`, color: 'rgba(46, 160, 67, 1)' }
              : d === 'rejected'
                ? { contentText: `✗ ${tag} rejected`, color: 'rgba(215, 58, 73, 1)' }
                : lensVisible
                  ? undefined
                  : { contentText: `● ${tag} pending: hover to accept or reject`, color: new vscode.ThemeColor('editorCodeLens.foreground') };
          labels.push({ range: doc.lineAt(anchor).range, hoverMessage, renderOptions: label ? { after: label } : undefined });
          for (const x of l.addedLines) {
            const line = clampLine(x, doc.lineCount);
            const range = doc.lineAt(line).range;
            if (d === 'accepted') accepted.push(range);
            else if (d === 'rejected') rejected.push(range);
            if (line !== anchor) hovers.push({ range, hoverMessage });
          }
        });
      }
      editor.setDecorations(this.acceptedDeco, accepted);
      editor.setDecorations(this.rejectedDeco, rejected);
      editor.setDecorations(this.labelDeco, labels);
      editor.setDecorations(this.hoverDeco, hovers);
    }
  }

  private hunkHover(entry: ReviewEntry, pos: number): vscode.MarkdownString {
    const id = entry.change.id;
    const index = entry.layout[pos].index;
    const link = (text: string, command: string, args: unknown[]) =>
      `[${text}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
    const md = new vscode.MarkdownString(
      `**Forgelight** hunk ${pos + 1}/${entry.layout.length}: ${entry.decisions[pos]}\n\n` +
        [
          link('$(check) Accept hunk', 'forgelight.acceptHunk', [id, index]),
          link('$(x) Reject hunk', 'forgelight.rejectHunk', [id, index]),
          link('Accept all', 'forgelight.acceptAll', [id]),
          link('Reject all', 'forgelight.rejectAll', [id]),
          link('Apply reviewed', 'forgelight.applyReview', [id]),
        ].join(' &nbsp;·&nbsp; '),
      true,
    );
    md.isTrusted = { enabledCommands: HOVER_COMMANDS };
    return md;
  }

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------

  private hunkCommand(id: unknown, index: unknown, decision: FinalDecision): void {
    if (typeof id !== 'string' || typeof index !== 'number') return;
    if (!this.setHunkDecision(id, index, decision)) void vscode.window.showInformationMessage('Forgelight: that review is no longer open.');
  }

  /** `arg` is a changeId (panel, hover link), a resource Uri (editor/title menu) or nothing. */
  private reviewCommand(arg: unknown, act: (entry: ReviewEntry) => void): void {
    let entry: ReviewEntry | undefined;
    if (typeof arg === 'string') entry = this.find(arg);
    else entry = (arg instanceof vscode.Uri ? this.entryForUri(arg) : undefined) ?? this.current;
    if (entry) act(entry);
    else void vscode.window.showInformationMessage('Forgelight: no review is open.');
  }

  private async undoCommand(): Promise<void> {
    try {
      const record = await this.undoLast();
      if (record) void vscode.window.showInformationMessage(`Forgelight: undid the change to ${record.path}.`);
      else void vscode.window.showInformationMessage(this.undoStack.length ? 'Forgelight: undo cancelled.' : 'Nothing to undo');
    } catch (err) {
      void vscode.window.showErrorMessage(`Forgelight: undo failed: ${errText(err)}`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Apply / undo
  // -------------------------------------------------------------------------------------------

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.ioChain.then(fn);
    this.ioChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doApply(change: ProposedChange, result: ReviewResult): Promise<ApplyRecord | undefined> {
    const uri = vscode.Uri.file(change.absPath);
    const doc = await this.openIfExists(uri);
    // no await between reading the text and building the edit
    const before = doc?.getText();
    // Unsaved edits the user made before the review: saving would write lines nobody reviewed.
    const wasDirty = doc?.isDirty ?? false;
    if (before === undefined && !change.isNewFile) throw new Error(`Cannot apply the change to ${change.path}: the file no longer exists.`);
    if (before !== undefined && before !== change.originalText && change.isNewFile) {
      throw new Error(`Cannot create ${change.path}: a different file with that name appeared after the proposal.`);
    }
    // The hunks (zero context) were computed from originalText, so this cannot fail.
    const target = applyHunks(change.originalText, change.hunks, result.accepted);
    let after: string;
    if (before === undefined || before === change.originalText) {
      after = target;
    } else {
      try {
        // the buffer changed since the proposal: carry the change over with context checks
        after = rebaseChange(change.originalText, target, before, change.path);
      } catch {
        throw new Error(
          `Cannot apply the accepted hunks to ${change.path}: the file changed after the edit was proposed and the hunks no longer match. Re-read the file and propose the edit again.`,
        );
      }
    }
    if (doc && after === before) return undefined;

    const meta: vscode.WorkspaceEditEntryMetadata = { needsConfirmation: false, label: `Forgelight: ${change.path}` };
    const edit = new vscode.WorkspaceEdit();
    if (doc) {
      this.replaceText(edit, doc, before!, after, meta);
    } else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(change.absPath)));
      edit.createFile(uri, { overwrite: false }, meta);
      edit.insert(uri, new vscode.Position(0, 0), after, meta);
    }
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code rejected the edit to ${change.path}.`);
    const saved = doc ?? (await vscode.workspace.openTextDocument(uri));
    if (wasDirty) {
      this.emit({
        type: 'notice',
        runId: change.runId,
        level: 'warn',
        text: `Applied the change to ${change.path} in the editor but did not save it, because the file had unsaved changes. Save it to write it to disk.`,
      });
    } else {
      await this.save(saved, change.path, change.runId);
    }

    const record: ApplyRecord = {
      changeId: change.id,
      runId: change.runId,
      path: change.path,
      absPath: change.absPath,
      beforeText: before ?? '',
      afterText: saved.getText(),
      createdFile: !doc,
      hunksApplied: [...result.accepted],
      hunksRejected: [...result.rejected],
    };
    this.undoStack.push(record);
    this.emit({ type: 'edit.applied', runId: change.runId, record });
    this.reveal(saved, record).catch(() => undefined);
    return record;
  }

  private async doUndo(): Promise<ApplyRecord | undefined> {
    const record = this.undoStack.pop();
    if (!record) return undefined;
    let done: boolean;
    try {
      done = await this.revert(record);
    } catch (err) {
      this.undoStack.push(record);
      throw err;
    }
    if (!done) {
      this.undoStack.push(record);
      return undefined;
    }
    this.emit({ type: 'edit.undone', record });
    return record;
  }

  private async doRevertRun(runId: number): Promise<RunRevertReport> {
    const report: RunRevertReport = { runId, reverted: [], files: [], skipped: [] };
    // One group per file, newest record first; Map order = order of each file's newest edit.
    const groups = new Map<string, ApplyRecord[]>();
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      const r = this.undoStack[i];
      if (r.runId !== runId) continue;
      const key = vscode.Uri.file(r.absPath).toString();
      const group = groups.get(key);
      if (group) group.push(r);
      else groups.set(key, [r]);
    }
    for (const group of groups.values()) {
      const relPath = group[0].path;
      // Normally each edit starts from the text the previous one wrote: revert the whole span in one
      // step (the file as the run left it -> the file before the run first touched it). If something
      // else changed the file between two of the run's edits, revert edit by edit so that change is
      // kept where it can be (the same per-edit safety as undo).
      const chained = group.every((r, i) => i === 0 || r.afterText === group[i - 1].beforeText);
      const steps = chained ? [group] : group.map((r) => [r]);
      let failure: string | undefined;
      let partly = false;
      for (const step of steps) {
        const newest = step[0];
        const oldest = step[step.length - 1];
        const span: ApplyRecord = step.length === 1 ? newest : { ...newest, beforeText: oldest.beforeText, createdFile: oldest.createdFile };
        let done: boolean;
        try {
          done = await this.revert(span, runId);
        } catch (err) {
          failure = errText(err);
          break;
        }
        if (!done) {
          failure = 'kept as it is';
          break;
        }
        for (const r of step) {
          const i = this.undoStack.indexOf(r);
          if (i >= 0) this.undoStack.splice(i, 1);
        }
        report.reverted.push(...step);
        partly = true;
      }
      if (failure === undefined) report.files.push(relPath);
      else report.skipped.push({ path: relPath, reason: partly ? `only partly reverted: ${failure}` : failure });
    }
    if (report.reverted.length) this.emit({ type: 'run.reverted', runId, records: report.reverted });
    return report;
  }

  /** Restore the state before `record` (with `runId`: a whole run's edits to one file). False when the user declined. */
  private async revert(record: ApplyRecord, runId?: number): Promise<boolean> {
    const uri = vscode.Uri.file(record.absPath);
    const by = runId === undefined ? 'Forgelight' : `Forgelight run ${runId}`;
    const label = runId === undefined ? `Forgelight undo: ${record.path}` : `Forgelight revert run ${runId}: ${record.path}`;
    const meta: vscode.WorkspaceEditEntryMetadata = { needsConfirmation: false, label };
    const doc = await this.openIfExists(uri);
    const edit = new vscode.WorkspaceEdit();

    if (!doc) {
      if (record.createdFile) return true; // already gone
      // deleted after we edited it: bring back the pre-edit version
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(record.absPath)));
      edit.createFile(uri, { overwrite: false }, meta);
      edit.insert(uri, new vscode.Position(0, 0), record.beforeText, meta);
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code rejected restoring ${record.path}.`);
      await this.save(await vscode.workspace.openTextDocument(uri), record.path);
      return true;
    }

    const current = doc.getText();
    if (record.createdFile) {
      if (current !== record.afterText && !(await this.confirm(`${record.path} was edited after ${by} created it. Delete it anyway?`, 'Delete'))) {
        return false;
      }
      edit.deleteFile(uri, { ignoreIfNotExists: true }, meta);
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code rejected deleting ${record.path}.`);
      await this.closeDeletedFileTabs(uri);
      return true;
    }

    if (current === record.beforeText) {
      // already reverted in the buffer (e.g. Cmd+Z, which does not save): persist it
      await this.save(doc, record.path);
      return true;
    }
    let target: string;
    if (current === record.afterText) {
      target = record.beforeText;
    } else {
      // revert only Forgelight's lines and keep later edits, when the context still matches
      try {
        const reverse = computeHunks(record.afterText, record.beforeText);
        target = applyHunks(current, reverse, reverse.map((h) => h.index));
      } catch {
        const ok = await this.confirm(
          runId === undefined
            ? `${record.path} changed after Forgelight edited it and the edit cannot be reverted on its own. Restore the version from before the edit? Later changes to this file will be lost.`
            : `${record.path} changed after ${by} edited it and the run's edits cannot be reverted on their own. Restore the version from before run ${runId}? Later changes to this file will be lost.`,
          'Restore',
        );
        if (!ok) return false;
        if (doc.getText() !== current) throw new Error(`${record.path} changed during ${runId === undefined ? 'undo' : 'the revert'}; try again.`);
        target = record.beforeText;
      }
    }
    this.replaceText(edit, doc, current, target, meta);
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code rejected the undo for ${record.path}.`);
    await this.save(doc, record.path);
    return true;
  }

  /** Close clean editor tabs still showing a file that was just deleted (they would show it as "deleted"). */
  private async closeDeletedFileTabs(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    if (vscode.workspace.textDocuments.some((d) => d.uri.toString() === key && d.isDirty)) return;
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key && !t.isDirty);
    if (tabs.length === 0) return;
    try {
      await vscode.window.tabGroups.close(tabs, true);
    } catch {
      // tab already gone
    }
  }

  /** Replace only the changed lines (keeps cursor and folding stable; one undo step). */
  private replaceText(edit: vscode.WorkspaceEdit, doc: vscode.TextDocument, from: string, to: string, meta: vscode.WorkspaceEditEntryMetadata): void {
    const r = minimalReplace(from, to);
    if (r) edit.replace(doc.uri, new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)), r.text, meta);
  }

  private async openIfExists(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    const key = uri.toString();
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (open) return open;
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      return undefined;
    }
    return vscode.workspace.openTextDocument(uri);
  }

  private async save(doc: vscode.TextDocument, relPath: string, runId?: number): Promise<void> {
    if (!doc.isDirty) return;
    if (!(await doc.save()) && doc.isDirty) {
      this.emit({ type: 'notice', runId, level: 'warn', text: `Forgelight changed ${relPath} but could not save it; the change is in the editor buffer.` });
    }
  }

  private async confirm(message: string, action: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
  }

  /** Briefly show and highlight what was written, without hiding an open review. */
  private async reveal(doc: vscode.TextDocument, record: ApplyRecord): Promise<void> {
    const key = doc.uri.toString();
    const lines = changedLines(record.beforeText, record.afterText).map((l) => clampLine(l, doc.lineCount));
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === key);
    if (!this.current) {
      const shown = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true });
      if (lines.length) shown.revealRange(doc.lineAt(lines[0]).range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      if (!editors.includes(shown)) editors.push(shown);
    }
    if (lines.length === 0 || editors.length === 0) return;
    const ranges = lines.map((l) => doc.lineAt(l).range);
    for (const e of editors) e.setDecorations(this.flashDeco, ranges);
    this.later(FLASH_MS, () => {
      for (const e of vscode.window.visibleTextEditors) if (e.document.uri.toString() === key) e.setDecorations(this.flashDeco, []);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------------------------

  private emit(event: ForgeEvent): void {
    try {
      this.bus.emit(event);
    } catch (err) {
      console.error('[forgelight] event listener failed', err);
    }
  }

  private later(ms: number, fn: () => void): void {
    if (this.disposed) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.disposed) return;
      try {
        fn();
      } catch (err) {
        console.error('[forgelight] review timer failed', err);
      }
    }, ms);
    this.timers.add(t);
  }
}
