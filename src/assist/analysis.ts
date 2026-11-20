/**
 * Live assist helpers (PURE: no vscode), unit-tested in test/assist.test.ts.
 *  - F2: mixed tab/space indentation, and the message for a Python SyntaxError / IndentationError.
 *  - F3/F4: the function around the cursor, and the request text sent to the agent.
 */
import type { IndexedSymbol } from '../context/indexer';

// ------------------------------------------------------------------------------- F2: indentation

/**
 * 0-based lines whose leading whitespace disagrees with the rest of the file: lines that mix tabs
 * and spaces, and, when a file indents some lines with tabs and others with spaces, the lines of
 * the less common kind. Blank lines are ignored. At most `max` lines.
 */
export function mixedIndentLines(text: string, max = 50): number[] {
  const tabs: number[] = [];
  const spaces: number[] = [];
  const both: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const ws = /^[ \t]*/.exec(line)![0];
    if (!ws) continue;
    const hasTab = ws.includes('\t');
    const hasSpace = ws.includes(' ');
    if (hasTab && hasSpace) both.push(i);
    else if (hasTab) tabs.push(i);
    else spaces.push(i);
  }
  const minority = tabs.length && spaces.length ? (tabs.length <= spaces.length ? tabs : spaces) : [];
  return [...new Set([...both, ...minority])].sort((a, b) => a - b).slice(0, max);
}

/** Python's own report of the first syntax problem, as printed by PY_CHECK. */
export interface PySyntaxProblem {
  line: number;
  col: number;
  endLine?: number;
  endCol?: number;
  kind: string;
  msg: string;
}

/**
 * Parses the unsaved text with the project's Python (`python -I -c PY_CHECK`, text on stdin).
 * ast.parse never runs the code. IndentationError and TabError are subclasses of SyntaxError.
 */
export const PY_CHECK = [
  'import ast, json, sys',
  'try:',
  '    ast.parse(sys.stdin.buffer.read())',
  '    print("[]")',
  'except SyntaxError as e:',
  '    print(json.dumps([{"line": e.lineno or 1, "col": e.offset or 1, "endLine": getattr(e, "end_lineno", None),',
  '                       "endCol": getattr(e, "end_offset", None), "kind": type(e).__name__, "msg": e.msg or "invalid syntax"}]))',
].join('\n');

/** Parse PY_CHECK's output; undefined when it is not the expected JSON. */
export function parsePyCheck(stdout: string): PySyntaxProblem[] | undefined {
  try {
    const v = JSON.parse(stdout.trim());
    if (!Array.isArray(v)) return undefined;
    return v
      .filter((p) => p && typeof p === 'object' && typeof p.msg === 'string')
      .map((p) => ({
        line: Number.isInteger(p.line) && p.line > 0 ? p.line : 1,
        col: Number.isInteger(p.col) && p.col > 0 ? p.col : 1,
        endLine: Number.isInteger(p.endLine) ? p.endLine : undefined,
        endCol: Number.isInteger(p.endCol) ? p.endCol : undefined,
        kind: String(p.kind || 'SyntaxError'),
        msg: String(p.msg),
      }));
  } catch {
    return undefined;
  }
}

/** "Indentation: expected an indented block after 'if' statement on line 12". */
export function syntaxMessage(p: PySyntaxProblem): string {
  const prefix = p.kind === 'IndentationError' ? 'Indentation' : p.kind === 'TabError' ? 'Tabs and spaces' : 'Syntax';
  return `${prefix}: ${p.msg}`;
}

// --------------------------------------------------------------------------- F3/F4: the function

/** The innermost function or method whose lines contain `line` (1-based). */
export function enclosingFunction(symbols: IndexedSymbol[], line: number): IndexedSymbol | undefined {
  let best: IndexedSymbol | undefined;
  for (const s of symbols) {
    if (s.kind !== 'function' && s.kind !== 'method') continue;
    if (line < s.startLine || line > s.endLine) continue;
    if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
  }
  return best;
}

export interface AskTarget {
  /** Workspace-relative path. */
  path: string;
  /** Function name, or undefined for a selection. */
  name?: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** The code, unsaved edits included. */
  code: string;
  /** Markdown fence language (python, typescript, …). */
  lang: string;
}

export const MAX_CODE_LINES = 160;

function codeBlock(t: AskTarget): string {
  const lines = t.code.replace(/\s+$/, '').split('\n');
  const shown = lines.slice(0, MAX_CODE_LINES).join('\n');
  const cut =
    lines.length > MAX_CODE_LINES
      ? `\n(The code is cut after ${MAX_CODE_LINES} lines; read_file lines ${t.startLine + MAX_CODE_LINES}-${t.endLine} for the rest.)`
      : '';
  // A fence longer than any backtick run inside the code.
  const runs = shown.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${fence}${t.lang}\n${shown}\n${fence}${cut}`;
}

function what(t: AskTarget): string {
  return t.name ? `the function \`${t.name}\`` : 'the selected code';
}

/** F3: possible bugs, meaning-changing indentation, simpler logic with the reason, another way. */
export function checkRequest(t: AskTarget): string {
  return [
    `Check ${what(t)} in \`${t.path}\` (lines ${t.startLine}-${t.endLine}). Its current code, unsaved edits included, is below. Do not create a sub-agent, do not change any file and do not run commands; read another file only if you need it to judge a point.`,
    '',
    'Report in this order, quoting the exact line for every point:',
    '1. **Possible bugs**: inputs or states where it gives a wrong result or crashes, and why.',
    '2. **Indentation**: any line whose indentation makes it run at the wrong time, for example outside the loop or the `if` it belongs to.',
    '3. **Simpler or safer logic**: what to change, and the reason.',
    '4. **Another way** to get the same result, with what you gain and what you lose.',
    '',
    'Write "none found" under a heading rather than inventing a point. Keep it under 200 words.',
    '',
    codeBlock(t),
  ].join('\n');
}

/** F4: a quick overview of the function. */
export function overviewRequest(t: AskTarget): string {
  return [
    `Give a quick overview of ${what(t)} in \`${t.path}\` (lines ${t.startLine}-${t.endLine}); its current code is below. Do not create a sub-agent and do not change any file.`,
    '',
    t.name
      ? `First call search_code once with the query \`${t.name}\` to find where it is used. Then answer in this order: what it does, in two sentences; how it works, in up to four steps; one example call with its result; where it is used in this project and which tests cover it (from the search). Keep it under 150 words.`
      : 'In this order: what it does, in two sentences; how it works, in up to four steps; one example of its effect; where the names it defines are used and which tests cover it (search for them if you need to). Keep it under 150 words.',
    '',
    codeBlock(t),
  ].join('\n');
}
