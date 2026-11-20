/**
 * Glue between TrueForge's approval pause and the MCP tool execution that follows it (no vscode).
 *
 * Flow for propose_edit:
 *   1. TrueForge pauses with tool.approval_required.
 *   2. The runner computes a ProposedChange, sends it through the ReviewGate (hunk-by-hunk
 *      review), and stores {change, result} here under argsKey(arguments).
 *   3. If at least one hunk was accepted the runner answers `allow`; TrueForge then calls the
 *      MCP tool propose_edit with the SAME arguments.
 *   4. The MCP handler takes the stored decision by argsKey and applies exactly the accepted hunks.
 * If every hunk is rejected the runner answers `deny` and nothing is stored or written.
 * If the arguments are invalid (search block not found, no change, path outside the workspace)
 * no review is opened: the runner stores the error and answers `allow`, so the MCP handler
 * returns it as a tool error instead of TrueForge reporting a user denial the user never made.
 */
import type { ProposedChange, ReviewResult } from './contracts';

export type StoredDecision =
  /** verifyNote: the shadow test result (Feature 1) when it was known at decision time, for the agent. */
  | { runId: number; change: ProposedChange; result: ReviewResult; verifyNote?: string }
  | { runId: number; error: string };

export class DecisionStore {
  private readonly byKey = new Map<string, StoredDecision[]>();

  put(key: string, decision: StoredDecision): void {
    const q = this.byKey.get(key) ?? [];
    q.push(decision);
    this.byKey.set(key, q);
  }

  /** FIFO take of the decision stored for these arguments. */
  take(key: string): StoredDecision | undefined {
    const q = this.byKey.get(key);
    if (!q || q.length === 0) return undefined;
    const d = q.shift();
    if (q.length === 0) this.byKey.delete(key);
    return d;
  }

  clearRun(runId: number): void {
    for (const [k, q] of this.byKey) {
      const kept = q.filter((d) => d.runId !== runId);
      if (kept.length) this.byKey.set(k, kept);
      else this.byKey.delete(k);
    }
  }
}

/** Tracks the active run so late tool calls from a cancelled run are refused. */
export class RunTracker {
  private counter = 0;
  private active: { runId: number; controller: AbortController } | undefined;
  private readonly cancelled = new Set<number>();

  begin(): { runId: number; signal: AbortSignal } {
    const runId = ++this.counter;
    const controller = new AbortController();
    this.active = { runId, controller };
    return { runId, signal: controller.signal };
  }

  get activeRunId(): number | undefined {
    return this.active?.runId;
  }

  get activeSignal(): AbortSignal | undefined {
    return this.active?.controller.signal;
  }

  isCancelled(runId: number): boolean {
    return this.cancelled.has(runId);
  }

  /** Abort the active run (if it matches) and remember it as cancelled. */
  cancel(runId?: number): number | undefined {
    const a = this.active;
    if (!a) return undefined;
    if (runId !== undefined && a.runId !== runId) return undefined;
    this.cancelled.add(a.runId);
    a.controller.abort();
    return a.runId;
  }

  end(runId: number): void {
    if (this.active?.runId === runId) this.active = undefined;
  }
}
