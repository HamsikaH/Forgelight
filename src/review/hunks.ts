/**
 * Pure hunk math (no vscode): turn propose_edit arguments into proposed text, split the
 * difference into unified-diff hunks, and apply any subset of accepted hunks.
 */
import { applyPatch, structuredPatch } from 'diff';
import { createHash } from 'node:crypto';
import type { Hunk, HunkSummary, ProposalComputation, ProposeEditArgs } from '../contracts';

/** JSON with object keys sorted recursively, so equal arguments give equal strings. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const val = (v as Record<string, unknown>)[k];
        if (val !== undefined) out[k] = norm(val);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/** Key that matches an approval-time tool call to the later MCP execution of the same call. */
export function argsKey(args: unknown): string {
  return createHash('sha1').update(canonicalJson(args)).digest('hex');
}

/**
 * Keep only the documented propose_edit fields, with the path normalized. BOTH the runner
 * (approval time, from the raw tool-call JSON) and the MCP handler (execution time, from the
 * parsed tool input) must call argsKey(pickProposeArgs(x)) so the keys match.
 */
export function pickProposeArgs(raw: unknown): ProposeEditArgs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: ProposeEditArgs = { path: normalizePath(String(r.path ?? '')) };
  let edits: unknown = r.edits;
  if (typeof edits === 'string') {
    // Some local models send the list as a JSON string; the MCP schema accepts it too.
    try {
      edits = JSON.parse(edits);
    } catch {
      /* leave as-is: reported as missing edits */
    }
  }
  if (Array.isArray(edits)) {
    out.edits = edits.map((e) => {
      const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
      return { search: String(o.search ?? ''), replace: String(o.replace ?? '') };
    });
  }
  if (typeof r.new_content === 'string') out.new_content = r.new_content;
  if (typeof r.explanation === 'string') out.explanation = r.explanation;
  return out;
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Line-window match that ignores trailing whitespace and CRLF differences. Returns the
 * [startLine, endLineExclusive) window in `lines`, or a count when ambiguous/missing.
 */
function findLooseWindow(lines: string[], searchLines: string[]): { start: number; end: number } | { matches: number } {
  const norm = (s: string) => s.replace(/\r$/, '').trimEnd();
  const target = searchLines.map(norm);
  // drop leading/trailing empty search lines that are often artifacts of copy/paste
  while (target.length && target[0] === '') target.shift();
  while (target.length && target[target.length - 1] === '') target.pop();
  if (!target.length) return { matches: 0 };
  const found: number[] = [];
  for (let i = 0; i + target.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (norm(lines[i + j]) !== target[j]) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  if (found.length === 1) return { start: found[0], end: found[0] + target.length };
  return { matches: found.length };
}

/** Apply ProposeEditArgs to the current text of a file (undefined = file does not exist). */
/**
 * A model that sends `new_content` for an existing file usually meant "add this" and would wipe
 * the rest (seen live: a 702-line test file replaced by 19 lines). Refuse when the file has at
 * least 30 non-blank lines and the new text keeps fewer than half of them; small files and
 * rewrites that keep most of the file go through.
 */
export function wholeFileLoss(original: string, proposed: string): { total: number; removed: number } | undefined {
  const norm = (t: string) => t.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd());
  const before = norm(original).filter((l) => l.trim() !== '');
  if (before.length < 30) return undefined;
  const pool = new Map<string, number>();
  for (const l of norm(proposed)) if (l.trim() !== '') pool.set(l, (pool.get(l) ?? 0) + 1);
  let kept = 0;
  for (const l of before) {
    const n = pool.get(l) ?? 0;
    if (n > 0) {
      kept++;
      pool.set(l, n - 1);
    }
  }
  if (kept * 2 >= before.length) return undefined;
  return { total: norm(original).length, removed: before.length - kept };
}

export function computeProposal(original: string | undefined, args: ProposeEditArgs): ProposalComputation {
  const path = args.path;
  const hasEdits = Array.isArray(args.edits) && args.edits.length > 0;
  if (typeof args.new_content === 'string' && (!hasEdits || original === undefined)) {
    if (original !== undefined && original === args.new_content) {
      return { isNewFile: false, error: `new_content for ${path} is identical to the current file; nothing to change.` };
    }
    if (original !== undefined) {
      const lost = wholeFileLoss(original, args.new_content);
      if (lost) {
        return {
          isNewFile: false,
          error:
            `${path} already exists (${lost.total} lines). new_content replaces the WHOLE file, and this one would delete ` +
            `${lost.removed} of its lines. To add to or change an existing file, call propose_edit with \`edits\` ` +
            '(search/replace blocks copied from read_file) instead.',
        };
      }
    }
    return { proposedText: args.new_content, isNewFile: original === undefined };
  }
  if (original === undefined) {
    return { isNewFile: true, error: `File ${path} does not exist. To create it, call propose_edit with new_content.` };
  }
  if (!hasEdits) {
    return { isNewFile: false, error: `propose_edit for ${path} needs either edits (search/replace blocks) or new_content.` };
  }
  let text = original;
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  for (let i = 0; i < args.edits!.length; i++) {
    const { search, replace } = args.edits![i];
    if (typeof search !== 'string' || search.length === 0) {
      return { isNewFile: false, error: `Edit #${i + 1} for ${path} has an empty search block. Copy the exact lines to replace from read_file.` };
    }
    if (typeof replace !== 'string') {
      return { isNewFile: false, error: `Edit #${i + 1} for ${path} has no replace string.` };
    }
    const exact = countOccurrences(text, search);
    if (exact === 1) {
      const at = text.indexOf(search);
      text = text.slice(0, at) + replace + text.slice(at + search.length);
      continue;
    }
    if (exact > 1) {
      return { isNewFile: false, error: `Edit #${i + 1}: the search block matches ${exact} places in ${path}. Include more surrounding lines so it is unique.` };
    }
    // Loose match: trailing whitespace / CRLF tolerant, whole lines.
    const lines = text.split('\n');
    const win = findLooseWindow(lines, search.split('\n'));
    if ('start' in win) {
      const replLines = replace.replace(/\r\n/g, '\n').split('\n');
      // keep trailing-newline semantics of the search block
      while (replLines.length && replLines[replLines.length - 1] === '' && !search.endsWith('\n\n')) {
        if (search.endsWith('\n')) {
          replLines.pop();
          break;
        }
        break;
      }
      const replacement = replLines.map((l) => (eol === '\r\n' ? l + '\r' : l));
      lines.splice(win.start, win.end - win.start, ...replacement);
      text = lines.join('\n');
      continue;
    }
    if (win.matches > 1) {
      return { isNewFile: false, error: `Edit #${i + 1}: the search block matches ${win.matches} places in ${path} (ignoring trailing whitespace). Include more surrounding lines.` };
    }
    if (replace.trim().length > 0 && replace !== search && text.includes(replace)) {
      return {
        isNewFile: false,
        error: `Edit #${i + 1}: this change is already applied in ${path} (its replacement text is already in the file). Do not propose it again; re-read the file with read_file before any further edit.`,
      };
    }
    return {
      isNewFile: false,
      error: `Edit #${i + 1}: the search block was not found in ${path}. Re-read the file with read_file and copy the exact current lines.`,
    };
  }
  if (text === original) {
    return {
      isNewFile: false,
      error: `The edits for ${path} produce no change; they are probably already applied. Re-read the file with read_file before any further edit.`,
    };
  }
  return { proposedText: text, isNewFile: false };
}

/**
 * Split original -> proposed into unified hunks with `context` unchanged lines around each change.
 * jsdiff merges two changes into one hunk when at most 2 * context unchanged lines separate them,
 * so review decisions use context 0 (every separate change region is its own hunk, e.g. a
 * docstring line and the code line two lines below it). Hunks keep exact original coordinates,
 * which is all applyHunks needs when it applies them to the text they were computed from.
 */
export function computeHunks(original: string, proposed: string, path = 'file', context = 3): Hunk[] {
  const patch = structuredPatch(path, path, original, proposed, '', '', { context });
  return patch.hunks.map((h, index) => ({
    index,
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: [...h.lines],
  }));
}

/**
 * Apply only the accepted hunks (by index) to `original`. Hunks keep their original-file
 * coordinates; jsdiff tracks the offset of previously applied hunks, so any subset works.
 */
export function applyHunks(original: string, hunks: Hunk[], accepted: number[]): string {
  const chosen = hunks.filter((h) => accepted.includes(h.index)).sort((a, b) => a.oldStart - b.oldStart);
  if (chosen.length === 0) return original;
  const result = applyPatch(original, {
    oldFileName: 'a',
    newFileName: 'b',
    oldHeader: '',
    newHeader: '',
    hunks: chosen.map((h) => ({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines,
    })),
  });
  if (result === false) {
    throw new Error('Could not apply the accepted hunks cleanly (the file changed underneath the review).');
  }
  return result;
}

/**
 * Carry the change original -> target over to `current`, the live text of the file, which may
 * have changed since the proposal. Equal texts take `target` as is. Otherwise the change is
 * re-diffed with 3 lines of context so it only lands where its surroundings still match (a
 * zero-context insertion would silently land at a stale offset); throws when they do not match.
 */
export function rebaseChange(original: string, target: string, current: string, path = 'file'): string {
  if (current === original) return target;
  const forward = computeHunks(original, target, path, 3);
  return applyHunks(current, forward, forward.map((h) => h.index));
}

export function hunkHeader(h: Hunk): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}

export function summarizeHunks(hunks: Hunk[], maxPreviewLines = 40): HunkSummary[] {
  return hunks.map((h) => {
    const body = h.lines.filter((l) => !l.startsWith('\\'));
    const preview = body.length > maxPreviewLines ? [...body.slice(0, maxPreviewLines), `… ${body.length - maxPreviewLines} more lines`] : body;
    return {
      index: h.index,
      header: hunkHeader(h),
      added: body.filter((l) => l.startsWith('+')).length,
      removed: body.filter((l) => l.startsWith('-')).length,
      preview: preview.join('\n'),
    };
  });
}
