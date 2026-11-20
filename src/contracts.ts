/**
 * Shared contracts for Forgelight.
 *
 * RULE: this file and every module that is not explicitly VS Code UI must stay free of
 * `import 'vscode'`, so the agent loop (TrueForge runner + MCP tool server + retrieval +
 * hunk math) can be exercised headlessly from Node (see test/headless).
 *
 * VS Code-only modules: src/extension.ts, src/vscodeHost.ts, src/review/reviewController.ts,
 * src/panel/agentPanel.ts, src/inline/inlineEdit.ts.
 */

/** Name the editor MCP server is registered under in TrueForge (Settings -> MCP servers). */
export const MCP_SERVER_NAME = 'forgelight-editor';
/** Name the agent definition (agent/forgelight.agent.json) is registered under in TrueForge. */
export const AGENT_NAME = 'forgelight';
/** Tools that TrueForge pauses on for human approval (require_approval_for_tools). */
export const APPROVAL_TOOLS = ['propose_edit', 'run_command'] as const;
/** Header carrying the per-activation shared secret TrueForge must send to our MCP server. */
export const MCP_TOKEN_HEADER = 'x-forgelight-token';

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

export interface ForgeConfig {
  /** TrueForge base URL, e.g. http://localhost:8790 */
  trueforgeUrl: string;
  /** Model FQNs configured in TrueForge, in priority order: [primary, fallback1, ...]. */
  models: string[];
  /** Retries of the SAME model on a model error before falling back (default 1). */
  retryAttempts: number;
  /** Base backoff between retries in ms; doubles per attempt (default 1500). */
  retryBackoffMs: number;
  /** Token budget for automatically retrieved context (default 6000). */
  contextBudgetTokens: number;
  /** Preferred port for the editor MCP server; 0 = pick a free port (default 7341). */
  mcpPort: number;
  /** Timeout for run_command in seconds (default 120). */
  commandTimeoutSec: number;
  /** Agent-loop iteration limit sent to TrueForge (default 60). */
  iterationLimit: number;
  /** Feature 1: run the relevant tests on a shadow copy with the proposal applied, shown on the review card. */
  verifyBeforeAccept: boolean;
  /** Test command for shadow runs; '' = auto-detect. Placeholders: {python} {tests} {file}. */
  verifyCommand: string;
  /** Timeout of one shadow test run in seconds (default 90). */
  verifyTimeoutSec: number;
  /** Feature 5: run commands rated 'test' or 'read' without asking (the card still shows them). */
  autoApproveSafeCommands: boolean;
  /** Feature 3: minutes a model that just failed is skipped before it is tried again (0 = off). */
  circuitBreakerMinutes: number;
}

export const DEFAULT_CONFIG: ForgeConfig = {
  trueforgeUrl: 'http://localhost:8790',
  models: ['ollama/qwen3-6-35b'],
  retryAttempts: 1,
  retryBackoffMs: 1500,
  contextBudgetTokens: 6000,
  mcpPort: 7341,
  commandTimeoutSec: 90,
  iterationLimit: 60,
  verifyBeforeAccept: true,
  verifyCommand: '',
  verifyTimeoutSec: 90,
  autoApproveSafeCommands: false,
  circuitBreakerMinutes: 5,
};

// ---------------------------------------------------------------------------------------------
// Edits and hunks
// ---------------------------------------------------------------------------------------------

/** One exact search/replace block. `search` must match the current file text exactly once. */
export interface EditOperation {
  search: string;
  replace: string;
}

/** Arguments of the MCP tool `propose_edit` (exactly what the model sends). */
export interface ProposeEditArgs {
  /** Workspace-relative path using forward slashes, e.g. "src/flask/cli.py". */
  path: string;
  /** Search/replace blocks applied in order. Use for edits to existing files. */
  edits?: EditOperation[];
  /** Full new file content. Use for new files (or full rewrites of small files). */
  new_content?: string;
  /** One-line explanation shown to the user in the review. */
  explanation?: string;
}

/** A unified-diff hunk. `lines` carry their ' ', '-', '+' prefix (jsdiff structuredPatch style). */
export interface Hunk {
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** A change the agent proposed, computed against the CURRENT editor text of the file. */
export interface ProposedChange {
  /** Stable id: the TrueForge tool call id. */
  id: string;
  /** Run generation that produced it (see RunHandle.runId). */
  runId: number;
  /** Workspace-relative path (forward slashes). */
  path: string;
  /** Absolute filesystem path. */
  absPath: string;
  isNewFile: boolean;
  originalText: string;
  proposedText: string;
  hunks: Hunk[];
  explanation?: string;
  /** Canonical key of the propose_edit arguments, used to match the later MCP execution. */
  argsKey: string;
}

export type HunkDecision = 'pending' | 'accepted' | 'rejected';

export interface ReviewResult {
  changeId: string;
  /** Per-hunk decision, same order as ProposedChange.hunks. Never 'pending' once resolved. */
  decisions: HunkDecision[];
  accepted: number[];
  rejected: number[];
  /** Set when the review ended because the run was cancelled. */
  cancelled?: boolean;
  /** Optional note for the agent, e.g. why hunks were rejected. */
  note?: string;
}

/** Record of an applied change, kept on the undo stack. */
export interface ApplyRecord {
  changeId: string;
  /** Run that applied it (Feature 2: revert a whole run). */
  runId: number;
  path: string;
  absPath: string;
  /** Text before the change (undo restores it). */
  beforeText: string;
  /** Text written. */
  afterText: string;
  /** True if the file did not exist before (undo deletes it). */
  createdFile: boolean;
  hunksApplied: number[];
  hunksRejected: number[];
}

/** Result of turning ProposeEditArgs into a ProposedChange; `error` when edits do not apply. */
export interface ProposalComputation {
  proposedText?: string;
  isNewFile: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------------------------
// Context retrieval
// ---------------------------------------------------------------------------------------------

export interface ContextFilePick {
  path: string;
  score: number;
  /** Human-readable reasons, e.g. 'defines symbol "get_debug_flag"', 'path matches "cli"'. */
  reasons: string[];
  /** 1-based inclusive line ranges included in the snippet. */
  ranges: Array<{ start: number; end: number }>;
  /** Estimated tokens this file contributed to the budget. */
  tokens: number;
  /** 'explicit' = user @-mentioned it; 'retrieved' = automatic retrieval. */
  source: 'explicit' | 'retrieved';
}

export interface ContextPick {
  query: string;
  budgetTokens: number;
  usedTokens: number;
  files: ContextFilePick[];
  /** Candidates that scored but did not fit the budget. */
  dropped: Array<{ path: string; score: number; reason: string }>;
  /** The packed text returned to the model (snippets with path:line headers). */
  packedText: string;
}

export interface SymbolHit {
  path: string;
  /** 1-based line of the definition. */
  line: number;
  kind: 'class' | 'function' | 'method' | 'variable' | 'heading' | 'other';
  name: string;
  /** The definition line, trimmed. */
  signature: string;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/**
 * Repository understanding used by the MCP tools and the runner. Implemented in
 * src/context/retrieval.ts (class RepoContextEngine), pure Node over WorkspaceIO + fs.
 */
export interface ContextEngine {
  /**
   * Ranked, budget-packed context for a natural-language query (the B1 core). `excludePaths`
   * (workspace-relative) are left out, e.g. files the user @-mentioned and already sent in full.
   */
  retrieve(query: string, budgetTokens: number, opts?: { excludePaths?: string[] }): Promise<ContextPick>;
  /** Compact repo map: one line per file listing its top-level symbols, cut to maxTokens. */
  repoMap(maxTokens: number): Promise<string>;
  findSymbol(name: string): Promise<SymbolHit[]>;
  search(query: string, opts?: { regex?: boolean; glob?: string; maxResults?: number }): Promise<SearchHit[]>;
  listFiles(dir?: string, max?: number): Promise<string[]>;
  /** Resolve @file / @symbol mentions in user text into an explicit context block. */
  resolveMentions(text: string): Promise<{ explicitBlock: string; files: ContextFilePick[]; unresolved: string[] }>;
  /** Drop cached index data for a file (or everything) after edits. */
  invalidate(relPath?: string): void;
}

// ---------------------------------------------------------------------------------------------
// Gates implemented by the host (VS Code UI in the extension, auto-policies in headless tests)
// ---------------------------------------------------------------------------------------------

/** Shows a proposed change hunk by hunk and resolves with the user's per-hunk decisions. */
export interface ReviewGate {
  review(change: ProposedChange, signal: AbortSignal): Promise<ReviewResult>;
  /** Close/forget every open review belonging to a run (used on cancel). */
  discardRun(runId: number): void;
}

/** Applies the accepted hunks of a reviewed change to the workspace (undoable). */
export interface ApplyGate {
  applyAccepted(change: ProposedChange, result: ReviewResult): Promise<ApplyRecord | undefined>;
  undoLast(): Promise<ApplyRecord | undefined>;
  /**
   * Feature 2: restore every file a run changed (newest first; files the run created are deleted).
   * Returns the records that were reverted (empty if none). Emits 'run.reverted'.
   */
  revertRun(runId: number): Promise<ApplyRecord[]>;
}

export type CommandDecision = 'once' | 'tenMinutes' | 'deny';
/** How a command approval ended, as shown to the user ('auto' = auto-approved safe command, 'blocked' = refused by the guard). */
export type CommandResolution = CommandDecision | 'auto' | 'blocked';

// Feature 5: command guard ----------------------------------------------------------------------

/** test = runs tests/linters; read = inspects only; write = changes files in the workspace;
 *  network = talks to the network or installs packages; destructive = deletes/overwrites broadly, escalates, or leaves the workspace. */
export type CommandRisk = 'test' | 'read' | 'write' | 'network' | 'destructive';

export interface CommandAssessment {
  risk: CommandRisk;
  /** True for patterns that must never run (e.g. rm -rf /, sudo, curl | sh, git push --force). */
  blocked: boolean;
  /** Short human-readable reasons, e.g. 'runs pytest', 'deletes files recursively'. */
  reasons: string[];
}

/** Pure classifier (src/safety/commandGuard.ts, class CommandGuard). */
export interface CommandAssessor {
  assess(command: string, cwd: string, root: string): CommandAssessment;
}

// Feature 1: verified diffs (shadow test runs) --------------------------------------------------

export type VerifyStatus = 'passed' | 'failed' | 'error' | 'skipped' | 'cancelled';

export interface VerifyResult {
  changeId: string;
  status: VerifyStatus;
  /** The command that ran (absent when skipped). */
  command?: string;
  /** Workspace-relative test targets that were run. */
  tests: string[];
  /** One line, e.g. '59 passed in 0.4s', '1 failed, 58 passed', 'no tests found for docs/cli.rst'. */
  summary: string;
  /** Last lines of output when it failed or errored. */
  outputTail?: string;
  durationMs: number;
}

/**
 * Runs the tests relevant to a proposed change against a temporary copy of the workspace with the
 * FULL proposal applied (the real workspace is never touched; on macOS the run is sandboxed, elsewhere
 * it is skipped). Implemented in src/verify/shadow.ts (class ShadowVerifier).
 */
export interface Verifier {
  /**
   * Which tests would run for this change. No `command` (and `tests` []) = nothing to run, the
   * result will be 'skipped'. A `command` with `tests` [] is a custom verifyCommand without {tests}
   * (e.g. `npm test`) that runs as a whole.
   */
  plan(change: ProposedChange): Promise<{ command?: string; tests: string[] }>;
  verify(change: ProposedChange, signal: AbortSignal): Promise<VerifyResult>;
}

/** A run_command call waiting for approval; toolCallId lets the panel place the card under its tool row. */
export interface CommandRequest {
  runId: number;
  command: string;
  cwd: string;
  toolCallId?: string;
  /** Feature 5: the guard's assessment, shown as a risk badge on the approval card. */
  assessment?: CommandAssessment;
}

/** Asks the user whether a run_command call may run. */
export interface CommandGate {
  approve(req: CommandRequest, signal: AbortSignal): Promise<CommandDecision>;
}

/** Workspace file access used by tools/runner. Implementations prefer unsaved editor text. */
export interface WorkspaceIO {
  /** Absolute workspace root. */
  root: string;
  /** Text of a workspace-relative file, or undefined if it does not exist. */
  readText(relPath: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------------------------
// Run requests
// ---------------------------------------------------------------------------------------------

export interface InlineTarget {
  path: string;
  /** 1-based inclusive lines of the selection. */
  startLine: number;
  endLine: number;
  selectedText: string;
}

export interface RunRequest {
  mode: 'agent' | 'inline';
  /** The user's instruction, possibly containing @file / @symbol mentions. */
  text: string;
  inlineTarget?: InlineTarget;
}

export type RunStatus = 'done' | 'error' | 'cancelled';

export interface RunOutcome {
  runId: number;
  status: RunStatus;
  message?: string;
  /** Model that finished the run (after any fallback). */
  model?: string;
  sessionId?: string;
  applied: ApplyRecord[];
}

// ---------------------------------------------------------------------------------------------
// Events (extension -> UI). Emitted on the ForgeEventBus (src/events.ts).
// ---------------------------------------------------------------------------------------------

export interface HunkSummary {
  index: number;
  header: string; // "@@ -12,6 +12,9 @@"
  added: number;
  removed: number;
  preview: string; // the hunk lines joined with \n (truncated to ~40 lines)
}

export type ForgeEvent =
  | { type: 'run.started'; runId: number; mode: RunRequest['mode']; text: string; model: string }
  | { type: 'run.session'; runId: number; sessionId: string; sessionUrl: string; model: string }
  | { type: 'assistant.delta'; runId: number; threadId: string; messageId: string; text: string }
  | { type: 'reasoning.delta'; runId: number; threadId: string; messageId: string; text: string }
  | { type: 'tool.call'; runId: number; threadId: string; toolCallId: string; name: string; argsPreview: string }
  | { type: 'tool.result'; runId: number; threadId: string; toolCallId: string; preview: string }
  | { type: 'thread.started'; runId: number; threadId: string; title: string }
  | { type: 'thread.finished'; runId: number; threadId: string }
  | { type: 'context.picked'; runId: number; pick: ContextPick }
  | { type: 'approval.command'; runId: number; requestId: string; command: string; cwd: string; toolCallId?: string; assessment?: CommandAssessment }
  | { type: 'approval.resolved'; runId: number; requestId: string; decision: CommandResolution; reason?: string }
  | { type: 'review.opened'; runId: number; changeId: string; path: string; explanation?: string; isNewFile: boolean; hunks: HunkSummary[] }
  | { type: 'review.updated'; changeId: string; decisions: HunkDecision[] }
  | { type: 'review.closed'; changeId: string; result: ReviewResult }
  | { type: 'edit.applied'; runId: number; record: ApplyRecord }
  | { type: 'edit.undone'; record: ApplyRecord }
  | { type: 'model.retry'; runId: number; model: string; attempt: number; delayMs: number; reason: string }
  | { type: 'model.fallback'; runId: number; from: string; to: string; reason: string }
  | { type: 'notice'; runId?: number; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'run.finished'; runId: number; status: RunStatus; message?: string; model?: string }
  // Feature 1: verified diffs
  | { type: 'verify.started'; runId: number; changeId: string; command: string; tests: string[] }
  | { type: 'verify.finished'; runId: number; result: VerifyResult }
  // Feature 2: run checkpoints
  | { type: 'run.reverted'; runId: number; records: ApplyRecord[] }
  // Feature 3: outage-proof sessions
  | { type: 'model.health'; model: string; status: 'ok' | 'down' | 'unknown' | 'skipped'; reason?: string; retryAt?: string; latencyMs?: number }
  | { type: 'model.resume'; runId: number; from: string; to: string; sessionId: string; reason: string }
  // Feature 4: context X-ray
  | {
      type: 'context.usage';
      runId: number;
      threadId: string;
      model: string;
      /** Input tokens of this model call, and its split when TrueForge reports one (harness, instructions, toolDefinitions, messages, ...). */
      inputTokens: number;
      outputTokens: number;
      breakdown?: Record<string, number>;
      /** Context window of the model when known. */
      contextLength?: number;
    }
  | { type: 'subagent.savings'; runId: number; threadId: string; title: string; contextTokens: number; returnedTokens: number };

/** Messages from the panel webview to the extension. */
export type PanelToExtension =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'cancel' }
  | { type: 'approveCommand'; requestId: string; decision: CommandDecision }
  | { type: 'hunk'; changeId: string; index: number; decision: 'accepted' | 'rejected' }
  | { type: 'reviewAll'; changeId: string; decision: 'accepted' | 'rejected' }
  | { type: 'applyReview'; changeId: string }
  | { type: 'openSession' }
  | { type: 'undo' }
  | { type: 'revertRun'; runId: number };

/** Messages from the extension to the panel webview. */
export type ExtensionToPanel =
  | { type: 'event'; event: ForgeEvent }
  | { type: 'state'; running: boolean; models: string[]; trueforgeUrl: string; mcpUrl?: string };
