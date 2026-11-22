/**
 * Pure tests of the runner features (no vscode, no TrueForge): outage-proof sessions (retry, circuit
 * breaker, same-session model switch, continuation), context X-ray, sub-agent savings, the
 * shadow-test hook on reviews and the command guard hook. TrueForge is replaced by a scripted fake
 * client (AgentRunnerDeps.createClient). Run:
 *   npx esbuild test/runnerFeatures.test.ts --bundle --platform=node --outfile=/tmp/rf.js && node /tmp/rf.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import inlineAgentJson from '../agent/forgelight-inline.agent.json';
import agentJson from '../agent/forgelight.agent.json';
import {
  DEFAULT_CONFIG,
  type CommandAssessment,
  type CommandAssessor,
  type CommandDecision,
  type CommandGate,
  type CommandRequest,
  type ContextEngine,
  type ForgeConfig,
  type ForgeEvent,
  type ProposedChange,
  type ReviewGate,
  type ReviewResult,
  type RunRequest,
  type Verifier,
  type VerifyResult,
} from '../src/contracts';
import { DecisionStore, RunTracker } from '../src/decisions';
import { ForgeEventBus, estimateTokens } from '../src/events';
import { venvPrefix, workspaceVenv } from '../src/mcp/tools';
import { argsKey, pickProposeArgs } from '../src/review/hunks';
import {
  AgentRunner,
  CircuitBreaker,
  buildAgentSpec,
  continuationMessage,
  looksUnfinished,
  retryMessage,
  stallFollowUp,
  verifyNote,
  type RunnerClient,
} from '../src/trueforge/runner';
import type { AgentDefinition, TrueForgeSetup } from '../src/trueforge/setup';

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

function definition(json: { name: string; description: string; manifest: unknown }): AgentDefinition {
  return { name: json.name, description: json.description, manifest: structuredClone(json.manifest) as Record<string, unknown> };
}

{
  // buildAgentSpec: a model swap changes only model.name (the session update sends the same spec).
  const manifest = definition(agentJson).manifest;
  const a = buildAgentSpec(manifest, { model: 'a/one', iterationLimit: 60, inline: false }) as unknown as Record<string, any>;
  const b = buildAgentSpec(manifest, { model: 'b/two', iterationLimit: 60, inline: false }) as unknown as Record<string, any>;
  assert.equal(a.model.name, 'a/one');
  assert.equal(b.model.name, 'b/two');
  assert.deepEqual(b.model.params, a.model.params);
  assert.deepEqual({ ...b, model: undefined }, { ...a, model: undefined });
  assert.equal((manifest.model as Record<string, unknown>).name, 'ollama/qwen3-6-35b', 'manifest not mutated');
}

{
  const m = continuationMessage('unreachable/broken-model', 'ollama/qwen3-6-35b', '[Model Error] Cannot connect to API: bad port');
  assert.ok(m.startsWith('The previous model (unreachable/broken-model) failed mid-task: [Model Error] Cannot connect to API: bad port.'));
  assert.ok(m.includes('You are now running as ollama/qwen3-6-35b with the full conversation so far.'));
  assert.ok(m.includes('re-read affected files before editing them again and do not repeat finished steps.'));
  const same = continuationMessage('x/m', 'x/m', 'timeout');
  assert.ok(same.includes('You are still running as x/m'));
  assert.ok(continuationMessage('a', 'b', 'x'.repeat(2000)).length < 700, 'reason is clipped');
}

{
  const base: VerifyResult = { changeId: 'c', status: 'passed', tests: ['tests/test_cli.py'], summary: '59 passed in 0.4s', durationMs: 900 };
  assert.equal(verifyNote(base), 'Shadow tests with all hunks applied (tests/test_cli.py): 59 passed in 0.4s.');
  assert.equal(verifyNote({ ...base, status: 'failed', summary: '1 failed, 58 passed' }), 'Shadow tests with all hunks applied (tests/test_cli.py) FAILED: 1 failed, 58 passed.');
  assert.ok(verifyNote({ ...base, status: 'error', summary: 'timed out' })!.includes('could not complete: timed out'));
  assert.equal(verifyNote({ ...base, status: 'skipped' }), undefined);
  assert.equal(verifyNote({ ...base, status: 'cancelled' }), undefined);
}

{
  let now = 1_000_000;
  const cb = new CircuitBreaker(() => now);
  assert.equal(cb.trip('a', 0, 'x'), undefined, 'minutes 0 = breaker off');
  assert.deepEqual(cb.plan(['a', 'b'], 5), { usable: ['a', 'b'], skipped: [], ignored: false });
  const t0 = now;
  const e = cb.trip('a', 5, 'bad port')!;
  assert.equal(e.until, t0 + 5 * 60_000);
  assert.deepEqual(cb.plan(['a', 'b'], 5), { usable: ['b'], skipped: [{ model: 'a', until: e.until, reason: 'bad port' }], ignored: false });
  // The CURRENT setting decides, not the one the breaker tripped with: a lower value applies at once...
  assert.deepEqual(cb.plan(['a', 'b'], 2).skipped, [{ model: 'a', until: t0 + 2 * 60_000, reason: 'bad port' }]);
  // ...and 0 turns it off at once (and forgets the failure).
  assert.deepEqual(cb.plan(['a', 'b'], 0), { usable: ['a', 'b'], skipped: [], ignored: false });
  assert.equal(cb.status('a', 5), undefined);
  cb.trip('a', 5, 'bad port');
  now += 120_000;
  cb.trip('b', 5, 'down');
  assert.deepEqual(cb.plan(['a', 'b'], 5), { usable: ['a', 'b'], skipped: [], ignored: true }, 'all open: breaker ignored');
  assert.deepEqual(cb.plan(['a', 'b'], 1).usable, ['a'], "a failed 2 min ago: closed under a 1-min setting; b still open");
  now += 61_000; // b's breaker expires under 1 min
  assert.deepEqual(cb.plan(['a', 'b'], 1).usable, ['a', 'b']);
  cb.trip('a', 5, 'x');
  assert.equal(cb.close('a'), true);
  assert.equal(cb.status('a', 5), undefined);
  cb.trip('c', 5, 'x');
  assert.deepEqual(cb.reset(), ['c']);
  assert.deepEqual(cb.plan(['c'], 5).usable, ['c']);
}

// ---------------------------------------------------------------------------------------------
// Scripted fake TrueForge
// ---------------------------------------------------------------------------------------------

type Ev = Record<string, any>;
let seq = 0;
const id = (p = 'ev') => `${p}-${++seq}`;
const at = () => new Date().toISOString();
const usage = (input: number, output = 50) => ({
  inputTokens: input,
  outputTokens: output,
  inputTokensBreakdown: { harness: 100, instructions: 400, toolDefinitions: 900, messages: input - 1400, skills: 0 },
});
const turnCreated = (): Ev => ({ type: 'turn.created', id: id(), createdAt: at(), turnId: id('turn'), previousTurnId: null, threadId: null, state: { status: 'running' } });
const message = (o: { threadId?: string; content?: string; toolCalls?: Ev[]; finishReason?: string; usage?: Ev; model?: string }): Ev => ({
  type: 'model.message',
  id: id('msg'),
  createdAt: at(),
  threadId: o.threadId ?? 'main',
  content: o.content ?? '',
  toolCalls: o.toolCalls,
  finishReason: o.finishReason ?? (o.toolCalls ? 'tool_calls' : 'stop'),
  usage: o.usage,
  model: o.model ? { name: o.model } : undefined,
});
const toolCall = (tool: string, args: unknown): Ev => ({
  id: id('call'),
  type: 'function',
  function: { name: tool, arguments: JSON.stringify(args) },
  toolInfo: { type: 'mcp', serverName: 'forgelight-editor', name: tool },
});
const approvalRequired = (msg: Ev, call: Ev): Ev => ({
  type: 'tool.approval_required',
  id: id(),
  createdAt: at(),
  threadId: msg.threadId,
  toolCalls: [{ id: call.id, sourceEventId: msg.id }],
});
const doneOk = (output: Ev): Ev => ({ type: 'turn.done', id: id(), createdAt: at(), threadId: null, state: { status: 'done', completedAt: at(), output, requiredActions: [] } });
const doneError = (msg: string): Ev => ({ type: 'turn.done', id: id(), createdAt: at(), threadId: null, state: { status: 'error', completedAt: at(), message: msg } });
const BAD_PORT = '[Model Error] Cannot connect to API: bad port';

interface TurnInfo {
  sessionId: string;
  model: string;
  content: string;
}
type Script = (t: TurnInfo, fake: FakeTrueForge) => AsyncGenerator<Ev>;

class FakeTrueForge {
  readonly created: Array<{ id: string; model: string; spec: Record<string, any> }> = [];
  readonly updates: Array<{ sessionId: string; model: string; spec: Record<string, any> }> = [];
  readonly turns: TurnInfo[] = [];
  readonly answers: Ev[] = [];
  readonly cancels: string[] = [];
  updateError: Error | ((model: string) => Error | undefined) | undefined;
  createError: ((model: string) => Error | undefined) | undefined;
  private readonly model = new Map<string, string>();
  private readonly waiters: Array<(events: Ev[]) => void> = [];
  private readonly answered: Ev[][] = [];

  constructor(readonly scripts: Script[]) {}

  /** Next batch of approval answers (createTurnEvents), in order. */
  nextAnswer(): Promise<Ev[]> {
    const ready = this.answered.shift();
    return ready ? Promise.resolve(ready) : new Promise((resolve) => this.waiters.push(resolve));
  }

  readonly sessions = {
    create: async (req: Ev) => {
      const err = this.createError?.(req.agent.spec.model.name);
      if (err) throw err;
      const sid = `session-${this.created.length + 1}`;
      this.model.set(sid, req.agent.spec.model.name);
      this.created.push({ id: sid, model: req.agent.spec.model.name, spec: structuredClone(req.agent.spec) });
      return { data: { id: sid } };
    },
    update: async (sid: string, req: Ev) => {
      const err = typeof this.updateError === 'function' ? this.updateError(req.agent.spec.model.name) : this.updateError;
      if (err) throw err;
      this.model.set(sid, req.agent.spec.model.name);
      this.updates.push({ sessionId: sid, model: req.agent.spec.model.name, spec: req.agent.spec });
      return { data: {} };
    },
    cancel: async (sid: string) => {
      this.cancels.push(sid);
      return { data: {} };
    },
    createTurnStream: async (sid: string, req: Ev) => {
      const t: TurnInfo = { sessionId: sid, model: this.model.get(sid) ?? '?', content: req.input[0].content };
      this.turns.push(t);
      const script = this.scripts.shift();
      if (!script) throw new Error(`no script left for turn ${this.turns.length}`);
      return script(t, this);
    },
    createTurnEvents: async (_sid: string, _turnId: string, req: Ev) => {
      this.answers.push(...req.events);
      const w = this.waiters.shift();
      if (w) w(req.events);
      else this.answered.push(req.events);
      return { data: {} };
    },
    subscribeToTurn: async () => (async function* () {})(),
    getTurn: async () => ({ data: { state: { status: 'running' } } }),
  };
}

// Scripts
const failInstantly: Script = async function* () {
  yield turnCreated();
  yield doneError(BAD_PORT);
};
const finishWith = (text: string, input = 9000): Script =>
  async function* () {
    yield turnCreated();
    const out = message({ content: text, usage: usage(input) });
    yield out;
    yield doneOk(out);
  };

// ---------------------------------------------------------------------------------------------
// Fake gates
// ---------------------------------------------------------------------------------------------

const acceptAll = (c: ProposedChange): ReviewResult => {
  const idx = c.hunks.map((h) => h.index);
  return { changeId: c.id, decisions: idx.map(() => 'accepted'), accepted: idx, rejected: [] };
};
const cancelledReview = (c: ProposedChange): ReviewResult => {
  const idx = c.hunks.map((h) => h.index);
  return { changeId: c.id, decisions: idx.map(() => 'rejected'), accepted: [], rejected: idx, cancelled: true };
};

class FakeReview implements ReviewGate {
  discarded: number[] = [];
  decide: (c: ProposedChange, signal: AbortSignal) => Promise<ReviewResult> = async (c) => acceptAll(c);
  constructor(private readonly bus: ForgeEventBus) {}
  review(change: ProposedChange, signal: AbortSignal): Promise<ReviewResult> {
    this.bus.emit({ type: 'review.opened', runId: change.runId, changeId: change.id, path: change.path, isNewFile: change.isNewFile, hunks: [] });
    return this.decide(change, signal);
  }
  discardRun(runId: number): void {
    this.discarded.push(runId);
  }
}

class FakeCommands implements CommandGate {
  readonly requests: CommandRequest[] = [];
  decision: CommandDecision = 'once';
  async approve(req: CommandRequest): Promise<CommandDecision> {
    this.requests.push(req);
    return this.decision;
  }
}

const fakeContext = {
  retrieve: async (query: string, budgetTokens: number) => ({ query, budgetTokens, usedTokens: 0, files: [], dropped: [], packedText: '' }),
  resolveMentions: async () => ({ explicitBlock: '', files: [], unresolved: [] }),
} as unknown as ContextEngine;

const FILES: Record<string, string> = { 'src/app.py': 'def f():\n    return 1\n' };

interface Harness {
  runner: AgentRunner;
  fake: FakeTrueForge;
  events: ForgeEvent[];
  cfg: ForgeConfig;
  bus: ForgeEventBus;
  review: FakeReview;
  commands: FakeCommands;
  decisions: DecisionStore;
  setFake(f: FakeTrueForge): void;
  ofType<T extends ForgeEvent['type']>(type: T): Array<Extract<ForgeEvent, { type: T }>>;
}

function harness(opts: { models: string[]; scripts: Script[]; verifier?: Verifier; guard?: CommandAssessor; cfg?: Partial<ForgeConfig> }): Harness {
  const bus = new ForgeEventBus();
  const events: ForgeEvent[] = [];
  bus.on((e) => events.push(e));
  const cfg: ForgeConfig = { ...DEFAULT_CONFIG, models: opts.models, retryAttempts: 1, retryBackoffMs: 0, ...opts.cfg };
  let fake = new FakeTrueForge(opts.scripts);
  const review = new FakeReview(bus);
  const commands = new FakeCommands();
  const decisions = new DecisionStore();
  const setup = {
    baseUrl: 'http://tf.test',
    sessionUrl: (sid: string) => `http://tf.test/s/${sid}`,
    modelDetails: async () => [
      { name: 'good/model', contextLength: 65536, maxOutputTokens: 16384 },
      { name: 'b/model', contextLength: 32768 },
    ],
  } as unknown as TrueForgeSetup;
  const runner = new AgentRunner({
    config: () => cfg,
    bus,
    decisions,
    runs: new RunTracker(),
    review,
    commands,
    io: { root: '/ws', readText: async (p: string) => FILES[p] },
    context: fakeContext,
    setup,
    agentDefinition: definition(agentJson),
    inlineAgentDefinition: definition(inlineAgentJson),
    verifier: opts.verifier,
    guard: opts.guard,
    createClient: () => fake as unknown as RunnerClient,
  });
  return {
    runner,
    get fake() {
      return fake;
    },
    events,
    cfg,
    bus,
    review,
    commands,
    decisions,
    setFake(f) {
      fake = f;
    },
    ofType: <T extends ForgeEvent['type']>(type: T) => events.filter((e): e is Extract<ForgeEvent, { type: T }> => e.type === type),
  };
}

const inlineReq: RunRequest = {
  mode: 'inline',
  text: 'return 2',
  inlineTarget: { path: 'src/app.py', startLine: 1, endLine: 2, selectedText: 'def f():\n    return 1\n' },
};
const agentReq: RunRequest = { mode: 'agent', text: 'make f return 2 and run the tests' };
const tick = () => new Promise((r) => setTimeout(r, 0));

async function main(): Promise<void> {
  // Stall nudge: announced-but-not-taken steps vs finished answers.
  assert.equal(looksUnfinished('The sub-agent is investigating. Let me wait for its response before proceeding with Step 2 (reading files). I\'ll continue once it reports back.'), true);
  assert.equal(looksUnfinished('Now let me update the documentation:'), true);
  assert.equal(looksUnfinished("Done. I added `flask config` to cli.py, a test in test_cli.py and docs in cli.rst. Let me know if you'd like changes."), false);
  assert.equal(looksUnfinished('Added the config command, its test and docs. All 60 tests in tests/test_cli.py pass.'), false);
  assert.equal(looksUnfinished('Done.'), false);
  assert.equal(looksUnfinished(''), false);
  assert.match(stallFollowUp(true, 0), /propose_edit/);
  assert.match(stallFollowUp(false, 0), /No edit has been proposed yet/);
  assert.match(stallFollowUp(false, 2), /already applied/);
  // -------------------------------------------------------------------------------------------
  // F3 + F4: instant model failure -> retry on the same session -> breaker -> same-session switch
  // -------------------------------------------------------------------------------------------
  const h = harness({ models: ['bad/model', 'good/model'], scripts: [failInstantly, failInstantly, finishWith('Done.')] });
  const out = await h.runner.run(inlineReq);
  assert.equal(out.status, 'done', out.message);
  assert.equal(out.model, 'good/model');
  assert.equal(h.fake.created.length, 1, 'one session per run');
  assert.equal(h.fake.created[0].model, 'bad/model');
  assert.deepEqual(h.fake.updates.map((u) => [u.sessionId, u.model]), [['session-1', 'good/model']]);
  // The update carries the same inline spec as the session, with only the model changed.
  assert.deepEqual({ ...h.fake.updates[0].spec, model: { ...h.fake.updates[0].spec.model, name: 'bad/model' } }, h.fake.created[0].spec);
  assert.deepEqual(h.fake.turns.map((t) => t.model), ['bad/model', 'bad/model', 'good/model']);
  const original = h.fake.turns[0].content;
  assert.ok(original.startsWith('INLINE EDIT'));
  // No output before the failure: the failed turn's request is already in the session history, so
  // the retry and the switched model get a short note instead of a second (third) copy of it.
  assert.deepEqual(
    h.fake.turns.slice(1).map((t) => t.content),
    [retryMessage('bad/model', 'bad/model', BAD_PORT), retryMessage('bad/model', 'good/model', BAD_PORT)],
  );
  assert.ok(h.fake.turns.slice(1).every((t) => t.content.length < 400 && !t.content.includes('INLINE EDIT')));
  assert.deepEqual(h.ofType('model.retry').map((e) => [e.model, e.attempt, e.delayMs]), [['bad/model', 2, 0]]);
  const down = h.ofType('model.health').filter((e) => e.status === 'down');
  assert.equal(down.length, 1);
  assert.equal(down[0].model, 'bad/model');
  assert.ok(down[0].retryAt && Date.parse(down[0].retryAt) > Date.now() + 4 * 60_000);
  assert.deepEqual(h.ofType('model.fallback').map((e) => [e.from, e.to]), [['bad/model', 'good/model']]);
  const resume = h.ofType('model.resume');
  assert.deepEqual(resume.map((e) => [e.from, e.to, e.sessionId, e.reason]), [['bad/model', 'good/model', 'session-1', BAD_PORT]]);
  const ok = h.ofType('model.health').filter((e) => e.status === 'ok');
  assert.deepEqual(ok.map((e) => e.model), ['good/model']);
  assert.equal(typeof ok[0].latencyMs, 'number');
  const usageEv = h.ofType('context.usage');
  assert.equal(usageEv.length, 1);
  assert.equal(usageEv[0].model, 'good/model');
  assert.equal(usageEv[0].inputTokens, 9000);
  assert.equal(usageEv[0].contextLength, 65536);
  assert.deepEqual(usageEv[0].breakdown, { harness: 100, instructions: 400, toolDefinitions: 900, messages: 7600, skills: 0 });
  assert.equal(h.ofType('run.finished').length, 1);
  assert.equal(h.ofType('run.session').length, 1);
  assert.equal(h.ofType('run.started')[0].model, 'bad/model');

  // Next run: bad/model's breaker is open, so it is skipped and the session starts on good/model.
  h.setFake(new FakeTrueForge([finishWith('Done.')]));
  const out2 = await h.runner.run(inlineReq);
  assert.equal(out2.status, 'done');
  assert.deepEqual(h.fake.created.map((c) => c.model), ['good/model']);
  assert.equal(h.fake.updates.length, 0);
  const skipped = h.ofType('model.health').filter((e) => e.status === 'skipped');
  assert.deepEqual(skipped.map((e) => e.model), ['bad/model']);
  assert.ok(skipped[0].retryAt);
  assert.equal(h.ofType('run.started')[1].model, 'good/model');

  // resetHealth (models setting changed): bad/model is tried first again.
  h.runner.resetHealth();
  assert.ok(h.events.some((e) => e.type === 'model.health' && e.model === 'bad/model' && e.status === 'unknown'));
  h.setFake(new FakeTrueForge([finishWith('Done.')]));
  await h.runner.run(inlineReq);
  assert.deepEqual(h.fake.created.map((c) => c.model), ['bad/model']);
  // Changing the models list also resets the breaker on its own.
  h.cfg.models = ['bad/model'];
  h.setFake(new FakeTrueForge([failInstantly, failInstantly]));
  const failedRun = await h.runner.run(inlineReq);
  assert.equal(failedRun.status, 'error');
  assert.ok(failedRun.message!.startsWith('Every configured model failed; nothing in the workspace was changed.'), failedRun.message);
  // ...and when every model's breaker is open, the breaker is ignored.
  h.setFake(new FakeTrueForge([finishWith('Done.')]));
  const before = h.events.length;
  await h.runner.run(inlineReq);
  assert.deepEqual(h.fake.created.map((c) => c.model), ['bad/model']);
  assert.ok(h.events.slice(before).some((e) => e.type === 'notice' && /trying them again anyway/.test(e.text)));
  // That success closed the breaker: the next run neither skips nor ignores anything.
  h.setFake(new FakeTrueForge([finishWith('Done.')]));
  const before2 = h.events.length;
  await h.runner.run(inlineReq);
  assert.ok(!h.events.slice(before2).some((e) => (e.type === 'notice' && /circuit breaker|trying them again/.test(e.text)) || (e.type === 'model.health' && e.status === 'skipped')));

  // forgelight.circuitBreakerMinutes is read on every run: 0 turns an open breaker off at once.
  {
    const hz = harness({ models: ['bad/model', 'good/model'], scripts: [failInstantly, failInstantly, finishWith('Done.')] });
    await hz.runner.run(inlineReq);
    hz.cfg.circuitBreakerMinutes = 0;
    hz.setFake(new FakeTrueForge([finishWith('Done.')]));
    const before = hz.events.length;
    await hz.runner.run(inlineReq);
    assert.deepEqual(hz.fake.created.map((c) => c.model), ['bad/model'], 'breaker off: the primary is tried again');
    assert.ok(!hz.events.slice(before).some((e) => e.type === 'model.health' && e.status === 'skipped'));
  }

  // Changing forgelight.models resets the breakers on its own (no resetHealth call).
  {
    const ha = harness({ models: ['bad/model', 'good/model'], scripts: [failInstantly, failInstantly, finishWith('Done.')] });
    await ha.runner.run(inlineReq);
    ha.cfg.models = ['bad/model', 'good/model', 'other/model'];
    ha.setFake(new FakeTrueForge([finishWith('Done.')]));
    await ha.runner.run(inlineReq);
    assert.deepEqual(ha.fake.created.map((c) => c.model), ['bad/model']);
    assert.ok(ha.events.some((e) => e.type === 'model.health' && e.model === 'bad/model' && e.status === 'unknown'));
  }

  // Unknown model at session creation: next model, no retry; unknown model on the switch: skip it too.
  {
    const hc = harness({ models: ['ghost/model', 'good/model'], scripts: [finishWith('Done.')] });
    hc.fake.createError = (m) => (m === 'ghost/model' ? new Error('Unknown model: ghost/model') : undefined);
    const r = await hc.runner.run(inlineReq);
    assert.equal(r.status, 'done', r.message);
    assert.deepEqual(hc.fake.created.map((c) => c.model), ['good/model']);
    assert.equal(hc.ofType('model.retry').length, 0);
    assert.deepEqual(hc.ofType('model.fallback').map((e) => [e.from, e.to]), [['ghost/model', 'good/model']]);
    assert.equal(hc.ofType('model.resume').length, 0);

    const hu = harness({ models: ['a/model', 'ghost/model', 'good/model'], scripts: [failInstantly, finishWith('Done.')], cfg: { retryAttempts: 0 } });
    hu.fake.updateError = (m) => (m === 'ghost/model' ? new Error('Unknown model: ghost/model (HTTP 422)') : undefined);
    const ru = await hu.runner.run(inlineReq);
    assert.equal(ru.status, 'done', ru.message);
    assert.deepEqual(hu.fake.updates.map((u) => u.model), ['good/model']);
    assert.deepEqual(hu.ofType('model.fallback').map((e) => [e.from, e.to]), [['a/model', 'ghost/model'], ['ghost/model', 'good/model']]);
    assert.deepEqual(hu.ofType('model.resume').map((e) => [e.from, e.to, e.reason]), [['a/model', 'good/model', BAD_PORT]]);
    assert.deepEqual(hu.ofType('model.health').filter((e) => e.status === 'down').map((e) => e.model), ['a/model', 'ghost/model']);
  }

  // sessions.update fails after an edit was applied: stop (no new session that could repeat edits).
  {
    const editThenFail: Script = async function* (_t, fake) {
      yield turnCreated();
      const call = toolCall('propose_edit', { path: 'src/app.py', edits: [{ search: 'return 1', replace: 'return 7' }] });
      const msg = message({ toolCalls: [call] });
      yield msg;
      yield approvalRequired(msg, call);
      await fake.nextAnswer();
      hs.bus.emit({
        type: 'edit.applied',
        runId: hs.ofType('run.started')[0].runId,
        record: { changeId: call.id, runId: hs.ofType('run.started')[0].runId, path: 'src/app.py', absPath: '/ws/src/app.py', beforeText: '', afterText: '', createdFile: false, hunksApplied: [0], hunksRejected: [] },
      });
      yield doneError(BAD_PORT);
    };
    const hs = harness({ models: ['a/model', 'b/model'], scripts: [editThenFail], cfg: { retryAttempts: 0 } });
    hs.fake.updateError = new Error('PATCH failed (500)');
    const r = await hs.runner.run(agentReq);
    assert.equal(r.status, 'error');
    assert.ok(/could not move the session to b\/model/.test(r.message ?? ''), r.message);
    assert.equal(hs.fake.created.length, 1);
    assert.equal(r.applied.length, 1);
  }

  // -------------------------------------------------------------------------------------------
  // F3 mid-task + F1: an accepted edit, then the model fails -> same session, continuation turn.
  // The shadow test result (known before the decision) reaches the agent through the review note.
  // -------------------------------------------------------------------------------------------
  {
    let editArgs: Record<string, unknown> = {};
    let storedNote: string | undefined;
    let runIdSeen = 0;
    const editThenFail: Script = async function* (_t, fake) {
      yield turnCreated();
      editArgs = { path: 'src/app.py', edits: [{ search: 'return 1', replace: 'return 2' }], explanation: 'return 2' };
      const call = toolCall('propose_edit', editArgs);
      const msg = message({ toolCalls: [call], usage: usage(5000) });
      yield msg;
      yield approvalRequired(msg, call);
      const [answer] = await fake.nextAnswer();
      assert.equal(answer.approval.status, 'allow');
      // What the MCP server does next: take the stored decision and apply it.
      const d = h2.decisions.take(argsKey(pickProposeArgs(editArgs)));
      assert.ok(d && 'result' in d);
      assert.equal(d.result.note, undefined, 'the shadow result is not presented as a user note');
      storedNote = d.verifyNote;
      runIdSeen = d.runId;
      h2.bus.emit({
        type: 'edit.applied',
        runId: d.runId,
        record: { changeId: call.id, runId: d.runId, path: 'src/app.py', absPath: '/ws/src/app.py', beforeText: '', afterText: '', createdFile: false, hunksApplied: [0], hunksRejected: [] },
      });
      yield { type: 'tool.response', id: id(), createdAt: at(), threadId: 'main', toolCallId: call.id, content: 'Applied 1 hunk to src/app.py.' };
      yield doneError(BAD_PORT);
    };
    const verifier: Verifier = {
      plan: async () => ({ command: '.venv/bin/python -m pytest tests/test_app.py -q', tests: ['tests/test_app.py'] }),
      verify: async (c) => ({ changeId: c.id, status: 'passed', command: 'pytest', tests: ['tests/test_app.py'], summary: '3 passed in 0.1s', durationMs: 100 }),
    };
    let discardedBeforeResume = -1;
    const resumeTurn: Script = async function* (t, fake) {
      discardedBeforeResume = h2.review.discarded.length;
      yield* finishWith('Finished on b.', 20000)(t, fake);
    };
    const h2 = harness({ models: ['a/model', 'b/model'], scripts: [editThenFail, resumeTurn], verifier, cfg: { retryAttempts: 0 } });
    // The reviewer decides only after the shadow run reported back.
    h2.review.decide = (c) =>
      new Promise((resolve) => {
        const off = h2.bus.on((e) => {
          if (e.type === 'verify.finished' && e.result.changeId === c.id) {
            off();
            setTimeout(() => resolve(acceptAll(c)), 0);
          }
        });
      });
    const r = await h2.runner.run(agentReq);
    assert.equal(r.status, 'done', r.message);
    assert.equal(r.applied.length, 1);
    assert.equal(runIdSeen, r.runId);
    assert.equal(h2.fake.created.length, 1);
    assert.deepEqual(h2.fake.updates.map((u) => u.model), ['b/model']);
    assert.equal(h2.fake.turns[1].sessionId, 'session-1');
    assert.equal(h2.fake.turns[1].content, continuationMessage('a/model', 'b/model', BAD_PORT), 'output before the failure: continuation message');
    assert.equal(h2.fake.answers.length, 1, 'the approval is never re-sent');
    assert.equal(storedNote, 'Shadow tests with all hunks applied (tests/test_app.py): 3 passed in 0.1s.');
    const kinds = h2.events.map((e) => e.type);
    assert.ok(kinds.indexOf('review.opened') < kinds.indexOf('verify.started'), 'card first, then its shadow run');
    const vs = h2.ofType('verify.started');
    assert.deepEqual(vs.map((e) => [e.command, e.tests]), [['.venv/bin/python -m pytest tests/test_app.py -q', ['tests/test_app.py']]]);
    assert.deepEqual(h2.ofType('verify.finished').map((e) => e.result.status), ['passed']);
    assert.deepEqual(h2.ofType('model.resume').map((e) => [e.from, e.to]), [['a/model', 'b/model']]);
    assert.equal(discardedBeforeResume, 1, 'reviews left open by the failed turn are closed before the next turn');
    const usages = h2.ofType('context.usage');
    assert.deepEqual(usages.map((u) => [u.model, u.inputTokens, u.contextLength]), [['a/model', 5000, undefined], ['b/model', 20000, 32768]]);
    assert.equal(h2.ofType('run.finished').length, 1);
  }

  // A rejected edit: the shadow result goes into the deny reason.
  {
    const editScript: Script = async function* (_t, fake) {
      yield turnCreated();
      const call = toolCall('propose_edit', { path: 'src/app.py', edits: [{ search: 'return 1', replace: 'return 3' }] });
      const msg = message({ toolCalls: [call] });
      yield msg;
      yield approvalRequired(msg, call);
      const [answer] = await fake.nextAnswer();
      assert.equal(answer.approval.status, 'deny');
      assert.equal(answer.approval.reason, 'The user rejected all hunks of this edit. Shadow tests with all hunks applied (tests/test_app.py) FAILED: 1 failed, 2 passed.');
      const out = message({ content: 'ok' });
      yield out;
      yield doneOk(out);
    };
    const verifier: Verifier = {
      plan: async () => ({ tests: ['tests/test_app.py'] }),
      verify: async (c) => ({ changeId: c.id, status: 'failed', tests: ['tests/test_app.py'], summary: '1 failed, 2 passed', outputTail: 'E assert 3 == 2', durationMs: 5 }),
    };
    const h3 = harness({ models: ['good/model'], scripts: [editScript], verifier });
    h3.review.decide = async (c) => {
      await new Promise((r) => setTimeout(r, 20));
      const idx = c.hunks.map((x) => x.index);
      return { changeId: c.id, decisions: idx.map(() => 'rejected'), accepted: [], rejected: idx };
    };
    const r = await h3.runner.run(inlineReq);
    assert.equal(r.status, 'done', r.message);
    assert.equal(h3.ofType('verify.started')[0].command, '', 'command optional in the plan');
  }

  // verifyBeforeAccept off, or nothing to test: no shadow run.
  {
    const editScript: Script = async function* (_t, fake) {
      yield turnCreated();
      const call = toolCall('propose_edit', { path: 'src/app.py', edits: [{ search: 'return 1', replace: 'return 4' }] });
      const msg = message({ toolCalls: [call] });
      yield msg;
      yield approvalRequired(msg, call);
      await fake.nextAnswer();
      const out = message({ content: 'ok' });
      yield out;
      yield doneOk(out);
    };
    let verifyCalls = 0;
    const verifier: Verifier = { plan: async () => ({ tests: ['t.py'] }), verify: async (c) => (verifyCalls++, { changeId: c.id, status: 'passed', tests: [], summary: '', durationMs: 0 }) };
    const off = harness({ models: ['good/model'], scripts: [editScript], verifier, cfg: { verifyBeforeAccept: false } });
    await off.runner.run(inlineReq);
    const none = harness({ models: ['good/model'], scripts: [editScript], verifier: { plan: async () => ({ tests: [] }), verify: verifier.verify } });
    await none.runner.run(inlineReq);
    // A custom verifyCommand without {tests} (npm test) has a command but no test targets: it still runs.
    const suite = harness({ models: ['good/model'], scripts: [editScript], verifier: { plan: async () => ({ command: 'npm test', tests: [] }), verify: verifier.verify } });
    await suite.runner.run(inlineReq);
    assert.deepEqual(suite.ofType('verify.started').map((e) => [e.command, e.tests]), [['npm test', []]]);
    assert.equal(verifyCalls, 1);
    verifyCalls = 0;
    const throwing = harness({ models: ['good/model'], scripts: [editScript], verifier: { plan: async () => { throw new Error('no python'); }, verify: verifier.verify } });
    const tr = await throwing.runner.run(inlineReq);
    assert.equal(tr.status, 'done');
    assert.ok(throwing.events.some((e) => e.type === 'notice' && /No shadow test run for src\/app.py: no python/.test(e.text)));
    assert.equal(verifyCalls, 0);
    assert.equal(off.ofType('verify.started').length + none.ofType('verify.started').length, 0);
  }

  // A run that ends normally waits briefly for a shadow run still in flight (verify.finished before run.finished).
  {
    const editScript: Script = async function* (_t, fake) {
      yield turnCreated();
      const call = toolCall('propose_edit', { path: 'src/app.py', edits: [{ search: 'return 1', replace: 'return 6' }] });
      const msg = message({ toolCalls: [call] });
      yield msg;
      yield approvalRequired(msg, call);
      await fake.nextAnswer();
      const out = message({ content: 'ok' });
      yield out;
      yield doneOk(out);
    };
    const verifier: Verifier = {
      plan: async () => ({ tests: ['tests/test_app.py'] }),
      verify: (c) => new Promise((resolve) => setTimeout(() => resolve({ changeId: c.id, status: 'passed', tests: ['tests/test_app.py'], summary: '3 passed', durationMs: 80 }), 80)),
    };
    const hg = harness({ models: ['good/model'], scripts: [editScript], verifier });
    const r = await hg.runner.run(inlineReq);
    assert.equal(r.status, 'done');
    const kinds = hg.events.map((e) => e.type);
    assert.deepEqual(hg.ofType('verify.finished').map((e) => e.result.status), ['passed']);
    assert.ok(kinds.indexOf('verify.finished') < kinds.indexOf('run.finished'));
  }

  // Cancel during review: the shadow run is aborted and verify.finished(cancelled) precedes run.finished.
  {
    let verifySignal: AbortSignal | undefined;
    const editScript: Script = async function* (_t, fake) {
      yield turnCreated();
      const call = toolCall('propose_edit', { path: 'src/app.py', edits: [{ search: 'return 1', replace: 'return 5' }] });
      const msg = message({ toolCalls: [call] });
      yield msg;
      yield approvalRequired(msg, call);
      await fake.nextAnswer(); // never answered
    };
    const verifier: Verifier = {
      plan: async () => ({ tests: ['tests/test_app.py'] }),
      verify: (c, signal) => {
        verifySignal = signal;
        return new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve({ changeId: c.id, status: 'cancelled', tests: [], summary: 'aborted', durationMs: 1 })),
        );
      },
    };
    const h4 = harness({ models: ['good/model'], scripts: [editScript], verifier });
    h4.review.decide = (c, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(cancelledReview(c))));
    h4.bus.on((e) => {
      if (e.type === 'verify.started') setTimeout(() => void h4.runner.cancel(), 5);
    });
    const r = await h4.runner.run(inlineReq);
    assert.equal(r.status, 'cancelled');
    assert.ok(verifySignal?.aborted);
    const kinds = h4.events.map((e) => e.type);
    assert.equal(kinds.filter((k) => k === 'verify.finished').length, 1);
    assert.ok(kinds.indexOf('verify.finished') < kinds.indexOf('run.finished'));
    assert.equal(h4.ofType('verify.finished')[0].result.status, 'cancelled');
    assert.equal(kinds.filter((k) => k === 'run.finished').length, 1);
    assert.deepEqual(h4.fake.cancels, ['session-1']);
  }

  // -------------------------------------------------------------------------------------------
  // F3: sessions.update fails -> old behaviour (new session) only while nothing was changed
  // -------------------------------------------------------------------------------------------
  {
    const h5 = harness({ models: ['a/model', 'b/model'], scripts: [failInstantly, finishWith('Done.')], cfg: { retryAttempts: 0 } });
    h5.fake.updateError = new Error('PATCH failed (500)');
    const r = await h5.runner.run(inlineReq);
    assert.equal(r.status, 'done', r.message);
    assert.deepEqual(h5.fake.created.map((c) => c.model), ['a/model', 'b/model']);
    assert.equal(h5.fake.turns[1].content, h5.fake.turns[0].content, 'new session: the original request');
    assert.ok(h5.events.some((e) => e.type === 'notice' && /Could not switch the TrueForge session to b\/model/.test(e.text)));
    assert.equal(h5.ofType('model.resume').length, 0);
    assert.equal(h5.ofType('run.session').length, 2);
    assert.equal(r.sessionId, 'session-2');
  }

  // Output truncated: no retry of the same model, straight to the next one.
  {
    const truncated: Script = async function* () {
      yield turnCreated();
      yield doneError('Output truncated: the model hit max_tokens');
    };
    const h6 = harness({ models: ['a/model', 'b/model'], scripts: [truncated, finishWith('Done.')], cfg: { retryAttempts: 3 } });
    const r = await h6.runner.run(inlineReq);
    assert.equal(r.status, 'done');
    assert.equal(h6.ofType('model.retry').length, 0);
    assert.deepEqual(h6.fake.updates.map((u) => u.model), ['b/model']);
  }

  // A non-model error is not retried and does not trip the breaker.
  {
    const h7 = harness({ models: ['a/model', 'b/model'], scripts: [async function* () { yield turnCreated(); yield doneError('Iteration limit reached'); }] });
    const r = await h7.runner.run(inlineReq);
    assert.equal(r.status, 'error');
    assert.equal(r.message, 'TrueForge reported an error: Iteration limit reached');
    assert.equal(h7.ofType('model.health').filter((e) => e.status === 'down').length, 0);
  }

  // -------------------------------------------------------------------------------------------
  // F4: sub-agent savings
  // -------------------------------------------------------------------------------------------
  {
    const returned = 'src/app.py:1-2, defines f\ntests/test_app.py:10-20, tests f';
    const withScout: Script = async function* () {
      yield turnCreated();
      yield { type: 'thread.created', id: id(), createdAt: at(), threadId: 'scout-1', title: 'context-scout', parent: { threadId: 'main', toolCallId: 'c0' }, agentInfo: { type: 'dynamic', name: 'context-scout', input: 'find f' } };
      yield message({ threadId: 'scout-1', toolCalls: [toolCall('read_file', { path: 'src/app.py' })], usage: usage(12000) });
      yield message({ threadId: 'scout-1', content: returned, usage: usage(15000) });
      yield { type: 'thread.done', id: id(), createdAt: at(), threadId: 'scout-1', title: 'context-scout', state: { status: 'done', output: { type: 'model.message', id: 'x', createdAt: at(), threadId: 'scout-1', content: returned } } };
      const out = message({ content: 'All done.', usage: usage(4000) });
      yield out;
      yield doneOk(out);
    };
    const h8 = harness({ models: ['good/model'], scripts: [withScout] });
    const r = await h8.runner.run(agentReq);
    assert.equal(r.status, 'done', r.message);
    assert.deepEqual(h8.ofType('subagent.savings').map((e) => [e.threadId, e.title, e.contextTokens, e.returnedTokens]), [
      ['scout-1', 'context-scout', 15000, estimateTokens(returned)],
    ]);
    assert.deepEqual(h8.ofType('context.usage').map((e) => [e.threadId, e.inputTokens]), [['scout-1', 12000], ['scout-1', 15000], ['main', 4000]]);
  }

  // -------------------------------------------------------------------------------------------
  // F5: command guard
  // -------------------------------------------------------------------------------------------
  {
    const assessments: Record<string, CommandAssessment> = {
      // the real guard prefixes hard-block reasons with "blocked: "; the runner drops the prefix
      'rm -rf /': { risk: 'destructive', blocked: true, reasons: ['blocked: deletes the filesystem root'] },
      'pytest -q': { risk: 'test', blocked: false, reasons: ['runs pytest'] },
      'pip install requests': { risk: 'network', blocked: false, reasons: ['installs packages'] },
      'make build': { risk: 'write', blocked: false, reasons: ['runs make'] },
      'rm -rf build': { risk: 'destructive', blocked: false, reasons: ['deletes files recursively'] },
    };
    const assessedWith: Array<[string, string, string]> = [];
    const guard: CommandAssessor = {
      assess: (command, cwd, root) => {
        assessedWith.push([command, cwd, root]);
        return assessments[command];
      },
    };
    const commands = ['rm -rf /', 'pytest -q', 'pip install requests', 'make build', 'rm -rf build'];
    const answers: Ev[] = [];
    const commandScript: Script = async function* (_t, fake) {
      yield turnCreated();
      for (const command of commands) {
        const call = toolCall('run_command', { command, cwd: 'src' });
        const msg = message({ toolCalls: [call] });
        yield msg;
        yield approvalRequired(msg, call);
        const events = await fake.nextAnswer();
        answers.push(...events.map((e) => ({ ...e, command })));
      }
      const out = message({ content: 'done' });
      yield out;
      yield doneOk(out);
    };
    const h9 = harness({ models: ['good/model'], scripts: [commandScript], guard, cfg: { autoApproveSafeCommands: true } });
    h9.commands.decision = 'tenMinutes';
    const r = await h9.runner.run(agentReq);
    assert.equal(r.status, 'done', r.message);
    assert.deepEqual(assessedWith[0], ['rm -rf /', '/ws/src', '/ws']);
    // blocked: denied with the guard's reasons, the user is never asked
    assert.equal(answers[0].approval.status, 'deny');
    assert.equal(answers[0].approval.reason, "Blocked by Forgelight's command guard: deletes the filesystem root. Use a safer command.");
    // test command: auto-approved
    assert.equal(answers[1].approval.status, 'allow');
    // network: asked, with the assessment on the request; "10 min" is kept locally (no TrueForge policy)
    assert.equal(answers[2].type, 'user.tool_approval');
    assert.equal(answers[2].approval.status, 'allow');
    // write command inside the 10-minute window: allowed without asking
    assert.equal(answers[3].approval.status, 'allow');
    // destructive (not blocked) is still asked even inside the window
    assert.deepEqual(h9.commands.requests.map((q) => [q.command, q.assessment?.risk]), [['pip install requests', 'network'], ['rm -rf build', 'destructive']]);
    assert.ok(!h9.fake.answers.some((e) => e.type === 'user.tool_approval_policy'));
    const resolved = h9.ofType('approval.resolved').map((e) => [e.decision, e.reason]);
    assert.deepEqual(resolved.map((x) => x[0]), ['blocked', 'auto', 'tenMinutes']);
    assert.equal(resolved[0][1], 'deletes the filesystem root');
    const cards = h9.ofType('approval.command');
    assert.deepEqual(cards.map((c) => [c.command, c.assessment?.risk, c.cwd]), [['rm -rf /', 'destructive', 'src'], ['pytest -q', 'test', 'src'], ['make build', 'write', 'src']]);
    assert.ok(cards.every((c) => c.toolCallId && c.requestId.startsWith('guard-')));
  }

  // Auto-approve never covers reads of secrets or of files outside the workspace (their output would
  // land in the model's context): those are asked even though they are rated 'read'.
  {
    const assessments: Record<string, CommandAssessment> = {
      'cat ~/.ssh/id_rsa': { risk: 'read', blocked: false, reasons: ['may expose secrets (~/.ssh/id_rsa)', 'reads files'] },
      'cat ~/.zsh_history': { risk: 'read', blocked: false, reasons: ['reads outside the workspace (~/.zsh_history)', 'reads files'] },
      'git status': { risk: 'read', blocked: false, reasons: ['shows git status'] },
    };
    const guard: CommandAssessor = { assess: (command) => assessments[command] };
    const commandScript: Script = async function* (_t, fake) {
      yield turnCreated();
      for (const command of Object.keys(assessments)) {
        const call = toolCall('run_command', { command });
        const msg = message({ toolCalls: [call] });
        yield msg;
        yield approvalRequired(msg, call);
        await fake.nextAnswer();
      }
      const out = message({ content: 'done' });
      yield out;
      yield doneOk(out);
    };
    const hs = harness({ models: ['good/model'], scripts: [commandScript], guard, cfg: { autoApproveSafeCommands: true } });
    await hs.runner.run(agentReq);
    assert.deepEqual(hs.commands.requests.map((q) => q.command), ['cat ~/.ssh/id_rsa', 'cat ~/.zsh_history']);
    assert.deepEqual(hs.ofType('approval.resolved').map((e) => e.decision), ['auto']);
  }

  // Without a guard: unchanged behaviour ("10 min" becomes a TrueForge session policy).
  {
    const commandScript: Script = async function* (_t, fake) {
      yield turnCreated();
      const call = toolCall('run_command', { command: 'pytest -q' });
      const msg = message({ toolCalls: [call] });
      yield msg;
      yield approvalRequired(msg, call);
      await fake.nextAnswer();
      const out = message({ content: 'done' });
      yield out;
      yield doneOk(out);
    };
    const h10 = harness({ models: ['good/model'], scripts: [commandScript], cfg: { autoApproveSafeCommands: true } });
    h10.commands.decision = 'tenMinutes';
    await h10.runner.run(agentReq);
    assert.equal(h10.commands.requests.length, 1);
    assert.equal(h10.commands.requests[0].assessment, undefined);
    assert.equal(h10.fake.answers[0].type, 'user.tool_approval_policy');
  }

  // Verify loop, part 2: the newest shadow run failed and the agent ended with "Done." (its own
  // commands hid the failure). The tests are re-run on the workspace as it is now: still failing ->
  // a follow-up turn with the output; passing -> the run ends.
  {
    const editScript: Script = async function* (_t, fake) {
      yield turnCreated();
      const call = toolCall('propose_edit', { path: 'src/app.py', edits: [{ search: 'return 1', replace: 'return 7' }] });
      const msg = message({ toolCalls: [call] });
      yield msg;
      yield approvalRequired(msg, call);
      await fake.nextAnswer();
      const out = message({ content: 'Done.' });
      yield out;
      yield doneOk(out);
    };
    const failingVerifier = (recheckPassesAfter: number) => {
      const calls: ProposedChange[] = [];
      const verifier: Verifier = {
        plan: async () => ({ command: 'pytest -q tests/test_app.py', tests: ['tests/test_app.py'] }),
        verify: async (c) => {
          calls.push(c);
          const rechecks = calls.filter((x) => x.id.endsWith('#recheck')).length;
          const status = c.id.endsWith('#recheck') && rechecks > recheckPassesAfter ? 'passed' : 'failed';
          return {
            changeId: c.id,
            status,
            command: 'pytest -q tests/test_app.py',
            tests: ['tests/test_app.py'],
            summary: status === 'failed' ? '1 failed, 2 passed' : '3 passed',
            outputTail: 'E   NameError: config_command',
            durationMs: 1,
          };
        },
      };
      return { calls, verifier };
    };
    const followUp = (text: string): Script =>
      async function* (t, fake) {
        assert.match(t.content, /re-ran the tests that cover src\/app\.py on the workspace as it is now, and they fail \(1 failed, 2 passed\)/);
        assert.match(t.content, /\$ pytest -q tests\/test_app\.py\nE {3}NameError: config_command/);
        yield* finishWith(text)(t, fake);
      };

    // Still failing after the first recheck, passing after the second: one follow-up turn.
    const v1 = failingVerifier(1);
    const h1 = harness({ models: ['good/model'], scripts: [editScript, followUp('Fixed.')], verifier: v1.verifier });
    const r1 = await h1.runner.run(agentReq);
    assert.equal(r1.status, 'done', r1.message);
    assert.equal(h1.fake.turns.length, 2);
    assert.equal(h1.fake.created.length, 1, 'the follow-up stays on the same session');
    assert.deepEqual(v1.calls.map((c) => c.id.endsWith('#recheck')), [false, true, true]);
    const recheck = v1.calls[1];
    assert.equal(recheck.path, 'src/app.py');
    assert.equal(recheck.proposedText, FILES['src/app.py'], 'the recheck tests the file as it is on disk');
    assert.deepEqual(recheck.hunks, []);
    assert.ok(h1.ofType('notice').some((e) => /Verify loop 1\/2: the tests covering src\/app\.py still fail on the workspace \(1 failed, 2 passed\)/.test(e.text)));

    // Never passing: at most two follow-ups, then the run ends normally.
    const v2 = failingVerifier(99);
    const h2 = harness({ models: ['good/model'], scripts: [editScript, followUp('Fixed.'), followUp('Fixed again.')], verifier: v2.verifier });
    const r2 = await h2.runner.run(agentReq);
    assert.equal(r2.status, 'done', r2.message);
    assert.equal(h2.fake.turns.length, 3);
    assert.equal(v2.calls.filter((c) => c.id.endsWith('#recheck')).length, 2);

    // Passing on the first recheck (the agent fixed it in a file the shadow run did not cover): no follow-up.
    const v3 = failingVerifier(0);
    const h3 = harness({ models: ['good/model'], scripts: [editScript], verifier: v3.verifier });
    assert.equal((await h3.runner.run(agentReq)).status, 'done');
    assert.equal(h3.fake.turns.length, 1);

    // Inline edits and passing shadow runs are never rechecked.
    const v4 = failingVerifier(99);
    const h4 = harness({ models: ['good/model'], scripts: [editScript], verifier: v4.verifier });
    assert.equal((await h4.runner.run(inlineReq)).status, 'done');
    assert.deepEqual(v4.calls.map((c) => c.id.endsWith('#recheck')), [false]);
    const passing: ProposedChange[] = [];
    const h5 = harness({
      models: ['good/model'],
      scripts: [editScript],
      verifier: { plan: async () => ({ tests: ['tests/test_app.py'] }), verify: async (c) => (passing.push(c), { changeId: c.id, status: 'passed', tests: [], summary: '3 passed', durationMs: 1 }) },
    });
    assert.equal((await h5.runner.run(agentReq)).status, 'done');
    assert.equal(passing.length, 1);
  }

  // run_command activates the workspace virtualenv, also in a login shell that rewrites PATH.
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fl-venv-'));
    const venv = path.join(dir, '.venv');
    await fs.mkdir(path.join(venv, 'bin'), { recursive: true });
    await fs.writeFile(path.join(venv, 'bin', 'python'), '#!/bin/sh\necho venv-python\n', { mode: 0o755 });
    assert.equal(await workspaceVenv(dir), venv);
    assert.equal(await workspaceVenv(path.join(dir, 'missing')), undefined);
    assert.equal(venvPrefix(undefined), '');
    assert.equal(venvPrefix("/a b/it's/.venv"), `export VIRTUAL_ENV='/a b/it'\\''s/.venv'; export PATH='/a b/it'\\''s/.venv'/bin:"$PATH"; unset PYTHONHOME; `);
    const out = execFileSync('/bin/bash', ['-lc', `${venvPrefix(venv)}python; echo "VENV=$VIRTUAL_ENV"`], { cwd: dir, encoding: 'utf8' });
    const lines = out.trim().split('\n');
    assert.ok(lines.includes('venv-python'), out);
    assert.ok(lines.includes(`VENV=${venv}`), out);
    await fs.rm(dir, { recursive: true, force: true });
  }

  // Stall nudge end to end: one follow-up turn on the same session, then the run finishes.
  {
    const hs = harness({ models: ['good/model'], scripts: [finishWith('The sub-agent is investigating. Let me wait for its response.'), finishWith('Done.')] });
    const r = await hs.runner.run(agentReq);
    assert.equal(r.status, 'done', r.message);
    assert.equal(hs.fake.created.length, 1, 'nudge stays on the same session');
    assert.ok(hs.ofType('notice').some((e) => /announcing a next step/.test((e as { text: string }).text)));
    const hi = harness({ models: ['good/model'], scripts: [finishWith('def f():\n    return 2'), finishWith('Done.')] });
    const ri = await hi.runner.run(inlineReq);
    assert.equal(ri.status, 'done', ri.message);
    assert.ok(hi.ofType('notice').some((e) => /without proposing an edit/.test((e as { text: string }).text)));
    // At most one nudge: a second stall ends the run normally.
    const h2 = harness({ models: ['good/model'], scripts: [finishWith('Let me wait.'), finishWith('Let me wait again.')] });
    const r2 = await h2.runner.run(agentReq);
    assert.equal(r2.status, 'done', r2.message);
  }

  await tick();
  console.log('runnerFeatures tests passed');
}

// A deadlock leaves no pending handles, so Node would exit 0 without finishing: fail unless main() completes.
process.exitCode = 1;
main().then(
  () => {
    process.exitCode = 0;
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
