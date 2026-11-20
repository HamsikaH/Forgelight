/**
 * @-mention resolution and snippet rendering (PURE: no vscode).
 *
 * Supported mentions: `@path/to/file.py`, `@file:path`, `@symbol:Name`, `@Name`,
 * `@Class.method`. Files are included whole when short (<= 300 lines), otherwise the first
 * 120 lines plus a symbol outline; symbols include their definition body (max 150 lines).
 */
import type { ContextFilePick, SymbolHit, WorkspaceIO } from '../contracts';
import { estimateTokens } from '../events';
import { normalizePath } from '../review/hunks';
import { extOf, extractSymbols, fileRank, type IndexedFile, type IndexedSymbol, type IndexSnapshot } from './indexer';

export interface LineRange {
  start: number;
  end: number;
}

const WHOLE_FILE_MAX_LINES = 300;
const FILE_HEAD_LINES = 120;
const SYMBOL_MAX_LINES = 150;
const MAX_MENTIONS = 12;

// ---------------------------------------------------------------------------------------------
// Rendering helpers shared with retrieval
// ---------------------------------------------------------------------------------------------

const FENCE_LANG: Record<string, string> = {
  py: 'python', pyi: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx', md: 'markdown', rst: 'rst', toml: 'toml', cfg: 'ini', ini: 'ini',
  json: 'json', yaml: 'yaml', yml: 'yaml', html: 'html', css: 'css', sh: 'bash', txt: 'text',
};

/** Code fence longer than any backtick run inside the content. */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/`{3,}/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

export function formatRanges(ranges: LineRange[]): string {
  return ranges.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`)).join(', ');
}

/**
 * "### <path> (lines a-b, c-d) — <reasons>" followed by one fenced block of raw lines per range
 * (no line-number prefixes, so the text can be copied verbatim into search/replace edits).
 * With several ranges, each block is preceded by a "lines a-b:" label outside the fence.
 */
export function renderSection(
  relPath: string,
  lines: string[],
  ranges: LineRange[],
  reasons: string[],
  labels?: Array<string | undefined>,
  footer?: string,
): string {
  const lang = FENCE_LANG[extOf(relPath)] ?? '';
  const out: string[] = [`### ${relPath} (lines ${formatRanges(ranges)}) — ${reasons.join('; ')}`];
  ranges.forEach((r, i) => {
    const body = lines.slice(r.start - 1, r.end).join('\n');
    const fence = fenceFor(body);
    if (ranges.length > 1 || labels?.[i]) out.push(`lines ${r.start}-${r.end}${labels?.[i] ? ` (${labels[i]})` : ''}:`);
    out.push(fence + lang, body, fence);
  });
  if (footer) out.push(footer);
  return out.join('\n');
}

export function qualifiedName(sym: IndexedSymbol): string {
  return sym.parent && (sym.kind === 'method' || sym.kind === 'function' || sym.kind === 'class') ? `${sym.parent}.${sym.name}` : sym.name;
}

const DEF_KINDS = new Set<SymbolHit['kind']>(['class', 'function', 'method', 'variable']);

/** Symbol lookup: exact name, then case-insensitive, then substring (first non-empty tier). */
export function lookupSymbols(snap: IndexSnapshot, query: string, max = 30): Array<{ file: IndexedFile; sym: IndexedSymbol }> {
  const q = query.trim().replace(/\(\)$/, '');
  if (!q) return [];
  const dot = q.lastIndexOf('.');
  const parent = dot > 0 ? q.slice(0, dot).split('.').pop()! : undefined;
  const name = dot > 0 ? q.slice(dot + 1) : q;
  const all: Array<{ file: IndexedFile; sym: IndexedSymbol }> = [];
  for (const file of snap.files) for (const sym of file.symbols) all.push({ file, sym });
  const parentOk = (s: IndexedSymbol, ci: boolean) =>
    !parent || (s.parent !== undefined && (ci ? s.parent.toLowerCase() === parent.toLowerCase() : s.parent === parent));
  const lname = name.toLowerCase();
  const tiers: Array<(s: IndexedSymbol) => boolean> = [
    (s) => s.name === name && parentOk(s, false),
    (s) => s.name.toLowerCase() === lname && parentOk(s, true),
    (s) => s.name.toLowerCase().includes(lname) && parentOk(s, true),
  ];
  for (const test of tiers) {
    const hits = all.filter((h) => test(h.sym));
    if (!hits.length) continue;
    hits.sort(
      (a, b) =>
        Number(!DEF_KINDS.has(a.sym.kind)) - Number(!DEF_KINDS.has(b.sym.kind)) ||
        fileRank(a.file) - fileRank(b.file) ||
        Number(!a.sym.topLevel) - Number(!b.sym.topLevel) ||
        a.file.path.localeCompare(b.file.path) ||
        a.sym.line - b.sym.line,
    );
    return hits.slice(0, max);
  }
  return [];
}

export function toSymbolHit(file: IndexedFile, sym: IndexedSymbol): SymbolHit {
  return { path: file.path, line: sym.line, kind: sym.kind, name: qualifiedName(sym), signature: sym.signature };
}

/** Resolve a user-typed path to a workspace file: exact, case-insensitive, path suffix, basename. */
export function resolvePath(snap: IndexSnapshot, raw: string): string | undefined {
  let p = raw.replace(/\\/g, '/');
  const root = snap.root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (p.startsWith(root + '/')) p = p.slice(root.length + 1);
  p = normalizePath(p);
  if (!p) return undefined;
  const all = snap.allPaths;
  if (all.includes(p)) return p;
  const lower = p.toLowerCase();
  const ci = all.filter((a) => a.toLowerCase() === lower);
  if (ci.length) return ci[0];
  const pick = (cands: string[]) => {
    if (!cands.length) return undefined;
    const rank = (c: string) => {
      const f = snap.byPath.get(c);
      return f ? fileRank(f) : 20 + (c.split('/').some((d) => d.startsWith('.')) ? 12 : 0);
    };
    return [...cands].sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b))[0];
  };
  const suffix = all.filter((a) => a.toLowerCase().endsWith('/' + lower));
  if (suffix.length) return pick(suffix);
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------------------------

interface ParsedMention {
  raw: string;
  type: 'file' | 'symbol' | 'auto';
  value: string;
}

export function parseMentions(text: string): ParsedMention[] {
  // ignore fenced code (decorators such as @click.command are not mentions)
  const clean = text.replace(/```[\s\S]*?```/g, ' ');
  const out: ParsedMention[] = [];
  const seen = new Set<string>();
  for (const m of clean.matchAll(/(?<![\w@`])@([^\s'"`<>()[\]{},;]+)/g)) {
    const raw = m[1].replace(/[.,:;!?]+$/, '');
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    let type: ParsedMention['type'] = 'auto';
    let value = raw;
    if (/^file:/i.test(raw)) {
      type = 'file';
      value = raw.slice(5);
    } else if (/^(symbol|sym):/i.test(raw)) {
      type = 'symbol';
      value = raw.replace(/^(symbol|sym):/i, '');
    }
    if (value) out.push({ raw: '@' + raw, type, value });
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

interface Section {
  path: string;
  ranges: LineRange[];
  reason: string;
  text: string;
  tokens: number;
}

async function readFresh(io: WorkspaceIO, relPath: string): Promise<string | undefined> {
  try {
    const t = await io.readText(relPath);
    return t === undefined || t.includes('\u0000') ? undefined : t;
  } catch {
    return undefined;
  }
}

function outline(symbols: IndexedSymbol[]): string {
  const items = symbols.filter((s) => s.kind !== 'variable' && s.kind !== 'other').slice(0, 80);
  if (!items.length) return '';
  const rows = items.map((s) => {
    const indent = s.kind === 'method' || (s.level ?? 1) > 1 ? '  ' : '';
    return `${indent}- line ${s.line}: ${s.kind === 'heading' ? s.name : s.signature}`;
  });
  return `Outline (use read_file with a line range for more):\n${rows.join('\n')}`;
}

async function fileSection(io: WorkspaceIO, relPath: string, mention: string): Promise<Section | undefined> {
  const text = await readFresh(io, relPath);
  if (text === undefined) return undefined;
  const lines = text.split(/\r?\n/);
  const reason = `explicitly mentioned as ${mention}`;
  let ranges: LineRange[];
  let footer: string | undefined;
  if (lines.length <= WHOLE_FILE_MAX_LINES) {
    ranges = [{ start: 1, end: Math.max(1, lines.length) }];
  } else {
    ranges = [{ start: 1, end: FILE_HEAD_LINES }];
    const ol = outline(extractSymbols(relPath, lines));
    footer = `(first ${FILE_HEAD_LINES} of ${lines.length} lines)` + (ol ? `\n${ol}` : '');
  }
  const out = renderSection(relPath, lines, ranges, [reason], undefined, footer);
  return { path: relPath, ranges, reason, text: out, tokens: estimateTokens(out) };
}

async function symbolSection(io: WorkspaceIO, file: IndexedFile, sym: IndexedSymbol, mention: string, others: number): Promise<Section | undefined> {
  const text = (await readFresh(io, file.path)) ?? file.text;
  const lines = text.split(/\r?\n/);
  // re-locate the symbol in the fresh text (the index may be a few seconds old)
  const fresh =
    extractSymbols(file.path, lines).find((s) => s.name === sym.name && s.parent === sym.parent && s.kind === sym.kind) ?? sym;
  const start = fresh.startLine;
  const end = Math.min(fresh.endLine, start + SYMBOL_MAX_LINES - 1, lines.length);
  const reason = `explicitly mentioned as ${mention}`;
  const notes: string[] = [];
  if (fresh.endLine > end) notes.push(`(definition continues to line ${fresh.endLine})`);
  if (others > 0) notes.push(`(${others} other definition${others > 1 ? 's' : ''} with this name; use find_symbol to list them)`);
  const ranges = [{ start, end }];
  const out = renderSection(file.path, lines, ranges, [reason], [qualifiedName(fresh)], notes.join(' ') || undefined);
  return { path: file.path, ranges, reason, text: out, tokens: estimateTokens(out) };
}

export async function resolveMentionsIn(
  snap: IndexSnapshot,
  io: WorkspaceIO,
  text: string,
): Promise<{ explicitBlock: string; files: ContextFilePick[]; unresolved: string[] }> {
  const sections: Section[] = [];
  const unresolved: string[] = [];
  for (const m of parseMentions(text)) {
    let section: Section | undefined;
    const tryFile = m.type === 'file' || (m.type === 'auto' && /[/.]/.test(m.value));
    if (tryFile) {
      const p = resolvePath(snap, m.value);
      if (p) section = await fileSection(io, p, m.raw);
    }
    const trySymbol = !section && m.type !== 'file' && /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(m.value);
    if (trySymbol) {
      const last = m.value.split('.').pop()!.toLowerCase();
      const hits = lookupSymbols(snap, m.value).filter((h) => h.sym.name.toLowerCase() === last);
      const defs = hits.filter((h) => DEF_KINDS.has(h.sym.kind));
      const best = (defs.length ? defs : hits)[0];
      if (best) section = await symbolSection(io, best.file, best.sym, m.raw, (defs.length ? defs : hits).length - 1);
    }
    if (section) sections.push(section);
    else unresolved.push(m.raw);
  }

  // one pick per path, merging ranges/reasons when a file is mentioned more than once
  const picks = new Map<string, ContextFilePick>();
  for (const s of sections) {
    const p = picks.get(s.path);
    if (p) {
      p.ranges.push(...s.ranges);
      p.reasons.push(s.reason.replace('explicitly mentioned as', 'mentioned as'));
      p.tokens += s.tokens;
    } else {
      picks.set(s.path, {
        path: s.path, score: 1, reasons: [s.reason.replace('explicitly mentioned as', 'mentioned as')],
        ranges: [...s.ranges], tokens: s.tokens, source: 'explicit',
      });
    }
  }
  for (const p of picks.values()) p.ranges.sort((a, b) => a.start - b.start);
  return { explicitBlock: sections.map((s) => s.text).join('\n\n'), files: [...picks.values()], unresolved };
}
