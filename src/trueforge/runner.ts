/**
 * AgentRunner (PURE, no vscode): runs one Forgelight request as ONE TrueForge session.
 *
 * The agent loop runs entirely on TrueForge; this class never talks to a model provider. It
 * streams turns onto the ForgeEventBus, answers TrueForge's tool approvals (propose_edit ->
 * hunk review with a concurrent shadow test run, run_command -> command guard + gate), resumes a
 * dropped event stream, cancels, and keeps the run alive through model outages: it retries the
 * failing model on the same session, then switches that session to the next model
 * (sessions.update) and continues with the full history, skipping models whose circuit breaker
 * is open. It also reports per-call context usage and what each sub-agent saved the main agent.
 */
import * as path from 'node:path';
import {
  TrueForge,
  TrueForgeError,
  TrueForgeTimeoutError,
  isEventDelta,
  mergeEventDelta,
  type TrueForgeApi,
} from '@truefoundry/trueforge-sdk';
import {
  MCP_SERVER_NAME,
  type ApplyRecord,
  type CommandAssessment,
  type CommandAssessor,
  type CommandGate,
  type CommandResolution,
  type ContextEngine,
  type ContextFilePick,
  type ContextPick,
  type ForgeConfig,
  type ForgeEvent,
  type ProposedChange,
  type ReviewGate,
  type RunOutcome,
  type RunRequest,
  type RunStatus,
  type Verifier,
  type VerifyResult,
  type WorkspaceIO,
} from '../contracts';
import type { DecisionStore, RunTracker } from '../decisions';
import { estimateTokens, sleep, type ForgeEventBus } from '../events';
import { argsKey, computeHunks, computeProposal, normalizePath, pickProposeArgs } from '../review/hunks';
import { NOT_AUTO_APPROVABLE } from '../safety/commandGuard';
import type { AgentDefinition, TrueForgeSetup } from './setup';

type StreamEvent = TrueForgeApi.TurnStreamingEvent;
type ModelMessage = TrueForgeApi.ModelMessageEvent;
type ToolCall = TrueForgeApi.ToolCall;
type TurnInput = TrueForgeApi.TurnUserEventMessage;
type DoneState = TrueForgeApi.TurnDoneEventState;

/** The TrueForge session calls the runner makes (the real SDK client by default; tests pass a fake). */
export type RunnerSessions = Pick<
  TrueForge['sessions'],
  'create' | 'update' | 'cancel' | 'createTurnStream' | 'createTurnEvents' | 'subscribeToTurn' | 'getTurn'
>;
export interface RunnerClient {
  readonly sessions: RunnerSessions;
}

export interface AgentRunnerDeps {
  config: () => ForgeConfig;
  bus: ForgeEventBus;
  decisions: DecisionStore;
  runs: RunTracker;
  review: ReviewGate;
  commands: CommandGate;
  io: WorkspaceIO;
  context: ContextEngine;
  setup: TrueForgeSetup;
  agentDefinition: AgentDefinition;
  /**
   * Optional dedicated inline-edit agent (agent/forgelight-inline.agent.json). When given, inline
   * runs use it as-is (model overridden, iteration limit capped by config); otherwise inline runs
   * use agentDefinition with subagents off and only read_file + propose_edit preloaded.
   */
  inlineAgentDefinition?: AgentDefinition;
  /** Feature 1: runs the relevant tests on a shadow copy while a change is under review. */
  verifier?: Verifier;
  /** Feature 5: classifies every run_command (risk badge, hard blocks, optional auto-approval). */
  guard?: CommandAssessor;
  /** Test seam: builds the TrueForge client of a run (default: the SDK client). */
  createClient?: (baseUrl: string, timeoutInSeconds: number) => RunnerClient;
}

/** Heading of the automatically retrieved context appended to agent-mode messages. */
export const CONTEXT_SECTION_HEADING = 'Context picked by Forgelight';

const PREVIEW_MAX = 300;
/** Retrieval budget floor when @-mentions already use most of contextBudgetTokens. */
const MIN_RETRIEVAL_TOKENS = 500;
/** Consecutive stream resumes without new events before giving up. */
const MAX_STREAM_RESUMES = 3;
/** The SSE stream stays open while the user reviews, so the HTTP timeout must be long. */
const STREAM_TIMEOUT_S = 3600;
/** Human-readable one-liner for a tool call (shown in the panel instead of raw JSON). */
export function describeArgs(tool: string, argsText: string): string {
  const a = parseJson(argsText);
  if (!isRecord(a)) return compactJson(argsText);
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
  const n = (k: string) => (typeof a[k] === 'number' ? (a[k] as number) : undefined);
  const q = (v: string | undefined) => (v === undefined ? '' : `"${v.replace(/\s+/g, ' ').trim()}"`);
  switch (tool) {
    case 'read_file': {
      const from = n('start_line');
      const to = n('end_line');
      return `${s('path') ?? '?'}${from || to ? `:${from ?? 1}-${to ?? 'end'}` : ''}`;
    }
    case 'search_code':
      return `${q(s('query'))}${a.regex ? ' (regex)' : ''}${s('glob') ? ` in ${s('glob')}` : ''}`;
    case 'find_symbol':
      return s('name') ?? compactJson(argsText);
    case 'list_files':
      return s('dir') ?? '(workspace root)';
    case 'repo_map':
      return n('max_tokens') ? `max ${n('max_tokens')} tokens` : '(whole repository)';
    case 'retrieve_context':
      return `${q(s('query'))}${n('budget_tokens') ? ` · budget ${n('budget_tokens')} tokens` : ''}`;
    case 'propose_edit': {
      const edits = Array.isArray(a.edits) ? a.edits.length : 0;
      const what = typeof a.new_content === 'string' ? 'new file' : `${edits} edit${edits === 1 ? '' : 's'}`;
      return `${s('path') ?? '?'} · ${what}${s('explanation') ? ` · ${s('explanation')}` : ''}`;
    }
    case 'run_command':
      return `$ ${s('command') ?? ''}`;
    case 'create_sub_agent':
      return `${s('name') ?? 'sub-agent'}${s('input') ? ` · ${s('input')!.replace(/\s+/g, ' ').trim()}` : ''}`;
    default:
      return compactJson(argsText);
  }
}

/** Read through a function: TypeScript would keep the narrowing from `state.lastCommand = undefined` across the turn. */
function lastCommandOf(state: RunState): RunState['lastCommand'] {
  return state.lastCommand;
}

/** Follow-up turns sent when an agent-mode turn ends while its last command was failing. */
const VERIFY_FOLLOW_UPS = 2;

/** Parse our run_command tool output ("$ cmd\nexit code: N\n<tail>"); undefined if not one. */
function parseCommandResult(content: string): { command: string; exitCode: number; tail: string } | undefined {
  const m = /^\$ ([^\n]*)\nexit code: (-?\d+)/.exec(content);
  if (!m) return undefined;
  const rest = content.slice(m[0].length).trim();
  return { command: m[1], exitCode: Number(m[2]), tail: rest.length > 2500 ? rest.slice(-2500) : rest };
}

function verifyFollowUp(failed: { command: string; exitCode: number; tail: string }): string {
  return [
    `The last command you ran still fails (exit code ${failed.exitCode}):`,
    '```',
    `$ ${failed.command}`,
    failed.tail,
    '```',
    'Find the cause and fix it with propose_edit. Your earlier accepted edits are already applied, so re-read the',
    'affected file ranges with read_file before proposing, and do not re-propose changes that are already there.',
    'If the failure is in a test you wrote, check what the fixtures and the code under test really do (for example',
    'read the fixture definitions) and correct the expectation or the code. Then run the same command again and',
    'only finish when it passes, with a short summary of every file you changed.',
  ].join('\n');
}

/**
 * Follow-up turn when an agent-mode turn ends while the tests of its newest shadow run still fail on
 * the workspace as it is now. The agent's own commands can hide that: `pytest … | tail` exits 0, a
 * `python` that is not installed prints "command not found" with exit 0 through the pipe, or the
 * last command was an `ls`.
 */
export function shadowFollowUp(file: string, r: VerifyResult): string {
  return [
    `Forgelight re-ran the tests that cover ${file} on the workspace as it is now, and they fail (${r.summary}):`,
    '```',
    ...(r.command ? [`$ ${r.command}`] : []),
    (r.outputTail ?? '').trim() || '(no output)',
    '```',
    'The task is not done while these tests fail. Find the cause and fix it with propose_edit. Your earlier',
    'accepted edits are already applied, so re-read the affected file ranges with read_file before proposing, and',
    'do not re-propose changes that are already there. If the failure is in a test you wrote, check what the',
    'fixtures and the code under test really do and correct the expectation or the code. Then run that command',
    'again with run_command and only finish when it passes, with a short summary of every file you changed.',
  ].join('\n');
}

/** Follow-up turns sent when a turn ends announcing work it did not do (small models stall like this). */
const STALL_NUDGES = 1;

/**
 * True when a final message reads like a step the model announced but did not take, e.g. "The
 * sub-agent is investigating. Let me wait for its response" or "Now let me update the docs:".
 */
export function looksUnfinished(output: string): boolean {
  const tail = output.replace(/\s+/g, ' ').trim().slice(-400);
  if (!tail || tail === 'Done.') return false;
  // Closing offers are the end of a finished answer, not an announced step.
  if (/\b(let me know|if you('d| would)? (like|want|prefer)|feel free|happy to)\b/i.test(tail)) return false;
  if (/:\s*$/.test(tail)) return true;
  return /\b(let me|i'll|i will|i am going to|i'm going to|next,? i|wait(ing)? for|once (it|the sub-?agent|they) (reports?|returns?|finish(es)?|responds?)|before proceeding|i'll continue)\b/i.test(tail);
}

/** Message of the turn that nudges a stalled run (see looksUnfinished). */
export function stallFollowUp(inline: boolean, proposals: number): string {
  if (inline) {
    return (
      'You ended the turn without calling propose_edit, so nothing was changed. Call propose_edit now with the ' +
      'edit for the selected code (exact "path" from the request, search/replace "edits"). Do not answer in text.'
    );
  }
  return [
    'You ended your turn with a step you announced but did not take. Nothing is running in the background:',
    'every tool call and sub-agent has already returned its result above (an empty sub-agent result means it',
    'found nothing useful, so explore yourself with retrieve_context, search_code and read_file).',
    proposals === 0
      ? 'No edit has been proposed yet. Continue the task now: read the exact ranges you need and call propose_edit.'
      : 'Continue the task now from where you stopped; edits that were accepted are already applied.',
    'Only finish when the whole request is done, with a short summary of every file you changed.',
  ].join('\n');
}

/**
 * Message of the turn that resumes a run after a model failed mid-task (the failed turn produced
 * output or tool calls). The session keeps the whole history, so the new model only needs to know
 * what happened and that accepted edits are already on disk.
 */
export function continuationMessage(from: string, to: string, reason: string): string {
  const why = clip(reason.replace(/\s+/g, ' ').trim() || 'unknown error', 300);
  const who =
    from === to
      ? `The previous call to ${from} failed mid-task: ${why}. You are still running as ${to} with the full conversation so far.`
      : `The previous model (${from}) failed mid-task: ${why}. You are now running as ${to} with the full conversation so far.`;
  return (
    `${who} Continue the task from where it stopped. Edits that were already accepted are applied in the workspace; ` +
    're-read affected files before editing them again and do not repeat finished steps.'
  );
}

/**
 * Message of the turn after one that failed BEFORE producing output, on the same session: that
 * turn's user.message (the request) is already in the history, so only this note is sent.
 */
export function retryMessage(from: string, to: string, reason: string): string {
  const why = clip(reason.replace(/\s+/g, ' ').trim() || 'unknown error', 300);
  const who =
    from === to
      ? `The previous call to ${from} failed before producing any output (${why}); trying ${to} again.`
      : `The previous model (${from}) failed before producing any output (${why}); you are now running as ${to}.`;
  return `${who} Nothing of the request above was done yet: handle it now, exactly as asked.`;
}

/** One line about a shadow test run for the agent (appended to the review note / deny reason). */
export function verifyNote(result: VerifyResult): string | undefined {
  const tests = result.tests.length ? ` (${clip(result.tests.join(', '), 120)})` : '';
  const summary = clip(result.summary.replace(/\s+/g, ' ').trim(), 200);
  switch (result.status) {
    case 'passed':
      return `Shadow tests with all hunks applied${tests}: ${summary}.`;
    case 'failed':
      return `Shadow tests with all hunks applied${tests} FAILED: ${summary}.`;
    case 'error':
      return `The shadow test run with all hunks applied could not complete: ${summary}.`;
    default:
      return undefined;
  }
}

/**
 * Feature 3: remembers models that just failed so the next runs skip them for a while.
 * The breaker records WHEN a model failed; how long that counts is the CURRENT
 * forgelight.circuitBreakerMinutes, passed on every check (so 0 turns an open breaker off at
 * once, and a lower value applies at once). Pure (clock injectable) so it can be unit-tested.
 */
export class CircuitBreaker {
  private readonly open = new Map<string, { trippedAt: number; reason: string }>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * `model` just failed: open its breaker. Returns when it closes under `minutes`, or undefined
   * when `minutes` <= 0 (breaker off, nothing is recorded).
   */
  trip(model: string, minutes: number, reason: string): { until: number; reason: string } | undefined {
    if (!breakerOn(minutes)) return undefined;
    const trippedAt = this.now();
    this.open.set(model, { trippedAt, reason });
    return { until: trippedAt + minutes * 60_000, reason };
  }

  /** The model worked: close its breaker. Returns true if it was open. */
  close(model: string): boolean {
    return this.open.delete(model);
  }

  /**
   * The open breaker of `model` under the current setting `minutes`, or undefined. Expired entries,
   * and every entry while the breaker is off (`minutes` <= 0), are dropped.
   */
  status(model: string, minutes: number): { until: number; reason: string } | undefined {
    const entry = this.open.get(model);
    if (!entry) return undefined;
    const until = entry.trippedAt + (breakerOn(minutes) ? minutes * 60_000 : 0);
    if (until <= this.now()) {
      this.open.delete(model);
      return undefined;
    }
    return { until, reason: entry.reason };
  }

  /**
   * Models to try in order, and those skipped because their breaker is open under the current
   * setting `minutes`. When EVERY model is open the breaker is ignored (`ignored`), since skipping
   * all of them would make the run fail anyway.
   */
  plan(models: string[], minutes: number): { usable: string[]; skipped: Array<{ model: string; until: number; reason: string }>; ignored: boolean } {
    const skipped: Array<{ model: string; until: number; reason: string }> = [];
    const usable: string[] = [];
    for (const model of models) {
      const entry = this.status(model, minutes);
      if (entry) skipped.push({ model, ...entry });
      else usable.push(model);
    }
    if (usable.length === 0 && models.length > 0) return { usable: [...models], skipped: [], ignored: true };
    return { usable, skipped, ignored: false };
  }

  /** Forget everything (the models setting changed). Returns the models that had an open breaker. */
  reset(): string[] {
    const models = [...this.open.keys()];
    this.open.clear();
    return models;
  }
}

/** forgelight.circuitBreakerMinutes turns the breaker on (a positive number). */
function breakerOn(minutes: number): boolean {
  return Number.isFinite(minutes) && minutes > 0;
}

const INLINE_PRELOAD_TOOLS = ['read_file', 'propose_edit'];
/** Keys of call_tool (deferred MCP tool) arguments that may hold the real tool arguments. */
const CALL_TOOL_ARG_KEYS = ['arguments', 'input', 'tool_input', 'args', 'params'];
const MODEL_FAILURE_RE =
  /\[Model Error\]|cannot connect|ECONNREFUSED|ENOTFOUND|fetch failed|401|403|404 model|429|\b5\d\d\b|timed? ?out|rate.?limit|api key|unauthori[sz]ed|authentication|overloaded/i;
const UNREACHABLE_RE = /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|socket hang up|network/i;

// ---------------------------------------------------------------------------------------------
// Agent spec (snake_case REST manifest -> SDK camelCase AgentSpec)
// ---------------------------------------------------------------------------------------------

/** Subtrees copied verbatim: their keys are data (JSON Schema, provider params), not spec fields. */
const VERBATIM_KEYS = new Set(['params', 'schema', 'metadata', 'headers']);

const snakeToCamel = (key: string) => key.replace(/(?<=[A-Za-z0-9])_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Deeply convert object KEYS from snake_case to camelCase; string values are never touched. */
export function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[snakeToCamel(key)] = VERBATIM_KEYS.has(key) ? structuredClone(v) : camelizeKeys(v);
  }
  return out;
}

/** Name of the editor MCP server in the agent manifest (MCP_SERVER_NAME unless renamed). */
export function editorServerName(manifest: Record<string, unknown>): string {
  const servers = Array.isArray(manifest.mcp_servers) ? manifest.mcp_servers : [];
  const names = servers.map((s) => (isRecord(s) ? s.name : undefined)).filter((n): n is string => typeof n === 'string');
  return names.includes(MCP_SERVER_NAME) ? MCP_SERVER_NAME : (names[0] ?? MCP_SERVER_NAME);
}

export function buildAgentSpec(
  manifest: Record<string, unknown>,
  opts: { model: string; iterationLimit: number; inline: boolean },
): TrueForgeApi.AgentSpec {
  const spec = camelizeKeys(manifest) as Record<string, unknown>;
  spec.model = { ...(isRecord(spec.model) ? spec.model : {}), name: opts.model };
  const config: Record<string, unknown> = isRecord(spec.config) ? spec.config : {};
  const limit = Number.isFinite(opts.iterationLimit) ? Math.floor(opts.iterationLimit) : 60;
  config.iterationLimit = Math.min(1024, Math.max(1, limit));
  spec.config = config;
  if (opts.inline) {
    const sub = isRecord(config.dynamicSubAgents) ? config.dynamicSubAgents : {};
    config.dynamicSubAgents = { ...sub, enabled: false };
    const editor = editorServerName(manifest);
    for (const server of Array.isArray(spec.mcpServers) ? spec.mcpServers : []) {
      if (isRecord(server) && server.name === editor) {
        server.preloadTools = [...INLINE_PRELOAD_TOOLS];
        server.preload = false; // preload:true would load every tool and override the list
      }
    }
  }
  return spec as unknown as TrueForgeApi.AgentSpec;
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

/** A shadow test run (Feature 1) started for a change under review. */
interface PendingVerify {
  changeId: string;
  /** The change under review (its path drives the end-of-turn recheck). */
  change: ProposedChange;
  command?: string;
  tests: string[];
  startedAt: number;
  ctl: AbortController;
  /** Settles once verify.finished was emitted (never rejects). */
  done: Promise<void>;
  /** Set once finished (by the verifier, or synthesized when the run ends first). */
  result?: VerifyResult;
  /** Emit verify.finished exactly once. */
  finish(result: VerifyResult): void;
}

interface RunState {
  runId: number;
  signal: AbortSignal;
  req: RunRequest;
  client: RunnerClient;
  /** Models to try in order (open circuit breakers removed), decided when the run starts. */
  plan: ReturnType<CircuitBreaker['plan']>;
  /** Model of the current (or next) turn. */
  model?: string;
  /** The run's single TrueForge session and the model it is currently set to. */
  sessionId?: string;
  sessionModel?: string;
  /** An edit was applied or a command approved during this run. */
  sideEffects: boolean;
  /** Result of the most recent run_command in this run (drives the verify loop). */
  lastCommand?: { command: string; exitCode: number; tail: string };
  /** propose_edit calls the main agent or a sub-agent made in this run (drives the stall nudge). */
  editProposals: number;
  applied: ApplyRecord[];
  /** Set right before run.finished; later events from background work are dropped. */
  finished: boolean;
  remoteCancelled: Set<string>;
  /** Models that produced output in this run (model.health ok is reported once per model). */
  healthy: Set<string>;
  /** When the current turn was sent: the model's latency is measured from here to its first output. */
  turnStartedAt: number;
  /** Shadow test runs of this run, by change id. */
  verifies: Map<string, PendingVerify>;
  /** "Allow for 10 min" while the command guard is active, kept here so the guard still sees every command. */
  commandsAllowedUntil?: number;
}

type Finished = { kind: 'finished'; status: RunStatus; message?: string; output?: string };
type ModelFailure = { kind: 'modelFailure'; reason: string; retryable: boolean };
type AttemptResult = Finished | ModelFailure;
type VerifyPlan = { command?: string; tests: string[] };

/** How long a run that ended normally waits for shadow test runs still in flight. */
const VERIFY_GRACE_MS = 3000;
/** Planning a shadow run must never hold up a review for long. */
const VERIFY_PLAN_TIMEOUT_MS = 3000;
const MAIN_THREAD = 'main';

export class AgentRunner {
  private active: RunState | undefined;
  private lastSessionId: string | undefined;
  /** Feature 3: models that failed recently, skipped by the next runs (instance-level). */
  private readonly breaker = new CircuitBreaker();
  /** forgelight.models of the previous run; a change resets model health (like resetHealth()). */
  private lastModelsKey: string | undefined;
  /** Feature 4: context length per model FQN from GET /models, loaded once per TrueForge URL. */
  private details: { baseUrl: string; lengths: Map<string, number> } | undefined;

  constructor(private readonly deps: AgentRunnerDeps) {}

  get running(): boolean {
    return this.active !== undefined;
  }

  /** Session of the active run, or of the most recent run once it finished. */
  get currentSessionId(): string | undefined {
    return this.active?.sessionId ?? this.lastSessionId;
  }

  get currentSessionUrl(): string | undefined {
    const id = this.currentSessionId;
    return id ? this.deps.setup.sessionUrl(id) : undefined;
  }

  /**
   * Forget model health: close every circuit breaker (reported as model.health 'unknown') and
   * reload the model details. The extension calls this when forgelight.models changes.
   */
  resetHealth(): void {
    const models = this.breaker.reset();
    this.details = undefined;
    for (const model of models) this.emitGlobal({ type: 'model.health', model, status: 'unknown' });
  }

  async run(req: RunRequest): Promise<RunOutcome> {
    if (this.active) throw new Error('Forgelight is already running a request. Cancel it before starting another one.');
    const { bus, runs } = this.deps;
    const cfg = this.deps.config();
    const models = cleanModels(cfg.models);
    const modelsKey = JSON.stringify(models);
    if (this.lastModelsKey !== undefined && this.lastModelsKey !== modelsKey) this.resetHealth();
    this.lastModelsKey = modelsKey;
    const createClient = this.deps.createClient ?? ((baseUrl: string, timeoutInSeconds: number) => new TrueForge({ baseUrl, timeoutInSeconds }));
    const { runId, signal } = runs.begin();
    const state: RunState = {
      runId,
      signal,
      req,
      client: createClient(cfg.trueforgeUrl, STREAM_TIMEOUT_S),
      plan: this.breaker.plan(models, Number(cfg.circuitBreakerMinutes)),
      sideEffects: false,
      editProposals: 0,
      applied: [],
      finished: false,
      remoteCancelled: new Set(),
      healthy: new Set(),
      turnStartedAt: Date.now(),
      verifies: new Map(),
    };
    this.active = state;
    const offBus = bus.on((ev) => {
      if (ev.type === 'edit.applied' && ev.runId === runId) {
        state.sideEffects = true;
        state.applied.push(ev.record);
      }
    });
    this.emit(state, { type: 'run.started', runId, mode: req.mode, text: req.text, model: state.plan.usable[0] ?? '' });
    this.loadModelDetails();

    let result: Finished;
    try {
      // The race guarantees a prompt return on cancel even if an await ignores the signal.
      result = await raceAbort(this.execute(state, cfg), signal);
    } catch (err) {
      result = { kind: 'finished', status: 'error', message: errorText(err) };
    }
    if (signal.aborted) result = { kind: 'finished', status: 'cancelled', message: 'Cancelled.' };

    // Every verify.started gets its verify.finished before run.finished.
    await this.settleVerifies(state, result.status);
    // A review still open when the run ends (any status) can no longer reach the agent: close it.
    this.deps.review.discardRun(runId);
    if (result.status !== 'done') void this.cancelRemote(state);
    this.deps.decisions.clearRun(runId);
    offBus();
    runs.end(runId);
    this.active = undefined;
    this.emit(state, { type: 'run.finished', runId, status: result.status, message: result.message, model: state.model });
    state.finished = true;
    return {
      runId,
      status: result.status,
      message: result.status === 'done' ? result.output : result.message,
      model: state.model,
      sessionId: state.sessionId,
      applied: state.applied,
    };
  }

  async cancel(): Promise<void> {
    const state = this.active;
    if (!state) return;
    this.deps.runs.cancel(state.runId);
    this.deps.review.discardRun(state.runId);
    this.deps.decisions.clearRun(state.runId);
    await this.cancelRemote(state);
  }

  /** Best-effort TrueForge-side cancel of the current session (bounded wait, errors ignored). */
  private cancelRemote(state: RunState): Promise<void> {
    const id = state.sessionId;
    if (!id || state.remoteCancelled.has(id)) return Promise.resolve();
    state.remoteCancelled.add(id);
    const request = state.client.sessions.cancel(id, {}, { timeoutInSeconds: 3, maxRetries: 0 }).then(
      () => undefined,
      () => undefined,
    );
    return Promise.race([request, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
  }

  /** Emit unless the run already finished; a throwing listener must not break the turn. */
  private emit(state: RunState, event: ForgeEvent): void {
    if (state.finished) return;
    this.emitGlobal(event);
  }

  /** Emit an event that belongs to no run (model health outside a run). */
  private emitGlobal(event: ForgeEvent): void {
    try {
      this.deps.bus.emit(event);
    } catch (err) {
      console.error(`[forgelight] listener failed on ${event.type}:`, err);
    }
  }

  /**
   * The model loop of a run. One TrueForge session for the whole run, created on the first
   * model that works. A model failure is retried on the same session with backoff; then the
   * model's circuit breaker opens and the SAME session is switched to the next model
   * (sessions.update), which continues with the full history: with the same message when the
   * failed turn produced nothing, otherwise with a continuation message. Accepted edits are never
   * re-applied and approvals never re-sent: every turn answers only its own approvals.
   */
  private async execute(state: RunState, cfg: ForgeConfig): Promise<Finished> {
    const { runId, signal } = state;
    const { usable: models, skipped, ignored } = state.plan;
    if (models.length === 0) {
      return { kind: 'finished', status: 'error', message: 'No models configured: set forgelight.models to at least one TrueForge model, e.g. "ollama/qwen3-6-35b".' };
    }
    for (const s of skipped) {
      this.emit(state, { type: 'model.health', model: s.model, status: 'skipped', retryAt: new Date(s.until).toISOString(), reason: s.reason });
    }
    if (skipped.length > 0) {
      this.emit(state, {
        type: 'notice',
        runId,
        level: 'info',
        text: `Skipping ${skipped.map((s) => s.model).join(', ')}: failed in the last ${cfg.circuitBreakerMinutes} min (circuit breaker). Starting with ${models[0]}.`,
      });
    }
    if (ignored) {
      this.emit(state, { type: 'notice', runId, level: 'warn', text: `Every configured model failed in the last ${cfg.circuitBreakerMinutes} min; trying them again anyway.` });
    }
    const content = await this.buildUserMessage(state, cfg);
    const retries = Math.max(0, Math.floor(Number(cfg.retryAttempts) || 0));
    const failures: string[] = [];
    let idx = 0;
    /** Attempt number on models[idx]. */
    let attempt = 1;
    /** Message of the current chain of turns: the request, or a verify follow-up. */
    let message = content;
    /** Set while recovering from a model failure: who failed, why, and whether any failed turn got anywhere. */
    let resume: { from: string; reason: string; progressed: boolean } | undefined;
    let verifyRound = 0;
    let stallRound = 0;
    state.lastCommand = undefined;

    /** Give up on `failed`: open its breaker and move on to the next model (false when none is left). */
    const moveOn = (failed: string, reason: string): boolean => {
      failures.push(`${failed}: ${reason}`);
      this.markDown(state, cfg, failed, reason);
      if (idx + 1 >= models.length) return false;
      idx++;
      attempt = 1;
      this.emit(state, { type: 'model.fallback', runId, from: failed, to: models[idx], reason });
      return true;
    };

    for (;;) {
      if (signal.aborted) throw abortError();
      const model = models[idx];
      state.model = model;

      if (!state.sessionId) {
        const created = await this.createSession(state, cfg, model);
        if (created.kind === 'finished') return created;
        if (created.kind === 'modelFailure') {
          if (!moveOn(model, created.reason)) return this.allFailed(state, failures);
          continue;
        }
      } else if (state.sessionModel !== model) {
        const from = state.sessionModel ?? '';
        const switched = await this.switchSessionModel(state, cfg, model);
        if (switched.kind === 'modelFailure') {
          if (!moveOn(model, switched.reason)) return this.allFailed(state, failures);
          continue;
        }
        if (switched.kind === 'failed') {
          // Old behaviour: a fresh session on the next model, only while nothing was changed.
          if (state.sideEffects) {
            return {
              kind: 'finished',
              status: 'error',
              message:
                `${resume?.from ?? from} failed after changes were already made, and Forgelight could not move the session to ${model} (${switched.reason}). ` +
                'It did not start over in a new session, which could apply edits twice. Review the applied changes; Undo and Revert run are available.',
            };
          }
          this.emit(state, {
            type: 'notice',
            runId,
            level: 'warn',
            text: `Could not switch the TrueForge session to ${model} (${switched.reason}); starting a new session on ${model} with the original request.`,
          });
          state.sessionId = undefined;
          state.sessionModel = undefined;
          message = content;
          resume = undefined;
          continue;
        }
        this.emit(state, { type: 'model.resume', runId, from: resume?.from ?? from, to: model, sessionId: switched.sessionId, reason: resume?.reason ?? '' });
      }
      const sessionId = state.sessionId;
      if (!sessionId) continue;

      // After a failed turn the session's history already holds the request (the failed turn's
      // user.message), so it is not sent again: a short note, or a continuation if work was done.
      const turnMessage = !resume
        ? message
        : resume.progressed
          ? continuationMessage(resume.from, model, resume.reason)
          : retryMessage(resume.from, model, resume.reason);
      state.turnStartedAt = Date.now();
      const turn = new TurnStreamer(this.turnContext(state, cfg, sessionId));
      const done = await turn.run(turnMessage);
      const res = classifyDone(done);

      if (res.kind === 'finished') {
        resume = undefined;
        // Verify loop: if the agent stopped while the last command it ran (usually the tests) was
        // failing, send a follow-up turn on the same session (history kept) asking it to fix that.
        const failed = lastCommandOf(state); // set by TurnStreamer while the turn ran
        if (res.status === 'done' && state.req.mode === 'agent' && failed && failed.exitCode !== 0 && verifyRound < VERIFY_FOLLOW_UPS) {
          verifyRound++;
          this.emit(state, {
            type: 'notice',
            runId,
            level: 'warn',
            text: `Verify loop ${verifyRound}/${VERIFY_FOLLOW_UPS}: \`${clip(failed.command)}\` still fails (exit ${failed.exitCode}). Asking the agent to fix it.`,
          });
          state.lastCommand = undefined;
          message = verifyFollowUp(failed);
          attempt = 1;
          continue;
        }
        // Verify loop, part 2: the agent's own commands can hide a failure. If the newest shadow
        // test run of this run failed, re-run those tests on the workspace as it is now.
        if (res.status === 'done' && state.req.mode === 'agent' && verifyRound < VERIFY_FOLLOW_UPS) {
          const still = await this.recheckFailedVerify(state);
          if (still) {
            verifyRound++;
            this.emit(state, {
              type: 'notice',
              runId,
              level: 'warn',
              text: `Verify loop ${verifyRound}/${VERIFY_FOLLOW_UPS}: the tests covering ${still.path} still fail on the workspace (${still.result.summary}). Asking the agent to fix it.`,
            });
            state.lastCommand = undefined;
            message = shadowFollowUp(still.path, still.result);
            attempt = 1;
            continue;
          }
        }
        // Stall nudge: the turn ended announcing a step it never took ("let me wait for the
        // sub-agent…"), or an inline run ended without proposing anything.
        const inline = state.req.mode === 'inline';
        const said = (res.output ?? '').trim();
        // Inline: the model answered in text (often the code itself) instead of calling propose_edit.
        const stalled = inline ? state.editProposals === 0 && said !== '' && said !== 'Done.' : looksUnfinished(said);
        if (res.status === 'done' && stalled && stallRound < STALL_NUDGES) {
          stallRound++;
          this.emit(state, {
            type: 'notice',
            runId,
            level: 'warn',
            text: inline
              ? 'The model answered without proposing an edit. Asking it to call propose_edit.'
              : 'The agent stopped after announcing a next step it did not take. Asking it to continue.',
          });
          message = stallFollowUp(inline, state.editProposals);
          attempt = 1;
          continue;
        }
        return res;
      }

      // The model failed. That turn is over, so reviews it left open can no longer reach the agent.
      this.deps.review.discardRun(runId);
      resume = { from: model, reason: res.reason, progressed: (resume?.progressed ?? false) || turn.producedOutput };
      if (res.retryable && attempt <= retries) {
        attempt++;
        const delayMs = Math.max(0, Number(cfg.retryBackoffMs) || 0) * 2 ** (attempt - 2);
        this.emit(state, { type: 'model.retry', runId, model, attempt, delayMs, reason: res.reason });
        await sleep(delayMs, signal);
        continue;
      }
      if (!moveOn(model, res.reason)) return this.allFailed(state, failures);
    }
  }

  private allFailed(state: RunState, failures: string[]): Finished {
    const workspace =
      state.applied.length > 0
        ? 'the edits you already accepted stay applied (Undo, or revert the whole run).'
        : 'nothing in the workspace was changed.';
    return { kind: 'finished', status: 'error', message: `Every configured model failed; ${workspace}\n- ${failures.join('\n- ')}` };
  }

  /** The agent definition, iteration limit and inline flag of this run (the same for every model). */
  private agentFor(state: RunState, cfg: ForgeConfig): { manifest: Record<string, unknown>; iterationLimit: number; inline: boolean } {
    const inline = state.req.mode === 'inline';
    const dedicated = inline ? this.deps.inlineAgentDefinition : undefined;
    const manifest = (dedicated ?? this.deps.agentDefinition).manifest;
    const ownLimit = Number(isRecord(manifest.config) ? manifest.config.iteration_limit : NaN);
    const iterationLimit = dedicated && Number.isFinite(ownLimit) ? Math.min(ownLimit, cfg.iterationLimit) : cfg.iterationLimit;
    return { manifest, iterationLimit, inline: inline && !dedicated };
  }

  /** The run's inline session spec with `model`: used on create and on every model switch. */
  private specFor(state: RunState, cfg: ForgeConfig, model: string): TrueForgeApi.AgentSpec {
    const { manifest, iterationLimit, inline } = this.agentFor(state, cfg);
    return buildAgentSpec(manifest, { model, iterationLimit, inline });
  }

  private async createSession(state: RunState, cfg: ForgeConfig, model: string): Promise<{ kind: 'ok' } | AttemptResult> {
    const { signal } = state;
    const spec = this.specFor(state, cfg, model);
    let sessionId: string;
    try {
      const { data } = await state.client.sessions.create({ agent: { spec } }, { abortSignal: signal, timeoutInSeconds: 30, maxRetries: 0 });
      sessionId = data.id;
    } catch (err) {
      if (signal.aborted) throw err;
      return classifyCreateError(err, cfg, editorServerName(this.agentFor(state, cfg).manifest));
    }
    state.sessionId = sessionId;
    state.sessionModel = model;
    this.lastSessionId = sessionId;
    this.emit(state, { type: 'run.session', runId: state.runId, sessionId, sessionUrl: this.deps.setup.sessionUrl(sessionId), model });
    if (signal.aborted) throw abortError();
    return { kind: 'ok' };
  }

  /**
   * Switch the run's session to `model`: PATCH /sessions/{id} with the same inline spec and the new
   * model. TrueForge keeps the session's history, so the next turn continues the conversation.
   */
  private async switchSessionModel(
    state: RunState,
    cfg: ForgeConfig,
    model: string,
  ): Promise<{ kind: 'ok'; sessionId: string } | { kind: 'modelFailure'; reason: string } | { kind: 'failed'; reason: string }> {
    const sessionId = state.sessionId;
    if (!sessionId) return { kind: 'failed', reason: 'the run has no session' };
    try {
      await state.client.sessions.update(
        sessionId,
        { agent: { spec: this.specFor(state, cfg, model) } },
        { abortSignal: state.signal, timeoutInSeconds: 15, maxRetries: 0 },
      );
    } catch (err) {
      if (state.signal.aborted) throw abortError();
      const reason = errorText(err);
      return /unknown model/i.test(reason) ? { kind: 'modelFailure', reason } : { kind: 'failed', reason };
    }
    state.sessionModel = model;
    return { kind: 'ok', sessionId };
  }

  /** A model gave up: open its circuit breaker and report it down. */
  private markDown(state: RunState, cfg: ForgeConfig, model: string, reason: string): void {
    const open = this.breaker.trip(model, Number(cfg.circuitBreakerMinutes), reason);
    state.healthy.delete(model);
    this.emit(state, { type: 'model.health', model, status: 'down', reason: clip(reason), retryAt: open ? new Date(open.until).toISOString() : undefined });
  }

  /** First output of the current model in this run: report it healthy with its latency, close its breaker. */
  private noteModelOutput(state: RunState): void {
    const model = state.model;
    if (!model || state.healthy.has(model)) return;
    state.healthy.add(model);
    this.breaker.close(model);
    this.emit(state, { type: 'model.health', model, status: 'ok', latencyMs: Math.max(0, Date.now() - state.turnStartedAt) });
  }

  /** Start loading context lengths (GET /models) once per TrueForge URL; usage events use what has loaded. */
  private loadModelDetails(): void {
    let setup: TrueForgeSetup;
    try {
      setup = this.deps.setup;
    } catch {
      return;
    }
    if (typeof setup.modelDetails !== 'function' || this.details?.baseUrl === setup.baseUrl) return;
    const entry = { baseUrl: setup.baseUrl, lengths: new Map<string, number>() };
    this.details = entry;
    setup.modelDetails().then(
      (list) => {
        for (const m of list) if (m.contextLength) entry.lengths.set(m.name, m.contextLength);
      },
      () => {
        if (this.details === entry) this.details = undefined; // try again on the next run
      },
    );
  }

  private turnContext(state: RunState, cfg: ForgeConfig, sessionId: string): TurnContext {
    return {
      deps: this.deps,
      state,
      sessionId,
      editorServer: editorServerName(this.agentFor(state, cfg).manifest),
      emit: (ev) => this.emit(state, ev),
      onModelOutput: () => this.noteModelOutput(state),
      contextLength: (model) => this.details?.lengths.get(model),
      planVerify: (change) => this.planVerify(state, change),
      launchVerify: (change, plan) => this.launchVerify(state, change, plan),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Feature 1: shadow test runs while a change is under review
  // -------------------------------------------------------------------------------------------

  /** Tests to run for a change, or undefined when verification is off or there is nothing to run. */
  private async planVerify(state: RunState, change: ProposedChange): Promise<VerifyPlan | undefined> {
    const verifier = this.deps.verifier;
    if (!verifier || !this.deps.config().verifyBeforeAccept) return undefined;
    try {
      const plan = await withTimeout(
        Promise.resolve().then(() => verifier.plan(change)),
        VERIFY_PLAN_TIMEOUT_MS,
        `planning the shadow test run took longer than ${VERIFY_PLAN_TIMEOUT_MS / 1000} s`,
      );
      // A custom forgelight.verifyCommand without {tests} (npm test, make test) runs with no test targets.
      return plan && Array.isArray(plan.tests) && (plan.tests.length > 0 || !!plan.command) ? plan : undefined;
    } catch (err) {
      this.emit(state, { type: 'notice', runId: state.runId, level: 'warn', text: `No shadow test run for ${change.path}: ${errorText(err)}` });
      return undefined;
    }
  }

  /** Start the shadow run without waiting for it; verify.finished is emitted once, whatever happens. */
  private launchVerify(state: RunState, change: ProposedChange, plan: VerifyPlan): PendingVerify {
    const verifier = this.deps.verifier!;
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (state.signal.aborted) ctl.abort();
    else state.signal.addEventListener('abort', onAbort, { once: true });
    const v: PendingVerify = {
      changeId: change.id,
      change,
      command: plan.command,
      tests: [...plan.tests],
      startedAt: Date.now(),
      ctl,
      done: Promise.resolve(),
      finish: (result) => {
        if (v.result) return;
        v.result = result;
        state.signal.removeEventListener('abort', onAbort);
        this.emit(state, { type: 'verify.finished', runId: state.runId, result });
      },
    };
    state.verifies.set(change.id, v);
    this.emit(state, { type: 'verify.started', runId: state.runId, changeId: change.id, command: plan.command ?? '', tests: v.tests });
    v.done = Promise.resolve()
      .then(() => verifier.verify(change, ctl.signal))
      .then(
        (result) => v.finish(result),
        (err) =>
          v.finish({
            changeId: change.id,
            status: ctl.signal.aborted ? 'cancelled' : 'error',
            command: plan.command,
            tests: v.tests,
            summary: ctl.signal.aborted ? 'Cancelled.' : clip(errorText(err)),
            durationMs: Date.now() - v.startedAt,
          }),
      )
      .catch((err) => console.error('[forgelight] verify.finished listener failed:', err));
    return v;
  }

  /**
   * Verify loop, part 2: when the newest shadow test run of this run failed, run the same tests on a
   * copy of the workspace as it is now (that file as it is on disk, after the user's decisions).
   * Returns the failure, or undefined when there is nothing to recheck or the tests pass now.
   */
  private async recheckFailedVerify(state: RunState): Promise<{ path: string; result: VerifyResult } | undefined> {
    const verifier = this.deps.verifier;
    if (!verifier || !this.deps.config().verifyBeforeAccept) return undefined;
    let latest: PendingVerify | undefined;
    for (const v of state.verifies.values()) if (!latest || v.startedAt >= latest.startedAt) latest = v;
    if (!latest) return undefined;
    if (!latest.result) await waitAtMost(latest.done, VERIFY_GRACE_MS);
    if (latest.result?.status !== 'failed') return undefined;
    const c = latest.change;
    const current = await this.deps.io.readText(c.path).catch(() => undefined);
    if (current === undefined) return undefined; // e.g. a rejected new file: nothing on disk to test
    this.emit(state, {
      type: 'notice',
      runId: state.runId,
      level: 'info',
      text: `The last shadow test run (${c.path}) failed; running those tests again on the workspace as it is now.`,
    });
    const now: ProposedChange = { ...c, id: `${c.id}#recheck`, isNewFile: false, originalText: current, proposedText: current, hunks: [] };
    let result: VerifyResult;
    try {
      result = await verifier.verify(now, state.signal);
    } catch {
      return undefined; // a recheck that cannot run never holds up the end of a run
    }
    if (state.signal.aborted) throw abortError();
    return result.status === 'failed' ? { path: c.path, result } : undefined;
  }

  /** Shadow runs still going when the run ends: a finished run waits briefly, then the rest are stopped. */
  private async settleVerifies(state: RunState, status: RunStatus): Promise<void> {
    const open = () => [...state.verifies.values()].filter((v) => !v.result);
    if (open().length === 0) return;
    if (status === 'done') await waitAtMost(Promise.all(open().map((v) => v.done)), VERIFY_GRACE_MS);
    for (const v of open()) {
      v.ctl.abort();
      v.finish({
        changeId: v.changeId,
        status: 'cancelled',
        command: v.command,
        tests: v.tests,
        summary: status === 'cancelled' ? 'Cancelled with the run.' : 'Stopped: the run ended before the shadow test run finished.',
        durationMs: Date.now() - v.startedAt,
      });
    }
  }
  private async buildUserMessage(state: RunState, cfg: ForgeConfig): Promise<string> {
    const { req, runId } = state;
    if (req.mode === 'inline') {
      const t = req.inlineTarget;
      if (!t) throw new Error('An inline edit needs a selection.');
      const code = t.selectedText.replace(/\r?\n$/, '');
      const fence = codeFence(code);
      return [
        'INLINE EDIT',
        `File: ${workspaceRelative(this.deps.io.root, t.path)} (use exactly this as the "path" argument of propose_edit)`,
        `Selected lines: ${t.startLine}-${t.endLine}`,
        'Selected code:',
        fence,
        code,
        fence,
        `Instruction: ${req.text}`,
        'Call propose_edit once for this file; change only the selected region.',
      ].join('\n');
    }

    const parts = [req.text];
    const explicit: ContextFilePick[] = [];
    try {
      const mentions = await this.deps.context.resolveMentions(req.text);
      if (mentions.explicitBlock.trim()) parts.push(`Explicitly mentioned context:\n${mentions.explicitBlock}`);
      explicit.push(...mentions.files);
      if (mentions.unresolved.length > 0) {
        this.emit(state, { type: 'notice', runId, level: 'warn', text: `Could not resolve: ${mentions.unresolved.join(', ')}` });
      }
    } catch (err) {
      this.emit(state, { type: 'notice', runId, level: 'warn', text: `Could not resolve @-mentions: ${errorText(err)}` });
    }
    parts.push(`Workspace: ${path.basename(this.deps.io.root)}`);

    // Automatic retrieval under the token budget (B1), shown to the user via context.picked.
    // @-mentioned files count against the same budget and are not packed a second time.
    const explicitTokens = explicit.reduce((sum, f) => sum + f.tokens, 0);
    let pick: ContextPick | undefined;
    if (!req.text.includes(CONTEXT_SECTION_HEADING)) {
      try {
        pick = await this.deps.context.retrieve(req.text, Math.max(MIN_RETRIEVAL_TOKENS, cfg.contextBudgetTokens - explicitTokens), {
          excludePaths: explicit.map((f) => f.path),
        });
      } catch (err) {
        this.emit(state, { type: 'notice', runId, level: 'warn', text: `Automatic context retrieval failed: ${errorText(err)}` });
      }
    }
    const files = [...explicit, ...(pick?.files ?? [])];
    if (files.length > 0) {
      this.emit(state, {
        type: 'context.picked',
        runId,
        pick: {
          query: req.text,
          budgetTokens: cfg.contextBudgetTokens,
          usedTokens: explicitTokens + (pick && pick.files.length > 0 ? pick.usedTokens : 0),
          files,
          dropped: pick?.dropped ?? [],
          packedText: pick?.packedText ?? '',
        },
      });
    }
    if (pick && pick.files.length > 0 && pick.packedText.trim()) {
      parts.push(`${CONTEXT_SECTION_HEADING}:\n${pick.packedText}`);
    }
    parts.push('Start with Step 1: delegate exploration to the context-scout sub-agent.');
    return parts.join('\n\n');
  }
}

function classifyCreateError(err: unknown, cfg: ForgeConfig, editorServer: string): AttemptResult {
  const msg = errorText(err);
  const httpStatus = err instanceof TrueForgeError ? err.statusCode : undefined;
  if (err instanceof TrueForgeTimeoutError || (httpStatus === undefined && UNREACHABLE_RE.test(msg))) {
    return { kind: 'finished', status: 'error', message: `Cannot reach TrueForge at ${cfg.trueforgeUrl}. Start it with scripts/start-trueforge.sh` };
  }
  if (/unknown model/i.test(msg)) return { kind: 'modelFailure', reason: msg, retryable: false };
  if (/unknown mcp server/i.test(msg)) {
    return {
      kind: 'finished',
      status: 'error',
      message: `TrueForge has no MCP server named "${editorServer}". Run "Forgelight: Re-register MCP Server and Agent with TrueForge". (${msg})`,
    };
  }
  return { kind: 'finished', status: 'error', message: `TrueForge could not create a session: ${msg}` };
}

function classifyDone(done: DoneState): AttemptResult {
  switch (done.status) {
    case 'done':
      // Some local models put their final words only in reasoning; never finish with an empty message.
      return { kind: 'finished', status: 'done', output: messageText(done.output?.content) || 'Done.' };
    case 'cancelled':
      return { kind: 'finished', status: 'cancelled', message: `The turn was cancelled in TrueForge (${done.reason}).` };
    case 'error': {
      const msg = done.message || 'unknown error';
      // finish_reason "length" (max_tokens hit): the same model would hit it again, so go straight to a fallback.
      if (/^Output truncated/i.test(msg)) return { kind: 'modelFailure', reason: msg, retryable: false };
      // Also after side effects: the session keeps the history, so the run continues instead of restarting.
      if (isModelFailure(msg)) return { kind: 'modelFailure', reason: msg, retryable: true };
      return { kind: 'finished', status: 'error', message: `TrueForge reported an error: ${msg}` };
    }
  }
}

function isModelFailure(message: string): boolean {
  // MCP transport errors (our own tool server) are not model failures.
  if (/\bMCP\b/i.test(message) && !/\[Model Error\]/i.test(message)) return false;
  return MODEL_FAILURE_RE.test(message);
}

// ---------------------------------------------------------------------------------------------
// One turn: stream, index, approvals, resume
// ---------------------------------------------------------------------------------------------

interface TurnContext {
  deps: AgentRunnerDeps;
  state: RunState;
  sessionId: string;
  editorServer: string;
  emit: (event: ForgeEvent) => void;
  /** The first model output of the turn arrived (model health). */
  onModelOutput: () => void;
  /** Context window of a model when known (GET /models). */
  contextLength: (model: string) => number | undefined;
  /** Feature 1: tests to run on a shadow copy for a change (undefined: none / off). */
  planVerify: (change: ProposedChange) => Promise<VerifyPlan | undefined>;
  launchVerify: (change: ProposedChange, plan: VerifyPlan) => PendingVerify;
}

interface CallTarget {
  server?: string;
  tool: string;
  argsText: string;
}

class TurnStreamer {
  /** Id-keyed event index; deltas are merged into their model.message base. */
  private readonly index = new Map<string, StreamEvent>();
  private readonly seen = new Set<string>();
  /** Characters of text/reasoning already emitted per message (replays must not repeat them). */
  private readonly shown = new Map<string, { text: number; reasoning: number }>();
  private readonly announced = new Set<string>();
  private readonly streamCtl = new AbortController();
  private turnId: string | undefined;
  private lastEventId: string | undefined;
  private done: DoneState | undefined;
  private fatal: string | undefined;
  private approvals: Promise<void> = Promise.resolve();
  /** The turn produced assistant text or tool calls (decides how a failed turn is resumed). */
  producedOutput = false;
  private outputSeen = false;
  /** Model messages whose usage was reported (context.usage once per model call). */
  private readonly usageReported = new Set<string>();
  /** Per sub-agent thread: title, peak input tokens of its model calls, last assistant text. */
  private readonly subagents = new Map<string, { title: string; peak: number; lastText: string }>();

  constructor(private readonly ctx: TurnContext) {}

  private get signal(): AbortSignal {
    return this.ctx.state.signal;
  }

  async run(content: string): Promise<DoneState> {
    const { state, sessionId } = this.ctx;
    const onAbort = () => this.streamCtl.abort();
    this.signal.addEventListener('abort', onAbort, { once: true });
    const opts = { abortSignal: this.streamCtl.signal, timeoutInSeconds: STREAM_TIMEOUT_S, maxRetries: 0 };
    try {
      let stream: AsyncIterable<StreamEvent>;
      try {
        stream = await state.client.sessions.createTurnStream(sessionId, { input: [{ type: 'user.message', content }] }, opts);
      } catch (err) {
        if (this.signal.aborted) throw abortError();
        throw new Error(`TrueForge could not start the turn: ${errorText(err)}`);
      }

      let failures = 0;
      let lastError: unknown;
      for (;;) {
        let progressed = false;
        try {
          for await (const ev of stream) {
            if (this.handle(ev)) progressed = true;
            if (this.done || this.fatal) break;
          }
        } catch (err) {
          lastError = err;
        }
        if (this.signal.aborted) throw abortError();
        if (this.fatal) throw new Error(this.fatal);
        if (this.done) return this.done;
        if (!this.turnId) {
          throw new Error(`The TrueForge event stream ended before the turn started${lastError ? `: ${errorText(lastError)}` : ''}.`);
        }

        // Stream dropped or ended early (it may close during a long pause). Let our pending
        // approval answers go out first, then resume from the last event we saw.
        await raceAbort(this.approvals, this.signal);
        failures = progressed ? 1 : failures + 1;
        if (failures > MAX_STREAM_RESUMES) {
          throw new Error(`Lost the TrueForge event stream and could not resume it${lastError ? ` (${errorText(lastError)})` : ''}.`);
        }
        await sleep(250 * failures, this.signal);
        const terminal = await this.terminalState();
        if (terminal) {
          if (terminal.status === 'done' && terminal.output) this.handle(terminal.output);
          return terminal;
        }
        try {
          stream = await state.client.sessions.subscribeToTurn(
            sessionId,
            this.turnId,
            this.lastEventId ? { fromEventId: this.lastEventId } : {},
            opts,
          );
          lastError = undefined;
        } catch (err) {
          if (this.signal.aborted) throw abortError();
          lastError = err;
          stream = emptyStream();
        }
      }
    } finally {
      this.signal.removeEventListener('abort', onAbort);
    }
  }

  /** Index one event and map it to ForgeEvents. Returns true when it carried something new. */
  private handle(ev: StreamEvent): boolean {
    const { emit, state } = this.ctx;
    const runId = state.runId;
    if (ev.id) this.lastEventId = ev.id;

    if (isEventDelta(ev)) {
      let base = this.index.get(ev.id);
      if (base?.type !== 'model.message') {
        base = { type: 'model.message', id: ev.id, threadId: ev.threadId, createdAt: ev.createdAt ?? '', content: '' };
        this.index.set(ev.id, base);
      }
      mergeEventDelta(base, ev);
      this.announceFinishedCalls(base);
      this.observe(base);
      return this.emitText(base);
    }
    if (ev.type === 'model.message') {
      // A replayed base restarts the merge; emitText only emits text not shown yet.
      this.index.set(ev.id, ev);
      const fresh = !this.seen.has(ev.id);
      this.seen.add(ev.id);
      this.announceFinishedCalls(ev);
      this.observe(ev);
      return this.emitText(ev) || fresh;
    }
    if (this.seen.has(ev.id)) return false;
    this.seen.add(ev.id);
    this.index.set(ev.id, ev);

    switch (ev.type) {
      case 'turn.created':
        this.turnId = ev.turnId;
        break;
      case 'turn.done':
        this.done = ev.state;
        break;
      case 'thread.created': {
        const title = ev.title || ev.agentInfo?.name || ev.threadId;
        this.subagent(ev.threadId).title = title;
        emit({ type: 'thread.started', runId, threadId: ev.threadId, title });
        break;
      }
      case 'thread.done':
        emit({ type: 'thread.finished', runId, threadId: ev.threadId });
        this.reportSavings(ev);
        break;
      case 'tool.approval_required':
        for (const ref of ev.toolCalls) {
          const call = this.findCall(ref.sourceEventId, ref.id);
          this.announce(ref.id, ev.threadId, call);
          this.enqueue(() => this.decide(ev.threadId, ref.id, call));
        }
        break;
      case 'tool.response_required':
        this.onResponseRequired(ev);
        break;
      case 'tool.response': {
        const call = this.findCallById(ev.toolCallId);
        this.announce(ev.toolCallId, ev.threadId, call);
        const tool = call ? resolveTarget(call).tool : '';
        emit({ type: 'tool.result', runId, threadId: ev.threadId, toolCallId: ev.toolCallId, preview: toolPreview(tool, ev.content) });
        if (tool === 'run_command') {
          const cmd = parseCommandResult(ev.content);
          if (cmd) this.ctx.state.lastCommand = cmd;
        }
        break;
      }
      case 'thread.context_compaction_started':
        emit({
          type: 'notice',
          runId,
          level: 'info',
          text: `Compacting context (${threadLabel(ev.threadId)}): ${ev.trigger.contextTokens} tokens exceeded the ${ev.trigger.thresholdTokens}-token threshold.`,
        });
        break;
      case 'thread.context_compaction_finished':
        emit({ type: 'notice', runId, level: 'info', text: `Context compacted (${threadLabel(ev.threadId)}) in ${(ev.durationMs / 1000).toFixed(1)} s.` });
        break;
      case 'mcp.auth_required':
        this.fail(`TrueForge cannot authenticate to the "${this.ctx.editorServer}" MCP server. Run "Forgelight: Re-register MCP Server and Agent with TrueForge".`);
        break;
      default:
        break;
    }
    return true;
  }

  /** Per model message: first output (model health), progress, context usage (Feature 4), sub-agent peaks. */
  private observe(msg: ModelMessage): void {
    const text = messageText(msg.content);
    const calls = msg.toolCalls?.length ?? 0;
    if (!this.outputSeen && (text || calls || msg.reasoningContent || (msg.finishReason && msg.usage))) {
      this.outputSeen = true;
      this.ctx.onModelOutput();
    }
    if (text.trim() || calls) this.producedOutput = true;
    if (!msg.finishReason) return; // usage is final only once the message is complete
    const sub = msg.threadId !== MAIN_THREAD ? this.subagent(msg.threadId) : undefined;
    if (sub && text.trim()) sub.lastText = text;
    const usage = msg.usage;
    if (!usage || this.usageReported.has(msg.id)) return;
    this.usageReported.add(msg.id);
    const inputTokens = tokenCount(usage.inputTokens);
    if (sub) sub.peak = Math.max(sub.peak, inputTokens);
    const model = msg.model?.name || this.ctx.state.model || '';
    this.ctx.emit({
      type: 'context.usage',
      runId: this.ctx.state.runId,
      threadId: msg.threadId,
      model,
      inputTokens,
      outputTokens: tokenCount(usage.outputTokens),
      breakdown: numericBreakdown(usage.inputTokensBreakdown),
      contextLength: this.ctx.contextLength(model),
    });
  }

  private subagent(threadId: string): { title: string; peak: number; lastText: string } {
    let sub = this.subagents.get(threadId);
    if (!sub) {
      sub = { title: '', peak: 0, lastText: '' };
      this.subagents.set(threadId, sub);
    }
    return sub;
  }

  /**
   * subagent.savings: the context a sub-agent consumed (peak input tokens of its model calls) vs
   * what it handed back to the main agent (its final output, estimated).
   */
  private reportSavings(ev: TrueForgeApi.ThreadDoneEvent): void {
    if (ev.threadId === MAIN_THREAD) return;
    const sub = this.subagent(ev.threadId);
    const output = ev.state.output;
    if (output?.usage) sub.peak = Math.max(sub.peak, tokenCount(output.usage.inputTokens));
    let returned = output ? messageText(output.content) : '';
    if (!returned.trim()) returned = sub.lastText;
    if (!returned.trim() && ev.state.status === 'error') returned = ev.state.error;
    if (sub.peak <= 0) return; // no usage reported for this sub-agent: nothing to compare
    this.ctx.emit({
      type: 'subagent.savings',
      runId: this.ctx.state.runId,
      threadId: ev.threadId,
      title: sub.title || ev.title || ev.threadId,
      contextTokens: sub.peak,
      returnedTokens: estimateTokens(returned),
    });
  }

  private emitText(msg: ModelMessage): boolean {
    const { emit, state } = this.ctx;
    const shown = this.shown.get(msg.id) ?? { text: 0, reasoning: 0 };
    this.shown.set(msg.id, shown);
    let progressed = false;
    const reasoning = msg.reasoningContent ?? '';
    if (reasoning.length > shown.reasoning) {
      emit({ type: 'reasoning.delta', runId: state.runId, threadId: msg.threadId, messageId: msg.id, text: reasoning.slice(shown.reasoning) });
      shown.reasoning = reasoning.length;
      progressed = true;
    }
    const text = messageText(msg.content);
    if (text.length > shown.text) {
      emit({ type: 'assistant.delta', runId: state.runId, threadId: msg.threadId, messageId: msg.id, text: text.slice(shown.text) });
      shown.text = text.length;
      progressed = true;
    }
    return progressed;
  }

  private findCall(sourceEventId: string, callId: string): ToolCall | undefined {
    const src = this.index.get(sourceEventId);
    return src?.type === 'model.message' ? src.toolCalls?.find((c) => c.id === callId) : undefined;
  }

  private findCallById(callId: string): ToolCall | undefined {
    const events = [...this.index.values()];
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      const call = ev.type === 'model.message' ? ev.toolCalls?.find((c) => c.id === callId) : undefined;
      if (call) return call;
    }
    return undefined;
  }

  /** Tool-call arguments are complete once the message has a finish reason. */
  private announceFinishedCalls(msg: ModelMessage): void {
    if (!msg.finishReason) return;
    for (const call of msg.toolCalls ?? []) this.announce(call.id, msg.threadId, call);
  }

  /** Emit tool.call once per call id. */
  private announce(toolCallId: string, threadId: string, call: ToolCall | undefined): void {
    if (this.announced.has(toolCallId)) return;
    this.announced.add(toolCallId);
    const target = call ? resolveTarget(call) : { tool: 'unknown', argsText: '' };
    this.ctx.emit({ type: 'tool.call', runId: this.ctx.state.runId, threadId, toolCallId, name: target.tool, argsPreview: clip(describeArgs(target.tool, target.argsText)) });
  }

  /** Approvals are answered one at a time (reviews are sequential) while the stream keeps flowing. */
  private enqueue(task: () => Promise<void>): void {
    this.approvals = this.approvals.then(task).catch((err) => {
      if (!this.signal.aborted) this.fail(`Answering a TrueForge tool approval failed: ${errorText(err)}`);
    });
  }

  private async decide(threadId: string, toolCallId: string, call: ToolCall | undefined): Promise<void> {
    if (this.signal.aborted || this.done) return;
    if (!call) return this.deny(threadId, toolCallId, 'Forgelight could not find this tool call in the event stream, so it was not approved.');
    const target = resolveTarget(call);
    if (target.server === this.ctx.editorServer && target.tool === 'propose_edit') return this.decideEdit(threadId, toolCallId, target);
    if (target.server === this.ctx.editorServer && target.tool === 'run_command') return this.decideCommand(threadId, toolCallId, target);
    return this.send([{ type: 'user.tool_approval', threadId, toolCallId, approval: { status: 'allow' } }]);
  }

  private async decideEdit(threadId: string, toolCallId: string, target: CallTarget): Promise<void> {
    const { deps, state } = this.ctx;
    state.editProposals++;
    const raw = parseJson(target.argsText);
    if (!isRecord(raw)) {
      return this.deny(threadId, toolCallId, 'propose_edit arguments must be a JSON object with "path" and "edits" (or "new_content").');
    }
    const args = pickProposeArgs(raw);
    const key = argsKey(args);
    // Invalid arguments are not a user decision: let the tool run and return the error itself
    // (TrueForge would tell the model "User denied tool call" for a deny).
    const invalid = (error: string) => {
      deps.decisions.put(key, { runId: state.runId, error });
      return this.send([{ type: 'user.tool_approval', threadId, toolCallId, approval: { status: 'allow' } }]);
    };
    const pathProblem = this.checkEditPath(args.path);
    if (pathProblem) return pathProblem.deny ? this.deny(threadId, toolCallId, pathProblem.message) : invalid(pathProblem.message);

    const current = await deps.io.readText(args.path);
    const comp = computeProposal(current, args);
    if (comp.error || comp.proposedText === undefined) return invalid(comp.error ?? `Could not compute the edit for ${args.path}.`);
    // Context 0: every separate change region is its own hunk, so each can be accepted on its own.
    const hunks = computeHunks(current ?? '', comp.proposedText, args.path, 0);
    if (hunks.length === 0) {
      return invalid(comp.isNewFile ? `new_content for ${args.path} is empty; provide the content of the new file.` : `The edit produces no change to ${args.path}.`);
    }
    const change: ProposedChange = {
      id: toolCallId,
      runId: state.runId,
      path: args.path,
      absPath: path.join(deps.io.root, args.path),
      isNewFile: comp.isNewFile,
      originalText: current ?? '',
      proposedText: comp.proposedText,
      hunks,
      explanation: args.explanation,
      argsKey: key,
    };
    if (this.signal.aborted || this.done) return;
    // Feature 1: while the user reviews, run the relevant tests on a shadow copy with the whole
    // proposal applied (never awaited before the review; the result lands on the review card).
    const plan = await this.ctx.planVerify(change);
    if (this.signal.aborted || this.done) return;
    const reviewing = deps.review.review(change, this.signal);
    const verify = plan ? this.ctx.launchVerify(change, plan) : undefined;
    const result = await reviewing;
    if (result.cancelled) verify?.ctl.abort(); // the card is gone: stop its shadow run
    // The turn may have ended meanwhile (model failure): its approvals can no longer be answered.
    if (this.signal.aborted || this.done) return;
    if (result.cancelled) return this.deny(threadId, toolCallId, 'The review was closed without a decision; nothing was written.');
    // If the shadow run already finished, tell the agent how the tests went.
    const shadow = verify?.result ? verifyNote(verify.result) : undefined;
    if (result.accepted.length > 0) {
      // Kept apart from the user's note so the tool result does not present it as something the user wrote.
      deps.decisions.put(change.argsKey, { runId: state.runId, change, result, ...(shadow ? { verifyNote: shadow } : {}) });
      return this.send([{ type: 'user.tool_approval', threadId, toolCallId, approval: { status: 'allow' } }]);
    }
    const note = result.note ? ` ${result.note}` : '';
    return this.deny(threadId, toolCallId, `The user rejected all hunks of this edit.${note}${shadow ? ` ${shadow}` : ''}`);
  }

  /**
   * Problem with the edit's path. `deny` marks the cases answered with a denial: a missing path
   * (the MCP schema would reject the call before our hint reaches the model) and an inline edit
   * aimed at another file (a scope decision on the user's behalf).
   */
  private checkEditPath(relPath: string): { message: string; deny: boolean } | undefined {
    const { deps, state } = this.ctx;
    if (!relPath) {
      const target = state.req.mode === 'inline' ? state.req.inlineTarget : undefined;
      const message = target
        ? `propose_edit is missing "path". Call it again with "path": "${workspaceRelative(deps.io.root, target.path)}" and the same edits.`
        : 'propose_edit needs a workspace-relative "path".';
      return { message, deny: true };
    }
    const rel = path.relative(deps.io.root, path.resolve(deps.io.root, relPath));
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return { message: `${relPath} is outside the workspace; use a workspace-relative path.`, deny: false };
    }
    const inline = state.req.mode === 'inline' ? state.req.inlineTarget : undefined;
    if (inline && workspaceRelative(deps.io.root, inline.path) !== relPath) {
      return { message: `This is an inline edit of ${inline.path}; propose_edit may only change that file.`, deny: true };
    }
    return undefined;
  }

  private async decideCommand(threadId: string, toolCallId: string, target: CallTarget): Promise<void> {
    const { deps, state } = this.ctx;
    const raw = parseJson(target.argsText);
    const args = isRecord(raw) ? raw : {};
    const command = typeof args.command === 'string' ? args.command : '';
    if (!command.trim()) return this.deny(threadId, toolCallId, 'run_command needs a non-empty "command".');
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd : '.';
    const runId = state.runId;

    // Feature 5: classify the command. Cards resolved without asking still show it with its risk badge.
    const assessment = assessCommand(deps.guard, command, cwd, deps.io.root);
    const resolvedCard = (decision: CommandResolution, reason: string) => {
      const requestId = `guard-${runId}-${toolCallId}`;
      this.ctx.emit({ type: 'approval.command', runId, requestId, command, cwd, toolCallId, assessment });
      this.ctx.emit({ type: 'approval.resolved', runId, requestId, decision, reason });
    };
    if (assessment?.blocked) {
      // the guard prefixes hard-block reasons with "blocked: "; the messages below already say it
      const plain = assessment.reasons.map((r) => r.replace(/^blocked:\s*/i, '')).filter(Boolean);
      const reasons = plain.length ? plain.join('; ') : 'it matches a pattern Forgelight never runs';
      resolvedCard('blocked', reasons);
      return this.deny(threadId, toolCallId, `Blocked by Forgelight's command guard: ${reasons}. Use a safer command.`);
    }
    if (assessment && state.commandsAllowedUntil !== undefined && Date.now() < state.commandsAllowedUntil && assessment.risk !== 'destructive') {
      resolvedCard('tenMinutes', 'Allowed for 10 minutes earlier in this run.');
      return this.allowCommand(threadId, toolCallId);
    }
    if (
      assessment &&
      deps.config().autoApproveSafeCommands &&
      (assessment.risk === 'test' || assessment.risk === 'read') &&
      // reads of secrets or of files outside the workspace would land in the model's context: always ask
      !assessment.reasons.some((r) => NOT_AUTO_APPROVABLE.test(r))
    ) {
      const why = assessment.reasons.length ? ` (${assessment.reasons.join('; ')})` : '';
      resolvedCard('auto', `Auto-approved: rated "${assessment.risk}"${why}.`);
      return this.allowCommand(threadId, toolCallId);
    }

    const decision = await deps.commands.approve({ runId, command, cwd, toolCallId, assessment }, this.signal);
    if (this.signal.aborted || this.done) return;
    if (decision === 'deny') return this.deny(threadId, toolCallId, 'The user declined to run this command.');
    if (decision === 'tenMinutes' && target.server) {
      if (deps.guard) {
        // A TrueForge session policy would stop the pauses on run_command, and with them the guard:
        // keep the 10-minute window here so every later command is still classified (and blocked if needed).
        state.commandsAllowedUntil = Date.now() + 10 * 60_000;
        return this.allowCommand(threadId, toolCallId);
      }
      state.sideEffects = true;
      // Also approves this pending call, so it replaces the one-off approval.
      const expireAt = new Date(Date.now() + 10 * 60_000).toISOString();
      return this.send([
        { type: 'user.tool_approval_policy', policies: [{ serverName: target.server, name: 'run_command', policy: { type: 'allow_session', expireAt } }] },
      ]);
    }
    return this.allowCommand(threadId, toolCallId);
  }

  private allowCommand(threadId: string, toolCallId: string): Promise<void> {
    this.ctx.state.sideEffects = true;
    return this.send([{ type: 'user.tool_approval', threadId, toolCallId, approval: { status: 'allow' } }]);
  }

  /** ask_user_question & co: Forgelight has no mid-run question UI, so answer and say so. */
  private onResponseRequired(ev: TrueForgeApi.ToolResponseRequiredEvent): void {
    const { emit, state } = this.ctx;
    for (const ref of ev.toolCalls) {
      const call = this.findCall(ref.sourceEventId, ref.id);
      this.announce(ref.id, ev.threadId, call);
      emit({
        type: 'notice',
        runId: state.runId,
        level: 'warn',
        text: `The agent asked a question (${clip(call?.function.arguments ?? '', 160)}); Forgelight told it to proceed with its best judgment.`,
      });
      this.enqueue(() =>
        this.send([
          {
            type: 'user.tool_response',
            threadId: ev.threadId,
            toolCallId: ref.id,
            content: 'The user cannot answer questions during this run. Proceed with your best judgment and state your assumptions in the final summary.',
          },
        ]),
      );
    }
  }

  private deny(threadId: string, toolCallId: string, reason: string): Promise<void> {
    return this.send([{ type: 'user.tool_approval', threadId, toolCallId, approval: { status: 'deny', reason } }]);
  }

  private async send(events: TurnInput[]): Promise<void> {
    const { state, sessionId } = this.ctx;
    for (let attempt = 0; ; attempt++) {
      if (this.signal.aborted || this.done || !this.turnId) return;
      try {
        await state.client.sessions.createTurnEvents(sessionId, this.turnId, { events }, { abortSignal: this.signal, timeoutInSeconds: 30, maxRetries: 0 });
        return;
      } catch (err) {
        if (this.signal.aborted || this.done) return;
        if (attempt >= 1) throw err;
        await sleep(500, this.signal);
      }
    }
  }

  /** Stop reading and end the turn with an error (the run cancels the session). */
  private fail(message: string): void {
    if (this.fatal || this.done) return;
    this.fatal = message;
    this.streamCtl.abort();
  }

  private async terminalState(): Promise<DoneState | undefined> {
    const { state, sessionId } = this.ctx;
    if (!this.turnId) return undefined;
    try {
      const { data } = await state.client.sessions.getTurn(sessionId, this.turnId, { abortSignal: this.signal, timeoutInSeconds: 10, maxRetries: 0 });
      const s = data.state;
      return s.status === 'done' || s.status === 'error' || s.status === 'cancelled' ? s : undefined;
    } catch {
      if (this.signal.aborted) throw abortError();
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** MCP server + tool behind a call; deferred tools arrive wrapped in TrueForge's call_tool. */
function resolveTarget(call: ToolCall): CallTarget {
  const info = call.toolInfo;
  const argsText = call.function?.arguments ?? '';
  if (info?.type === 'mcp') return { server: info.serverName, tool: info.name, argsText };
  const name = info?.name ?? call.function?.name ?? 'unknown';
  if (name === 'call_tool') {
    const outer = parseJson(argsText);
    if (isRecord(outer) && typeof outer.mcp_server === 'string' && typeof outer.tool_name === 'string') {
      const inner = CALL_TOOL_ARG_KEYS.map((k) => outer[k]).find((v) => v !== undefined);
      return { server: outer.mcp_server, tool: outer.tool_name, argsText: typeof inner === 'string' ? inner : JSON.stringify(inner ?? {}) };
    }
  }
  return { tool: name, argsText };
}

function messageText(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** Forward-slash workspace-relative form of a relative or absolute path. */
function workspaceRelative(root: string, p: string): string {
  return normalizePath(path.isAbsolute(p) ? path.relative(root, p) : p);
}

function threadLabel(threadId: string): string {
  return threadId === 'main' ? 'main agent' : `subagent ${threadId}`;
}

/** Readable preview of a tool result for the panel. */
export function toolPreview(tool: string, content: string): string {
  const text = toolResultText(tool, content);
  return tool === 'run_command' && text.startsWith('$ ') ? commandPreview(text) : clip(text);
}

/**
 * TrueForge sends isError results (MCP failures and approval denials) as {"error":[content parts]},
 * a denial's text being {"error":"User denied tool call: <reason>"}. Unwrap both, and say "Not
 * applied" rather than "User denied": Forgelight denies on the user's behalf only after a review.
 */
export function toolResultText(tool: string, content: string): string {
  const o = parseJson(content);
  if (!isRecord(o) || !Array.isArray(o.error) || Object.keys(o).length !== 1) return content;
  let t = o.error
    .map((p) => (isRecord(p) && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
  const inner = parseJson(t);
  if (isRecord(inner) && typeof inner.error === 'string') t = inner.error;
  const denied = /^User denied tool call:\s*/i;
  if (denied.test(t)) return `${tool === 'run_command' ? 'Not run' : 'Not applied'}: ${t.replace(denied, '')}`;
  return `Error: ${t}`;
}

/** run_command output: the command and exit code, then the last lines (where pytest prints its summary). */
function commandPreview(text: string): string {
  if (text.length <= PREVIEW_MAX) return text;
  const lines = text.split('\n');
  const tail = lines
    .slice(2)
    .filter((l) => l.trim())
    .slice(-3)
    .map((l) => clip(l, 160));
  return [...lines.slice(0, 2).map((l) => clip(l, 160)), '…', ...tail].join('\n');
}

function clip(text: string, max = PREVIEW_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function codeFence(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Re-serialize JSON so escapes such as > read naturally in previews. */
function compactJson(text: string): string {
  const parsed = parseJson(text);
  return parsed === undefined ? text : JSON.stringify(parsed);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function abortError(): Error {
  return new Error('aborted');
}

/** forgelight.models without blanks. */
function cleanModels(models: unknown): string[] {
  return (Array.isArray(models) ? models : []).map((m) => String(m).trim()).filter(Boolean);
}

/** The guard's assessment (cwd resolved against the workspace root), or undefined without a guard or if it throws. */
function assessCommand(guard: CommandAssessor | undefined, command: string, cwd: string, root: string): CommandAssessment | undefined {
  if (!guard) return undefined;
  try {
    return guard.assess(command, path.resolve(root, cwd), root);
  } catch (err) {
    console.error('[forgelight] command guard failed:', err);
    return undefined;
  }
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** usage.inputTokensBreakdown as the SDK gives it, numeric entries only. */
function numericBreakdown(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(value)) if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Reject with `message` when `promise` takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Wait for `promise`, but at most `ms` (never rejects). */
function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise.then(
    () => undefined,
    () => undefined,
  ), timeout]).finally(() => clearTimeout(timer));
}

function emptyStream(): AsyncIterable<StreamEvent> {
  return (async function* () {})();
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function errorText(err: unknown): string {
  if (err instanceof TrueForgeError) {
    const apiMessage = (err.body as { error?: { message?: unknown } } | undefined)?.error?.message;
    if (typeof apiMessage === 'string') return err.statusCode ? `${apiMessage} (HTTP ${err.statusCode})` : apiMessage;
    const cause = (err.cause as { code?: string } | undefined)?.code;
    return cause && !err.message.includes(cause) ? `${err.message} (${cause})` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
