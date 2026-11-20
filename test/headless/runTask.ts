/**
 * Headless Forgelight run (no VS Code): the real RepoContextEngine, EditorMcpServer,
 * TrueForgeSetup and AgentRunner on a workspace on disk, with auto-answering gates. The agent
 * loop runs on TrueForge exactly as in the extension; only the human review is automated.
 *
 *   node dist/test/headless/runTask.js --root <workspace> --task "<text>"
 *     [--mode agent|inline --file <rel> --lines a-b] [--models m1,m2] [--reject-hunks]
 *     [--cancel-after <sec>] [--trueforge <url>] [--events-out <file.jsonl>] [--revert-run]
 *     [--no-verify] [--await-verify] [--auto-approve-safe] [--repeat <n>]
 *
 * --revert-run (alias --revert-after) reverts the whole run afterwards (Feature 2) and checks that
 * every file it changed is back to its text from before the run (created files gone); the exit
 * code is 1 if not.
 * Feature 1 (shadow test runs) is on unless --no-verify; --await-verify makes the auto review wait
 * for a change's shadow result before deciding (as a human would), so the result reaches the agent.
 * Feature 5: every run_command is classified by the command guard; --auto-approve-safe sets
 * autoApproveSafeCommands (test/read commands run without the gate; the auto gate still approves
 * everything else, blocked commands are refused).
 * --repeat <n> runs the task n times with ONE runner (so the circuit breaker of Feature 3 carries
 * over); every repetition but the last is reverted before the next one starts.
 * FORGELIGHT_HEADLESS_IMPORT=1 skips the run, so a test can import the gates exported here.
 *
 * It re-registers the MCP server under MCP_SERVER_NAME (pointing at this process); run
 * "Forgelight: Re-register…" in VS Code afterwards to point it back at the extension.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import inlineAgentJson from '../../agent/forgelight-inline.agent.json';
import agentJson from '../../agent/forgelight.agent.json';
import { RepoContextEngine } from '../../src/context/retrieval';
import { CommandGuard } from '../../src/safety/commandGuard';
import { ShadowVerifier } from '../../src/verify/shadow';
import {
  DEFAULT_CONFIG,
  type ApplyGate,
  type ApplyRecord,
  type CommandDecision,
  type CommandGate,
  type CommandRequest,
  type ForgeConfig,
  type ForgeEvent,
  type ProposedChange,
  type ReviewGate,
  type ReviewResult,
  type RunRequest,
  type VerifyResult,
  type WorkspaceIO,
} from '../../src/contracts';
import { DecisionStore, RunTracker } from '../../src/decisions';
import { ForgeEventBus } from '../../src/events';
import { EditorMcpServer } from '../../src/mcp/server';
import { applyHunks, rebaseChange, summarizeHunks } from '../../src/review/hunks';
import { AgentRunner } from '../../src/trueforge/runner';
import { TrueForgeSetup, type AgentDefinition } from '../../src/trueforge/setup';

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

interface Args {
  root: string;
  task: string;
  mode: 'agent' | 'inline';
  file?: string;
  lines?: { start: number; end: number };
  models?: string[];
  rejectHunks: boolean;
  cancelAfterSec?: number;
  trueforgeUrl: string;
  /** Write every ForgeEvent as JSON lines ({t: ms since start, event}) for the panel preview. */
  eventsOut?: string;
  /** After the run, revert it with ApplyGate.revertRun and check the files (Feature 2). */
  revertRun: boolean;
  /** Feature 1 off (verifyBeforeAccept = false). */
  noVerify: boolean;
  /** The auto review waits for the change's shadow test result before deciding. */
  awaitVerify: boolean;
  /** Feature 5: autoApproveSafeCommands. */
  autoApproveSafe: boolean;
  /** Runs of the task with the same runner (Feature 3: the circuit breaker carries over). */
  repeat: number;
}

const USAGE =
  'Usage: node dist/test/headless/runTask.js --root <workspace> --task "<text>" ' +
  '[--mode agent|inline --file <rel> --lines a-b] [--models m1,m2] [--reject-hunks] [--cancel-after <sec>] [--trueforge <url>] [--events-out <file.jsonl>] [--revert-run] ' +
  '[--no-verify] [--await-verify] [--auto-approve-safe] [--repeat <n>]';

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {
    mode: 'agent',
    rejectHunks: false,
    revertRun: false,
    noVerify: false,
    awaitVerify: false,
    autoApproveSafe: false,
    repeat: 1,
    trueforgeUrl: process.env.TRUEFORGE_URL || DEFAULT_CONFIG.trueforgeUrl,
  };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--root':
        out.root = value(i++, flag);
        break;
      case '--task':
        out.task = value(i++, flag);
        break;
      case '--mode': {
        const m = value(i++, flag);
        if (m !== 'agent' && m !== 'inline') throw new Error('--mode must be agent or inline.');
        out.mode = m;
        break;
      }
      case '--file':
        out.file = value(i++, flag);
        break;
      case '--lines': {
        const m = /^(\d+)-(\d+)$/.exec(value(i++, flag));
        if (!m || Number(m[1]) < 1 || Number(m[2]) < Number(m[1])) throw new Error('--lines must look like 28-48.');
        out.lines = { start: Number(m[1]), end: Number(m[2]) };
        break;
      }
      case '--models':
        out.models = value(i++, flag).split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--events-out':
        out.eventsOut = value(i++, flag);
        break;
      case '--reject-hunks':
        out.rejectHunks = true;
        break;
      case '--revert-run':
      case '--revert-after':
        out.revertRun = true;
        break;
      case '--no-verify':
        out.noVerify = true;
        break;
      case '--await-verify':
        out.awaitVerify = true;
        break;
      case '--auto-approve-safe':
        out.autoApproveSafe = true;
        break;
      case '--repeat': {
        const n = Number(value(i++, flag));
        if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error('--repeat needs a whole number from 1 to 10.');
        out.repeat = n;
        break;
      }
      case '--cancel-after': {
        const s = Number(value(i++, flag));
        if (!Number.isFinite(s) || s < 0) throw new Error('--cancel-after needs a number of seconds.');
        out.cancelAfterSec = s;
        break;
      }
      case '--trueforge':
        out.trueforgeUrl = value(i++, flag);
        break;
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
      default:
        throw new Error(`Unknown argument ${flag}.`);
    }
  }
  if (!out.root || !out.task) throw new Error('--root and --task are required.');
  if (out.mode === 'inline' && (!out.file || !out.lines)) throw new Error('--mode inline needs --file and --lines.');
  return out as Args;
}

// ---------------------------------------------------------------------------------------------
// Logging (deltas coalesced per message)
// ---------------------------------------------------------------------------------------------

const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`;
const log = (line: string) => console.log(`${stamp()} ${line}`);
const oneLine = (s: string, max = 160) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};
const indent = (s: string, pad = '           ') => s.replace(/\n$/, '').split('\n').map((l) => pad + l).join('\n');
const thread = (id: string) => (id === 'main' ? '' : ` [${id.slice(-8)}]`);

class EventPrinter {
  private pending: { key: string; kind: 'assistant' | 'reasoning'; threadId: string; text: string } | undefined;

  onEvent(ev: ForgeEvent): void {
    if (ev.type === 'assistant.delta' || ev.type === 'reasoning.delta') {
      const key = `${ev.type}:${ev.messageId}`;
      if (this.pending?.key !== key) {
        this.flush();
        this.pending = { key, kind: ev.type === 'reasoning.delta' ? 'reasoning' : 'assistant', threadId: ev.threadId, text: '' };
        if (ev.type === 'reasoning.delta') log(`thinking…${thread(ev.threadId)}`);
      }
      this.pending.text += ev.text;
      return;
    }
    this.flush();
    const line = describe(ev);
    if (line) log(line);
  }

  flush(): void {
    const p = this.pending;
    this.pending = undefined;
    if (!p) return;
    if (p.kind === 'reasoning') log(`  (thought ${p.text.length} chars${thread(p.threadId)}: "${oneLine(p.text, 100)}")`);
    else if (p.text.trim()) log(`assistant${thread(p.threadId)}:\n${indent(p.text.trim())}`);
  }
}

function describe(ev: ForgeEvent): string | undefined {
  switch (ev.type) {
    case 'run.started':
      return `RUN ${ev.runId} started (${ev.mode}), primary model ${ev.model}`;
    case 'run.session':
      return `session ${ev.sessionId} on ${ev.model}  ${ev.sessionUrl}`;
    case 'tool.call':
      return `→ ${ev.name}${thread(ev.threadId)} ${oneLine(ev.argsPreview, 200)}`;
    case 'tool.result':
      return `← ${thread(ev.threadId).trim()}${oneLine(ev.preview, 200)}`;
    case 'thread.started':
      return `subagent started: "${ev.title}" (${ev.threadId})`;
    case 'thread.finished':
      return `subagent finished (${ev.threadId})`;
    case 'context.picked': {
      const files = ev.pick.files.map(
        (f) => `${f.source === 'explicit' ? '@' : ' '} ${f.path} (${f.ranges.map((r) => `${r.start}-${r.end}`).join(', ') || 'outline'}, ${f.tokens} tok): ${oneLine(f.reasons.slice(0, 2).join('; '), 140)}`,
      );
      return `context picked: ${ev.pick.files.length} files, ${ev.pick.usedTokens}/${ev.pick.budgetTokens} tokens\n${indent(files.join('\n'))}`;
    }
    case 'approval.command': {
      const a = ev.assessment;
      const reasons = (a?.reasons ?? []).join('; ');
      const risk = a ? ` [risk ${a.risk}${a.blocked ? ', BLOCKED' : ''}${reasons ? `: ${reasons}` : ''}]` : '';
      return `command approval requested: ${ev.command} (cwd ${ev.cwd})${risk}`;
    }
    case 'approval.resolved':
      return `command approval: ${ev.decision}${ev.reason ? ` (${oneLine(ev.reason)})` : ''}`;
    case 'review.opened': {
      const body = ev.hunks.map((h) => `${h.header}  (+${h.added} -${h.removed})\n${h.preview}`).join('\n');
      return `REVIEW ${ev.path}${ev.isNewFile ? ' (new file)' : ''}: ${ev.hunks.length} hunk(s)${ev.explanation ? ` — ${ev.explanation}` : ''}\n${indent(body)}`;
    }
    case 'review.updated':
      return undefined;
    case 'review.closed':
      return `review closed: accepted [${ev.result.accepted.join(', ')}] rejected [${ev.result.rejected.join(', ')}]${ev.result.cancelled ? ' (cancelled)' : ''}`;
    case 'edit.applied':
      return `APPLIED ${ev.record.path}${ev.record.createdFile ? ' (created)' : ''}: hunks [${ev.record.hunksApplied.join(', ')}]`;
    case 'edit.undone':
      return `undone ${ev.record.path}`;
    case 'model.retry':
      return `RETRY ${ev.model} (attempt ${ev.attempt}) in ${ev.delayMs} ms: ${oneLine(ev.reason)}`;
    case 'model.fallback':
      return `FALLBACK ${ev.from} → ${ev.to}: ${oneLine(ev.reason)}`;
    case 'model.resume':
      return `RESUME session ${ev.sessionId}: ${ev.from} → ${ev.to}: ${oneLine(ev.reason)}`;
    case 'model.health': {
      const extra = [ev.reason && oneLine(ev.reason, 120), ev.retryAt && `retry after ${ev.retryAt}`, ev.latencyMs !== undefined && `${ev.latencyMs} ms`].filter(Boolean);
      return `model ${ev.model}: ${ev.status}${extra.length ? ` (${extra.join(', ')})` : ''}`;
    }
    case 'verify.started':
      return `VERIFY started: ${ev.command}${ev.tests?.length ? ` (${ev.tests.join(', ')})` : ''}`;
    case 'verify.finished': {
      const r = ev.result;
      const tail = r.outputTail && (r.status === 'failed' || r.status === 'error') ? `\n${indent(r.outputTail.trimEnd())}` : '';
      return `VERIFY ${r.status}: ${r.summary} (${(r.durationMs / 1000).toFixed(1)} s)${tail}`;
    }
    case 'run.reverted':
      return `REVERTED run ${ev.runId}: ${[...new Set(ev.records.map((r) => r.path))].join(', ')} (${ev.records.length} change(s))`;
    case 'context.usage': {
      const of = ev.contextLength ? `/${ev.contextLength} (${Math.round((100 * ev.inputTokens) / ev.contextLength)}%)` : '';
      const parts = ev.breakdown ? Object.entries(ev.breakdown).map(([k, v]) => `${k} ${v}`) : [];
      return `context ${ev.model}${thread(ev.threadId)}: in ${ev.inputTokens}${of}, out ${ev.outputTokens}${parts.length ? ` [${parts.join(', ')}]` : ''}`;
    }
    case 'subagent.savings':
      return `subagent "${ev.title}"${thread(ev.threadId)}: read ${ev.contextTokens} tok, returned ${ev.returnedTokens} tok to the main agent`;
    case 'notice':
      return `[${ev.level}] ${ev.text}`;
    case 'run.finished':
      return `RUN ${ev.runId} finished: ${ev.status}${ev.model ? ` (model ${ev.model})` : ''}${ev.message ? `: ${oneLine(ev.message, 400)}` : ''}`;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Workspace and gates
// ---------------------------------------------------------------------------------------------

export class FsWorkspaceIO implements WorkspaceIO {
  constructor(readonly root: string) {}

  async readText(relPath: string): Promise<string | undefined> {
    const abs = path.resolve(this.root, relPath);
    const rel = path.relative(this.root, abs);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
    try {
      return await fs.readFile(abs, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined;
      throw err;
    }
  }
}

/**
 * Accepts (or with --reject-hunks rejects) every hunk; emits the same review events as the UI.
 * With awaitVerifyMs > 0 it first waits (at most that long) for the change's shadow test result.
 */
class AutoReviewGate implements ReviewGate {
  constructor(
    private readonly bus: ForgeEventBus,
    private readonly reject: boolean,
    private readonly awaitVerifyMs = 0,
  ) {}

  async review(change: ProposedChange, signal: AbortSignal): Promise<ReviewResult> {
    const idx = change.hunks.map((h) => h.index);
    const cancelled = (): ReviewResult => ({ changeId: change.id, decisions: idx.map(() => 'rejected'), accepted: [], rejected: idx, cancelled: true, note: 'run cancelled' });
    if (signal.aborted) return cancelled();
    this.bus.emit({
      type: 'review.opened',
      runId: change.runId,
      changeId: change.id,
      path: change.path,
      explanation: change.explanation,
      isNewFile: change.isNewFile,
      hunks: summarizeHunks(change.hunks),
    });
    if (this.awaitVerifyMs > 0) {
      const t = Date.now();
      const verified = await this.waitForVerify(change.id, signal);
      if (verified) log(`review: waited ${Date.now() - t} ms for the shadow test result (${verified.status})`);
      if (signal.aborted) {
        const result = cancelled();
        this.bus.emit({ type: 'review.closed', changeId: change.id, result });
        return result;
      }
    }
    const result: ReviewResult = this.reject
      ? { changeId: change.id, decisions: idx.map(() => 'rejected'), accepted: [], rejected: idx, note: 'Rejected by the headless harness (--reject-hunks).' }
      : { changeId: change.id, decisions: idx.map(() => 'accepted'), accepted: idx, rejected: [] };
    this.bus.emit({ type: 'review.closed', changeId: change.id, result });
    return result;
  }

  discardRun(runId: number): void {
    log(`review: discarded open reviews of run ${runId}`);
  }

  /**
   * The runner opens the review and then starts the shadow run in the same tick, so a
   * verify.started for this change arrives before the next macrotask; without one there is
   * nothing to wait for.
   */
  private waitForVerify(changeId: string, signal: AbortSignal): Promise<VerifyResult | undefined> {
    return new Promise((resolve) => {
      let started = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (r?: VerifyResult) => {
        if (settled) return;
        settled = true;
        off();
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const onAbort = () => finish(undefined);
      const off = this.bus.on((ev) => {
        if (ev.type === 'verify.started' && ev.changeId === changeId) started = true;
        else if (ev.type === 'verify.finished' && ev.result?.changeId === changeId) finish(ev.result);
      });
      signal.addEventListener('abort', onAbort, { once: true });
      setImmediate(() => {
        if (!started) finish(undefined);
        else if (!settled) timer = setTimeout(() => finish(undefined), this.awaitVerifyMs);
      });
    });
  }
}

/** Writes accepted hunks straight to disk, with an undo stack. Applies, undos and reverts are serialized. */
export class FsApplyGate implements ApplyGate {
  private readonly stack: ApplyRecord[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly io: FsWorkspaceIO,
    private readonly bus: ForgeEventBus,
  ) {}

  applyAccepted(change: ProposedChange, result: ReviewResult): Promise<ApplyRecord | undefined> {
    if (result.accepted.length === 0) return Promise.resolve(undefined);
    return this.serialize(() => this.doApply(change, result));
  }

  undoLast(): Promise<ApplyRecord | undefined> {
    return this.serialize(() => this.doUndo());
  }

  /**
   * Feature 2: restore every file the run changed, newest first, to its text from before the run's
   * first edit to it (created files are deleted). Headless: nobody to ask, so it always restores.
   */
  revertRun(runId: number): Promise<ApplyRecord[]> {
    return this.serialize(() => this.doRevertRun(runId));
  }

  /** Applied changes still on the undo stack, oldest first. */
  get records(): readonly ApplyRecord[] {
    return this.stack;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doApply(change: ProposedChange, result: ReviewResult): Promise<ApplyRecord | undefined> {
    const current = await this.io.readText(change.path);
    if (current === undefined && !change.isNewFile) throw new Error(`${change.path} no longer exists.`);
    if (current !== undefined && change.isNewFile && current !== change.originalText) {
      throw new Error(`a different ${change.path} appeared after the proposal.`);
    }
    const before = current ?? '';
    // Zero-context hunks apply to the text they were computed from; carry the result over to the
    // current text with context checks (throws if the file changed where the hunks are).
    const target = applyHunks(change.originalText, change.hunks, result.accepted);
    const after = current === undefined ? target : rebaseChange(change.originalText, target, current, change.path);
    if (current !== undefined && after === current) return undefined;
    await fs.mkdir(path.dirname(change.absPath), { recursive: true });
    await fs.writeFile(change.absPath, after, 'utf8');
    const record: ApplyRecord = {
      changeId: change.id,
      runId: change.runId,
      path: change.path,
      absPath: change.absPath,
      beforeText: before,
      afterText: after,
      createdFile: current === undefined,
      hunksApplied: [...result.accepted],
      hunksRejected: [...result.rejected],
    };
    this.stack.push(record);
    this.bus.emit({ type: 'edit.applied', runId: change.runId, record });
    return record;
  }

  private async doUndo(): Promise<ApplyRecord | undefined> {
    const record = this.stack.pop();
    if (!record) return undefined;
    if (record.createdFile) await fs.rm(record.absPath, { force: true });
    else await fs.writeFile(record.absPath, record.beforeText, 'utf8');
    this.bus.emit({ type: 'edit.undone', record });
    return record;
  }

  private async doRevertRun(runId: number): Promise<ApplyRecord[]> {
    // one group per file, newest record first; Map order = order of each file's newest edit
    const groups = new Map<string, ApplyRecord[]>();
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const r = this.stack[i];
      if (r.runId !== runId) continue;
      const group = groups.get(r.absPath);
      if (group) group.push(r);
      else groups.set(r.absPath, [r]);
    }
    const reverted: ApplyRecord[] = [];
    try {
      for (const group of groups.values()) {
        const oldest = group[group.length - 1];
        if (oldest.createdFile) {
          await fs.rm(oldest.absPath, { force: true });
        } else {
          await fs.mkdir(path.dirname(oldest.absPath), { recursive: true });
          await fs.writeFile(oldest.absPath, oldest.beforeText, 'utf8');
        }
        for (const r of group) this.stack.splice(this.stack.indexOf(r), 1);
        reverted.push(...group);
      }
    } finally {
      if (reverted.length) this.bus.emit({ type: 'run.reverted', runId, records: reverted });
    }
    return reverted;
  }
}

class AutoCommandGate implements CommandGate {
  private seq = 0;

  constructor(private readonly bus: ForgeEventBus) {}

  async approve(req: CommandRequest, signal: AbortSignal): Promise<CommandDecision> {
    const requestId = `cmd-${++this.seq}`;
    const decision: CommandDecision = signal.aborted ? 'deny' : 'once';
    this.bus.emit({
      type: 'approval.command',
      runId: req.runId,
      requestId,
      command: req.command,
      cwd: req.cwd,
      toolCallId: req.toolCallId,
      assessment: req.assessment,
    });
    this.bus.emit({ type: 'approval.resolved', runId: req.runId, requestId, decision });
    return decision;
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

/** Shadow test output, printed line by line (pytest -q sends its progress dots one chunk at a time). */
function shadowOutputPrinter(): (chunk: string) => void {
  let partial = '';
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (partial) process.stdout.write(`           ‖ ${partial}\n`);
    partial = '';
  };
  return (chunk) => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) process.stdout.write(`           ‖ ${line}\n`);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 500);
    flushTimer.unref();
  };
}

function definition(json: { name: string; description: string; manifest: unknown }): AgentDefinition {
  return { name: json.name, description: json.description, manifest: structuredClone(json.manifest) as Record<string, unknown> };
}

/** Last turn state of a session as TrueForge reports it (verifies remote cancellation). */
async function remoteTurnStatus(baseUrl: string, sessionId: string): Promise<string> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`, { signal: AbortSignal.timeout(5000) });
    const body = (await res.json()) as { data?: Array<{ state?: { status?: string; reason?: string; message?: string } }> };
    const turns = body.data ?? [];
    const state = turns[turns.length - 1]?.state;
    return state ? [state.status, state.reason ?? state.message].filter(Boolean).join(' / ') : 'no turns';
  } catch (err) {
    return `unknown (${err instanceof Error ? err.message : String(err)})`;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  if (!(await fs.stat(root).catch(() => undefined))?.isDirectory()) throw new Error(`--root ${root} is not a directory.`);
  const cfg: ForgeConfig = {
    ...DEFAULT_CONFIG,
    trueforgeUrl: args.trueforgeUrl.replace(/\/+$/, ''),
    models: args.models?.length ? args.models : DEFAULT_CONFIG.models,
    verifyBeforeAccept: !args.noVerify,
    autoApproveSafeCommands: args.autoApproveSafe,
  };

  const io = new FsWorkspaceIO(root);
  const bus = new ForgeEventBus();
  const printer = new EventPrinter();
  bus.on((ev) => printer.onEvent(ev));
  if (args.eventsOut) {
    const t0 = Date.now();
    const sink = (await import('node:fs')).createWriteStream(path.resolve(args.eventsOut));
    bus.on((ev) => sink.write(JSON.stringify({ t: Date.now() - t0, event: ev }) + '\n'));
  }
  // --revert-run: each file as it was before the run first touched it (undefined = did not exist).
  // review.opened is emitted synchronously before the change is applied, so this is the pre-run text.
  const preRun = new Map<string, string | undefined>();
  if (args.revertRun) {
    const { readFileSync } = await import('node:fs');
    bus.on((ev) => {
      if (ev.type !== 'review.opened' || preRun.has(ev.path)) return;
      try {
        preRun.set(ev.path, readFileSync(path.resolve(root, ev.path), 'utf8'));
      } catch {
        preRun.set(ev.path, undefined);
      }
    });
  }
  const decisions = new DecisionStore();
  const runs = new RunTracker();
  const context = new RepoContextEngine(io);
  const review = new AutoReviewGate(bus, args.rejectHunks, args.awaitVerify ? (cfg.verifyTimeoutSec + 10) * 1000 : 0);
  const apply = new FsApplyGate(io, bus);
  const commands = new AutoCommandGate(bus);
  const mcp = new EditorMcpServer({
    io,
    context,
    bus,
    decisions,
    runs,
    review,
    apply,
    commandTimeoutSec: () => cfg.commandTimeoutSec,
    onCommandOutput: (chunk) => process.stdout.write(indent(chunk, '           | ') + '\n'),
  });

  const setup = new TrueForgeSetup(cfg.trueforgeUrl);
  if (!(await setup.health())) throw new Error(`TrueForge is not reachable at ${cfg.trueforgeUrl}. Start it with scripts/start-trueforge.sh.`);
  const ep = await mcp.start(0);
  try {
    const tools = await setup.registerMcpServer(ep.url, ep.token);
    log(`MCP server ${ep.url} registered with TrueForge (${tools.length} tools)`);
    const available = await setup.listModels();
    const missing = cfg.models.filter((m) => !available.includes(m));
    if (missing.length) log(`[warn] not configured in TrueForge: ${missing.join(', ')}`);
    log(`workspace ${root}; models ${cfg.models.join(' → ')}`);
    log(
      `shadow tests ${cfg.verifyBeforeAccept ? `on${args.awaitVerify ? ' (reviews wait for them)' : ''}` : 'off'}; ` +
        `command guard on${cfg.autoApproveSafeCommands ? ', safe commands auto-approved' : ''}`,
    );

    const runner = new AgentRunner({
      config: () => cfg,
      bus,
      decisions,
      runs,
      review,
      commands,
      io,
      context,
      setup,
      agentDefinition: definition(agentJson),
      inlineAgentDefinition: definition(inlineAgentJson),
      verifier: new ShadowVerifier(io, { config: () => cfg, onOutput: shadowOutputPrinter() }),
      guard: new CommandGuard(),
    });

    let exitCode = 0;
    for (let rep = 1; rep <= args.repeat; rep++) {
      if (args.repeat > 1) console.log(`\n=== Repetition ${rep}/${args.repeat} ===`);
      preRun.clear();
      const req: RunRequest = { mode: args.mode, text: args.task };
      if (args.mode === 'inline') {
        const text = await io.readText(args.file!);
        if (text === undefined) throw new Error(`--file ${args.file} does not exist in ${root}.`);
        const lines = text.split('\n');
        const { start, end } = args.lines!;
        if (end > lines.length) throw new Error(`--lines ${start}-${end} is past the end of ${args.file} (${lines.length} lines).`);
        req.inlineTarget = { path: args.file!.replace(/\\/g, '/'), startLine: start, endLine: end, selectedText: lines.slice(start - 1, end).join('\n') };
      }

      let cancelAt: number | undefined;
      let cancelling: Promise<void> | undefined;
      const cancel = () => {
        if (cancelAt !== undefined) return;
        cancelAt = Date.now();
        log('CANCEL requested');
        cancelling = runner.cancel().then(() => log(`cancel() returned after ${Date.now() - cancelAt!} ms`));
      };
      process.once('SIGINT', cancel);
      const timer = args.cancelAfterSec !== undefined ? setTimeout(cancel, args.cancelAfterSec * 1000) : undefined;

      const started = Date.now();
      const outcome = await runner.run(req);
      const ended = Date.now();
      if (timer) clearTimeout(timer);
      process.off('SIGINT', cancel);
      await cancelling; // the remote cancel must land before the remote status is read
      printer.flush();

      console.log(`\n=== Summary${args.repeat > 1 ? ` (repetition ${rep}/${args.repeat})` : ''} ===`);
      console.log(`status:   ${outcome.status}`);
      console.log(`model:    ${outcome.model ?? '-'}`);
      console.log(`session:  ${outcome.sessionId ? setup.sessionUrl(outcome.sessionId) : '-'}`);
      if (outcome.sessionId) console.log(`remote:   last turn ${await remoteTurnStatus(cfg.trueforgeUrl, outcome.sessionId)}`);
      console.log(`elapsed:  ${((ended - started) / 1000).toFixed(1)} s`);
      if (cancelAt !== undefined) console.log(`cancel:   run ended ${ended - cancelAt} ms after the cancel request`);
      console.log(`changed:  ${outcome.applied.length ? '' : 'none'}`);
      for (const r of outcome.applied) {
        console.log(`  ${r.path}${r.createdFile ? ' (created)' : ''}: hunks applied [${r.hunksApplied.join(', ')}], rejected [${r.hunksRejected.join(', ')}]`);
      }
      if (outcome.message) console.log(`${(outcome.status === 'done' ? 'final:' : 'message:').padEnd(10)}${outcome.message.trim()}`);
      let revertOk = true;
      if (args.revertRun) revertOk = await revertAndCheck(apply, io, outcome.runId, outcome.applied, preRun);
      else if (rep < args.repeat) {
        // the next repetition starts from the same workspace
        const reverted = await apply.revertRun(outcome.runId);
        console.log(`(reverted ${reverted.length} change(s) of run ${outcome.runId} before the next repetition)`);
      }
      const code = !revertOk ? 1 : outcome.status === 'done' ? 0 : outcome.status === 'cancelled' && args.cancelAfterSec !== undefined ? 0 : 1;
      exitCode = Math.max(exitCode, code);
    }
    return exitCode;
  } finally {
    await mcp.stop();
  }
}

/** --revert-run: revert the whole run, then check every changed file against its pre-run text. */
async function revertAndCheck(
  apply: FsApplyGate,
  io: FsWorkspaceIO,
  runId: number,
  applied: ApplyRecord[],
  preRun: Map<string, string | undefined>,
): Promise<boolean> {
  console.log('\n=== Revert run ===');
  const reverted = await apply.revertRun(runId);
  const files = [...new Set(reverted.map((r) => r.path))];
  console.log(`reverted: ${files.length ? `${files.length} file(s), ${reverted.length} change(s): ${files.join(', ')}` : 'nothing to revert'}`);
  let ok = true;
  for (const rel of new Set(applied.map((r) => r.path))) {
    const now = await io.readText(rel);
    const first = applied.find((r) => r.path === rel)!;
    const want = preRun.has(rel) ? preRun.get(rel) : first.createdFile ? undefined : first.beforeText;
    const fine = now === want;
    ok &&= fine;
    console.log(`  ${fine ? 'OK  ' : 'FAIL'} ${rel}: ${want === undefined ? 'created by the run' : 'existed'}, now ${now === undefined ? 'absent' : now === want ? 'as before the run' : 'DIFFERENT from before the run'}`);
  }
  if (apply.records.some((r) => r.runId === runId)) {
    ok = false;
    console.log('  FAIL records of the run are still on the undo stack');
  }
  console.log(`revert check: ${ok ? 'PASS' : 'FAIL'}`);
  return ok;
}

if (process.env.FORGELIGHT_HEADLESS_IMPORT !== '1') {
  main().then(
    (code) => {
      process.exitCode = code;
      // SDK keep-alive sockets can hold the loop open; nothing else is pending here.
      setTimeout(() => process.exit(code), 300).unref();
    },
    (err: unknown) => {
      console.error(`runTask: ${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
      process.exit(2);
    },
  );
}
