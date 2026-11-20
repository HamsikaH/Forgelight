/**
 * VS Code host adapters: settings -> ForgeConfig, WorkspaceIO over open editors + disk, and the
 * run_command approval gate (agent panel card, with a notification as a fallback).
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  DEFAULT_CONFIG,
  type CommandAssessment,
  type CommandDecision,
  type CommandGate,
  type CommandRequest,
  type CommandRisk,
  type ForgeConfig,
  type WorkspaceIO,
} from './contracts';
import type { ForgeEventBus } from './events';

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

function num(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Current `forgelight.*` settings, with DEFAULT_CONFIG for anything missing or invalid. */
export function readConfig(): ForgeConfig {
  const c = vscode.workspace.getConfiguration('forgelight');
  const url = String(c.get<string>('trueforgeUrl') ?? '').trim();
  const rawModels = c.get<unknown>('models');
  const verifyCommand = c.get<unknown>('verifyCommand');
  const models = Array.isArray(rawModels) ? rawModels.map((m) => String(m).trim()).filter(Boolean) : [];
  return {
    trueforgeUrl: (url || DEFAULT_CONFIG.trueforgeUrl).replace(/\/+$/, ''),
    models: models.length ? models : [...DEFAULT_CONFIG.models],
    retryAttempts: Math.floor(num(c.get('retryAttempts'), DEFAULT_CONFIG.retryAttempts, 0, 10)),
    retryBackoffMs: num(c.get('retryBackoffMs'), DEFAULT_CONFIG.retryBackoffMs, 0, 60_000),
    contextBudgetTokens: Math.floor(num(c.get('contextBudgetTokens'), DEFAULT_CONFIG.contextBudgetTokens, 500, 64_000)),
    mcpPort: Math.floor(num(c.get('mcpPort'), DEFAULT_CONFIG.mcpPort, 0, 65_535)),
    commandTimeoutSec: num(c.get('commandTimeoutSec'), DEFAULT_CONFIG.commandTimeoutSec, 1, 110),
    iterationLimit: Math.floor(num(c.get('iterationLimit'), DEFAULT_CONFIG.iterationLimit, 1, 1024)),
    verifyBeforeAccept: bool(c.get('verifyBeforeAccept'), DEFAULT_CONFIG.verifyBeforeAccept),
    verifyCommand: typeof verifyCommand === 'string' ? verifyCommand.trim() : DEFAULT_CONFIG.verifyCommand,
    verifyTimeoutSec: num(c.get('verifyTimeoutSec'), DEFAULT_CONFIG.verifyTimeoutSec, 5, 600),
    autoApproveSafeCommands: bool(c.get('autoApproveSafeCommands'), DEFAULT_CONFIG.autoApproveSafeCommands),
    circuitBreakerMinutes: num(c.get('circuitBreakerMinutes'), DEFAULT_CONFIG.circuitBreakerMinutes, 0, 120),
  };
}

// ---------------------------------------------------------------------------------------------
// Workspace IO
// ---------------------------------------------------------------------------------------------

/** WorkspaceIO rooted at the first workspace folder; open editors win over the file on disk. */
export class VscodeWorkspaceIO implements WorkspaceIO {
  /** Absolute root of the first workspace folder ('' when no folder is open). */
  get root(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.scheme === 'file' ? folder.uri.fsPath : '';
  }

  get hasWorkspace(): boolean {
    return this.root !== '';
  }

  /** Forward-slash workspace-relative path of an absolute path, or undefined if outside the root. */
  relativePath(absPath: string): string | undefined {
    const root = this.root;
    if (!root) return undefined;
    const rel = path.relative(root, absPath);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
    return rel.split(path.sep).join('/');
  }

  async readText(relPath: string): Promise<string | undefined> {
    const root = this.root;
    if (!root) return undefined;
    const abs = path.resolve(root, relPath);
    if (this.relativePath(abs) === undefined) return undefined;
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, abs));
    if (open) return open.getText();
    try {
      return await fs.readFile(abs, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined;
      throw err;
    }
  }
}

function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  // macOS and Windows file systems are case-insensitive by default
  return process.platform !== 'linux' && a.toLowerCase() === b.toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Command approval
// ---------------------------------------------------------------------------------------------

const DECISION_LABELS: Array<[string, CommandDecision]> = [
  ['Run once', 'once'],
  ['Allow for 10 minutes', 'tenMinutes'],
  ['Deny', 'deny'],
];

/** Risks shown as a warning notification instead of an information one. */
const RISKY: CommandRisk[] = ['write', 'network', 'destructive'];

/** ". Risk: network (installs packages)." appended to the notification text; '' without an assessment. */
function riskText(a: CommandAssessment | undefined): string {
  if (!a) return '';
  const reasons = (a.reasons ?? []).filter(Boolean).join('; ');
  return `. Risk: ${a.risk}${a.blocked ? ', blocked' : ''}${reasons ? ` (${reasons})` : ''}.`;
}

interface PendingCommand {
  runId: number;
  resolve: (decision: CommandDecision) => void;
}

/**
 * Asks for run_command approval through the agent panel (approval.command -> approveCommand) and
 * a non-modal notification with the same choices; whichever answers first wins. Aborting denies.
 */
export class PanelCommandGate implements CommandGate, vscode.Disposable {
  private readonly pending = new Map<string, PendingCommand>();
  private seq = 0;

  constructor(
    private readonly bus: ForgeEventBus,
    private readonly revealPanel: () => unknown,
  ) {}

  approve(req: CommandRequest, signal: AbortSignal): Promise<CommandDecision> {
    if (signal.aborted) return Promise.resolve('deny');
    const requestId = `cmd-${req.runId}-${++this.seq}`;
    return new Promise<CommandDecision>((resolve) => {
      const onAbort = () => this.resolveCommand(requestId, 'deny');
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(requestId, {
        runId: req.runId,
        resolve: (decision) => {
          signal.removeEventListener('abort', onAbort);
          resolve(decision);
        },
      });
      this.bus.emit({
        type: 'approval.command',
        runId: req.runId,
        requestId,
        command: req.command,
        cwd: req.cwd,
        toolCallId: req.toolCallId,
        assessment: req.assessment,
      });
      try {
        void Promise.resolve(this.revealPanel()).catch(() => undefined);
      } catch {
        // the panel is optional; the notification below still asks
      }
      const where = req.cwd && req.cwd !== '.' ? ` (in ${req.cwd})` : '';
      const text = `Forgelight wants to run: ${req.command}${where}${riskText(req.assessment)}`;
      const labels = DECISION_LABELS.map(([label]) => label);
      const risky = req.assessment && (req.assessment.blocked || RISKY.includes(req.assessment.risk));
      void (risky ? vscode.window.showWarningMessage(text, ...labels) : vscode.window.showInformationMessage(text, ...labels))
        .then((label) => {
          const hit = DECISION_LABELS.find(([l]) => l === label);
          // dismissing the notification is not an answer: the panel card is still open
          if (hit) this.resolveCommand(requestId, hit[1]);
        });
    });
  }

  /** Answer a pending request (from the panel or the notification). False if it is not pending. */
  resolveCommand(requestId: string, decision: CommandDecision): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    this.bus.emit({ type: 'approval.resolved', runId: p.runId, requestId, decision });
    p.resolve(decision);
    return true;
  }

  dispose(): void {
    for (const id of [...this.pending.keys()]) this.resolveCommand(id, 'deny');
  }
}
