/**
 * Editor capabilities exposed to the TrueForge agent as MCP tools (PURE: no vscode).
 *
 * Every handler returns a CallToolResult and never throws: failures become `isError` results
 * with a message the model can act on. Writes only happen through the ReviewGate + ApplyGate.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ApplyGate, ApplyRecord, ContextEngine, ProposedChange, ReviewGate, ReviewResult, WorkspaceIO } from '../contracts';
import type { DecisionStore, RunTracker } from '../decisions';
import type { ForgeEventBus } from '../events';
import { argsKey, computeProposal, pickProposeArgs } from '../review/hunks';

export interface EditorToolDeps {
  io: WorkspaceIO;
  context: ContextEngine;
  bus: ForgeEventBus;
  decisions: DecisionStore;
  runs: RunTracker;
  review: ReviewGate;
  apply: ApplyGate;
  /** Default run_command timeout in seconds (read on every call, so settings changes apply). */
  commandTimeoutSec: () => number;
  /** Live stdout/stderr of run_command (e.g. to an output channel). */
  onCommandOutput?: (chunk: string) => void;
}

export const EDITOR_TOOL_NAMES = [
  'read_file',
  'list_files',
  'search_code',
  'find_symbol',
  'repo_map',
  'retrieve_context',
  'propose_edit',
  'run_command',
] as const;

const READ_MAX_LINES = 400;
const READ_MAX_CHARS = 24_000;
const LIST_OUTPUT_MAX_CHARS = 24_000;
// TrueForge abandons an MCP tool call after 120 s (MCP_REQUEST_TIMEOUT_MS), so stay below it.
const COMMAND_MAX_TIMEOUT_SEC = 110;
const COMMAND_OUTPUT_TAIL = 12_000;
const CANCELLED_EDIT = 'Run was cancelled; no changes were made.';
const CANCELLED_COMMAND = 'Run was cancelled; the command was not run.';
const NO_DECISION = 'No review decision was recorded for this call; nothing was written. Call propose_edit again.';

// ---------------------------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------------------------

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function guarded(tool: string, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return fail(e instanceof UserFacingError ? e.message : `${tool} failed: ${errMsg(e)}`);
  }
}

/** Errors whose message is already written for the model. */
class UserFacingError extends Error {}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + ' …';
}

/** Join lines, stopping before `maxChars`; returns the joined text and how many lines fit. */
function joinCapped(lines: string[], maxChars: number): { text: string; shown: number } {
  let chars = 0;
  let shown = 0;
  for (const l of lines) {
    if (chars + l.length + 1 > maxChars && shown > 0) break;
    chars += l.length + 1;
    shown++;
  }
  return { text: lines.slice(0, shown).join('\n'), shown };
}

function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function plural(n: number, word: string): string {
  if (n === 1) return word;
  return /(s|x|z|ch|sh)$/.test(word) ? word + 'es' : word + 's';
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Normalize a model-supplied path to a workspace-relative POSIX path ('' = the root).
 * Absolute paths are accepted only when they point inside the root. Throws on escapes.
 */
export function toWorkspacePath(root: string, p: string | undefined): string {
  const raw = (p ?? '').trim();
  let s = raw.replace(/\\/g, '/');
  if (s === '' || s === '.' || s === './') return '';
  if (path.isAbsolute(s) || /^[a-zA-Z]:\//.test(s)) {
    if (!isInside(root, path.resolve(s))) {
      throw new UserFacingError(`Path "${raw}" is outside the workspace. Use a workspace-relative path such as "src/app.py".`);
    }
    s = path.relative(root, path.resolve(s)).split(path.sep).join('/');
  }
  const norm = path.posix.normalize(s).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (norm === '..' || norm.startsWith('../')) {
    throw new UserFacingError(`Path "${raw}" is outside the workspace. Use a workspace-relative path such as "src/app.py".`);
  }
  return norm === '.' ? '' : norm;
}

function requireFilePath(root: string, p: string | undefined): string {
  const rel = toWorkspacePath(root, p);
  if (!rel) throw new UserFacingError('A file path is required (workspace-relative, e.g. "src/app.py").');
  return rel;
}

// ---------------------------------------------------------------------------------------------
// Read-only tools
// ---------------------------------------------------------------------------------------------

interface ReadFileInput {
  path: string;
  start_line?: number;
  end_line?: number;
}

async function readFileTool(deps: EditorToolDeps, a: ReadFileInput): Promise<CallToolResult> {
  const rel = requireFilePath(deps.io.root, a.path);
  const text = await deps.io.readText(rel);
  if (text === undefined) {
    return fail(`File not found: ${rel}. Use list_files, search_code or find_symbol to locate the right path.`);
  }
  if (text.includes('\u0000')) return fail(`${rel} looks like a binary file; it cannot be shown.`);
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // trailing newline is not an extra line
  const total = lines.length;
  if (total === 0) return ok(`${rel} (empty file, 0 lines)`);

  const start = a.start_line ?? 1;
  if (start > total) return fail(`start_line ${start} is past the end of ${rel} (${total} lines).`);
  const wantedEnd = Math.min(a.end_line ?? total, total);
  if (wantedEnd < start) return fail(`end_line ${a.end_line} is before start_line ${start}.`);

  const out: string[] = [];
  let chars = 0;
  let last = start - 1;
  for (let n = start; n <= Math.min(wantedEnd, start + READ_MAX_LINES - 1); n++) {
    const line = lines[n - 1].replace(/\r$/, '');
    if (chars + line.length + 1 > READ_MAX_CHARS) {
      if (out.length === 0) {
        out.push(line.slice(0, READ_MAX_CHARS) + ' … [line truncated]');
        last = n;
      }
      break;
    }
    out.push(line);
    chars += line.length + 1;
    last = n;
  }
  let result = `${rel} (lines ${start}-${last} of ${total})\n${out.join('\n')}`;
  if (last < wantedEnd) {
    result +=
      `\n[read_file limit: at most ${READ_MAX_LINES} lines / ${READ_MAX_CHARS} characters per call.` +
      ` Call read_file with start_line=${last + 1} to read the next range.]`;
  }
  return ok(result);
}

async function listFilesTool(deps: EditorToolDeps, a: { dir?: string; max?: number }): Promise<CallToolResult> {
  const dir = toWorkspacePath(deps.io.root, a.dir);
  const max = clamp(Math.floor(a.max ?? 300), 1, 2000);
  const files = await deps.context.listFiles(dir || undefined, max);
  if (files.length === 0) return ok(dir ? `No files under ${dir}/.` : 'The workspace has no files.');
  const { text, shown } = joinCapped(files, LIST_OUTPUT_MAX_CHARS);
  const where = dir ? ` under ${dir}/` : '';
  const more =
    shown < files.length
      ? ` (showing the first ${shown}; pass a narrower dir)`
      : files.length >= max
        ? ` (limit of ${max} reached; pass a narrower dir or a larger max)`
        : '';
  return ok(`${files.length} ${plural(files.length, 'file')}${where}${more}:\n${text}`);
}

async function searchCodeTool(
  deps: EditorToolDeps,
  a: { query: string; regex?: boolean; glob?: string; max_results?: number },
): Promise<CallToolResult> {
  const max = clamp(Math.floor(a.max_results ?? 50), 1, 300);
  let hits;
  try {
    hits = await deps.context.search(a.query, { regex: a.regex, glob: a.glob, maxResults: max });
  } catch (e) {
    return fail(`Search failed: ${errMsg(e)}${a.regex ? ' (check the regular expression syntax)' : ''}`);
  }
  if (hits.length === 0) {
    return ok(`No matches for ${a.regex ? 'regex' : 'text'} "${a.query}"${a.glob ? ` in ${a.glob}` : ''}.`);
  }
  const lines = hits.map((h) => `${h.path}:${h.line}: ${clip(h.text.trim(), 240)}`);
  const { text, shown } = joinCapped(lines, LIST_OUTPUT_MAX_CHARS);
  const more =
    shown < hits.length
      ? ` (showing the first ${shown}; narrow the query or glob)`
      : hits.length >= max
        ? ` (limit of ${max} reached; narrow the query or glob, or raise max_results)`
        : '';
  return ok(`${hits.length} ${plural(hits.length, 'match')}${more}:\n${text}`);
}

async function findSymbolTool(deps: EditorToolDeps, a: { name: string }): Promise<CallToolResult> {
  const hits = await deps.context.findSymbol(a.name);
  if (hits.length === 0) return ok(`No definition found for "${a.name}". Try search_code for usages or a partial name.`);
  const lines = hits.map((h) => `${h.path}:${h.line}: ${h.kind} ${h.name} — ${clip(h.signature, 200)}`);
  return ok(joinCapped(lines, LIST_OUTPUT_MAX_CHARS).text);
}

async function repoMapTool(deps: EditorToolDeps, a: { max_tokens?: number }): Promise<CallToolResult> {
  const map = await deps.context.repoMap(clamp(Math.floor(a.max_tokens ?? 1500), 200, 8000));
  return ok(map.trim() ? map : '(the repository map is empty)');
}

async function retrieveContextTool(
  deps: EditorToolDeps,
  a: { query: string; budget_tokens?: number },
): Promise<CallToolResult> {
  const budget = clamp(Math.floor(a.budget_tokens ?? 6000), 500, 24_000);
  const pick = await deps.context.retrieve(a.query, budget);
  deps.bus.emit({ type: 'context.picked', runId: deps.runs.activeRunId ?? 0, pick });
  if (pick.files.length === 0) {
    return ok(`No relevant files found for "${a.query}". Try search_code, find_symbol or repo_map.`);
  }
  const ranked = pick.files.map(
    (f, i) => `${i + 1}. ${f.path} — ${f.reasons.join('; ') || 'relevant'} (${f.tokens} tokens)`,
  );
  const header =
    `Retrieved context for "${a.query}": ${pick.files.length} ${plural(pick.files.length, 'file')},` +
    ` ${pick.usedTokens}/${pick.budgetTokens} tokens.`;
  const dropped = pick.dropped.length
    ? `\nNot included (over budget): ${pick.dropped.slice(0, 10).map((d) => d.path).join(', ')}` +
      `${pick.dropped.length > 10 ? ` and ${pick.dropped.length - 10} more` : ''}. Use read_file if you need them.`
    : '';
  return ok(`${header}\n${ranked.join('\n')}${dropped}\n\n${pick.packedText}`);
}

// ---------------------------------------------------------------------------------------------
// propose_edit: never writes without a ReviewGate decision
// ---------------------------------------------------------------------------------------------

interface ProposeEditInput {
  path: string;
  edits?: Array<{ search: string; replace: string }>;
  new_content?: string;
  explanation?: string;
}

async function proposeEditTool(deps: EditorToolDeps, input: ProposeEditInput): Promise<CallToolResult> {
  // Same normalization the runner used at approval time, so the decision keys match.
  const args = pickProposeArgs(input);
  const key = argsKey(args);
  const runId = deps.runs.activeRunId;
  if (runId === undefined || deps.runs.isCancelled(runId)) return fail(CANCELLED_EDIT);

  const stored = deps.decisions.take(key);
  if (stored) {
    // invalid arguments: the runner allowed the call so the error reaches the model as a tool error
    if ('error' in stored) return fail(stored.error);
    if (stored.result.cancelled || deps.runs.isCancelled(stored.runId)) return fail(CANCELLED_EDIT);
    return applyReviewed(deps, stored.change, stored.result, stored.verifyNote);
  }

  // No decision was recorded for these exact arguments (approved from the TrueForge web UI, or the
  // executed arguments differ from the reviewed ones). Fail closed: never open a review inside the
  // tool call, since TrueForge abandons MCP calls after 120 s and the review would outlive it.
  const rel = requireFilePath(deps.io.root, input.path);
  const comp = computeProposal(await deps.io.readText(rel), { ...args, path: rel });
  if (comp.error || comp.proposedText === undefined) {
    return fail(comp.error ?? `Could not compute the proposed change for ${rel}.`);
  }
  return fail(NO_DECISION);
}

async function applyReviewed(deps: EditorToolDeps, change: ProposedChange, result: ReviewResult, verifyNote?: string): Promise<CallToolResult> {
  // verifyNote (Feature 1) is Forgelight's shadow test result, not something the user wrote
  const note = (result.note?.trim() ? ` User note: "${result.note.trim()}".` : '') + (verifyNote?.trim() ? ` ${verifyNote.trim()}` : '');
  if (result.accepted.length === 0) return ok(`All hunks were rejected by the user; nothing was written.${note}`);
  let record: ApplyRecord | undefined;
  try {
    record = await deps.apply.applyAccepted(change, result);
  } catch (e) {
    return fail(`Could not write ${change.path} (${errMsg(e)}). Nothing was written. Re-read the file and propose the change again.`);
  } finally {
    deps.context.invalidate(change.path);
  }
  if (!record) return fail(`Nothing was written to ${change.path} (the change was not applied, e.g. the run was cancelled).`);
  return ok(describeApply(change, record, note));
}

function describeApply(change: ProposedChange, record: ApplyRecord, note: string): string {
  const total = change.hunks.length;
  const applied = record.hunksApplied.map((i) => i + 1);
  const rejected = record.hunksRejected.map((i) => i + 1);
  let text = record.createdFile ? `Created new file ${record.path}` : `Applied`;
  if (record.createdFile) {
    text += rejected.length ? ` with ${plural(applied.length, 'hunk')} ${applied.join(', ')} of ${total}.` : '.';
  } else {
    text += ` ${plural(applied.length, 'hunk')} ${applied.join(', ')} of ${total} to ${record.path}.`;
  }
  if (rejected.length) {
    text +=
      ` Rejected ${plural(rejected.length, 'hunk')}: ${rejected.join(', ')}` +
      ' (the user rejected these; do not re-propose them unless asked).';
  }
  return text + note + ` ${record.path} has changed; call read_file before editing it again.`;
}

// ---------------------------------------------------------------------------------------------
// run_command
// ---------------------------------------------------------------------------------------------

interface ExecResult {
  spawnError?: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  output: string;
  /** Characters dropped from the front of `output`. */
  dropped: number;
}

async function resolveCwd(root: string, cwd: string | undefined): Promise<string> {
  const rel = toWorkspacePath(root, cwd);
  const abs = rel ? path.join(root, rel) : root;
  let realAbs: string;
  try {
    realAbs = await fs.realpath(abs);
  } catch {
    throw new UserFacingError(`cwd "${cwd}" does not exist in the workspace.`);
  }
  if (!isInside(await fs.realpath(root), realAbs)) throw new UserFacingError(`cwd "${cwd}" resolves outside the workspace.`);
  if (!(await fs.stat(realAbs)).isDirectory()) throw new UserFacingError(`cwd "${cwd}" is not a directory.`);
  return abs;
}

/** Run `bash -lc command` in its own process group; kill the whole group on timeout/abort. */
function execInGroup(
  command: string,
  cwd: string,
  timeoutSec: number,
  signal: AbortSignal | undefined,
  onOutput: ((chunk: string) => void) | undefined,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const res: ExecResult = { code: null, signal: null, timedOut: false, aborted: false, output: '', dropped: 0 };
    const emit = (s: string) => {
      try {
        onOutput?.(s);
      } catch {
        // a broken output sink must not break the command
      }
    };
    if (signal?.aborted) {
      res.aborted = true;
      return resolve(res);
    }
    let child: ChildProcess;
    try {
      child = spawn('/bin/bash', ['-lc', command], { cwd, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      res.spawnError = errMsg(e);
      return resolve(res);
    }

    const append = (chunk: string) => {
      res.output += chunk;
      if (res.output.length > COMMAND_OUTPUT_TAIL) {
        res.dropped += res.output.length - COMMAND_OUTPUT_TAIL;
        res.output = res.output.slice(-COMMAND_OUTPUT_TAIL);
      }
      emit(chunk);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // group already gone
      }
    };
    const terminate = () => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 2000).unref();
    };
    const timer = setTimeout(() => {
      res.timedOut = true;
      terminate();
    }, timeoutSec * 1000);
    const onAbort = () => {
      res.aborted = true;
      terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve(res);
    };
    child.on('error', (e) => {
      if (child.pid === undefined) res.spawnError = e.message;
      finish();
    });
    child.on('exit', (code, sig) => {
      res.code = code;
      res.signal = sig;
      // Background children may keep the pipes open; do not wait for them forever.
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, 1500);
    });
    child.on('close', (code, sig) => {
      if (res.code === null && res.signal === null) {
        res.code = code;
        res.signal = sig;
      }
      finish();
    });
  });
}

function outputTail(r: ExecResult): string {
  if (!r.output) return '(no output)';
  if (!r.dropped) return r.output;
  // start at a line boundary when one is near
  const nl = r.output.indexOf('\n');
  const body = nl >= 0 && nl < 300 ? r.output.slice(nl + 1) : r.output;
  return `[… ${r.dropped + (r.output.length - body.length)} earlier characters omitted]\n${body}`;
}

async function runCommandTool(
  deps: EditorToolDeps,
  a: { command: string; cwd?: string; timeout_sec?: number },
): Promise<CallToolResult> {
  const runId = deps.runs.activeRunId;
  if (runId === undefined || deps.runs.isCancelled(runId)) return fail(CANCELLED_COMMAND);
  const cwd = await resolveCwd(deps.io.root, a.cwd);
  const timeoutSec = clamp(a.timeout_sec ?? deps.commandTimeoutSec(), 1, COMMAND_MAX_TIMEOUT_SEC);
  const relCwd = path.relative(deps.io.root, cwd) || '.';
  const emit = (s: string) => {
    try {
      deps.onCommandOutput?.(s);
    } catch {
      // ignore sink errors
    }
  };
  emit(`$ ${a.command}${relCwd !== '.' ? `   (in ${relCwd})` : ''}\n`);
  const r = await execInGroup(a.command, cwd, timeoutSec, deps.runs.activeSignal, deps.onCommandOutput);
  if (r.spawnError) {
    emit(`[could not start: ${r.spawnError}]\n`);
    return fail(`Could not start the command: ${r.spawnError}`);
  }
  let status = r.code !== null ? String(r.code) : `none (killed by ${r.signal ?? 'signal'})`;
  if (r.timedOut) status += ` — timed out after ${timeoutSec}s; the process group was killed`;
  else if (r.aborted) status += ' — the run was cancelled; the process group was killed';
  emit(`[exit code: ${status}]\n`);
  return ok(`$ ${a.command}\nexit code: ${status}\n${outputTail(r)}`);
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/** Register every editor tool on a (per-request) McpServer. */
export function registerEditorTools(server: McpServer, deps: EditorToolDeps): void {
  server.registerTool(
    'read_file',
    {
      title: 'Read file',
      description:
        'Read a text file from the workspace. Returns a header line "path (lines a-b of N)" followed by the raw file text ' +
        'for that range, WITHOUT line numbers, so lines can be copied exactly into propose_edit search blocks. ' +
        `Returns at most ${READ_MAX_LINES} lines / ${READ_MAX_CHARS} characters per call; for longer files pass ` +
        'start_line/end_line (1-based, inclusive) to read further ranges.',
      inputSchema: {
        path: z.string().min(1).describe('Workspace-relative file path with forward slashes, e.g. "src/flask/cli.py".'),
        start_line: z.number().int().min(1).optional().describe('First line to read (1-based). Default 1.'),
        end_line: z.number().int().min(1).optional().describe('Last line to read (1-based, inclusive). Default: end of file.'),
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
    },
    async (a) => guarded('read_file', () => readFileTool(deps, a)),
  );

  server.registerTool(
    'list_files',
    {
      title: 'List files',
      description: 'List files in the workspace as workspace-relative paths, optionally only those under a directory.',
      inputSchema: {
        dir: z.string().optional().describe('Workspace-relative directory to list, e.g. "src/flask". Default: the whole workspace.'),
        max: z.number().int().min(1).optional().describe('Maximum number of paths to return. Default 300.'),
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
    },
    async (a) => guarded('list_files', () => listFilesTool(deps, a)),
  );

  server.registerTool(
    'search_code',
    {
      title: 'Search code',
      description:
        'Search the contents of workspace files. Plain-text match by default; set regex=true to use a regular expression. ' +
        'Returns one "path:line: text" line per match.',
      inputSchema: {
        query: z.string().min(1).describe('Text (or regular expression when regex=true) to search for.'),
        regex: z.boolean().optional().describe('Treat query as a regular expression. Default false.'),
        glob: z.string().optional().describe('Only search files matching this glob, e.g. "src/**/*.py".'),
        max_results: z.number().int().min(1).optional().describe('Maximum matches to return. Default 50.'),
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
    },
    async (a) => guarded('search_code', () => searchCodeTool(deps, a)),
  );

  server.registerTool(
    'find_symbol',
    {
      title: 'Find symbol',
      description:
        'Find where a class, function, method or variable is defined, by name. ' +
        'Returns "path:line: kind name — signature" lines.',
      inputSchema: {
        name: z.string().min(1).describe('Symbol name, e.g. "get_debug_flag" or "FlaskGroup".'),
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
    },
    async (a) => guarded('find_symbol', () => findSymbolTool(deps, a)),
  );

  server.registerTool(
    'repo_map',
    {
      title: 'Repository map',
      description:
        'Compact map of the repository: one line per file listing its top-level symbols. ' +
        'Use it to get oriented in an unfamiliar codebase.',
      inputSchema: {
        max_tokens: z.number().int().min(1).optional().describe('Approximate size limit of the map in tokens. Default 1500.'),
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
    },
    async (a) => guarded('repo_map', () => repoMapTool(deps, a)),
  );

  server.registerTool(
    'retrieve_context',
    {
      title: 'Retrieve context',
      description:
        'Rank the workspace for a task and pack the best snippets within budget_tokens. Output: a ranked file list ' +
        'with reasons, then sections "### path (lines a-b) — reasons" with raw lines (no line numbers). The first user ' +
        'message already contains this pack for the original request; call it for a new or narrower query (sub-agents: ' +
        'call it first). Use read_file to see the exact current text before editing.',
      inputSchema: {
        query: z.string().min(1).describe('The task or question in natural language, e.g. the user request.'),
        budget_tokens: z.number().int().min(1).optional().describe('Token budget for the packed context. Default 6000.'),
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
    },
    async (a) => guarded('retrieve_context', () => retrieveContextTool(deps, a)),
  );

  server.registerTool(
    'propose_edit',
    {
      title: 'Propose edit',
      description:
        'Propose a change to ONE file. The user reviews the diff hunk by hunk in the editor and accepts or rejects each ' +
        'hunk; only accepted hunks are written, and the result tells you which hunks were applied and which were ' +
        'rejected (do not re-propose rejected hunks unless asked). Make ONE call per file containing all edits for that ' +
        'file. For existing files pass `edits`: search/replace blocks applied in order, where `search` is copied EXACTLY ' +
        'from read_file output (whole lines, same indentation, with enough surrounding lines to match exactly one place) ' +
        'and `replace` is the new text for those lines. Use `new_content` (the full file text) ONLY to create a new file.',
      inputSchema: {
        path: z.string().min(1).describe('Workspace-relative file path with forward slashes, e.g. "src/flask/cli.py".'),
        edits: z
          .preprocess(
            // Some local models send the list as a JSON string; accept it instead of failing the call.
            (v) => (typeof v === 'string' ? parseJsonLenient(v) : v),
            z.array(
              z.object({
                search: z.string().describe('Exact current text to replace, copied from read_file (must match exactly once).'),
                replace: z.string().describe('Replacement text.'),
              }),
            ),
          )
          .optional()
          .describe('Search/replace blocks for an existing file, applied in order.'),
        new_content: z.string().optional().describe('Full content of a NEW file. Do not use for existing files.'),
        explanation: z.string().optional().describe('One line explaining the change, shown to the user in the review.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (a) => guarded('propose_edit', () => proposeEditTool(deps, a)),
  );

  server.registerTool(
    'run_command',
    {
      title: 'Run command',
      description:
        'Run a shell command with bash in the workspace, e.g. tests or linters. The user must approve each command. ' +
        `Times out after timeout_sec seconds (default ${deps.commandTimeoutSec()}, max ${COMMAND_MAX_TIMEOUT_SEC}). ` +
        `Returns the exit code and the last ${COMMAND_OUTPUT_TAIL} characters of combined stdout/stderr. ` +
        'Do not start servers, watchers or interactive programs.',
      inputSchema: {
        command: z.string().min(1).describe('The command line, e.g. ".venv/bin/python -m pytest tests/test_cli.py -q".'),
        cwd: z.string().optional().describe('Workspace-relative working directory. Default: the workspace root.'),
        timeout_sec: z.number().int().min(1).optional().describe(`Timeout in seconds (max ${COMMAND_MAX_TIMEOUT_SEC}).`),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a) => guarded('run_command', () => runCommandTool(deps, a)),
  );
}
