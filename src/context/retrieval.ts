/**
 * Context retrieval (PURE: no vscode), the B1 core.
 *
 * Strategy (stated at the top of every pick): tokenize the request (identifiers split, light
 * stemming, stopwords dropped; quoted strings, --flags, dotted names and adjacent word pairs kept
 * as phrases), score every indexed file with explainable signals (symbol names, path, BM25 over
 * content, string literals, phrases, CLI command definitions), add pairing boosts (tests of the
 * chosen sources; docs that mention them when docs are requested), then greedily pack the best
 * line windows of the top files into the token budget. Every signal yields a readable reason.
 */
import type { ContextEngine, ContextFilePick, ContextPick, SearchHit, SymbolHit, WorkspaceIO } from '../contracts';
import { estimateTokens } from '../events';
import { normalizePath } from '../review/hunks';
import {
  fileRank, lineTokens, splitIdentifier, stem, WorkspaceIndex,
  type FileKind, type IndexedFile, type IndexedSymbol, type IndexSnapshot,
} from './indexer';
import { lookupSymbols, qualifiedName, renderSection, resolveMentionsIn, toSymbolHit, type LineRange } from './mentions';

// ---------------------------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    'a about above after again against all also alongside always am an and any are as at be because been before being ' +
    'below between both but by can cannot could did do does doing done down during each either else etc even ever every ' +
    'few for from further had has have having he her here him his how however i if in into is it its itself just let ' +
    'like many may me might more most must my no nor not now of on once one ones only or other others our out over own ' +
    'please same say says she should so some such than that the their them then there these they this those though ' +
    'through to too under until up upon us very via was we well were what when where whether which while who whom ' +
    'whose why will with within without would yes yet you your ' +
    // instruction verbs that describe the task, not the code
    'add adds added adding new create creates created creating update updates updated updating change changes changed ' +
    'changing modify modifies modified implement implements implemented implementing ensure ensures make makes made ' +
    'sure want wants appear appears covered cover existing exists exist able instead thing things something anything ' +
    'everything way need needs needed correctly properly py js ts'
  ).split(/\s+/),
);
/** Words that set an intent but are too generic to score files by. */
const INTENT_WORDS = new Set([
  'test', 'tests', 'tested', 'testing', 'doc', 'docs', 'documentation', 'documented', 'document', 'documenting',
  'docstring', 'docstrings',
]);

export interface QueryTerm {
  stem: string;
  /** The word as typed (first occurrence), used in reasons. */
  display: string;
  weight: number;
}

export interface QueryIntents {
  tests: boolean;
  docs: boolean;
  cli: boolean;
  docstring: boolean;
  examples: boolean;
  changelog: boolean;
}

export interface ParsedQuery {
  terms: QueryTerm[];
  /** Lowercased compound identifiers typed in the request (get_debug_flag, flaskgroup). */
  identifiers: string[];
  /** Lowercased phrases matched as substrings (quoted text, --flags, dotted names, word pairs). */
  phrases: Array<{ text: string; weight: number }>;
  /**
   * Lowercased candidates for string-literal matches in code: quoted text from the request, and
   * plain words (which only count as much as they are distinctive, see scoreFile).
   */
  literals: Array<{ text: string; weight: number; quoted: boolean }>;
  intents: QueryIntents;
}

/** Shortest inflection of a word with the same stem, for readable reasons ("loaded" -> "load"). */
function baseForm(word: string, s: string): string {
  const forms = [word.replace(/ly$/, ''), word.replace(/s$/, ''), word.replace(/ed$/, ''), word.replace(/ing$/, '')];
  return forms.filter((f) => f.length >= 3 && stem(f) === s).sort((a, b) => a.length - b.length)[0] ?? word;
}

export function parseQuery(query: string): ParsedQuery {
  const lower = query.toLowerCase();
  const intents: QueryIntents = {
    tests: /\b(tests?|tested|testing|pytest|unit ?tests?|covered by)\b/.test(lower),
    docs: /\b(docs?|documentation|documented|documenting|document|readme)\b/.test(lower),
    cli: /\b(cli|commands?|command-line|subcommands?|argparse|click)\b|(^|[\s("'`])--[a-z][\w-]*/.test(lower),
    docstring: /\bdocstrings?\b/.test(lower),
    examples: /\b(examples?|tutorial|samples?)\b/.test(lower),
    changelog: /\b(changelog|changes\.rst|release notes?)\b/.test(lower),
  };
  const terms = new Map<string, QueryTerm>();
  const phrases = new Map<string, number>();
  const literals = new Map<string, number>();
  const wordLiterals = new Map<string, number>();
  const identifiers = new Set<string>();
  const bump = <K>(m: Map<K, number>, k: K, w: number) => m.set(k, Math.max(m.get(k) ?? 0, w));

  const addWord = (word: string, weight: number) => {
    const lw = word.toLowerCase();
    if (lw.length < 2 || STOPWORDS.has(lw) || INTENT_WORDS.has(lw) || /^\d+$/.test(lw)) return false;
    const s = stem(lw);
    const t = terms.get(s);
    if (t) {
      // repeated mentions raise the weight a little
      const w = Math.max(t.weight, weight);
      t.weight = Math.min(w + 0.25, w * 1.75);
    } else terms.set(s, { stem: s, display: baseForm(lw, s), weight });
    if (lw.length >= 3) bump(wordLiterals, lw, 0.7);
    return true;
  };

  // quoted strings: literal and phrase candidates, their words count as terms
  for (const m of query.matchAll(/(?<![\w])(["'`])([^"'`\n]{1,80}?)\1(?![\w])/g)) {
    const inner = m[2].trim().toLowerCase();
    if (!inner) continue;
    bump(literals, inner, 2);
    // a single quoted word is already a term (and often a value the change introduces)
    if (inner.length >= 2 && /[a-z0-9]/.test(inner) && !/^[\w-]+$/.test(inner)) bump(phrases, inner, 1.5);
  }
  // --flags
  for (const m of query.matchAll(/(?<![\w-])--[A-Za-z][\w-]*/g)) bump(phrases, m[0].toLowerCase(), 1.5);
  // dotted names and paths: app.config, flask.cli, src/flask/cli.py
  for (const m of query.matchAll(/[A-Za-z_][\w-]*(?:[./][A-Za-z_][\w-]*)+/g)) {
    const segs = m[0].split(/[./]/);
    if (segs.some((s) => s.length > 1)) bump(phrases, m[0].toLowerCase(), 1.5);
  }
  // hyphenated words: built-in, case-insensitive
  for (const m of query.matchAll(/\b[A-Za-z]+(?:-[A-Za-z]+)+\b/g)) {
    if (!/^-/.test(m[0])) bump(phrases, m[0].toLowerCase(), 0.8);
  }

  // words, identifiers and adjacent pairs
  let prev: string | undefined;
  for (const m of query.matchAll(/--?[A-Za-z][\w-]*|[A-Za-z_][A-Za-z0-9_]*|[^\sA-Za-z_]+|\s+/g)) {
    const tok = m[0];
    if (/^\s+$/.test(tok)) continue;
    if (!/^[A-Za-z_-]/.test(tok)) {
      if (!/^[-./]+$/.test(tok)) prev = undefined; // punctuation breaks word pairs
      continue;
    }
    const word = tok.replace(/^-+/, '');
    const parts = splitIdentifier(word);
    const codeish = /_/.test(word) || /[a-z][A-Z]/.test(word) || (/^[A-Z0-9]{2,}$/.test(word) && /[A-Z]/.test(word));
    if (codeish && parts.length > 1) identifiers.add(word.toLowerCase());
    let content = false;
    // words from --flags count less: `--help` is about the flag, not every help= argument
    for (const p of parts) content = addWord(p, tok.startsWith('-') ? 0.7 : codeish ? 1.4 : 1) || content;
    const lw = word.toLowerCase();
    if (content && parts.length === 1 && !tok.startsWith('-')) {
      if (prev) bump(phrases, `${prev} ${lw}`, 0.6);
      prev = lw;
    } else prev = undefined;
  }
  return {
    terms: [...terms.values()],
    identifiers: [...identifiers],
    phrases: [...phrases].map(([text, weight]) => ({ text, weight })),
    literals: [
      ...[...literals].map(([text, weight]) => ({ text, weight, quoted: true })),
      ...[...wordLiterals].filter(([t]) => !literals.has(t)).map(([text, weight]) => ({ text, weight, quoted: false })),
    ],
    intents,
  };
}

// ---------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------

const W = { symbol: 2.2, symbolExact: 7, path: 2.5, content: 1, literal: 2.2, phrase: 1.6, cli: 2.5, named: 12 };
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Files scoring below this fraction of the best file are reported as low relevance. */
const MIN_REL_SCORE = 0.55;

interface Signal {
  kind: 'symbol' | 'path' | 'content' | 'literal' | 'phrase' | 'cli' | 'named' | 'tests' | 'docs';
  score: number;
  reason: string;
}

interface Candidate {
  file: IndexedFile;
  score: number;
  /** Score before pairing boosts. */
  base: number;
  signals: Signal[];
  /** Matched symbols with their match strength. */
  symbols: Map<IndexedSymbol, number>;
  /** Lines holding matched string literals -> window bonus. */
  literalLines: Map<number, number>;
  /** Extra token weights for window selection (from pairing). */
  extra: Map<string, number>;
  /** Test file paired by name with a chosen source (its imports/fixtures are worth showing). */
  testOf?: string;
}

interface ScoringContext {
  snap: IndexSnapshot;
  q: ParsedQuery;
  idf: (token: string) => number;
  literalIdf: (lit: string) => number;
  phraseIdf: Map<string, number>;
}

const lowerCache = new WeakMap<IndexedFile, string>();
function lowerText(f: IndexedFile): string {
  let t = lowerCache.get(f);
  if (t === undefined) {
    t = f.text.toLowerCase();
    lowerCache.set(f, t);
  }
  return t;
}

const phraseReCache = new Map<string, RegExp>();
/** Whole-word matcher for a lowercased phrase ('off' must not match 'offset'). */
function phraseRe(phrase: string): RegExp {
  let re = phraseReCache.get(phrase);
  if (!re) {
    const body = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`${/^\w/.test(phrase) ? '(?<![\\w])' : '(?<![\\w-])'}${body}${/\w$/.test(phrase) ? '(?![\\w])' : ''}`, 'g');
    if (phraseReCache.size > 500) phraseReCache.clear();
    phraseReCache.set(phrase, re);
  }
  return re;
}

/** Whole-word occurrences of a lowercased phrase in lowercased text. */
function countPhrase(hay: string, phrase: string, cap = 50): number {
  if (!hay.includes(phrase)) return 0;
  const re = phraseRe(phrase);
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(hay) && n < cap) n++;
  return n;
}

function displayName(sym: IndexedSymbol): string {
  if (sym.kind === 'heading') return `"${sym.name}"`;
  const q = qualifiedName(sym);
  return sym.kind === 'function' || sym.kind === 'method' ? `${q}()` : q;
}

/**
 * Innermost symbol containing a line (code: defs; docs: sections). With `api`, nested helper
 * functions are skipped so the answer is a top-level function, class or method.
 */
function enclosingSymbol(f: IndexedFile, line: number, api = false): IndexedSymbol | undefined {
  let best: IndexedSymbol | undefined;
  for (const s of f.symbols) {
    if (s.kind === 'variable' && f.lang !== 'python') continue;
    if (s.kind === 'other') continue;
    if (api && s.kind === 'function' && s.parent) continue;
    if (s.startLine <= line && line <= s.endLine) {
      if (!best || s.endLine - s.startLine <= best.endLine - best.startLine) best = s;
    }
  }
  return best;
}

function kindPrior(f: IndexedFile, intents: QueryIntents): number {
  const base: Record<FileKind, number> = { source: 1, test: 0.6, docs: 0.4, example: 0.35, config: 0.5, other: 0.4 };
  let p = base[f.kind];
  if (f.kind === 'test' && intents.tests) p = 0.85;
  if (f.kind === 'docs' && intents.docs) p = 0.75;
  if (f.kind === 'docs' && intents.docstring && !intents.docs) p *= 0.7;
  if (f.kind === 'example' && intents.examples) p = 1;
  if (f.isChangelog && !intents.changelog) p *= 0.3;
  if (f.hidden) p *= 0.5;
  return p;
}

function scoreFile(f: IndexedFile, ctx: ScoringContext): Candidate | undefined {
  const { q, idf } = ctx;
  const signals: Signal[] = [];
  const symbols = new Map<IndexedSymbol, number>();
  const literalLines = new Map<number, number>();

  // 1. symbol names (strong)
  let symScore = 0;
  for (const t of q.terms) {
    let count = 0;
    const w = idf(t.stem) * t.weight;
    for (const s of f.symbols) {
      if (!s.parts.includes(t.stem)) continue;
      // nested helper functions (parent is a function) say less about the file than its API
      const kw = s.kind === 'heading' ? 0.6 : s.kind === 'other' ? 0.4 : s.kind === 'function' && s.parent ? 0.4 : 1;
      count += kw;
      symbols.set(s, (symbols.get(s) ?? 0) + w * kw);
    }
    if (count > 0) symScore += w * W.symbol * Math.min(1 + Math.log(Math.max(1, count)), 2.5);
  }
  for (const id of q.identifiers) {
    for (const s of f.symbols) {
      if (s.name.toLowerCase() !== id) continue;
      symScore += W.symbolExact * idf(id) * (s.kind === 'heading' || s.kind === 'other' ? 0.4 : 1);
      symbols.set(s, (symbols.get(s) ?? 0) + 100);
    }
  }
  if (symScore > 0) {
    const top = [...symbols]
      .sort((a, b) => b[1] - a[1] || Number(b[0].topLevel) - Number(a[0].topLevel) || a[0].line - b[0].line)
      .slice(0, 3)
      .map(([s]) => displayName(s));
    const defs = [...symbols.keys()].some((s) => s.kind !== 'heading');
    signals.push({ kind: 'symbol', score: symScore, reason: `${defs ? 'defines' : 'sections'} ${top.join(', ')}` });
  }

  // 2. path
  let pathScore = 0;
  const pathHits: string[] = [];
  for (const t of q.terms) {
    if (!f.pathTerms.has(t.stem)) continue;
    pathScore += idf(t.stem) * t.weight * W.path * (f.baseTerms.has(t.stem) ? 1.5 : 1);
    pathHits.push(`"${t.display}"`);
  }
  if (pathScore > 0) signals.push({ kind: 'path', score: pathScore, reason: `path matches ${pathHits.slice(0, 3).join(', ')}` });
  const lp = f.path.toLowerCase();
  const named = q.phrases.find(
    (p) => (p.text.includes('.') || p.text.includes('/')) && (lp === p.text || lp.endsWith('/' + p.text) || p.text === f.moduleId?.toLowerCase()),
  );
  if (named) signals.push({ kind: 'named', score: W.named * 3, reason: `named in the request ("${named.text}")` });

  // 3. BM25 over content
  const norm = BM25_K1 * (1 - BM25_B + (BM25_B * f.length) / ctx.snap.avgLength);
  const contrib: Array<{ label: string; tf: number; s: number }> = [];
  for (const t of q.terms) {
    const tf = f.tf.get(t.stem);
    if (!tf) continue;
    contrib.push({ label: t.display, tf, s: (idf(t.stem) * t.weight * W.content * tf * (BM25_K1 + 1)) / (tf + norm) });
  }
  for (const id of q.identifiers) {
    const tf = f.tf.get(id);
    if (!tf) continue;
    contrib.push({ label: id, tf, s: (idf(id) * 1.5 * tf * (BM25_K1 + 1)) / (tf + norm) });
  }
  if (contrib.length) {
    contrib.sort((a, b) => b.s - a.s);
    const s = contrib.reduce((acc, c) => acc + c.s, 0);
    const labels = contrib.slice(0, 3).map((c) => `"${c.label}" ×${c.tf}`);
    signals.push({ kind: 'content', score: s, reason: `mentions ${labels.join(', ')}` });
  }

  // 4. string literals in code ("false", "off")
  let litScore = 0;
  const litHits: Array<{ text: string; line: number; s: number }> = [];
  for (const lit of q.literals) {
    const lines = f.literals.get(lit.text);
    if (!lines) continue;
    // plain words count only as much as they are distinctive in the code ("false" yes, "value" no)
    const wordWeight = () => (q.terms.find((t) => t.stem === stem(lit.text))?.weight ?? 1) * Math.min(1, idf(stem(lit.text)) / 3);
    const w = lit.quoted ? lit.weight : wordWeight();
    const ls = ctx.literalIdf(lit.text) * w * W.literal * (1 + Math.log(Math.min(lines.length, 5)));
    litScore += ls;
    for (const l of lines) literalLines.set(l, Math.max(literalLines.get(l) ?? 0, 2 + 3 * w));
    litHits.push({ text: lit.text, line: lines[0], s: ls });
  }
  if (litScore > 0) {
    litHits.sort((a, b) => b.s - a.s);
    const where = enclosingSymbol(f, litHits[0].line);
    const shown = litHits.slice(0, 3).map((h) => `"${h.text}"`).join(', ');
    signals.push({
      kind: 'literal', score: litScore,
      reason: `string literal ${shown} ${where && where.kind !== 'heading' ? `in ${displayName(where)}` : `at line ${litHits[0].line}`}`,
    });
  }

  // 5. phrases (--help, quoted text, dotted names, word pairs)
  let phraseScore = 0;
  const phraseHits: string[] = [];
  const lt = lowerText(f);
  for (const p of q.phrases) {
    const idfP = ctx.phraseIdf.get(p.text) ?? 0;
    if (!idfP) continue;
    const n = countPhrase(lt, p.text);
    if (!n) continue;
    phraseScore += W.phrase * p.weight * idfP * (1 + Math.log(n));
    phraseHits.push(`"${p.text}"${n > 1 ? ` ×${n}` : ''}`);
  }
  if (phraseScore > 0) signals.push({ kind: 'phrase', score: phraseScore, reason: `contains ${phraseHits.slice(0, 3).join(', ')}` });

  // 6. CLI command definitions when the request is about a CLI; a command named in the request
  // ("flask routes") counts like a symbol match
  if (q.intents.cli && f.cliLines.length && (f.kind === 'source' || f.kind === 'example')) {
    const named = f.cliNames.filter((n) => q.terms.some((t) => t.stem === stem(n)));
    const namedScore = named.reduce((a, n) => a + W.symbolExact * 0.6 * idf(stem(n)), 0);
    const names = (named.length ? named : f.cliNames).slice(0, 4).map((n) => `"${n}"`).join(', ');
    signals.push({
      kind: 'cli', score: W.cli * (1 + Math.log(f.cliLines.length)) + namedScore,
      reason: named.length
        ? `defines the CLI command${named.length > 1 ? 's' : ''} ${names}`
        : names ? `defines CLI commands ${names}` : `registers CLI commands (${f.cliLines.length} sites)`,
    });
  }

  if (!signals.length) return undefined;
  const raw = signals.reduce((a, s) => a + s.score, 0);
  const prior = kindPrior(f, q.intents);
  for (const s of signals) s.score *= prior;
  return { file: f, score: raw * prior, base: raw * prior, signals, symbols, literalLines, extra: new Map() };
}

/**
 * Add a pairing signal (strongest per kind wins). The boost may lift the file up to `cap`
 * (just below its source) but never pushes it past the source on the pairing alone.
 */
function addPairing(c: Candidate, sig: Signal, cap: number): void {
  const boost = Math.max(0, Math.min(sig.score, cap - c.base));
  const existing = c.signals.find((s) => s.kind === sig.kind);
  if (existing) {
    if (existing.score >= boost) return;
    c.signals.splice(c.signals.indexOf(existing), 1);
  }
  c.signals.push({ ...sig, score: boost });
  c.score = c.base + c.signals.filter((s) => s.kind === 'tests' || s.kind === 'docs').reduce((a, s) => a + s.score, 0);
}

function topSymbolNames(c: Candidate, max: number): string[] {
  return [...c.symbols]
    .filter(([s]) => s.kind !== 'heading' && s.kind !== 'other' && s.name.length > 3 && !s.name.startsWith('__'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([s]) => s.name);
}

/**
 * Names a chosen source hands to its tests/docs: symbols defined in its best windows, then its
 * strongest symbol matches; plus its CLI command names.
 */
function pairingNames(src: Candidate, ctx: ScoringContext): { symbols: string[]; cli: string[] } {
  const windows = computeWindows(src, ctx).slice(0, 3);
  const inWindows = src.file.symbols
    .filter((s) => (s.kind === 'class' || s.kind === 'function' || s.kind === 'method') && !(s.kind === 'function' && s.parent))
    .filter((s) => s.name.length > 3 && !s.name.startsWith('__') && windows.some((w) => s.line >= w.start && s.line <= w.end))
    .map((s) => s.name);
  const symbols = [...new Set(inWindows.length ? inWindows : topSymbolNames(src, 3))].slice(0, 8);
  return { symbols, cli: src.file.cliNames.filter((n) => n.length >= 4) };
}

function applyPairing(cands: Map<string, Candidate>, ctx: ScoringContext): void {
  const { snap, q } = ctx;
  const ranked = [...cands.values()].sort((a, b) => b.score - a.score);
  if (!ranked.length) return;
  const top = ranked[0].score;
  const sources = ranked.filter((c) => c.file.kind === 'source' && c.score >= 0.3 * top).slice(0, 3);
  const ensure = (f: IndexedFile): Candidate => {
    let c = cands.get(f.path);
    if (!c) {
      c = { file: f, score: 0, base: 0, signals: [], symbols: new Map(), literalLines: new Map(), extra: new Map() };
      cands.set(f.path, c);
    }
    return c;
  };
  const setExtra = (target: Candidate, token: string, w: number) => target.extra.set(token, Math.max(target.extra.get(token) ?? 0, w));
  const names = new Map(sources.map((src) => [src, pairingNames(src, ctx)]));
  const extraFrom = (src: Candidate, target: Candidate) => {
    const n = names.get(src)!;
    for (const name of [...n.symbols, ...n.cli]) {
      setExtra(target, name.toLowerCase(), 2);
      for (const p of splitIdentifier(name)) if (p.length > 2 && p !== 'test') setExtra(target, stem(p), 1);
    }
  };

  // (a) tests for selected sources: tests/test_<module>.py or test files importing the module
  for (const src of sources) {
    const base = src.file.path.slice(src.file.path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
    const mod = base.replace(/^_+/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!mod || base === '__init__' || base === 'index') continue;
    const byNameRe = new RegExp(`^(test_${mod}s?\\.py|${mod}_test\\.py|${mod}\\.(test|spec)\\.[cm]?[jt]sx?)$`);
    for (const f of snap.files) {
      if (f.kind !== 'test') continue;
      const b = f.path.slice(f.path.lastIndexOf('/') + 1);
      const byName = byNameRe.test(b);
      const byImport = !!src.file.moduleId && f.imports.includes(src.file.moduleId);
      if (!byName && !byImport) continue;
      const c = ensure(f);
      const boost = src.score * (q.intents.tests ? 0.6 : 0.5) * (byName ? 1 : 0.5);
      addPairing(c, { kind: 'tests', score: boost, reason: `tests for ${src.file.path}` }, src.score * (byName ? 0.9 : 0.6));
      if (byName) c.testOf ??= src.file.path;
      extraFrom(src, c);
    }
  }

  // (b) when docs are requested: docs that mention the chosen sources' symbols / CLI commands,
  // or that are named like the source (docs/cli.rst for src/flask/cli.py)
  if (q.intents.docs) {
    const docs = snap.files.filter((f) => f.kind === 'docs' && !f.isChangelog);
    for (const src of sources.slice(0, 2)) {
      const n = names.get(src)!;
      const mention = new Map<string, number>();
      for (const s of n.symbols) mention.set(s.toLowerCase(), 1.5);
      for (const c of n.cli) if (!mention.has(c.toLowerCase())) mention.set(c.toLowerCase(), 1);
      const counts = new Map<string, Map<IndexedFile, number>>();
      for (const term of mention.keys()) {
        const per = new Map<IndexedFile, number>();
        for (const f of docs) {
          const k = countPhrase(lowerText(f), term);
          if (k) per.set(f, k);
        }
        counts.set(term, per);
      }
      const srcBase = [...src.file.baseTerms];
      for (const f of docs) {
        let ms = 0;
        const hits: Array<{ term: string; n: number; w: number }> = [];
        for (const [term, w] of mention) {
          const per = counts.get(term)!;
          const k = per.get(f);
          if (!k) continue;
          // rarer mentions across the docs say more
          ms += w * Math.log(1 + docs.length / (per.size + 0.5)) * Math.log(1 + k);
          hits.push({ term, n: k, w });
        }
        const sameStem = srcBase.length > 0 && srcBase.every((t) => f.baseTerms.has(t));
        if (!hits.length && !sameStem) continue;
        const boost = src.score * (Math.min(0.45, 0.04 * ms) + (sameStem ? 0.35 : 0));
        if (boost < 0.05 * top) continue;
        hits.sort((a, b) => b.w - a.w || b.n - a.n);
        const shown = hits.slice(0, 2).map((h) => `"${h.term}"`).join(', ');
        const reason = shown ? `docs mention ${shown}${sameStem ? ` (docs for ${src.file.path})` : ''}` : `docs for ${src.file.path}`;
        const c = ensure(f);
        addPairing(c, { kind: 'docs', score: boost, reason }, src.score * 0.85);
        extraFrom(src, c);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Windows and packing
// ---------------------------------------------------------------------------------------------

interface Window {
  start: number;
  end: number;
  value: number;
  focus: number;
  label?: string;
}

/** Window geometry for code vs. prose (docs windows stay tighter: prose matches everywhere). */
const GEOMETRY = {
  code: { before: 12, after: 20, snapMax: 70, symbolMax: 60, mergeMax: 100 },
  docs: { before: 6, after: 16, snapMax: 40, symbolMax: 30, mergeMax: 50 },
};
const CLI_EXAMPLE_BONUS = 15;
const HEADER_LABEL = 'imports and fixtures';
/** Max share of the budget per file, by rank. */
const FILE_SHARES = [0.45, 0.3, 0.22, 0.18, 0.15, 0.15, 0.12, 0.12];
/** Extra windows must be at least this relevant relative to the file's best window. */
const EXTRA_WINDOW_MIN = 0.3;

interface LineInfo {
  /** Per-line score (used to find focus lines). */
  score: number[];
  /** Per-line matched tokens with their weights. */
  terms: Array<Array<[string, number]>>;
  /** Per-line additive bonus (phrases, literals, CLI definitions). */
  bonus: number[];
}

function lineScores(c: Candidate, ctx: ScoringContext): LineInfo {
  const { q } = ctx;
  const weights = new Map<string, number>();
  for (const t of q.terms) weights.set(t.stem, ctx.idf(t.stem) * t.weight);
  for (const id of q.identifiers) weights.set(id, Math.max(weights.get(id) ?? 0, ctx.idf(id) * 2));
  for (const [tok, w] of c.extra) weights.set(tok, Math.max(weights.get(tok) ?? 0, w * Math.max(1, ctx.idf(tok))));
  const cli = q.intents.cli ? new Set(c.file.cliLines) : undefined;
  const info: LineInfo = { score: [], terms: [], bonus: [] };
  c.file.lines.forEach((line, i) => {
    const matched: Array<[string, number]> = [];
    let bonus = 0;
    if (line.trim()) {
      // comments/docstrings count less than code when choosing windows
      const prose = c.file.prose?.[i] ? 0.6 : 1;
      for (const tok of lineTokens(line, c.file.lang)) {
        const w = weights.get(tok);
        if (w) matched.push([tok, w * prose]);
      }
      const ll = line.toLowerCase();
      for (const p of q.phrases) {
        if (!ctx.phraseIdf.get(p.text) || !ll.includes(p.text)) continue;
        const re = phraseRe(p.text);
        re.lastIndex = 0;
        if (re.test(ll)) bonus += p.weight * 1.5 * prose;
      }
      bonus += c.literalLines.get(i + 1) ?? 0;
      if (cli?.has(i + 1)) bonus += 2;
    }
    info.terms.push(matched);
    info.bonus.push(bonus);
    info.score.push(matched.reduce((a, [, w]) => a + w, 0) + bonus);
  });
  return info;
}

/**
 * Window value: each distinct matched term counts with saturation (1 + ln n), so a window that
 * repeats one generic word does not beat one that holds the distinctive match; bonuses add up.
 */
function windowValue(info: LineInfo, start: number, end: number): { value: number; focus: number } {
  const perTerm = new Map<string, { w: number; n: number }>();
  let bonus = 0;
  let focus = start;
  for (let l = start; l <= end; l++) {
    for (const [tok, w] of info.terms[l - 1] ?? []) {
      const e = perTerm.get(tok);
      if (e) {
        e.n++;
        e.w = Math.max(e.w, w);
      } else perTerm.set(tok, { w, n: 1 });
    }
    bonus += info.bonus[l - 1] ?? 0;
    if ((info.score[l - 1] ?? 0) > (info.score[focus - 1] ?? 0)) focus = l;
  }
  let value = bonus;
  for (const { w, n } of perTerm.values()) value += w * (1 + Math.log(n));
  // mild preference for compact windows
  return { value: value / Math.sqrt(Math.max(1, (end - start + 1) / 40)), focus };
}

function computeWindows(c: Candidate, ctx: ScoringContext): Window[] {
  const f = c.file;
  const scores = lineScores(c, ctx);
  const seeds: Window[] = [];
  const clamp = (n: number) => Math.min(Math.max(1, n), f.lineCount);
  const span = (s: IndexedSymbol) => s.endLine - s.startLine + 1;
  const geo = f.lang === 'markdown' || f.lang === 'rst' || f.lang === 'text' ? GEOMETRY.docs : GEOMETRY.code;

  // matched symbol definitions (their bodies)
  const matched = [...c.symbols]
    .filter(([s]) => s.kind !== 'other' && !(s.kind === 'class' && span(s) > geo.snapMax))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  for (const [s, strength] of matched) {
    const start = s.startLine;
    const end = Math.min(s.endLine, start + geo.symbolMax - 1);
    const v = windowValue(scores, start, end);
    seeds.push({ start, end, value: v.value + Math.min(strength, 10), focus: v.focus, label: qualifiedName(s) });
  }

  // CLI requests: complete, compact command definitions (decorators through body) are the best
  // examples to copy from
  if (ctx.q.intents.cli && f.cliLines.length) {
    for (const s of f.symbols) {
      if (s.kind !== 'function' && s.kind !== 'method') continue;
      if (span(s) > geo.snapMax || !f.cliLines.some((l) => l >= s.startLine && l <= s.line)) continue;
      const v = windowValue(scores, s.startLine, s.endLine);
      seeds.push({ start: s.startLine, end: s.endLine, value: v.value + CLI_EXAMPLE_BONUS, focus: v.focus, label: qualifiedName(s) });
    }
  }

  // best-scoring lines, snapped to their enclosing function/section when it is small
  const order = scores.score.map((s, i) => ({ s, line: i + 1 })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const maxS = order[0]?.s ?? 0;
  const taken: number[] = [];
  for (const { s, line } of order) {
    if (s < 0.25 * maxS || taken.length >= 10) break;
    if (taken.some((t) => Math.abs(t - line) <= 4)) continue;
    taken.push(line);
    const enc = enclosingSymbol(f, line);
    let start: number;
    let end: number;
    if (enc && span(enc) <= geo.snapMax) {
      start = enc.startLine;
      end = enc.endLine;
    } else {
      start = clamp(line - geo.before);
      end = clamp(line + geo.after);
      if (enc) {
        start = Math.max(start, enc.startLine);
        end = Math.min(end, enc.endLine);
      }
    }
    const v = windowValue(scores, start, end);
    seeds.push({ start, end, value: v.value, focus: v.focus, label: enc ? qualifiedName(enc) : undefined });
  }

  // test file paired by name with a chosen source: imports and fixtures are needed to write a
  // new test, so when tests are requested the header leads
  if (c.testOf) {
    const defs = f.symbols.filter((s) => s.topLevel && s.kind !== 'variable');
    const header = defs.filter((s) => s.endLine <= 45).pop();
    const end = Math.min(f.lineCount, Math.max(header?.endLine ?? 0, 12), 45);
    const v = windowValue(scores, 1, end);
    seeds.push({ start: 1, end, value: v.value + 5, focus: v.focus, label: HEADER_LABEL });
  }

  // merge overlapping / adjacent windows
  seeds.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Window[] = [];
  for (const w of seeds) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end + 2 && Math.max(last.end, w.end) - last.start + 1 <= geo.mergeMax) {
      const end = Math.max(last.end, w.end);
      const v = windowValue(scores, last.start, end);
      const bonus = Math.max(last.value - windowValue(scores, last.start, last.end).value, w.value - windowValue(scores, w.start, w.end).value, 0);
      if (!(last.start <= w.start && w.end <= last.end)) last.label = last.label === w.label ? last.label : undefined;
      last.end = end;
      last.value = v.value + bonus;
      last.focus = v.focus;
    } else if (!last || w.start > last.end || w.end > last.end) {
      // partial overlap that is too long to merge: keep only the non-overlapping tail
      const start = last && w.start <= last.end ? last.end + 1 : w.start;
      if (start > w.end) continue;
      const v = windowValue(scores, start, w.end);
      merged.push({ ...w, start, value: start === w.start ? w.value : v.value, focus: start === w.start ? w.focus : v.focus });
    }
  }
  for (const w of merged) {
    if (!w.label) {
      const enc = enclosingSymbol(f, w.focus);
      if (enc && enc.startLine <= w.start + 3) w.label = qualifiedName(enc);
    }
  }
  // matched only by name/path: show the start of the file
  if (!merged.length && f.lineCount > 0) merged.push({ start: 1, end: Math.min(f.lineCount, 40), value: 0, focus: 1, label: 'file start' });
  if (c.testOf && ctx.q.intents.tests && merged.length && merged[0].start === 1) {
    merged[0].value = Math.max(...merged.map((w) => w.value)) + 1;
  }
  return merged.sort((a, b) => b.value - a.value);
}

function shrinkAround(w: Window, lines: number): Window {
  if (w.end - w.start + 1 <= lines) return w;
  let start = Math.max(w.start, w.focus - Math.floor(lines / 3));
  let end = start + lines - 1;
  if (end > w.end) {
    end = w.end;
    start = end - lines + 1;
  }
  return { ...w, start, end };
}

interface Packed {
  cand: Candidate;
  rank: number;
  /** Value of the file's best window (relevance yardstick for extra windows). */
  best: number;
  windows: Window[];
  reasons: string[];
  section: string;
  tokens: number;
}

function mergeRanges(windows: Window[]): Array<LineRange & { label?: string }> {
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const out: Array<LineRange & { label?: string }> = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.start <= last.end + 1) {
      if (w.end > last.end) {
        last.end = w.end;
        if (last.label !== w.label) last.label = undefined;
      }
    } else out.push({ start: w.start, end: w.end, label: w.label });
  }
  return out;
}

/** Label for a range: the definitions/sections it contains, else the one it sits in. */
function rangeLabel(f: IndexedFile, r: LineRange, fallback?: string): string | undefined {
  if (fallback === HEADER_LABEL) return fallback;
  const docs = f.lang === 'markdown' || f.lang === 'rst';
  const inRange = f.symbols.filter((s) => s.line >= r.start && s.line <= r.end);
  const classes = new Set(inRange.filter((s) => s.kind === 'class').map((s) => s.name));
  const inside = inRange.filter((s) =>
    docs
      ? s.kind === 'heading'
      : s.kind === 'class' || (s.kind === 'method' && !classes.has(s.parent ?? '')) || (s.kind === 'function' && !s.parent),
  );
  if (inside.length) {
    const names = inside.slice(0, 3).map((s) => qualifiedName(s));
    return names.join(', ') + (inside.length > 3 ? ` +${inside.length - 3} more` : '');
  }
  const enc = enclosingSymbol(f, r.start, true);
  return enc ? `in ${qualifiedName(enc)}` : fallback;
}

function render(p: Pick<Packed, 'cand' | 'windows' | 'reasons'>): string {
  const ranges = mergeRanges(p.windows);
  const f = p.cand.file;
  return renderSection(f.path, f.lines, ranges, p.reasons, ranges.map((r) => rangeLabel(f, r, r.label)));
}

function reasonsFor(c: Candidate, best: Window | undefined): string[] {
  const sorted = [...c.signals].sort((a, b) => b.score - a.score);
  // pairing and CLI heuristics are always shown; the strongest other signals fill up to four
  const always = sorted.filter((s) => s.kind === 'tests' || s.kind === 'docs' || s.kind === 'cli');
  const rest = sorted.filter((s) => !always.includes(s));
  const reasons = [...always.map((s) => s.reason), ...rest.slice(0, Math.max(2, 4 - always.length)).map((s) => s.reason)];
  if (best?.label && !reasons.some((r) => r.includes(best.label!))) reasons.push(`best match in ${best.label}`);
  return reasons;
}

// ---------------------------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------------------------

export class RepoContextEngine implements ContextEngine {
  private readonly index: WorkspaceIndex;

  constructor(private readonly io: WorkspaceIO, opts?: { maxFileBytes?: number }) {
    this.index = new WorkspaceIndex(io, opts);
  }

  /** Index snapshot (exposed for diagnostics/tests). */
  snapshot(): Promise<IndexSnapshot> {
    return this.index.get();
  }

  invalidate(relPath?: string): void {
    this.index.invalidate(relPath);
  }

  /** Score and rank every indexed file for a query (pairing included). */
  private async rank(query: string): Promise<{ snap: IndexSnapshot; q: ParsedQuery; ctx: ScoringContext; ranked: Candidate[] }> {
    const snap = await this.index.get();
    const q = parseQuery(query);
    const N = Math.max(1, snap.files.length);
    const idfOf = (df: number) => Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const phraseIdf = new Map<string, number>();
    for (const p of q.phrases) {
      let df = 0;
      for (const f of snap.files) if (countPhrase(lowerText(f), p.text, 1)) df++;
      // word pairs only count when they are distinctive
      if (df > 0 && !(p.weight < 1 && df > N * 0.1)) phraseIdf.set(p.text, idfOf(df));
    }
    const ctx: ScoringContext = {
      snap, q, phraseIdf,
      idf: (t) => idfOf(snap.df.get(t) ?? 0),
      literalIdf: (l) => idfOf(snap.literalDf.get(l) ?? 0),
    };
    const cands = new Map<string, Candidate>();
    for (const f of snap.files) {
      const c = scoreFile(f, ctx);
      if (c) cands.set(f.path, c);
    }
    applyPairing(cands, ctx);
    const ranked = [...cands.values()].filter((c) => c.score > 0).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
    return { snap, q, ctx, ranked };
  }

  /** Diagnostics: per-signal scores and candidate windows of the top files. */
  async explain(query: string, top = 10): Promise<Array<{
    path: string; score: number; base: number;
    signals: Array<{ kind: string; score: number; reason: string }>;
    windows: Array<{ start: number; end: number; value: number; label?: string }>;
  }>> {
    const { ctx, ranked } = await this.rank(query);
    const max = ranked[0]?.score ?? 1;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return ranked.slice(0, top).map((c) => ({
      path: c.file.path, score: r2(c.score / max), base: r2(c.base / max),
      signals: c.signals.map((s) => ({ kind: s.kind, score: r2(s.score / max), reason: s.reason })),
      windows: computeWindows(c, ctx).slice(0, 6).map((w) => ({ start: w.start, end: w.end, value: r2(w.value), label: w.label })),
    }));
  }

  async retrieve(query: string, budgetTokens: number, opts: { excludePaths?: string[] } = {}): Promise<ContextPick> {
    const budget = Number.isFinite(budgetTokens) && budgetTokens > 0 ? Math.floor(budgetTokens) : 6000;
    const { snap, q, ctx, ranked: all } = await this.rank(query);
    const exclude = new Set(opts.excludePaths ?? []);
    const ranked = exclude.size ? all.filter((c) => !exclude.has(c.file.path)) : all;
    const topScore = ranked[0]?.score ?? 1;
    const norm = (s: number) => Math.round((s / topScore) * 100) / 100;

    const maxFiles = Math.min(8, Math.max(3, Math.round(budget / 1000)));
    const eligible = ranked.filter((c) => c.score >= MIN_REL_SCORE * topScore);
    const selected = eligible.slice(0, maxFiles);
    const overBudget: ContextPick['dropped'] = [];

    const shownTerms = [...q.terms].sort((a, b) => ctx.idf(b.stem) * b.weight - ctx.idf(a.stem) * a.weight).slice(0, 10).map((t) => t.display);
    const pairings = [
      'tests of chosen sources',
      ...(q.intents.docs ? ['docs that mention them'] : []),
      ...(q.intents.cli ? ['CLI command definitions'] : []),
    ];
    const strategy =
      `Strategy: ranked ${snap.files.length} indexed files by symbol names, paths, BM25 content match, string literals and phrases for ` +
      `[${shownTerms.join(', ')}]; boosted ${pairings.join(', ')}; packed the best line windows into the budget.`;
    const headerReserve = estimateTokens(`Context picked: 00 files, 00000/${budget} tokens\n${strategy}\n`) + 2;

    // round 1: the best window of each selected file, in rank order
    const packed: Packed[] = [];
    let used = headerReserve;
    const windowsByPath = new Map<string, Window[]>();
    selected.forEach((c, rank) => {
      const windows = computeWindows(c, ctx);
      windowsByPath.set(c.file.path, windows);
      let first = windows[0];
      if (!first) return;
      const limit = Math.min(Math.floor(budget * FILE_SHARES[Math.min(rank, FILE_SHARES.length - 1)]), budget - used);
      const reasons = reasonsFor(c, first);
      let section = render({ cand: c, windows: [first], reasons });
      while (estimateTokens(section) > limit && first.end - first.start + 1 > 8) {
        first = shrinkAround(first, Math.floor((first.end - first.start + 1) * 0.8));
        section = render({ cand: c, windows: [first], reasons });
      }
      const tokens = estimateTokens(section) + 1;
      if (tokens > budget - used) {
        overBudget.push({ path: c.file.path, score: norm(c.score), reason: `over budget (needs ~${tokens} tokens, ${Math.max(0, budget - used)} left)` });
        return;
      }
      packed.push({ cand: c, rank, windows: [first], best: first.value, reasons, section, tokens });
      used += tokens;
    });

    // round 2: further relevant windows, round-robin over the files in rank order (every file
    // gets its next-best window before any gets another), each file within its share
    const queues = packed.map((p) => (windowsByPath.get(p.cand.file.path) ?? []).slice(1).filter((w) => w.value >= EXTRA_WINDOW_MIN * p.best));
    const extra: Array<{ p: Packed; w: Window }> = [];
    for (let k = 0; queues.some((q) => k < q.length); k++) {
      packed.forEach((p, i) => {
        if (k < queues[i].length) extra.push({ p, w: queues[i][k] });
      });
    }
    for (const { p, w } of extra) {
      if (p.windows.some((x) => x.start <= w.start && w.end <= x.end)) continue;
      const windows = [...p.windows, w];
      const section = render({ cand: p.cand, windows, reasons: p.reasons });
      const tokens = estimateTokens(section) + 1;
      const share = Math.floor(budget * FILE_SHARES[Math.min(p.rank, FILE_SHARES.length - 1)]);
      if (used - p.tokens + tokens > budget || tokens > share) continue;
      used += tokens - p.tokens;
      p.windows = windows;
      p.section = section;
      p.tokens = tokens;
    }

    const dropped: ContextPick['dropped'] = [
      ...overBudget,
      ...eligible.slice(maxFiles).map((c) => ({ path: c.file.path, score: norm(c.score), reason: `over budget (file limit ${maxFiles})` })),
      ...ranked
        .filter((c) => c.score < MIN_REL_SCORE * topScore)
        .map((c) => ({ path: c.file.path, score: norm(c.score), reason: `low relevance (below ${MIN_REL_SCORE} of the best match)` })),
    ].slice(0, Math.max(6, overBudget.length));

    const files: ContextFilePick[] = packed.map((p) => ({
      path: p.cand.file.path,
      score: norm(p.cand.score),
      reasons: p.reasons,
      ranges: mergeRanges(p.windows).map(({ start, end }) => ({ start, end })),
      tokens: p.tokens,
      source: 'retrieved',
    }));
    const why = q.terms.length ? `no indexed file matched [${shownTerms.join(', ')}]` : 'the request has no searchable terms';
    const rest = packed.length
      ? `${strategy}\n\n${packed.map((p) => p.section).join('\n\n')}`
      : `No automatic context: ${why}. Use search_code / find_symbol / list_files.`;
    // the summary states the size of the whole text, itself included
    let total = used;
    let packedText = '';
    for (let i = 0; i < 4; i++) {
      packedText = `Context picked: ${packed.length} files, ${total}/${budget} tokens\n${rest}`;
      const real = estimateTokens(packedText);
      if (real === total) break;
      total = real;
    }
    return { query, budgetTokens: budget, usedTokens: estimateTokens(packedText), files, dropped, packedText };
  }

  async repoMap(maxTokens: number): Promise<string> {
    const snap = await this.index.get();
    const ordered = [...snap.files].sort((a, b) => fileRank(a) - fileRank(b) || a.path.localeCompare(b.path));
    const header = `Repository map (${snap.files.length} indexed files; top-level symbols):`;
    const lines: string[] = [header];
    let used = estimateTokens(header) + 1;
    let shown = 0;
    for (const f of ordered) {
      const syms = f.symbols.filter((s) =>
        f.kind === 'docs' ? s.kind === 'heading' && (s.level ?? 1) <= 2 : s.topLevel && (s.kind === 'class' || s.kind === 'function' || (s.kind === 'other' && f.lang === 'js')),
      );
      const all = [...new Set(syms.map((s) => (s.kind === 'function' ? `${s.name}()` : s.name)))];
      const names = all.slice(0, 10);
      if (all.length > 10) names.push(`+${all.length - 10} more`);
      const line = names.length ? `${f.path}: ${names.join(', ')}` : f.path;
      const cost = estimateTokens(line) + 1;
      const tail = `… ${ordered.length - shown} more files (use list_files)`;
      if (used + cost + (shown + 1 < ordered.length ? estimateTokens(tail) + 1 : 0) > maxTokens) {
        if (used + estimateTokens(tail) <= maxTokens) lines.push(tail);
        break;
      }
      lines.push(line);
      used += cost;
      shown++;
    }
    return lines.join('\n');
  }

  async findSymbol(name: string): Promise<SymbolHit[]> {
    const snap = await this.index.get();
    return lookupSymbols(snap, name, 30).map((h) => toSymbolHit(h.file, h.sym));
  }

  async search(query: string, opts?: { regex?: boolean; glob?: string; maxResults?: number }): Promise<SearchHit[]> {
    if (!query) return [];
    const snap = await this.index.get();
    const max = Math.max(1, opts?.maxResults ?? 50);
    let test: (line: string) => boolean;
    if (opts?.regex) {
      let re: RegExp;
      try {
        // smart case: case-insensitive unless the pattern contains an uppercase letter
        re = new RegExp(query, /[A-Z]/.test(query.replace(/\\[A-Za-z]/g, '')) ? '' : 'i');
      } catch (e) {
        throw new Error(`Invalid regular expression ${JSON.stringify(query)}: ${(e as Error).message}`);
      }
      test = (line) => re.test(line);
    } else {
      const needle = query.toLowerCase();
      test = (line) => line.toLowerCase().includes(needle);
    }
    const globRe = opts?.glob ? globToRegExp(opts.glob) : undefined;
    const files = [...snap.files]
      .filter((f) => !globRe || globRe(f.path))
      .sort((a, b) => fileRank(a) - fileRank(b) || a.path.localeCompare(b.path));
    const hits: SearchHit[] = [];
    for (const f of files) {
      for (let i = 0; i < f.lines.length; i++) {
        const line = f.lines[i];
        if (line.length > 2000 || !test(line)) continue;
        const text = line.trim();
        hits.push({ path: f.path, line: i + 1, text: text.length > 200 ? text.slice(0, 199) + '…' : text });
        if (hits.length >= max) return hits;
      }
    }
    return hits;
  }

  async listFiles(dir?: string, max = 1000): Promise<string[]> {
    const snap = await this.index.get();
    const d = normalizePath(dir ?? '').replace(/\/+$/, '');
    const all = d && d !== '.' ? snap.allPaths.filter((p) => p === d || p.startsWith(d + '/')) : snap.allPaths;
    return all.slice(0, Math.max(1, max));
  }

  async resolveMentions(text: string): Promise<{ explicitBlock: string; files: ContextFilePick[]; unresolved: string[] }> {
    const snap = await this.index.get();
    return resolveMentionsIn(snap, this.io, text);
  }
}

/**
 * Glob matcher for workspace-relative paths: `**` spans directories, `*` and `?` stay within a
 * segment, `{a,b}` alternates. A pattern without `/` matches the basename anywhere; a pattern
 * without wildcards also matches everything below that directory.
 */
export function globToRegExp(glob: string): (relPath: string) => boolean {
  const g = normalizePath(glob.trim());
  if (!g) return () => true;
  if (!/[*?{[]/.test(g)) {
    const d = g.replace(/\/+$/, '');
    return (p) => p === d || p.startsWith(d + '/') || (!d.includes('/') && p.split('/').pop() === d);
  }
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const close = g.indexOf('}', i);
      if (close < 0) re += '\\{';
      else {
        re += '(?:' + g.slice(i + 1, close).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')';
        i = close;
      }
    } else re += c.replace(/[.+^$()|[\]\\}]/g, '\\$&');
  }
  const full = new RegExp(`^${re}$`);
  if (g.includes('/')) return (p) => full.test(p);
  return (p) => full.test(p.slice(p.lastIndexOf('/') + 1)) || full.test(p);
}
