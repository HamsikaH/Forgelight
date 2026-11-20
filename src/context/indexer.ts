/**
 * Workspace indexer (PURE: no vscode).
 *
 * Walks the workspace with fs, reads text through WorkspaceIO (so unsaved editor text wins) and
 * keeps, per file: line count, symbols (with body spans), stemmed term frequencies, short string
 * literals, imports and CLI command definitions. Built lazily on first use, cached per file and
 * refreshed by mtime/size; invalidate() forces a re-read.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { SymbolHit, WorkspaceIO } from '../contracts';
import { normalizePath } from '../review/hunks';

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', 'env', '__pycache__', 'dist', 'build',
  '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.eggs', '.cache', '.next',
  '.idea', 'htmlcov', 'site-packages', '_build', 'coverage',
]);
const TEXT_EXTS = new Set([
  'py', 'pyi', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'md', 'rst', 'txt', 'toml', 'cfg', 'ini',
  'json', 'yaml', 'yml', 'html', 'css', 'sh',
]);
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'npm-shrinkwrap.json']);
const DEFAULT_MAX_FILE_BYTES = 300 * 1024;
const MAX_LISTED_FILES = 20000;
const MAX_INDEXED_FILES = 5000;
/** A snapshot older than this re-walks the tree (stat only) to pick up external changes. */
const REFRESH_MS = 4000;

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type FileKind = 'source' | 'test' | 'docs' | 'example' | 'config' | 'other';
export type Lang = 'python' | 'js' | 'markdown' | 'rst' | 'text' | 'config' | 'other';

export interface IndexedSymbol {
  name: string;
  kind: SymbolHit['kind'];
  /** 1-based definition line. */
  line: number;
  /** First line of the declaration including decorators / heading overline. */
  startLine: number;
  /** Last line of the body (Python: indentation, JS: braces, headings: section end). */
  endLine: number;
  /** Enclosing class/function name. */
  parent?: string;
  topLevel: boolean;
  signature: string;
  /** Stemmed name parts, e.g. routes_command -> ['rout', 'command']. */
  parts: string[];
  /** Heading level (1 = top). */
  level?: number;
}

export interface IndexedFile {
  path: string;
  ext: string;
  lang: Lang;
  kind: FileKind;
  isChangelog: boolean;
  /** Under a dot-directory such as .github/ (ranked after regular files). */
  hidden: boolean;
  size: number;
  mtimeMs: number;
  text: string;
  lines: string[];
  lineCount: number;
  symbols: IndexedSymbol[];
  /** Stemmed term (and lowercased compound identifier) -> frequency. */
  tf: Map<string, number>;
  /** Number of term occurrences (document length for BM25). */
  length: number;
  /** Stemmed tokens of every path segment, and of the basename alone. */
  pathTerms: Set<string>;
  baseTerms: Set<string>;
  /** Lowercased short string literals (code files) -> 1-based lines. */
  literals: Map<string, number[]>;
  /** Imported modules: Python dotted names, JS workspace module ids (path without extension). */
  imports: string[];
  /** Module identity used by importers (python: 'flask.cli', js: 'src/context/indexer'). */
  moduleId?: string;
  /** 1-based lines that define or register CLI commands (click, argparse, typer, commander...). */
  cliLines: number[];
  /** CLI command names, e.g. 'routes' from @click.command("routes"). */
  cliNames: string[];
  /** Per line: 1 when the line is a comment or docstring (code files only). */
  prose?: Uint8Array;
}

export interface IndexSnapshot {
  root: string;
  /** Indexed text files, sorted by path. */
  files: IndexedFile[];
  byPath: Map<string, IndexedFile>;
  /** Every walked file (including binary/large/non-text ones), sorted. */
  allPaths: string[];
  /** term -> number of files containing it */
  df: Map<string, number>;
  /** lowercased literal -> number of files containing it as a string literal */
  literalDf: Map<string, number>;
  avgLength: number;
  builtMs: number;
}

// ---------------------------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------------------------

const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with',
  'yield', 'self', 'cls',
]);
const JS_KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield', 'async', 'await', 'of', 'static',
]);

/** Split an identifier into lowercased parts: getDebugFlag / get_debug_flag / HTTPServer. */
export function splitIdentifier(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((p) => p.toLowerCase())
    .filter((p) => p.length > 0 && !/^\d+$/.test(p));
}

/** Light suffix stemmer: values/value -> valu, treated -> treat, commands -> command. */
export function stem(word: string): string {
  let s = word.toLowerCase();
  if (s.length <= 3) return s;
  if (s.endsWith('ies') && s.length > 4) s = s.slice(0, -3) + 'y';
  else if (s.endsWith('sses')) s = s.slice(0, -2);
  else if (s.endsWith('s') && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);
  if (s.length > 5 && s.endsWith('ly')) s = s.slice(0, -2);
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  if (s.length > 6 && s.endsWith('ation')) s = s.slice(0, -5);
  if (s.length > 4 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

/**
 * Tokens of a piece of text for matching: stemmed identifier parts plus the lowercased full
 * compound identifier (e.g. "get_debug_flag"). Language keywords are skipped (case-sensitive),
 * so Python's `False` does not match a request about the string "false".
 */
export function tokenize(text: string, lang: Lang, emit: (token: string) => void): void {
  const keywords = lang === 'python' ? PY_KEYWORDS : lang === 'js' ? JS_KEYWORDS : undefined;
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const w = m[0];
    if (keywords?.has(w)) continue;
    const parts = splitIdentifier(w);
    for (const p of parts) if (p.length > 1) emit(stem(p));
    if (parts.length > 1) emit(w.toLowerCase());
  }
}

/** Set of tokens on one line (used for line-level scoring). */
export function lineTokens(line: string, lang: Lang): Set<string> {
  const out = new Set<string>();
  tokenize(line, lang, (t) => out.add(t));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

export function extOf(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function langOf(ext: string): Lang {
  if (ext === 'py' || ext === 'pyi') return 'python';
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'].includes(ext)) return 'js';
  if (ext === 'md') return 'markdown';
  if (ext === 'rst') return 'rst';
  if (ext === 'txt') return 'text';
  if (['toml', 'cfg', 'ini', 'json', 'yaml', 'yml'].includes(ext)) return 'config';
  return 'other';
}

export function classify(relPath: string, lang: Lang): { kind: FileKind; isChangelog: boolean } {
  const lower = relPath.toLowerCase();
  const segs = lower.split('/');
  const base = segs[segs.length - 1];
  const dirs = segs.slice(0, -1);
  const isChangelog = /^(changes|changelog|history|news|releases?)(\.|$)/.test(base);
  if (dirs.some((d) => d === 'examples' || d === 'example' || d === 'samples' || d === 'demo')) {
    return { kind: 'example', isChangelog };
  }
  const isTest =
    dirs.some((d) => d === 'tests' || d === 'test' || d === '__tests__' || d === 'spec') ||
    /^test_.+\.py$|_test\.py$|^conftest\.py$|\.(test|spec)\.[cm]?[jt]sx?$/.test(base);
  if (isTest && (lang === 'python' || lang === 'js')) return { kind: 'test', isChangelog };
  if (lang === 'markdown' || lang === 'rst' || dirs[0] === 'docs' || dirs[0] === 'doc' || /^readme(\.|$)/.test(base)) {
    return { kind: 'docs', isChangelog };
  }
  if (isTest) return { kind: 'test', isChangelog };
  if (lang === 'config') return { kind: 'config', isChangelog };
  if (lang === 'python' || lang === 'js') return { kind: 'source', isChangelog };
  return { kind: 'other', isChangelog };
}

/** Importance order used by repo maps and search listings: src, tests, config, docs, examples. */
export function kindRank(kind: FileKind): number {
  return { source: 0, test: 1, config: 2, docs: 3, example: 4, other: 5 }[kind];
}

/** kindRank with files under dot-directories (and changelogs) after everything else. */
export function fileRank(f: { kind: FileKind; hidden: boolean; isChangelog: boolean }): number {
  return kindRank(f.kind) + (f.isChangelog ? 6 : 0) + (f.hidden ? 12 : 0);
}

function pythonModuleName(relPath: string): string {
  let p = relPath.replace(/\.pyi?$/, '');
  p = p.replace(/^(src|lib)\//, '');
  p = p.replace(/\/__init__$/, '');
  return p.split('/').join('.');
}

function jsModuleId(relPath: string): string {
  return relPath.replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
}

// ---------------------------------------------------------------------------------------------
// Line scanners (strings, comments and bracket depth)
// ---------------------------------------------------------------------------------------------

interface ScanResult {
  /** Line begins a new logical statement (not inside a string/comment/bracket/continuation). */
  logicalStart: boolean[];
  /** Bracket depth (Python: all brackets, JS: braces only) at the start of each line. */
  depthStart: number[];
  /** Maximum brace depth reached within each line (JS). */
  depthMax: number[];
  /** Depth at the end of each line. */
  depthEnd: number[];
  literals: Map<string, number[]>;
  /** Line is a comment or a docstring line. */
  prose: Uint8Array;
}

function newScan(n: number): ScanResult {
  return {
    logicalStart: new Array(n), depthStart: new Array(n), depthMax: new Array(n), depthEnd: new Array(n),
    literals: new Map(), prose: new Uint8Array(n),
  };
}

function addLiteral(map: Map<string, number[]>, raw: string, line: number): void {
  const lit = raw.trim().toLowerCase();
  if (!lit || lit.length > 40) return;
  const arr = map.get(lit);
  if (!arr) map.set(lit, [line]);
  else if (arr[arr.length - 1] !== line && arr.length < 50) arr.push(line);
}

function scanPython(lines: string[]): ScanResult {
  const n = lines.length;
  const res = newScan(n);
  let depth = 0;
  let triple: string | undefined;
  let cont = false;
  for (let i = 0; i < n; i++) {
    const raw = lines[i];
    const lead = raw.trimStart();
    if (triple !== undefined || lead.startsWith('#') || /^[rRbBuU]?("{3}|'{3})/.test(lead)) res.prose[i] = 1;
    res.logicalStart[i] = triple === undefined && depth === 0 && !cont;
    res.depthStart[i] = depth;
    let maxD = depth;
    cont = false;
    let j = 0;
    const len = raw.length;
    while (j < len) {
      if (triple) {
        const k = raw.indexOf(triple, j);
        if (k < 0) { j = len; break; }
        triple = undefined;
        j = k + 3;
        continue;
      }
      const c = raw[j];
      if (c === '#') break;
      if (c === '"' || c === "'") {
        if (raw.startsWith(c + c + c, j)) { triple = c + c + c; j += 3; continue; }
        let k = j + 1;
        while (k < len && raw[k] !== c) k += raw[k] === '\\' ? 2 : 1;
        addLiteral(res.literals, raw.slice(j + 1, Math.min(k, len)), i + 1);
        j = k + 1;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') { depth++; if (depth > maxD) maxD = depth; }
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
      j++;
    }
    if (!triple && /\\\s*$/.test(raw) && !/#.*\\\s*$/.test(raw)) cont = true;
    res.depthMax[i] = maxD;
    res.depthEnd[i] = depth;
  }
  return res;
}

/** A '/' at raw[j] starts a regex literal (not a division) when it follows an operator or keyword. */
function regexAllowed(raw: string, j: number): boolean {
  let k = j - 1;
  while (k >= 0 && (raw[k] === ' ' || raw[k] === '\t')) k--;
  if (k < 0) return true;
  if ('(,=:[!&|?{};+-*%<>~^'.includes(raw[k])) return true;
  return /\b(return|typeof|case|in|of|delete|void|throw|yield|await)$/.test(raw.slice(0, k + 1));
}

function scanJs(lines: string[]): ScanResult {
  const n = lines.length;
  const res = newScan(n);
  let braces = 0;
  let parens = 0;
  let state: 'code' | 'block' | 'template' = 'code';
  for (let i = 0; i < n; i++) {
    const raw = lines[i];
    const lead = raw.trimStart();
    if (state === 'block' || lead.startsWith('//') || lead.startsWith('/*') || /^\*(\s|\/|$)/.test(lead)) res.prose[i] = 1;
    res.logicalStart[i] = state === 'code' && parens === 0;
    res.depthStart[i] = braces;
    let maxD = braces;
    let j = 0;
    const len = raw.length;
    while (j < len) {
      if (state === 'block') {
        const k = raw.indexOf('*/', j);
        if (k < 0) { j = len; break; }
        state = 'code';
        j = k + 2;
        continue;
      }
      if (state === 'template') {
        let k = j;
        while (k < len && raw[k] !== '`') k += raw[k] === '\\' ? 2 : 1;
        if (k >= len) { j = len; break; }
        state = 'code';
        j = k + 1;
        continue;
      }
      const c = raw[j];
      if (c === '/' && raw[j + 1] === '/') break;
      if (c === '/' && raw[j + 1] === '*') { state = 'block'; j += 2; continue; }
      if (c === '/' && regexAllowed(raw, j)) {
        // regex literal: skip to the closing slash (escapes and [...] classes respected)
        let k = j + 1;
        let inClass = false;
        while (k < len && (raw[k] !== '/' || inClass)) {
          if (raw[k] === '\\') k++;
          else if (raw[k] === '[') inClass = true;
          else if (raw[k] === ']') inClass = false;
          k++;
        }
        j = k + 1;
        continue;
      }
      if (c === '`') { state = 'template'; j++; continue; }
      if (c === '"' || c === "'") {
        let k = j + 1;
        while (k < len && raw[k] !== c) k += raw[k] === '\\' ? 2 : 1;
        addLiteral(res.literals, raw.slice(j + 1, Math.min(k, len)), i + 1);
        j = k + 1;
        continue;
      }
      if (c === '{') { braces++; if (braces > maxD) maxD = braces; }
      else if (c === '}') braces = Math.max(0, braces - 1);
      else if (c === '(' || c === '[') parens++;
      else if (c === ')' || c === ']') parens = Math.max(0, parens - 1);
      j++;
    }
    res.depthMax[i] = maxD;
    res.depthEnd[i] = braces;
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------------------------

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

function symbolParts(name: string): string[] {
  return splitIdentifier(name).filter((p) => p.length > 1).map(stem);
}

function joinSignature(lines: string[], i: number): string {
  let sig = lines[i].trim();
  for (let k = i + 1; k < lines.length && k < i + 6 && !/[:{]\s*$|\)\s*(->.*)?:?\s*$/.test(sig); k++) {
    sig += ' ' + lines[k].trim();
  }
  sig = sig.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/,?\s+\)/g, ')');
  return sig.length > 200 ? sig.slice(0, 199) + '…' : sig;
}

function extractPython(lines: string[], scan: ScanResult): IndexedSymbol[] {
  const out: IndexedSymbol[] = [];
  const stack: Array<{ sym: IndexedSymbol; indent: number }> = [];
  let lastCode = 0;
  let decoStart: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!scan.logicalStart[i]) {
      if (trimmed) lastCode = i + 1;
      continue;
    }
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = indentOf(raw);
    while (stack.length && indent <= stack[stack.length - 1].indent) {
      const top = stack.pop()!;
      top.sym.endLine = Math.max(top.sym.line, lastCode);
    }
    lastCode = i + 1;
    if (trimmed.startsWith('@')) {
      if (decoStart === undefined) decoStart = i + 1;
      continue;
    }
    const enclosing = [...stack].reverse().find((s) => s.sym.kind !== 'variable');
    const def = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(trimmed);
    const cls = def ? null : /^class\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (def || cls) {
      const name = (def ?? cls)![1];
      const kind: SymbolHit['kind'] = cls ? 'class' : enclosing?.sym.kind === 'class' ? 'method' : 'function';
      const sym: IndexedSymbol = {
        name, kind, line: i + 1, startLine: decoStart ?? i + 1, endLine: i + 1,
        parent: enclosing?.sym.name, topLevel: indent === 0 && !enclosing,
        signature: joinSignature(lines, i), parts: symbolParts(name),
      };
      out.push(sym);
      stack.push({ sym, indent });
    } else if (indent === 0) {
      const asg = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(trimmed);
      if (asg) {
        const sym: IndexedSymbol = {
          name: asg[1], kind: 'variable', line: i + 1, startLine: i + 1, endLine: i + 1,
          topLevel: true, signature: trimmed.length > 200 ? trimmed.slice(0, 199) + '…' : trimmed, parts: symbolParts(asg[1]),
        };
        out.push(sym);
        stack.push({ sym, indent: 0 });
      }
    }
    decoStart = undefined;
  }
  for (const s of stack) s.sym.endLine = Math.max(s.sym.line, lastCode);
  return out;
}

const JS_NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'with', 'else', 'do', 'new', 'typeof', 'await', 'super']);

function extractJs(lines: string[], scan: ScanResult): IndexedSymbol[] {
  const out: IndexedSymbol[] = [];
  type Open = { sym: IndexedSymbol; depth0: number; opened: boolean; startIdx: number };
  const stack: Open[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const d0 = scan.depthStart[i];
    if (scan.logicalStart[i] && trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
      const enclosing = stack.length ? stack[stack.length - 1] : undefined;
      let name: string | undefined;
      let kind: SymbolHit['kind'] = 'function';
      let m: RegExpExecArray | null;
      if ((m = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(trimmed))) {
        name = m[1];
      } else if ((m = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(trimmed))) {
        name = m[1];
        kind = 'class';
      } else if ((m = /^(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(trimmed))) {
        name = m[1];
        kind = 'other';
      } else if (d0 === 0 && (m = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*)$/.exec(trimmed))) {
        name = m[1];
        kind = /^class\b/.test(m[2])
          ? 'class'
          : /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>|^(?:async\s+)?function\b/.test(m[2]) ? 'function' : 'variable';
      } else if (
        enclosing?.sym.kind === 'class' && d0 === enclosing.depth0 + 1 &&
        (m = /^(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*(?:\(|=\s*(?:async\s+)?\([^)]*\)\s*(?::[^=]+)?=>)/.exec(trimmed)) &&
        !JS_NOT_METHODS.has(m[1])
      ) {
        name = m[1];
        kind = 'method';
      }
      if (name) {
        const sym: IndexedSymbol = {
          name, kind, line: i + 1, startLine: i + 1, endLine: i + 1,
          parent: enclosing?.sym.name, topLevel: d0 === 0,
          signature: joinSignature(lines, i), parts: symbolParts(name),
        };
        out.push(sym);
        stack.push({ sym, depth0: d0, opened: false, startIdx: i });
      }
    }
    // close symbols whose braces balanced (or that never opened a body)
    for (let k = stack.length - 1; k >= 0; k--) {
      const o = stack[k];
      if (!o.opened && scan.depthMax[i] > o.depth0) o.opened = true;
      const ended = o.opened
        ? scan.depthEnd[i] <= o.depth0
        : /;\s*$/.test(trimmed) || i - o.startIdx >= 4;
      if (ended) {
        o.sym.endLine = i + 1;
        stack.splice(k, 1);
      }
    }
  }
  for (const o of stack) o.sym.endLine = lines.length;
  return out;
}

function closeSections(headings: IndexedSymbol[], lineCount: number): void {
  for (let k = 0; k < headings.length; k++) {
    const h = headings[k];
    let end = lineCount;
    for (let j = k + 1; j < headings.length; j++) {
      if ((headings[j].level ?? 1) <= (h.level ?? 1)) {
        end = headings[j].startLine - 1;
        break;
      }
    }
    h.endLine = Math.max(h.line, end);
  }
}

function extractMarkdown(lines: string[]): IndexedSymbol[] {
  const out: IndexedSymbol[] = [];
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    const f = /^\s*(```+|~~~+)/.exec(t);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1].startsWith(fence)) fence = undefined;
      continue;
    }
    if (fence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(t);
    if (m) {
      out.push({
        name: m[2], kind: 'heading', line: i + 1, startLine: i + 1, endLine: i + 1, topLevel: m[1].length <= 2,
        signature: t.trim(), parts: symbolParts(m[2]), level: m[1].length,
      });
    }
  }
  closeSections(out, lines.length);
  return out;
}

const RST_ADORN = /^([=\-~^"'`#*+:.])\1{2,}\s*$/;
const RST_DIRECTIVES = /^\.\.\s+((?:py:)?(?:auto)?(?:function|class|method|data|attribute|module|exception|decorator|envvar|confval|currentmodule))::\s*(\S.*)$/;

function extractRst(lines: string[]): IndexedSymbol[] {
  const headings: IndexedSymbol[] = [];
  const others: IndexedSymbol[] = [];
  const styles: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    const d = RST_DIRECTIVES.exec(t);
    if (d) {
      const target = d[2].replace(/\(.*$/, '').trim();
      const name = target.split('.').pop() || target;
      others.push({
        name, kind: 'other', line: i + 1, startLine: i + 1, endLine: i + 1, topLevel: false,
        signature: t.trim(), parts: symbolParts(name),
      });
      continue;
    }
    const next = lines[i + 1];
    if (!t.trim() || /^\s/.test(t) || RST_ADORN.test(t) || next === undefined || !RST_ADORN.test(next)) continue;
    if (next.trimEnd().length < Math.min(t.trimEnd().length, 3)) continue;
    const over = i > 0 && RST_ADORN.test(lines[i - 1]) && lines[i - 1][0] === next[0];
    const style = (over ? 'o' : 'u') + next[0];
    let level = styles.indexOf(style);
    if (level < 0) {
      styles.push(style);
      level = styles.length - 1;
    }
    const name = t.trim();
    headings.push({
      name, kind: 'heading', line: i + 1, startLine: over ? i : i + 1, endLine: i + 2, topLevel: level <= 1,
      signature: name, parts: symbolParts(name), level: level + 1,
    });
    i++;
  }
  closeSections(headings, lines.length);
  return [...headings, ...others].sort((a, b) => a.line - b.line);
}

/** Symbols of a file's lines (also used for fresh text in mention resolution). */
export function extractSymbols(relPath: string, lines: string[]): IndexedSymbol[] {
  const lang = langOf(extOf(relPath));
  if (lang === 'python') return extractPython(lines, scanPython(lines));
  if (lang === 'js') return extractJs(lines, scanJs(lines));
  if (lang === 'markdown') return extractMarkdown(lines);
  if (lang === 'rst') return extractRst(lines);
  return [];
}

// ---------------------------------------------------------------------------------------------
// Imports and CLI detection
// ---------------------------------------------------------------------------------------------

function pythonImports(relPath: string, lines: string[], scan: ScanResult): string[] {
  const own = pythonModuleName(relPath);
  const pkgParts = own.split('.');
  if (!/\/__init__\.pyi?$/.test(relPath)) pkgParts.pop();
  const out = new Set<string>();
  const resolveRel = (spec: string): string => {
    const dots = /^\.*/.exec(spec)![0].length;
    if (!dots) return spec;
    const base = pkgParts.slice(0, Math.max(0, pkgParts.length - (dots - 1)));
    const rest = spec.slice(dots);
    return [...base, ...(rest ? [rest] : [])].join('.');
  };
  for (let i = 0; i < lines.length; i++) {
    if (!scan.logicalStart[i]) continue;
    const t = lines[i].trim();
    let m = /^from\s+(\.*[\w.]*)\s+import\s+\(?\s*(.+)$/.exec(t);
    if (m) {
      const mod = resolveRel(m[1]);
      if (mod) out.add(mod);
      // `from pkg import sub` may import a submodule
      for (const nm of m[2].split(',')) {
        const sub = nm.trim().split(/\s+/)[0].replace(/[()]/g, '');
        if (/^[A-Za-z_]\w*$/.test(sub) && mod) out.add(`${mod}.${sub}`);
      }
      continue;
    }
    m = /^import\s+(.+)$/.exec(t);
    if (m) for (const part of m[1].split(',')) out.add(part.trim().split(/\s+/)[0]);
  }
  return [...out];
}

function jsImports(relPath: string, text: string): string[] {
  const out = new Set<string>();
  const dir = path.posix.dirname(relPath);
  const re = /(?:from\s+|require\(\s*|import\(\s*|import\s+)['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const spec = m[1];
    if (spec.startsWith('.')) out.add(jsModuleId(path.posix.normalize(path.posix.join(dir, spec))));
    else out.add(spec);
  }
  return [...out];
}

const CLI_LINE_RES = [
  /^\s*@[\w.]*\b(command|group)\s*\(/, // click / typer decorators
  /\bclick\.(Command|Group|command|group|Option|Argument)\s*\(/,
  /\.add_command\s*\(/,
  /\bargparse\.ArgumentParser\s*\(|\.add_parser\s*\(|\.add_subparsers\s*\(/,
  /\btyper\.Typer\s*\(/,
  /\bprogram\s*\.\s*command\s*\(|\byargs\b.*\.command\s*\(/,
  /\bregisterCommand\s*\(/,
];

function cliInfo(lines: string[]): { cliLines: number[]; cliNames: string[] } {
  const cliLines: number[] = [];
  const names = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    if (!CLI_LINE_RES.some((re) => re.test(t))) continue;
    cliLines.push(i + 1);
    const m = /(?:command|add_parser|group)\s*\(\s*["']([\w:.-]+)["']/.exec(t);
    if (m) names.add(m[1]);
  }
  return { cliLines, cliNames: [...names] };
}

// ---------------------------------------------------------------------------------------------
// Per-file indexing
// ---------------------------------------------------------------------------------------------

function looksBinaryOrMinified(text: string, lineCount: number): boolean {
  if (text.indexOf('\u0000') !== -1) return true;
  if (text.length > 3000 && lineCount <= 3) return true;
  return text.length > 20000 && text.length / Math.max(1, lineCount) > 300;
}

/** Bundler output (esbuild/webpack/rollup) duplicates the real sources; keep it out of the index. */
function looksGenerated(lang: Lang, text: string): boolean {
  if (lang !== 'js' || text.length < 20000) return false;
  const head = text.slice(0, 2000);
  return /\n\/\/# sourceMappingURL=\S+\s*$/.test(text.slice(-300)) ||
    /\bvar __(defProp|create|getOwnPropNames|toESM|commonJS)\b|__webpack_require__|\/\/ (node_modules|src)\/\S+\.[cm]?[jt]sx?$/m.test(head);
}

export function indexText(relPath: string, text: string, stat: { size: number; mtimeMs: number }): IndexedFile | undefined {
  const ext = extOf(relPath);
  const lang = langOf(ext);
  const lines = text.split(/\r?\n/);
  if (looksBinaryOrMinified(text, lines.length) || looksGenerated(lang, text)) return undefined;
  const { kind, isChangelog } = classify(relPath, lang);

  let symbols: IndexedSymbol[] = [];
  let literals = new Map<string, number[]>();
  let imports: string[] = [];
  let moduleId: string | undefined;
  let prose: Uint8Array | undefined;
  if (lang === 'python') {
    const scan = scanPython(lines);
    symbols = extractPython(lines, scan);
    literals = scan.literals;
    prose = scan.prose;
    imports = pythonImports(relPath, lines, scan);
    moduleId = pythonModuleName(relPath);
  } else if (lang === 'js') {
    const scan = scanJs(lines);
    symbols = extractJs(lines, scan);
    literals = scan.literals;
    prose = scan.prose;
    imports = jsImports(relPath, text);
    moduleId = jsModuleId(relPath);
  } else if (lang === 'markdown') symbols = extractMarkdown(lines);
  else if (lang === 'rst') symbols = extractRst(lines);

  const tf = new Map<string, number>();
  let length = 0;
  tokenize(text, lang, (t) => {
    tf.set(t, (tf.get(t) ?? 0) + 1);
    length++;
  });

  const pathTerms = new Set<string>();
  const baseTerms = new Set<string>();
  const segs = relPath.split('/');
  segs.forEach((seg, idx) => {
    const isBase = idx === segs.length - 1;
    const name = isBase ? seg.replace(/\.[^.]+$/, '') : seg;
    for (const p of splitIdentifier(name)) {
      if (p.length < 2) continue;
      pathTerms.add(stem(p));
      if (isBase) baseTerms.add(stem(p));
    }
  });

  const cli = lang === 'python' || lang === 'js' ? cliInfo(lines) : { cliLines: [], cliNames: [] };
  return {
    path: relPath, ext, lang, kind, isChangelog, hidden: relPath.split('/').slice(0, -1).some((d) => d.startsWith('.')), size: stat.size, mtimeMs: stat.mtimeMs, text, lines,
    lineCount: lines.length, symbols, tf, length, pathTerms, baseTerms, literals, imports, moduleId,
    cliLines: cli.cliLines, cliNames: cli.cliNames, prose,
  };
}

// ---------------------------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------------------------

interface CacheEntry {
  file: IndexedFile | undefined; // undefined = unreadable/binary/minified
  size: number;
  mtimeMs: number;
  gen: number;
}

export class WorkspaceIndex {
  private readonly maxFileBytes: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly invalidGen = new Map<string, number>();
  private allInvalidGen = 0;
  private gen = 0;
  private snapshot: IndexSnapshot | undefined;
  private snapshotAt = 0;
  private building: Promise<IndexSnapshot> | undefined;
  private buildingGen = -1;

  constructor(private readonly io: WorkspaceIO, opts?: { maxFileBytes?: number }) {
    this.maxFileBytes = opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  /** Current snapshot; builds lazily and refreshes changed files after REFRESH_MS. */
  async get(): Promise<IndexSnapshot> {
    if (this.snapshot && Date.now() - this.snapshotAt < REFRESH_MS) return this.snapshot;
    // reuse an in-flight build unless something was invalidated after it started
    if (!this.building || this.buildingGen !== this.gen) {
      const prev = this.building ?? Promise.resolve(undefined);
      const p = prev.catch(() => undefined).then(() => this.build());
      this.building = p;
      this.buildingGen = this.gen;
      p.finally(() => {
        if (this.building === p) this.building = undefined;
      }).catch(() => undefined);
    }
    return this.building;
  }

  invalidate(relPath?: string): void {
    this.gen++;
    this.snapshot = undefined;
    if (relPath === undefined) {
      this.cache.clear();
      this.allInvalidGen = this.gen;
      return;
    }
    const p = normalizePath(relPath);
    this.cache.delete(p);
    this.invalidGen.set(p, this.gen);
  }

  private async walk(): Promise<{ all: string[]; textFiles: string[] }> {
    const root = this.io.root;
    const all: string[] = [];
    const textFiles: string[] = [];
    const dirs: string[] = [''];
    while (dirs.length && all.length < MAX_LISTED_FILES) {
      const rel = dirs.pop()!;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fsp.readdir(rel ? path.join(root, rel) : root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.endsWith('.egg-info')) dirs.push(childRel);
        } else if (e.isFile()) {
          all.push(childRel);
          const lower = e.name.toLowerCase();
          if (TEXT_EXTS.has(extOf(lower)) && !SKIP_FILES.has(lower) && !/\.min\.(js|css)$/.test(lower)) textFiles.push(childRel);
        }
      }
    }
    all.sort();
    textFiles.sort();
    return { all, textFiles: textFiles.slice(0, MAX_INDEXED_FILES) };
  }

  private async build(): Promise<IndexSnapshot> {
    const t0 = Date.now();
    const genAtStart = this.gen;
    const { all, textFiles } = await this.walk();
    const files: IndexedFile[] = [];
    const seen = new Set<string>();
    const BATCH = 32;
    for (let b = 0; b < textFiles.length; b += BATCH) {
      const batch = textFiles.slice(b, b + BATCH);
      const results = await Promise.all(batch.map((rel) => this.loadFile(rel, genAtStart)));
      for (const f of results) if (f) files.push(f);
      for (const rel of batch) seen.add(rel);
    }
    for (const key of [...this.cache.keys()]) if (!seen.has(key)) this.cache.delete(key);

    const df = new Map<string, number>();
    const literalDf = new Map<string, number>();
    let totalLen = 0;
    for (const f of files) {
      totalLen += f.length;
      for (const t of f.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      for (const l of f.literals.keys()) literalDf.set(l, (literalDf.get(l) ?? 0) + 1);
    }
    const snap: IndexSnapshot = {
      root: this.io.root, files, byPath: new Map(files.map((f) => [f.path, f])), allPaths: all, df, literalDf,
      avgLength: files.length ? totalLen / files.length : 1, builtMs: Date.now() - t0,
    };
    if (genAtStart === this.gen) {
      this.snapshot = snap;
      this.snapshotAt = Date.now();
    }
    return snap;
  }

  private async loadFile(rel: string, gen: number): Promise<IndexedFile | undefined> {
    let st: import('node:fs').Stats;
    try {
      st = await fsp.stat(path.join(this.io.root, rel));
    } catch {
      return undefined;
    }
    if (st.size > this.maxFileBytes) return undefined;
    const cached = this.cache.get(rel);
    const minGen = Math.max(this.allInvalidGen, this.invalidGen.get(rel) ?? 0);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs && cached.gen >= minGen) return cached.file;
    let text: string | undefined;
    try {
      text = await this.io.readText(rel);
    } catch {
      text = undefined;
    }
    const file = text === undefined || text.length > this.maxFileBytes * 2 ? undefined : indexText(rel, text, { size: st.size, mtimeMs: st.mtimeMs });
    this.cache.set(rel, { file, size: st.size, mtimeMs: st.mtimeMs, gen });
    return file;
  }
}
