/**
 * PURE (no vscode): where review UI sits on a hunk, minimal line-aligned document edits, and
 * turning per-hunk decisions into a ReviewResult. Used by reviewController.ts.
 */
import type { Hunk, HunkDecision, ReviewResult } from '../contracts';
import { computeHunks } from './hunks';

export interface HunkLayout {
  /** Hunk.index */
  index: number;
  /** 0-based line in the proposed text where the hunk's first change sits (CodeLens anchor). */
  anchorLine: number;
  /** 0-based lines of the proposed text that the hunk adds (empty for pure deletions). */
  addedLines: number[];
}

export function layoutHunk(h: Hunk): HunkLayout {
  let line = Math.max(0, h.newStart - 1);
  let anchor: number | undefined;
  const addedLines: number[] = [];
  for (const l of h.lines) {
    const c = l[0];
    if (c === ' ') {
      line++;
    } else if (c === '+') {
      anchor ??= line;
      addedLines.push(line);
      line++;
    } else if (c === '-') {
      // a deletion sits just above the next line of the proposed text
      anchor ??= line;
    }
    // '\' ("No newline at end of file") occupies no line
  }
  return { index: h.index, anchorLine: anchor ?? Math.max(0, h.newStart - 1), addedLines };
}

export function clampLine(line: number, lineCount: number): number {
  return Math.max(0, Math.min(line, lineCount - 1));
}

/** 0-based lines of `after` to highlight after `before` -> `after` (deletions mark the line below). */
export function changedLines(before: string, after: string): number[] {
  const out = new Set<number>();
  for (const h of computeHunks(before, after)) {
    const l = layoutHunk(h);
    if (l.addedLines.length) for (const x of l.addedLines) out.add(x);
    else out.add(l.anchorLine);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Smallest replacement of whole lines turning `before` into `after`:
 * before.slice(0, start) + text + before.slice(end) === after, with start/end on line starts
 * (never between \r and \n). Undefined when the texts are equal.
 */
export function minimalReplace(before: string, after: string): { start: number; end: number; text: string } | undefined {
  if (before === after) return undefined;
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  p = p > 0 ? before.lastIndexOf('\n', p - 1) + 1 : 0;
  const maxS = max - p;
  let s = 0;
  while (s < maxS && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  if (s > 0) {
    // start the kept suffix right after a newline inside it (identical in both texts)
    const nl = before.indexOf('\n', before.length - s);
    s = nl === -1 ? 0 : before.length - nl - 1;
  }
  return { start: p, end: before.length - s, text: after.slice(p, after.length - s) };
}

/** Final result for a review; undecided hunks count as rejected. */
export function decisionsToResult(
  changeId: string,
  hunks: Hunk[],
  decisions: HunkDecision[],
  extra: { cancelled?: boolean; note?: string } = {},
): ReviewResult {
  const final = hunks.map((_, i): HunkDecision => (decisions[i] === 'accepted' ? 'accepted' : 'rejected'));
  const result: ReviewResult = {
    changeId,
    decisions: final,
    accepted: hunks.filter((_, i) => final[i] === 'accepted').map((h) => h.index),
    rejected: hunks.filter((_, i) => final[i] === 'rejected').map((h) => h.index),
  };
  if (extra.cancelled) result.cancelled = true;
  if (extra.note) result.note = extra.note;
  return result;
}
