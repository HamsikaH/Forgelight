/**
 * Command guard (Feature 5): classifies every run_command before it reaches the approval card.
 *
 * PURE: no fs, no processes, no vscode. assess() parses the command with a small shell lexer
 * (quotes, escapes, $(..) / `..` / <(..) substitutions, heredocs, redirections, pipelines, subshells),
 * classifies each simple command with the rule tables below, and returns the MAX risk over all parts:
 *
 *     test  <  read  <  write  <  network  <  destructive          (+ blocked: must never run)
 *
 * It is a speed bump for an AI agent, not a sandbox: when unsure it answers with a HIGHER risk
 * (an unrecognised command is 'write'), and only 'test'/'read' can ever be auto-approved.
 *
 * Layout: risk bookkeeping -> lexer -> parser -> path helpers -> rule tables & handlers -> analyzer -> class.
 */
import * as path from 'node:path';
import type { CommandAssessment, CommandAssessor, CommandRisk } from '../contracts';

const P = path.posix;

// =============================================================================================
// Risk bookkeeping
// =============================================================================================

const RISK_ORDER: readonly CommandRisk[] = ['test', 'read', 'write', 'network', 'destructive'];
const rank = (r: CommandRisk): number => RISK_ORDER.indexOf(r);

/** Nested shells (bash -c, eval, $(..)) are analysed up to this depth; deeper is 'write'. */
const MAX_DEPTH = 6;
const MAX_REASONS = 8;

interface Verdict {
  risk: CommandRisk;
  reason: string;
  blocked?: boolean;
  /** Only shown when nothing more notable was found (cd, echo, export, ...). */
  minor?: boolean;
}

class Verdicts {
  readonly list: Verdict[] = [];
  /** Something in this text downloads (curl/wget/...): makes `sh <(curl ..)` and `eval "$(curl ..)"` detectable. */
  downloads = false;
  add(risk: CommandRisk, reason: string, minor = false): void {
    this.list.push(minor ? { risk, reason, minor } : { risk, reason });
  }
  block(reason: string): void {
    this.list.push({ risk: 'destructive', reason, blocked: true });
  }
  merge(o: Verdicts): void {
    this.list.push(...o.list);
    this.downloads ||= o.downloads;
  }
  maxFrom(start: number): number {
    let m = -1;
    for (let i = start; i < this.list.length; i++) m = Math.max(m, rank(this.list[i].risk));
    return m;
  }
}

// =============================================================================================
// Lexer: shell words, operators and redirections
// =============================================================================================

interface Word {
  /** Text with quoting removed; substitutions keep their source text (e.g. "$(date)"). */
  value: string;
  /** Source text as typed (used to recognise unquoted keywords and VAR=value). */
  raw: string;
  /** Inner command texts of $(..), `..`, <(..) and >(..) inside this word. */
  subs: string[];
}

interface Heredoc {
  delim: string;
  stripTabs: boolean;
  body?: string;
  /** Unquoted delimiter: the shell expands $(..) and `..` in the body. */
  expands?: boolean;
}

type Token =
  | { t: 'word'; w: Word }
  | { t: 'op'; op: string }
  | { t: 'redir'; op: string; fd: string; heredoc?: Heredoc };

/** Index just past the `close` that balances src[i] (=== open), skipping quoted text. */
function findClose(src: string, i: number, open: string, close: string): number {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\') {
      j++;
    } else if (ch === "'") {
      const e = src.indexOf("'", j + 1);
      j = e < 0 ? src.length : e;
    } else if (ch === '"') {
      j = skipDouble(src, j);
    } else if (ch === open) {
      depth++;
    } else if (ch === close && --depth === 0) {
      return j + 1;
    }
  }
  return src.length;
}

/** Index of the '"' that closes the double-quoted string starting at src[i]. */
function skipDouble(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length && src[j] !== '"') {
    if (src[j] === '\\') j += 2;
    else if (src[j] === '$' && src[j + 1] === '(') j = findClose(src, j + 1, '(', ')');
    else j++;
  }
  return j;
}

/** $( .. ) at src[i] === '(' -> inner command; $(( .. )) is arithmetic (no command). */
function readSubst(src: string, i: number): { inner: string; end: number; cmd: boolean } {
  const end = findClose(src, i, '(', ')');
  const arith = src[i + 1] === '(';
  return { inner: src.slice(i + 1, Math.max(i + 1, end - 1)), end, cmd: !arith };
}

/**
 * Command substitutions nested in text the shell expands without it being a command itself:
 * arithmetic $(( a[$(cmd)] )), parameter expansions ${x:-$(cmd)}, unquoted heredoc bodies.
 */
function innerSubs(text: string, depth = 0): string[] {
  const out: string[] = [];
  if (depth > MAX_DEPTH) return out;
  for (let j = 0; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') j++;
    else if (ch === '$' && text[j + 1] === '(') {
      const s = readSubst(text, j + 1);
      if (s.cmd) out.push(s.inner);
      else out.push(...innerSubs(s.inner, depth + 1));
      j = s.end - 1;
    } else if (ch === '`') {
      const s = readBacktick(text, j);
      out.push(s.inner);
      j = s.end - 1;
    }
  }
  return out;
}

function readBacktick(src: string, i: number): { inner: string; end: number } {
  let j = i + 1;
  while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
  return { inner: src.slice(i + 1, j).replace(/\\`/g, '`'), end: j + 1 };
}

/** Reads heredoc bodies that start after the newline at src[i]; returns the index after the last one. */
function readHeredocs(src: string, i: number, docs: Heredoc[]): number {
  let pos = i + 1;
  for (const doc of docs) {
    const body: string[] = [];
    while (pos < src.length) {
      const e = src.indexOf('\n', pos);
      const line = src.slice(pos, e < 0 ? src.length : e);
      pos = e < 0 ? src.length : e + 1;
      if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delim) break;
      body.push(line);
    }
    doc.body = body.join('\n');
  }
  return pos;
}

const REDIR_OPS = ['<<<', '<<-', '>>', '>|', '>&', '<<', '<&', '<>'];

/** f(){ f|f& }: a function whose body pipes itself into itself. Bounded so long input stays linear. */
const FUNC_DEF = /([A-Za-z_:.][\w:.-]{0,63})\s*\(\s*\)\s*\{([^}]{0,400})/g;
function hasForkBomb(skeleton: string): boolean {
  if (!skeleton.includes('|') || !skeleton.includes('{')) return false;
  for (const m of skeleton.matchAll(FUNC_DEF)) {
    const body = m[2].replace(/\s+/g, '');
    if (body.includes(`${m[1]}|${m[1]}`) || body.includes(`${m[1]}|&${m[1]}`)) return true;
  }
  return false;
}

/**
 * Tokenises shell text. `skeleton` is the text with quoted contents blanked out, so that
 * pattern checks (fork bombs) never fire on quoted strings such as grep ':(){ :|:& };:'.
 */
function lex(src: string): { tokens: Token[]; skeleton: string } {
  const tokens: Token[] = [];
  const pending: Heredoc[] = [];
  let skeleton = '';
  let cur: Word | undefined;
  let awaitingDelim: Heredoc | undefined;
  let i = 0;
  const n = src.length;

  const word = (): Word => (cur ??= { value: '', raw: '', subs: [] });
  const endWord = (): void => {
    if (!cur) return;
    tokens.push({ t: 'word', w: cur });
    if (awaitingDelim) {
      awaitingDelim.delim = cur.value;
      awaitingDelim.expands = !/['"\\]/.test(cur.raw);
      pending.push(awaitingDelim);
      awaitingDelim = undefined;
    }
    cur = undefined;
  };
  const op = (o: string, len: number): void => {
    endWord();
    tokens.push({ t: 'op', op: o });
    skeleton += src.slice(i, i + len);
    i += len;
  };
  const append = (value: string, raw: string, skel: string): void => {
    const w = word();
    w.value += value;
    w.raw += raw;
    skeleton += skel;
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '\\' && next === '\n') {
      i += 2; // line continuation
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      skeleton += c;
      i++;
    } else if (c === '\n') {
      op('\n', 1);
      if (pending.length) i = readHeredocs(src, i - 1, pending.splice(0));
    } else if (c === '#' && !cur) {
      while (i < n && src[i] !== '\n') i++; // comment
    } else if (c === "'") {
      const e = src.indexOf("'", i + 1);
      const stop = e < 0 ? n : e;
      append(src.slice(i + 1, stop), src.slice(i, stop + 1), "''");
      i = stop + 1;
    } else if (c === '$' && next === "'") {
      // ANSI-C quoting $'..': keep the text, unescape \' only
      let j = i + 2;
      while (j < n && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
      append(src.slice(i + 2, j).replace(/\\(.)/g, '$1'), src.slice(i, j + 1), "''");
      i = j + 1;
    } else if (c === '"') {
      const w = word();
      let j = i + 1;
      while (j < n && src[j] !== '"') {
        const ch = src[j];
        if (ch === '\\' && j + 1 < n) {
          const e = src[j + 1];
          w.value += '"\\$`'.includes(e) ? e : e === '\n' ? '' : ch + e;
          j += 2;
        } else if (ch === '$' && src[j + 1] === '(') {
          const s = readSubst(src, j + 1);
          w.value += src.slice(j, s.end);
          if (s.cmd) w.subs.push(s.inner);
          else w.subs.push(...innerSubs(s.inner));
          j = s.end;
        } else if (ch === '`') {
          const s = readBacktick(src, j);
          w.value += src.slice(j, s.end);
          w.subs.push(s.inner);
          j = s.end;
        } else {
          w.value += ch;
          j++;
        }
      }
      w.raw += src.slice(i, j + 1);
      skeleton += '""';
      i = j + 1;
    } else if (c === '\\') {
      append(next ?? '', src.slice(i, i + 2), '__');
      i += 2;
    } else if (c === '$' && next === '(') {
      const s = readSubst(src, i + 1);
      append(src.slice(i, s.end), src.slice(i, s.end), '$()');
      if (s.cmd) word().subs.push(s.inner);
      else word().subs.push(...innerSubs(s.inner));
      i = s.end;
    } else if (c === '$' && next === '{') {
      const end = findClose(src, i + 1, '{', '}');
      append(src.slice(i, end), src.slice(i, end), '${}');
      word().subs.push(...innerSubs(src.slice(i + 2, Math.max(i + 2, end - 1))));
      i = end;
    } else if (c === '`') {
      const s = readBacktick(src, i);
      append(src.slice(i, s.end), src.slice(i, s.end), '``');
      word().subs.push(s.inner);
      i = s.end;
    } else if ((c === '<' || c === '>') && next === '(') {
      // process substitution <(cmd) / >(cmd) is a word
      const s = readSubst(src, i + 1);
      append(src.slice(i, s.end), src.slice(i, s.end), c + '()');
      word().subs.push(s.inner);
      i = s.end;
    } else if (c === '<' || c === '>') {
      let fd = '';
      if (cur && /^\d+$/.test(cur.raw)) {
        fd = cur.raw; // 2>file: the digits are the fd, not a word
        cur = undefined;
      } else {
        endWord();
      }
      const o = REDIR_OPS.find((x) => src.startsWith(x, i)) ?? c;
      const tok: Extract<Token, { t: 'redir' }> = { t: 'redir', op: o, fd };
      if (o === '<<' || o === '<<-') awaitingDelim = tok.heredoc = { delim: '', stripTabs: o === '<<-' };
      tokens.push(tok);
      skeleton += o;
      i += o.length;
    } else if (c === '&') {
      if (next === '&') op('&&', 2);
      else if (next === '>') {
        endWord();
        const o = src.startsWith('&>>', i) ? '&>>' : '&>';
        tokens.push({ t: 'redir', op: o, fd: '' });
        skeleton += o;
        i += o.length;
      } else op('&', 1);
    } else if (c === '|') {
      if (next === '|') op('||', 2);
      else if (next === '&') op('|&', 2);
      else op('|', 1);
    } else if (c === ';') {
      op(';', next === ';' || next === '&' ? 2 : 1);
    } else if (c === '(') {
      if (cur && /^[A-Za-z_]\w*\+?=$/.test(cur.raw)) {
        const end = findClose(src, i, '(', ')'); // arr=(a b c)
        append(src.slice(i, end), src.slice(i, end), '()');
        i = end;
      } else op('(', 1);
    } else if (c === ')') {
      op(')', 1);
    } else {
      append(c, c, c);
      i++;
    }
  }
  endWord();
  return { tokens, skeleton };
}

// =============================================================================================
// Parser: simple commands, pipelines and subshell markers
// =============================================================================================

interface Redir {
  op: string;
  fd: string;
  target?: Word;
  heredoc?: Heredoc;
}

interface SimpleCmd {
  words: Word[];
  redirs: Redir[];
}

type Item = { kind: 'pipeline'; cmds: SimpleCmd[] } | { kind: 'open' } | { kind: 'close' };

function parse(tokens: Token[]): Item[] {
  const items: Item[] = [];
  let pipe: SimpleCmd[] = [];
  let cur: SimpleCmd = { words: [], redirs: [] };
  const flushCmd = (): void => {
    if (cur.words.length || cur.redirs.length) pipe.push(cur);
    cur = { words: [], redirs: [] };
  };
  const flushPipe = (): void => {
    flushCmd();
    if (pipe.length) items.push({ kind: 'pipeline', cmds: pipe });
    pipe = [];
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t === 'word') {
      cur.words.push(t.w);
    } else if (t.t === 'redir') {
      const r: Redir = { op: t.op, fd: t.fd, heredoc: t.heredoc };
      const nx = tokens[k + 1];
      if (nx?.t === 'word') {
        r.target = nx.w;
        k++;
      }
      cur.redirs.push(r);
    } else if (t.op === '|' || t.op === '|&') {
      flushCmd();
    } else if (t.op === '(' || t.op === ')') {
      flushPipe();
      items.push({ kind: t.op === '(' ? 'open' : 'close' });
    } else {
      flushPipe(); // ; && || & newline
    }
  }
  flushPipe();
  return items;
}

/** Leading reserved words that introduce a command: `then rm x` is `rm x`. */
const KEYWORD_PREFIX = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);
/** Reserved words that close a block and carry no command. */
const KEYWORD_ALONE = new Set(['fi', 'done', 'esac', '}', 'then', 'else', 'do']);
/** Headers whose words are a list, not a command: `for f in *.py`, `case $x in`. */
const CONTROL_HEADER = new Set(['for', 'select', 'case', 'function']);
const ASSIGNMENT = /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/;

// =============================================================================================
// Paths
// =============================================================================================

/** Where a path lands, from the workspace's point of view. */
type Cat =
  | 'null' // /dev/null, /dev/stdout, ...: harmless sinks
  | 'device' // other /dev/*: raw devices
  | 'fsroot' // '/'
  | 'system' // /etc, /usr, /bin, /System, ...
  | 'home' // the user's home directory itself
  | 'ancestor' // a parent of the workspace
  | 'wsroot' // the workspace root itself
  | 'workspace' // inside the workspace
  | 'temp' // /tmp, /var/folders, $TMPDIR
  | 'outside' // anywhere else
  | 'unknown'; // built from variables or command output

const DEV_SINK = /^\/dev\/(null|stdout|stderr|tty|zero|random|urandom|fd\/\d+)$/;
const SYSTEM_DIRS = [
  '/etc', '/usr', '/bin', '/sbin', '/System', '/Library', '/boot', '/lib', '/lib32', '/lib64',
  '/private/etc', '/private/var', '/var', '/opt', '/Applications', '/proc', '/sys', '/cores',
];
const DEFAULT_TEMP_DIRS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'];

/** p is strictly inside dir. */
const within = (dir: string, p: string): boolean => p.startsWith(dir === '/' ? '/' : dir + '/') && p !== dir;

/** Pathspecs that mean "the whole tree" for git checkout/restore. */
const WHOLE_TREE = new Set(['.', './', '*', ':/', ':/:', ':(top)', ':(top).']);

/** Programs run through a path are trusted only from these bin directories. */
const TRUSTED_BIN: readonly RegExp[] = [
  /(^|\/)(\.?venv[\w.-]*|\.?env|virtualenv|\.tox\/[^/]+|\.nox\/[^/]+)\/(bin|Scripts)\/[^/]+$/,
  /(^|\/)node_modules\/\.bin\/[^/]+$/,
  /^\/(usr\/(local\/)?|opt\/homebrew\/|opt\/local\/)?s?bin\/[^/]+$/,
  /^(~|\$HOME|\/Users\/[^/]+|\/home\/[^/]+)\/(\.local\/bin|\.cargo\/bin|\.pyenv\/shims|\.bun\/bin|\.deno\/bin|go\/bin)\/[^/]+$/,
];

const URL_RE = /\b(https?|ftp|wss?):\/\//i;
/** Files whose contents are secrets; reading them is still 'read' but says so. */
const SENSITIVE = /(^|\/)(\.ssh\/|\.aws\/|\.gnupg\/|\.netrc$|\.pgpass$|\.pypirc$|\.npmrc$|id_(rsa|ed25519|ecdsa|dsa)\b|\.env(\.[\w-]+)?$|credentials(\.json)?$|shadow$)/;

/** Basename with version suffixes folded: python3.11 -> python, pip3 -> pip, mkfs.ext4 -> mkfs. */
function normaliseName(prog: string): string {
  const n = prog.slice(prog.lastIndexOf('/') + 1);
  if (/^(python|pypy)\d*(\.\d+)*$/.test(n)) return 'python';
  if (/^pip\d*(\.\d+)*$/.test(n)) return 'pip';
  if (/^(mkfs|newfs)([._].+)?$/.test(n)) return 'mkfs';
  if (n === 'py.test') return 'pytest';
  if (n === 'gradlew') return 'gradle';
  if (n === 'mvnw') return 'mvn';
  return n;
}

/** Non-option arguments; options listed in `withValue` consume the next argument. Everything after `--` counts. */
function positionals(args: string[], withValue: readonly string[] = []): string[] {
  const out: string[] = [];
  let dash = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (dash) out.push(a);
    else if (a === '--') dash = true;
    else if (a.startsWith('-') && a !== '-') {
      if (withValue.includes(a)) i++;
    } else out.push(a);
  }
  return out;
}

/** Any arg is one of `longs` (or --long=value), or a short-flag bundle (-rf) containing one of `shorts`. Stops at `--`. */
function hasFlag(args: string[], longs: readonly string[], shorts = ''): boolean {
  for (const a of args) {
    if (a === '--') break;
    if (longs.includes(a) || longs.some((l) => l.startsWith('--') && a.startsWith(l + '='))) return true;
    if (shorts && /^-[A-Za-z0-9]+$/.test(a) && [...a.slice(1)].some((ch) => shorts.includes(ch))) return true;
  }
  return false;
}

/** First non-option argument and the arguments after it (options in `withValue` take a value). */
function subcommand(args: string[], withValue: readonly string[] = []): { sub?: string; rest: string[] } {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (withValue.includes(a)) i++;
    else if (!a.startsWith('-') && !a.startsWith('+')) return { sub: a, rest: args.slice(i + 1) };
  }
  return { rest: [] };
}

/** Own-property lookup: a command named "constructor" must not find Object.prototype members. */
function own<T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

const clip = (s: string, n = 60): string => (s.length > n ? '…' + s.slice(-(n - 1)) : s);

// =============================================================================================
// Python snippets (python -c, python - <<EOF)
// =============================================================================================

const PY_DESTRUCTIVE = /\bshutil\s*\.\s*rmtree\b/;
const PY_NETWORK = /\b(urllib|requests|httpx|aiohttp|http\.client|socket|ftplib|smtplib|paramiko)\b|https?:\/\//;
const PY_WRITES: readonly RegExp[] = [
  /\bopen\s*\([^)]{0,200},\s*(mode\s*=\s*)?['"][rbt]*[wax+]/, // open(p, 'w'), open(p, mode='a')
  /\bopen\s*\([^)]{0,200}\bmode\s*=\s*['"][rbt]*[wax+]/, // open(mode='w', file=p)
  /\.(write_text|write_bytes|unlink|rmdir|touch|mkdir|rename|symlink_to|hardlink_to|chmod)\s*\(/,
  /\bos\s*\.\s*(remove|unlink|rmdir|removedirs|rename|renames|replace|makedirs|mkdir|system|popen|exec\w*|spawn\w*|posix_spawn\w*|chmod|lchmod|fchmod|chown|lchown|fchown|chflags|truncate|ftruncate|kill|killpg|symlink|link|utime|fork|open|write|mkfifo|mknod|setxattr|removexattr|startfile)\b/,
  /\b(shutil|subprocess|pty|ctypes|multiprocessing|posix|runpy)\b/,
  /\bnt\s*\./,
  // the same functions reached without `os.`: from os import system, import os as o, getattr(os, ...)
  /\bfrom\s+(os|posix|nt|shutil|subprocess|pty|pathlib|importlib|ctypes|signal|socket)\b/,
  /\bimport\b[^\n;]*\b(os|posix|nt)\s+as\b/,
  /\b(getattr|setattr|importlib|builtins|__builtins__|__dict__|__getattribute__|vars|globals|locals)\b|\bsys\s*\.\s*modules\b/,
  /\b__import__\s*\(|\b(exec|eval|compile)\s*\(/,
];

function analysePython(code: string): [CommandRisk, string] {
  if (PY_DESTRUCTIVE.test(code)) return ['destructive', 'python code deletes a directory tree (shutil.rmtree)'];
  if (PY_NETWORK.test(code)) return ['network', 'python code uses the network'];
  if (PY_WRITES.some((r) => r.test(code))) return ['write', 'python code writes files or runs commands'];
  return ['read', 'runs a read-only python snippet'];
}

// =============================================================================================
// Rule tables
// =============================================================================================

/**
 * Commands whose class does not depend on their arguments. Redirections, paths and
 * substitutions are still checked separately for every command.
 */
const SIMPLE_RULES: ReadonlyArray<{ risk: CommandRisk; reason: string; names: string[]; minor?: boolean; blocked?: boolean }> = [
  // read: look, never touch
  { risk: 'read', reason: 'lists files', names: ['ls', 'tree', 'exa', 'eza', 'll', 'dir'] },
  { risk: 'read', reason: 'reads files', names: ['cat', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'tac', 'xxd', 'od', 'hexdump', 'strings'] },
  { risk: 'read', reason: 'counts lines', names: ['wc'] },
  { risk: 'read', reason: 'searches file contents', names: ['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'pt'] },
  { risk: 'read', reason: 'compares files', names: ['diff', 'cmp', 'comm', 'colordiff', 'diff3'] },
  { risk: 'read', reason: 'inspects files', names: ['stat', 'file', 'du', 'df', 'realpath', 'readlink', 'basename', 'dirname', 'md5', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'cksum', 'lsof'] },
  { risk: 'read', reason: 'transforms text', names: ['cut', 'tr', 'uniq', 'column', 'paste', 'fold', 'fmt', 'rev', 'jq', 'yq', 'base64', 'expand', 'unexpand', 'iconv', 'tsort', 'look'] },
  { risk: 'read', reason: 'locates a program', names: ['which', 'whereis', 'type', 'hash'] },
  { risk: 'read', reason: 'inspects the system', names: ['date', 'uname', 'whoami', 'id', 'hostname', 'uptime', 'ps', 'sw_vers', 'arch', 'nproc', 'locale', 'groups', 'tty', 'free', 'vm_stat', 'cal'] },
  { risk: 'read', reason: 'prints environment variables (may expose secrets)', names: ['printenv'] },
  { risk: 'read', reason: 'shows the current directory', names: ['pwd', 'dirs'], minor: true },
  { risk: 'read', reason: 'shell built-in', names: ['true', 'false', ':', 'test', '[', '[[', ']]', 'sleep', 'wait', 'exit', 'return', 'shift', 'read', 'let', 'expr', 'seq', 'unset', 'unalias', 'shopt', 'history', 'jobs', 'clear', 'popd', 'deactivate', 'help'], minor: true },
  // test: runs tests, type-checkers and linters that only report
  { risk: 'test', reason: 'runs pytest', names: ['pytest'] },
  { risk: 'test', reason: 'runs tox', names: ['tox'] },
  { risk: 'test', reason: 'runs nox', names: ['nox'] },
  { risk: 'test', reason: 'runs mocha', names: ['mocha'] },
  { risk: 'test', reason: 'runs ava', names: ['ava'] },
  { risk: 'test', reason: 'runs rspec', names: ['rspec'] },
  { risk: 'test', reason: 'runs phpunit', names: ['phpunit'] },
  { risk: 'test', reason: 'runs ctest', names: ['ctest'] },
  { risk: 'test', reason: 'runs a type checker', names: ['mypy', 'pyright', 'dmypy'] },
  { risk: 'test', reason: 'runs a linter', names: ['flake8', 'pylint', 'pycodestyle', 'pydocstyle', 'pyflakes', 'bandit', 'shellcheck', 'hadolint', 'yamllint', 'markdownlint', 'vulture'] },
  // write: changes files or state in ways that need a human
  { risk: 'write', reason: 'stops processes', names: ['pkill', 'killall'] },
  { risk: 'write', reason: 'changes permissions or attributes', names: ['chflags', 'xattr', 'setfacl', 'umask'] },
  { risk: 'write', reason: 'creates or extracts an archive', names: ['tar', 'zip', 'unzip', 'gzip', 'gunzip', 'bzip2', 'xz', 'unxz', '7z'] },
  { risk: 'write', reason: 'patches files', names: ['patch'] },
  { risk: 'write', reason: 'compiles code', names: ['gcc', 'g++', 'cc', 'clang', 'clang++', 'javac', 'rustc', 'cmake', 'ninja', 'meson'] },
  { risk: 'write', reason: 'opens a file or app', names: ['open', 'xdg-open', 'code', 'vim', 'vi', 'nano', 'emacs'] },
  // network: talks to other machines
  { risk: 'network', reason: 'connects to a remote host', names: ['ssh', 'sftp', 'telnet', 'nc', 'ncat', 'netcat', 'socat', 'ftp', 'mosh'] },
  { risk: 'network', reason: 'probes the network', names: ['ping', 'ping6', 'traceroute', 'dig', 'nslookup', 'host', 'whois', 'mtr', 'netstat'] },
  { risk: 'network', reason: 'calls the GitHub API', names: ['gh', 'hub'] },
  { risk: 'network', reason: 'installs packages', names: ['brew', 'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'apk', 'gem', 'port', 'snap'] },
  // destructive
  { risk: 'destructive', reason: 'shreds files', names: ['shred', 'srm', 'wipe'] },
  // blocked: must never run from an agent
  { risk: 'destructive', blocked: true, reason: 'runs with elevated privileges (sudo/su/doas)', names: ['sudo', 'su', 'doas', 'pkexec', 'run0'] },
  { risk: 'destructive', blocked: true, reason: 'formats or partitions a disk', names: ['mkfs', 'fdisk', 'sfdisk', 'cfdisk', 'parted', 'wipefs', 'gpart'] },
  { risk: 'destructive', blocked: true, reason: 'shuts down or reboots the machine', names: ['shutdown', 'reboot', 'halt', 'poweroff'] },
];
const SIMPLE_BY_NAME = new Map(SIMPLE_RULES.flatMap((r) => r.names.map((n) => [n, r] as const)));
/** Read rules whose positionals are files (a read outside the workspace is flagged; it is never auto-approved). */
const FILE_READ_REASONS = new Set(['lists files', 'reads files', 'counts lines', 'searches file contents', 'compares files', 'inspects files', 'transforms text']);
/** Search tools: the first positional is the pattern unless -e/-f gave it. */
const SEARCH_TOOLS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'pt']);
const SEARCH_VALUE_OPTS = ['-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '-B', '-C', '--context', '-g', '--glob', '-t', '--type', '-T', '--type-not', '--include', '--exclude', '--exclude-dir'];
/** Built-ins that evaluate array subscripts arithmetically, so 'a[$(cmd)]' runs cmd even in single quotes. */
const SUBSCRIPT_EVAL = new Set(['let', 'test', '[', '[[', 'declare', 'typeset', 'local', 'export', 'readonly', 'unset', 'read', 'mapfile', 'readarray']);
/** Environment variables that make programs load code (shell startup files, preloads, interpreter options). */
const CODE_LOADING_ENV = /^(BASH_ENV|ENV|SHELLOPTS|BASHOPTS|ZDOTDIR|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_\w+|NODE_OPTIONS|PERL5OPT|RUBYOPT|PYTHONSTARTUP|PYTHONWARNINGS|PYTHONHOME|PYTHONINSPECT|GIT_CONFIG(_\w+)?|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GCONV_PATH)$/;
/** NODE_OPTIONS flags that only tune the runtime (anything else, e.g. --require, loads code). */
const SAFE_NODE_OPTION = /^--(max-old-space-size|max-semi-space-size|stack-size|stack-trace-limit|enable-source-maps|no-warnings|no-deprecation|throw-deprecation|trace-warnings|trace-deprecation|trace-uncaught|unhandled-rejections|openssl-legacy-provider|experimental-vm-modules|dns-result-order|preserve-symlinks)(=[\w.-]*)?$/;
/** A code-loading variable set to a value that loads nothing: PYTHONWARNINGS=ignore, NODE_OPTIONS=--max-old-space-size=4096. */
function harmlessEnvValue(name: string, value: string): boolean {
  // action:message:category:module:lineno; only a dotted category (pkg.Warning) imports a module
  if (name === 'PYTHONWARNINGS') return value.split(',').every((e) => !(e.split(':')[2] ?? '').includes('.'));
  if (name === 'NODE_OPTIONS') return value.split(/\s+/).filter(Boolean).every((o) => SAFE_NODE_OPTION.test(o));
  return false;
}
/** Environment variables whose value is a command some program runs. */
const COMMAND_ENV = /^(PS4|PROMPT_COMMAND|GIT_SSH_COMMAND|GIT_SSH|GIT_EXTERNAL_DIFF|GIT_PAGER|PAGER|MANPAGER|GIT_EDITOR|GIT_SEQUENCE_EDITOR|EDITOR|VISUAL|GIT_ASKPASS|SSH_ASKPASS|SUDO_ASKPASS|GIT_PROXY_COMMAND|LESSOPEN|LESSCLOSE|BROWSER)$/;
/** git config keys whose value is a command (or a file of config) git runs. */
const GIT_CONFIG_RUNS =
  /^(core\.(fsmonitor|pager|sshcommand|editor|hookspath|askpass|gitproxy|alternaterefscommand)|alias\..*|pager\..*|diff\.external|credential\..*|include\.path|includeif\..*|sequence\.editor|uploadpack\.packobjectshook|gpg(\.\w+)?\.program|.*\.(command|cmd|textconv|clean|smudge|process|driver|program))$/i;
/** Reasons that keep a 'read' command from being auto-approved (see the runner). */
export const NOT_AUTO_APPROVABLE = /secrets|outside the workspace|leaves the workspace/;

/** Programs that fetch remote content (their output piped into a shell is blocked). */
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'http', 'https', 'xh', 'aria2c', 'lwp-download']);
/** Read-only filters that usually just post-process piped output. */
const FILTERS = new Set([
  'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'wc', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk', 'column', 'jq', 'yq',
  'cat', 'less', 'more', 'nl', 'fold', 'fmt', 'rev', 'tac', 'tee', 'xargs',
]);
/** JS tools that npx/bunx/pnpm dlx run from node_modules rather than downloading. */
const LOCAL_JS_TOOLS = new Set(['jest', 'vitest', 'mocha', 'ava', 'tsc', 'eslint', 'prettier', 'stylelint']);
/** Python modules that `python -m X` dispatches to the X handler. */
const PY_TOOL_MODULES = new Set([
  'pytest', 'mypy', 'ruff', 'flake8', 'pylint', 'pyright', 'black', 'isort', 'pip', 'flask', 'tox', 'nox', 'coverage',
  'pycodestyle', 'pydocstyle', 'pyflakes', 'bandit', 'uv',
]);
/** Other `python -m` modules. */
const PY_MODULES: Readonly<Record<string, [CommandRisk, string]>> = {
  unittest: ['test', 'runs unittest'],
  doctest: ['test', 'runs doctest'],
  venv: ['write', 'creates a virtualenv'],
  virtualenv: ['write', 'creates a virtualenv'],
  'http.server': ['network', 'starts a web server'],
  'json.tool': ['read', 'pretty-prints JSON'],
  site: ['read', 'prints python site info'],
  sysconfig: ['read', 'prints python build info'],
  platform: ['read', 'prints platform info'],
  pydoc: ['read', 'shows documentation'],
  compileall: ['write', 'compiles python files'],
  py_compile: ['write', 'compiles python files'],
  build: ['write', 'builds a package'],
  ensurepip: ['write', 'installs pip'],
};
const FLASK_SUBCOMMANDS: Readonly<Record<string, [CommandRisk, string]>> = {
  routes: ['read', 'lists the app routes (flask routes)'],
  config: ['read', 'prints the app config (read-only flask command)'],
  run: ['network', 'starts the flask dev server'],
  shell: ['write', 'opens a flask shell'],
};
const PIP_SUBCOMMANDS: Readonly<Record<string, [CommandRisk, string]>> = {
  install: ['network', 'installs packages'],
  download: ['network', 'downloads packages'],
  wheel: ['network', 'builds wheels (downloads packages)'],
  search: ['network', 'queries the package index'],
  index: ['network', 'queries the package index'],
  uninstall: ['write', 'uninstalls packages'],
  list: ['read', 'lists installed packages'],
  show: ['read', 'shows package info'],
  freeze: ['read', 'lists installed packages'],
  check: ['read', 'checks installed packages'],
  inspect: ['read', 'inspects the environment'],
  debug: ['read', 'shows pip debug info'],
  hash: ['read', 'hashes a package file'],
  help: ['read', 'shows pip help'],
};
const GIT_READ: Readonly<Record<string, string>> = {
  status: 'shows git status',
  diff: 'shows the diff',
  log: 'shows the git log',
  show: 'shows a commit',
  blame: 'shows line history (git blame)',
  grep: 'searches tracked files (git grep)',
  'ls-files': 'lists tracked files',
};
const GIT_INSPECT = new Set([
  'shortlog', 'describe', 'rev-parse', 'rev-list', 'ls-tree', 'cat-file', 'show-ref', 'for-each-ref', 'merge-base',
  'name-rev', 'count-objects', 'check-ignore', 'check-attr', 'whatchanged', 'var', 'help', 'version', 'show-branch', 'fsck',
]);
const GIT_NETWORK: Readonly<Record<string, string>> = {
  clone: 'clones a repository',
  fetch: 'fetches from a remote',
  pull: 'pulls from a remote',
  'ls-remote': 'queries a remote',
  'request-pull': 'contacts a remote',
  'send-email': 'sends email',
  lfs: 'transfers large files (git lfs)',
};
const GIT_WRITE: Readonly<Record<string, string>> = {
  add: 'stages files (git add)',
  commit: 'creates a commit',
  switch: 'switches branches',
  merge: 'merges branches',
  rebase: 'rebases commits',
  'cherry-pick': 'cherry-picks commits',
  revert: 'reverts commits',
  am: 'applies patches',
  apply: 'applies a patch',
  init: 'initialises a repository',
  mv: 'moves tracked files',
};

// =============================================================================================
// Analyzer
// =============================================================================================

type Stdin = { kind: 'none' | 'pipe' | 'file' | 'download' } | { kind: 'text'; text: string };

/** One simple command being classified (shared by wrappers such as `xargs`, `nohup`, `uv run`). */
interface Call {
  v: Verdicts;
  /** Directory the command runs in (absolute); undefined when it was computed (cd "$X"). */
  dir: string | undefined;
  /** Directory the NEXT command runs in (changed by cd/pushd). */
  newDir: string | undefined;
  depth: number;
  stdin: Stdin;
  /** A $(..)/`..`/<(..) inside this command downloads something. */
  subDownloads: boolean;
  /** This command fetches remote content (for `curl .. | sh`). */
  downloader: boolean;
  /** Text this command prints (echo/printf), for `echo "..." | sh`. */
  echo?: string;
}

type Handler = (a: Analyzer, c: Call, args: string[], name: string) => void;

class Analyzer {
  constructor(
    readonly root: string,
    readonly home: string | undefined,
    readonly temps: readonly string[],
  ) {}

  /** Analyses a full command text (also used recursively for bash -c, eval, $(..)). */
  run(text: string, dir: string | undefined, depth: number): Verdicts {
    const out = new Verdicts();
    if (depth > MAX_DEPTH) {
      out.add('write', 'nested commands too deep to analyse');
      return out;
    }
    const { tokens, skeleton } = lex(text);
    if (hasForkBomb(skeleton)) out.block('fork bomb (spawns processes until the machine hangs)');
    const stack: Array<string | undefined> = [];
    for (const item of parse(tokens)) {
      if (item.kind === 'open') {
        stack.push(dir); // ( .. ) is a subshell: cd inside it does not leak out
        continue;
      }
      if (item.kind === 'close') {
        if (stack.length) dir = stack.pop();
        continue;
      }
      let downloaded = false;
      let echo: string | undefined;
      item.cmds.forEach((cmd, k) => {
        const c = this.simple(cmd, dir, depth, this.stdinOf(cmd, k > 0, downloaded, echo));
        out.merge(c.v);
        dir = c.newDir;
        downloaded ||= c.downloader;
        echo = c.echo;
      });
    }
    return out;
  }

  private stdinOf(cmd: SimpleCmd, piped: boolean, downloaded: boolean, echo: string | undefined): Stdin {
    for (const r of cmd.redirs) {
      if (r.heredoc) return { kind: 'text', text: r.heredoc.body ?? '' };
      if (r.op === '<<<') return { kind: 'text', text: r.target?.value ?? '' };
      if (r.op === '<') return { kind: 'file' };
    }
    if (!piped) return { kind: 'none' };
    if (downloaded) return { kind: 'download' };
    if (echo !== undefined) return { kind: 'text', text: echo };
    return { kind: 'pipe' };
  }

  private simple(cmd: SimpleCmd, dir: string | undefined, depth: number, stdin: Stdin): Call {
    const c: Call = { v: new Verdicts(), dir, newDir: dir, depth, stdin, subDownloads: false, downloader: false };
    // 1. Substitutions run before the command: analyse them as commands of their own (also those
    //    in an unquoted heredoc body, which the shell expands).
    const subs = [...cmd.words, ...cmd.redirs.flatMap((r) => (r.target ? [r.target] : []))].flatMap((w) => w.subs);
    for (const r of cmd.redirs) if (r.heredoc?.expands && r.heredoc.body) subs.push(...innerSubs(r.heredoc.body));
    for (const s of subs) {
      const r = this.run(s, dir, depth + 1);
      c.v.merge(r);
      c.subDownloads ||= r.downloads;
    }
    // 2. Shell syntax: reserved words and leading VAR=value assignments.
    let words = cmd.words;
    while (words.length > 1 && KEYWORD_PREFIX.has(words[0].raw)) words = words.slice(1);
    if (words.length === 1 && (KEYWORD_ALONE.has(words[0].raw) || KEYWORD_PREFIX.has(words[0].raw))) words = [];
    if (words.length && CONTROL_HEADER.has(words[0].raw)) {
      c.v.add('read', 'shell control flow', true);
      words = [];
    }
    const assigns: Word[] = [];
    while (words.length && ASSIGNMENT.test(words[0].raw)) {
      assigns.push(words[0]);
      words = words.slice(1);
    }
    if (!words.length && assigns.length) c.v.add('read', 'sets a shell variable', true);
    // BASH_ENV=x bash .., GIT_EXTERNAL_DIFF='cmd' git diff: the value is code something will run.
    for (const w of assigns) {
      const m = /^([A-Za-z_]\w*)(?:\[[^\]]*\])?\+?=([\s\S]*)$/.exec(w.value);
      if (m) this.envAssign(c, m[1], m[2]);
    }
    // 3. The command itself, then its redirections.
    const start = c.v.list.length;
    this.dispatch(c, words.map((w) => w.value));
    this.redirects(c, cmd.redirs);
    // 4. Writing while the shell sits outside the workspace (cd .. && make) is destructive.
    if (c.v.maxFrom(start) === rank('write') && this.isOutside(dir)) {
      c.v.add('destructive', `writes outside the workspace (runs in ${this.show(dir!)})`);
    }
    c.v.downloads ||= c.downloader || c.subDownloads;
    return c;
  }

  /** Classifies argv (wrappers call this again with the wrapped command). */
  dispatch(c: Call, argv: string[]): void {
    if (!argv.length) return;
    const prog = argv[0];
    const args = argv.slice(1);
    if (/^\$|\$\(|`/.test(prog)) {
      if (c.subDownloads) c.v.block('runs downloaded content as a command');
      else c.v.add('write', `runs a computed command (${clip(prog, 40)})`);
      return;
    }
    const name = normaliseName(prog);
    const start = c.v.list.length;
    if (DOWNLOADERS.has(name)) c.downloader = true;
    // let 'a[$(cmd)]', [[ -v 'a[$(cmd)]' ]]: the subscript is evaluated, running cmd (even single-quoted).
    if (SUBSCRIPT_EVAL.has(name) || (name === 'printf' && args.includes('-v'))) {
      for (const x of args) if (/\[[^\]]*(\$\(|`)/.test(x)) this.nested(c, x.slice(x.indexOf('[')));
    }
    const handler = own(HANDLERS, name);
    const rule = SIMPLE_BY_NAME.get(name);
    if (handler) {
      handler(this, c, args, name);
    } else if (rule) {
      if (rule.blocked) c.v.block(rule.reason);
      else c.v.add(rule.risk, rule.reason, rule.minor);
      if (rule.risk === 'read' && FILE_READ_REASONS.has(rule.reason)) this.readsFiles(c, name, args);
      // `cat <<EOF | sh` passes its heredoc on like `echo ... | sh`
      if (name === 'cat' && c.stdin.kind === 'text' && !positionals(args).length) c.echo = c.stdin.text;
    } else {
      c.v.add('write', prog.includes('/') ? `runs a script (${clip(prog, 50)})` : `unrecognised command (${clip(name, 40)})`);
      return;
    }
    // A known name run through a path is only trusted from venv/node_modules/system bin dirs.
    if (prog.includes('/') && !TRUSTED_BIN.some((r) => r.test(prog))) {
      c.v.add('write', `runs ${name} from an untrusted path (${clip(prog, 50)})`);
    }
    // A read-only filter fed by a pipe (pytest -q | tail -20) is plumbing: it should not outrank the producer.
    if ((c.stdin.kind === 'pipe' || c.stdin.kind === 'text') && FILTERS.has(name)) {
      for (let k = start; k < c.v.list.length; k++) {
        const x = c.v.list[k];
        if (x.risk === 'read' && !x.blocked && !NOT_AUTO_APPROVABLE.test(x.reason)) x.minor = true;
      }
    }
    // Writing commands that mention a URL probably talk to it.
    if (c.v.maxFrom(start) === rank('write') && args.some((x) => URL_RE.test(x))) c.v.add('network', 'accesses a URL');
  }

  /** Analyses nested shell text in the context of the current command. */
  nested(c: Call, text: string): void {
    c.v.merge(this.run(text, c.dir, c.depth + 1));
  }

  /**
   * NAME=value for a command (leading assignment, env, export/declare): variables that load code
   * are 'write'; command-valued ones (GIT_EXTERNAL_DIFF, PAGER, PS4, ...) have their value analysed.
   */
  envAssign(c: Call, name: string, value: string): void {
    if (CODE_LOADING_ENV.test(name) && !harmlessEnvValue(name, value)) {
      if (/^\/dev\/(stdin|fd\/\d+)$/.test(value)) {
        if (c.stdin.kind === 'text') this.nested(c, c.stdin.text);
        else if (c.stdin.kind === 'download') c.v.block(`loads downloaded content as code (${name}=${clip(value, 20)})`);
      } else if (value.startsWith('<(')) {
        this.codeFromFile(c, value, name, 'shell');
      }
      c.v.add('write', `sets ${name}, which makes programs load extra code`);
      return;
    }
    if (COMMAND_ENV.test(name)) {
      const cmd = /^LESS(OPEN|CLOSE)$/.test(name) ? value.replace(/^\|\|?-?/, '') : value;
      if (cmd.trim()) this.nested(c, cmd);
      c.v.add('read', `sets ${name}`, true);
    }
  }

  /**
   * Code that comes from a "file" that is really stdin (/dev/stdin) or a <(..) substitution whose
   * output is known (echo/printf/heredoc) or downloaded. Returns true when it was classified.
   */
  codeFromFile(c: Call, f: string, name: string, lang: 'shell' | 'python'): boolean {
    if (/^\/dev\/(stdin|fd\/0)$/.test(f)) {
      this.stdinCode(c, name, lang);
      return true;
    }
    if (!f.startsWith('<(')) return false;
    const printed = this.printedBy(f.slice(2, f.endsWith(')') ? -1 : undefined), c.dir, c.depth + 1);
    if (printed.downloads) {
      c.v.block(`runs downloaded content in ${name} (unreviewed remote code)`);
      return true;
    }
    if (printed.text === undefined) return false;
    if (lang === 'shell') this.nested(c, printed.text);
    else c.v.add(...analysePython(printed.text));
    return true;
  }

  /** What shell text prints when that is known (echo, printf, cat <<EOF), and whether it downloads. */
  private printedBy(text: string, dir: string | undefined, depth: number): { text?: string; downloads: boolean } {
    if (depth > MAX_DEPTH) return { downloads: false };
    const texts: string[] = [];
    let known = true;
    let downloads = false;
    for (const item of parse(lex(text).tokens)) {
      if (item.kind !== 'pipeline') continue;
      let downloaded = false;
      let echo: string | undefined;
      item.cmds.forEach((cmd, k) => {
        const c = this.simple(cmd, dir, depth, this.stdinOf(cmd, k > 0, downloaded, echo));
        downloaded ||= c.downloader;
        downloads ||= c.downloader || c.subDownloads;
        echo = c.echo;
      });
      if (echo === undefined) known = false;
      else texts.push(echo);
    }
    return { text: known && texts.length ? texts.join('\n') : undefined, downloads };
  }

  /** Secrets and reads outside the workspace among a read-only command's file arguments. */
  readsFiles(c: Call, name: string, args: string[]): void {
    const secret = args.find((x) => SENSITIVE.test(x));
    if (secret) c.v.add('read', `may expose secrets (${clip(secret, 40)})`);
    let paths = positionals(args, SEARCH_TOOLS.has(name) ? SEARCH_VALUE_OPTS : []);
    if (SEARCH_TOOLS.has(name) && !args.some((x) => ['-e', '--regexp', '-f', '--file'].includes(x) || /^--(regexp|file)=/.test(x))) paths = paths.slice(1);
    this.readsPaths(c, paths);
  }

  /** One 'reads outside the workspace' reason when any path lands outside it (home, parents, system, elsewhere). */
  readsPaths(c: Call, paths: string[]): void {
    for (const p of paths) {
      const w = this.where(p, c.dir);
      if (['home', 'ancestor', 'outside', 'system', 'fsroot'].includes(w.cat)) {
        c.v.add('read', `reads outside the workspace (${w.show})`);
        return;
      }
    }
  }

  /** Code an interpreter reads from stdin (`curl .. | sh`, `python - <<EOF`, `echo .. | bash`). */
  stdinCode(c: Call, name: string, lang: 'shell' | 'python' | 'other'): void {
    const s = c.stdin;
    if (s.kind === 'download') return c.v.block(`pipes downloaded content into ${name} (runs unreviewed remote code)`);
    if (s.kind === 'text') {
      if (lang === 'shell') return this.nested(c, s.text);
      if (lang === 'python') {
        const [risk, reason] = analysePython(s.text);
        return c.v.add(risk, reason);
      }
      return c.v.add('write', `runs ${name} code from stdin`);
    }
    if (s.kind === 'none') return c.v.add('write', `starts an interactive ${name}`);
    c.v.add('write', `runs ${name} code from stdin`);
  }

  private redirects(c: Call, redirs: Redir[]): void {
    for (const r of redirs) {
      if (!r.target) continue;
      if (r.op === '<' || r.op === '<>') {
        if (SENSITIVE.test(r.target.value)) c.v.add('read', `may expose secrets (${clip(r.target.value, 40)})`);
        this.readsPaths(c, [r.target.value]);
      }
      const fileDup = r.op === '>&' && !/^(\d+|-)$/.test(r.target.value); // >&file == &>file
      if (['>', '>>', '>|', '&>', '&>>', '<>'].includes(r.op) || fileDup) {
        this.writeTo(c, r.target.value, r.op.endsWith('>>') ? 'appends to' : 'writes');
      }
    }
  }

  // ---- paths --------------------------------------------------------------------------------

  /** Absolute path, or undefined when it depends on variables / command output. */
  resolve(p: string, dir: string | undefined): string | undefined {
    let s = p;
    if (s === '~' || s.startsWith('~/')) {
      if (!this.home) return undefined;
      s = this.home + s.slice(1);
    } else if (/^\$\{?HOME\}?(\/|$)/.test(s)) {
      if (!this.home) return undefined;
      s = s.replace(/^\$\{?HOME\}?/, this.home);
    } else if (s.startsWith('~')) {
      return undefined; // ~otheruser
    }
    if (s.includes('$') || s.includes('`')) return undefined;
    if (s.startsWith('/')) return P.normalize(s).replace(/(.)\/+$/, '$1');
    if (dir === undefined) return undefined;
    return P.resolve(dir, s);
  }

  cat(abs: string | undefined): Cat {
    if (abs === undefined) return 'unknown';
    if (DEV_SINK.test(abs)) return 'null';
    if (abs === '/dev' || abs.startsWith('/dev/')) return 'device';
    if (abs === this.root) return 'wsroot';
    if (within(this.root, abs)) return 'workspace';
    if (abs === '/') return 'fsroot';
    if (this.home && abs === this.home) return 'home';
    if (within(abs, this.root)) return 'ancestor';
    if (this.temps.some((t) => abs === t || within(t, abs))) return 'temp';
    if (SYSTEM_DIRS.some((s) => abs === s || within(s, abs))) return 'system';
    return 'outside';
  }

  isOutside(dir: string | undefined): boolean {
    return ['fsroot', 'system', 'home', 'ancestor', 'outside'].includes(this.cat(dir));
  }

  /** Workspace-relative when inside, ~/.. under home, else absolute. */
  show(abs: string): string {
    if (abs === this.root) return '.';
    if (within(this.root, abs)) return clip(abs.slice(this.root.length + 1));
    if (this.home && within(this.home, abs)) return clip('~' + abs.slice(this.home.length));
    return clip(abs);
  }

  where(p: string, dir: string | undefined): { cat: Cat; show: string } {
    const abs = this.resolve(p, dir);
    return { cat: this.cat(abs), show: abs === undefined ? clip(p) : this.show(abs) };
  }

  /** A command writes (creates, modifies, moves onto) path p. */
  writeTo(c: Call, p: string, verb = 'writes'): void {
    const w = this.where(p, c.dir);
    switch (w.cat) {
      case 'null':
        return;
      case 'device':
        return c.v.block(`${verb} a raw device (${w.show})`);
      case 'fsroot':
      case 'system':
        return c.v.block(`${verb} a system location (${w.show})`);
      case 'home':
      case 'ancestor':
      case 'outside':
        return c.v.add('destructive', `${verb} ${w.show} (outside the workspace)`);
      case 'temp':
        return c.v.add('write', `${verb} a temp file (${w.show})`);
      case 'unknown':
        return c.v.add('write', `${verb} a computed path (${w.show})`);
      default:
        return c.v.add('write', `${verb} ${w.show}`);
    }
  }

  /** rm / rmdir / unlink of path p. `*`, `.` and `..` at the workspace root are as bad as `/`. */
  removePath(c: Call, p: string, recursive: boolean): void {
    const everything = /^(\.\/)?(\*|\.\*)$/.test(p); // rm -rf * : everything in the current dir
    const base = everything ? '.' : p.replace(/\/(\*|\.\*)?$/, '') || '/';
    const w = this.where(base, c.dir);
    const homeLiteral = /^(~|\$\{?HOME\}?)$/.test(base);
    if (recursive) {
      switch (w.cat) {
        case 'fsroot':
          return c.v.block('deletes the entire filesystem (rm -r /)');
        case 'home':
          return c.v.block('deletes your home directory recursively');
        case 'ancestor':
          return c.v.block(`deletes a parent of the workspace recursively (${w.show})`);
        case 'wsroot':
          return c.v.block('deletes the entire workspace recursively');
        case 'system':
        case 'device':
          return c.v.block(`deletes system files recursively (${w.show})`);
        case 'unknown':
          if (homeLiteral) return c.v.block('deletes your home directory recursively');
          return c.v.add('destructive', `deletes a computed path recursively (${w.show})`);
        case 'outside':
          return c.v.add('destructive', `deletes files recursively outside the workspace (${w.show})`);
        default:
          return c.v.add('destructive', `deletes files recursively (${w.show})`);
      }
    }
    switch (w.cat) {
      case 'fsroot':
      case 'system':
      case 'device':
        return c.v.block(`deletes system files (${w.show})`);
      case 'home':
      case 'ancestor':
      case 'outside':
        return c.v.add('destructive', `deletes files outside the workspace (${w.show})`);
      case 'wsroot':
        return c.v.add('destructive', 'deletes every file in the workspace root');
      case 'unknown':
        return c.v.add('write', `deletes a computed path (${w.show})`);
      case 'temp':
        return c.v.add('write', `deletes a temp file (${w.show})`);
      default:
        return everything ? c.v.add('destructive', `deletes every file in ${w.show}`) : c.v.add('write', `deletes ${w.show}`);
    }
  }

  /** Recursive operations (chmod -R, find -delete) on /, ~, a parent of the workspace or system dirs are blocked. */
  catastrophicDir(p: string, dir: string | undefined): string | undefined {
    const w = this.where(p.replace(/\/\*?$/, '') || '/', dir);
    if (w.cat === 'fsroot') return 'the filesystem root (/)';
    if (w.cat === 'home' || /^(~|\$\{?HOME\}?)\/?$/.test(p)) return 'your home directory';
    if (w.cat === 'ancestor') return `a parent of the workspace (${w.show})`;
    if (w.cat === 'system' || w.cat === 'device') return `system files (${w.show})`;
    return undefined;
  }

  /** git checkout -- . / git restore . : the pathspec covers the whole tree. */
  isWholeTree(p: string, dir: string | undefined): boolean {
    if (WHOLE_TREE.has(p)) return true;
    const abs = this.resolve(p, dir);
    return abs !== undefined && (abs === this.root || within(abs, this.root));
  }

  escalateOutside(c: Call, dir: string | undefined, start: number): void {
    if (dir !== c.dir && c.v.maxFrom(start) === rank('write') && this.isOutside(dir)) {
      c.v.add('destructive', `writes outside the workspace (in ${this.show(dir!)})`);
    }
  }
}

// =============================================================================================
// Handlers: commands whose class depends on their arguments
// =============================================================================================

/** Runs the wrapped command: `nohup X`, `timeout 30 X`, `nice -n 5 X`, ... */
function wrapper(withValue: readonly string[] = [], skipPositionals = 0): Handler {
  return (a, c, args) => {
    let i = 0;
    let skipped = 0;
    for (; i < args.length; i++) {
      const x = args[i];
      if (x === '--') {
        i++;
        break;
      }
      if (withValue.includes(x)) i++;
      else if (x.startsWith('-') && x !== '-') continue;
      else if (skipped < skipPositionals) skipped++;
      else break;
    }
    a.dispatch(c, args.slice(i));
  };
}

/** Runs a project-manager subcommand: `poetry run X`, `pipenv run X`, ... */
function projectManager(label: string): Handler {
  return (a, c, args) => {
    const { sub, rest } = subcommand(args, ['-C', '--directory', '--project', '-p', '-n', '--name', '--python']);
    if (sub === 'run') return a.dispatch(c, rest[0] === '--' ? rest.slice(1) : rest);
    if (sub === undefined) return c.v.add('read', `shows ${label} info`);
    if (['install', 'add', 'update', 'upgrade', 'lock', 'sync', 'create', 'self'].includes(sub)) return c.v.add('network', `installs packages (${label} ${sub})`);
    if (['show', 'check', 'env', 'info', 'list', 'graph', 'version', 'config', 'search'].includes(sub)) return c.v.add('read', `inspects the project (${label} ${sub})`);
    if (['activate', 'deactivate', 'shell'].includes(sub)) return c.v.add('read', `activates an environment (${label} ${sub})`, true);
    c.v.add('write', `runs ${label} ${sub}`);
  };
}

/** Script interpreters other than python/sh: node, ruby, perl, ... */
function interpreter(): Handler {
  return (a, c, args, name) => {
    if (args.length === 1 && ['--version', '-v', '-V', '--help', '-h'].includes(args[0])) return c.v.add('read', `prints the ${name} version`);
    if (c.subDownloads) return c.v.block(`runs downloaded code in ${name} (unreviewed remote code)`);
    if (args.some((x) => ['-e', '--eval', '-p', '--print', '-E', '-r', '-pe', '-ne', '-pi', '-i'].includes(x))) return c.v.add('write', `runs inline ${name} code`);
    const script = positionals(args)[0];
    if (script === undefined) return a.stdinCode(c, name, 'other');
    c.v.add('write', `runs a ${name} script (${clip(script, 40)})`);
  };
}

const PM_TEST_SCRIPT = /^(test|tests|lint|typecheck|type-check|check|check-types|tsc)(:.*)?$/;
const PM_INSTALL = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isntall', 'add', 'ci', 'clean-install', 'install-test', 'it', 'update', 'up', 'upgrade', 'u', 'dedupe', 'link', 'ln', 'upgrade-interactive']);
const PM_REMOVE = new Set(['uninstall', 'remove', 'rm', 'r', 'un', 'unlink']);
const PM_INSPECT = new Set(['ls', 'list', 'la', 'll', 'why', 'explain', 'root', 'bin', 'prefix', 'help', 'config', 'get', 'version-check']);
const PM_REGISTRY = new Set(['outdated', 'view', 'info', 'show', 'search', 'audit', 'ping', 'whoami', 'doctor', 'publish', 'unpublish', 'deprecate', 'dist-tag', 'owner', 'access', 'login', 'logout', 'adduser', 'token']);

function pmScript(c: Call, name: string, script: string, rest: string[] = []): void {
  const fixes = rest.includes('--fix') || rest.includes('--write') || rest.includes('-u');
  c.v.add(PM_TEST_SCRIPT.test(script) && !fixes ? 'test' : 'write', `runs the ${script} script (${name})`);
}

/** npx / bunx / pnpm dlx: a local test tool, or a package that may be downloaded and run. */
const npx: Handler = (a, c, args) => {
  let i = 0;
  let noInstall = false;
  for (; i < args.length; i++) {
    const x = args[i];
    if (x === '-p' || x === '--package') i++;
    else if (x === '-c' || x === '--call') return a.nested(c, args[i + 1] ?? '');
    else if (x === '--no-install' || x === '--no') noInstall = true;
    else if (!x.startsWith('-')) break;
  }
  const rest = args.slice(i);
  if (!rest.length) return c.v.add('read', 'npx without a command', true);
  const tool = normaliseName(rest[0].replace(/(.)@[^/]*$/, '$1'));
  if (LOCAL_JS_TOOLS.has(tool)) return a.dispatch(c, [tool, ...rest.slice(1)]);
  c.v.add(noInstall ? 'write' : 'network', noInstall ? `runs ${clip(rest[0], 40)}` : `may download and run the package ${clip(rest[0], 40)}`);
};

const shell: Handler = (a, c, args, name) => {
  let i = 0;
  let code: string | undefined;
  let codeAtRunTime = false;
  let fromStdin = false;
  for (; i < args.length; i++) {
    const x = args[i];
    if (x === '--') {
      i++;
      break;
    }
    if (['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(x)) i++;
    else if (/^-[A-Za-z]+$/.test(x)) {
      if (x.includes('c')) {
        code = args[i + 1];
        // `.. | xargs bash -c`: xargs appends stdin as the code
        codeAtRunTime = code === undefined;
        break;
      }
      if (x.includes('s')) fromStdin = true;
      if (/[oO]$/.test(x)) i++; // -euo pipefail
    } else if (!x.startsWith('-') && !x.startsWith('+')) break;
  }
  if (codeAtRunTime) {
    if (c.subDownloads || c.stdin.kind === 'download') return c.v.block(`runs downloaded content in ${name} (unreviewed remote code)`);
    if (c.stdin.kind === 'text') return a.nested(c, c.stdin.text);
    return c.v.add('write', 'runs shell code supplied at run time');
  }
  if (code !== undefined) {
    if (c.subDownloads) c.v.block(`runs downloaded content in ${name} (unreviewed remote code)`);
    if (code.trim()) a.nested(c, code);
    else c.v.add('read', 'empty shell command', true);
    return;
  }
  const script = fromStdin ? undefined : args[i];
  if (script === undefined) return a.stdinCode(c, name, 'shell');
  if (c.subDownloads) return c.v.block(`runs a downloaded script in ${name} (unreviewed remote code)`);
  if (a.codeFromFile(c, script, name, 'shell')) return;
  c.v.add('write', `runs a shell script (${clip(script, 40)})`);
};

const python: Handler = (a, c, args, name) => {
  let i = 0;
  for (; i < args.length; i++) {
    const x = args[i];
    if (x === '-m' || (x.startsWith('-m') && x.length > 2 && !x.startsWith('--'))) {
      const mod = x === '-m' ? args[i + 1] : x.slice(2);
      const rest = args.slice(x === '-m' ? i + 2 : i + 1);
      if (!mod) return c.v.add('write', 'runs python');
      if (PY_TOOL_MODULES.has(mod)) return a.dispatch(c, [mod, ...rest]);
      const [risk, reason] = own(PY_MODULES, mod) ?? (['write', `runs the python module ${clip(mod, 40)}`] as const);
      return c.v.add(risk, reason);
    }
    if (x === '-c') {
      if (c.subDownloads) return c.v.block('runs downloaded python code (unreviewed remote code)');
      const [risk, reason] = analysePython(args[i + 1] ?? '');
      return c.v.add(risk, reason);
    }
    if (x === '-') return a.stdinCode(c, name, 'python');
    if (['-V', '--version', '-h', '--help'].includes(x)) return c.v.add('read', 'prints the python version');
    if (x === '-W' || x === '-X' || x === '--check-hash-based-pycs') i++;
    else if (!x.startsWith('-')) break;
  }
  const script = args[i];
  if (script === undefined) return a.stdinCode(c, name, 'python');
  if (c.subDownloads) return c.v.block('runs a downloaded python script (unreviewed remote code)');
  if (a.codeFromFile(c, script, name, 'python')) return;
  c.v.add('write', `runs a python script (${clip(script, 40)})`);
};

const flask: Handler = (_a, c, args) => {
  let i = 0;
  for (; i < args.length; i++) {
    const x = args[i];
    if (['--app', '-A', '--env-file', '-e'].includes(x)) i++;
    else if (x === '--version') return c.v.add('read', 'prints the flask version');
    else if (x === '--help') return c.v.add('test', 'shows the flask CLI help');
    else if (!x.startsWith('-')) break;
  }
  const sub = args[i];
  if (sub === undefined) return c.v.add('test', 'shows the flask CLI help');
  if (args.slice(i + 1).includes('--help')) return c.v.add('test', `shows help for flask ${clip(sub, 30)}`);
  const [risk, reason] = own(FLASK_SUBCOMMANDS, sub) ?? (['write', `runs the flask command "${clip(sub, 30)}"`] as const);
  c.v.add(risk, reason);
};

const pip: Handler = (_a, c, args) => {
  const { sub, rest } = subcommand(args, ['--index-url', '-i', '--extra-index-url', '--proxy', '--cache-dir', '--log', '--timeout', '--retries', '--python', '--trusted-host']);
  if (sub === undefined) return c.v.add('read', hasFlag(args, ['--version'], 'V') ? 'prints the pip version' : 'shows pip help');
  if (sub === 'config' || sub === 'cache') {
    const op = positionals(rest)[0];
    return ['list', 'get', 'debug', 'info', 'dir'].includes(op ?? 'list') ? c.v.add('read', `reads pip ${sub}`) : c.v.add('write', `changes pip ${sub}`);
  }
  const [risk, reason] = own(PIP_SUBCOMMANDS, sub) ?? (['write', `runs pip ${clip(sub, 30)}`] as const);
  c.v.add(risk, reason);
};

const uv: Handler = (a, c, args) => {
  const { sub, rest } = subcommand(args, ['--directory', '--project', '--cache-dir', '--python', '-p']);
  switch (sub) {
    case undefined:
      return c.v.add('read', 'shows uv info');
    case 'pip':
      return a.dispatch(c, ['pip', ...rest]);
    case 'run': {
      const withValue = ['--with', '--python', '-p', '--project', '--directory', '--package', '--extra', '--group', '--env-file', '--index', '--with-requirements'];
      let i = 0;
      for (; i < rest.length; i++) {
        if (withValue.includes(rest[i])) i++;
        else if (rest[i] === '-m' || rest[i] === '--module') return a.dispatch(c, ['python', '-m', ...rest.slice(i + 1)]);
        else if (rest[i] === '--') {
          i++;
          break;
        } else if (!rest[i].startsWith('-')) break;
      }
      return a.dispatch(c, rest.slice(i));
    }
    case 'tool':
      return rest[0] === 'run' ? npx(a, c, rest.slice(1), 'uvx') : c.v.add(rest[0] === 'list' || rest[0] === 'dir' ? 'read' : 'network', `manages uv tools (uv tool ${rest[0] ?? ''})`.trim());
    case 'add':
    case 'sync':
    case 'lock':
    case 'publish':
      return c.v.add('network', `installs packages (uv ${sub})`);
    case 'python':
      return c.v.add(rest[0] === 'install' ? 'network' : 'read', `manages python versions (uv python ${rest[0] ?? ''})`.trim());
    case 'tree':
    case 'version':
    case 'help':
    case 'export':
      return c.v.add('read', `inspects the project (uv ${sub})`);
    case 'venv':
      return c.v.add('write', 'creates a virtualenv');
    default:
      return c.v.add('write', `runs uv ${clip(sub, 30)}`);
  }
};

/** npm / pnpm / yarn / bun. */
const packageManager: Handler = (a, c, args, name) => {
  const { sub, rest } = subcommand(args, ['--prefix', '-C', '--dir', '--cwd', '--filter', '-F', '--workspace']);
  if (sub === undefined) {
    if (hasFlag(args, ['--version'], 'v')) return c.v.add('read', `prints the ${name} version`);
    return name === 'yarn' || name === 'bun' ? c.v.add('network', `installs packages (${name})`) : c.v.add('read', `shows ${name} help`);
  }
  if (sub === 'test' || sub === 't' || sub === 'tst') return c.v.add('test', `runs ${name} test`);
  if (sub === 'run' || sub === 'run-script' || sub === 'rum' || sub === 'urn') {
    const script = positionals(rest)[0];
    return script ? pmScript(c, name, script, rest) : c.v.add('read', 'lists package scripts');
  }
  if (sub === 'exec' || sub === 'x' || sub === 'dlx') return npx(a, c, rest, name);
  if (PM_INSTALL.has(sub)) return c.v.add('network', `installs packages (${name} ${sub})`);
  if (PM_REMOVE.has(sub)) return c.v.add('write', `removes packages (${name} ${sub})`);
  if (PM_INSPECT.has(sub)) return c.v.add('read', `inspects packages (${name} ${sub})`);
  if (PM_REGISTRY.has(sub)) return c.v.add('network', `talks to the package registry (${name} ${sub})`);
  if (sub === 'create' || sub === 'init') return positionals(rest).length ? c.v.add('network', 'scaffolds a project from a downloaded template') : c.v.add('write', 'creates package.json');
  if (['start', 'restart', 'stop', 'serve', 'dev', 'version', 'pack', 'build', 'cache', 'prune', 'rebuild'].includes(sub)) {
    return c.v.add('write', `runs ${name} ${sub}`);
  }
  if (name === 'npm') return c.v.add('write', `runs npm ${clip(sub, 30)}`);
  if (name === 'bun' && /\.(m?[jt]sx?|cjs)$/.test(sub)) return c.v.add('write', `runs a script (${clip(sub, 40)})`);
  pmScript(c, name, sub, rest); // yarn lint / pnpm typecheck: shorthand for run
};

const git: Handler = (a, c, args) => {
  let dir = c.dir;
  let i = 0;
  const configs: Array<{ key: string; value?: string }> = [];
  for (; i < args.length; i++) {
    const x = args[i];
    if (x === '-C') dir = a.resolve(args[++i] ?? '.', dir);
    else if (x === '-c') {
      const kv = args[++i] ?? '';
      const eq = kv.indexOf('=');
      configs.push(eq < 0 ? { key: kv } : { key: kv.slice(0, eq), value: kv.slice(eq + 1) });
    } else if (x === '--config-env') configs.push({ key: (args[++i] ?? '').split('=')[0] });
    else if (x.startsWith('--config-env=')) configs.push({ key: x.slice('--config-env='.length).split('=')[0] });
    else if (x.startsWith('--exec-path=')) c.v.add('write', 'changes where git finds its programs (--exec-path)');
    else if (['--git-dir', '--work-tree', '--namespace', '--super-prefix'].includes(x)) i++;
    else if (!x.startsWith('-')) break;
  }
  // git -c core.fsmonitor=CMD / alias.x='!CMD' / diff.external=CMD ... run CMD: analyse it, and ask anyway.
  for (const cfg of configs) {
    const runs = GIT_CONFIG_RUNS.test(cfg.key);
    if (runs && cfg.value?.trim()) a.nested(c, cfg.value.replace(/^\s*!/, ''));
    c.v.add('write', runs ? `overrides git config that runs commands (${clip(cfg.key, 30)})` : 'overrides git config (can run programs)');
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const pos = positionals(rest);
  const start = c.v.list.length;
  const R = (risk: CommandRisk, reason: string): void => c.v.add(risk, reason);
  const all = (paths: string[]): boolean => paths.some((p) => a.isWholeTree(p, dir));
  switch (sub) {
    case undefined:
      R('read', 'shows git help');
      break;
    case 'branch': {
      const forceDelete = rest.some((x) => /^-[A-Za-z]*D[A-Za-z]*$/.test(x)) || (hasFlag(rest, ['--delete'], 'd') && hasFlag(rest, ['--force'], 'f'));
      if (forceDelete) R('destructive', 'force-deletes a branch (git branch -D)');
      else if (hasFlag(rest, ['--delete'], 'd')) R('write', 'deletes a merged branch');
      else if (hasFlag(rest, ['--move', '--copy', '--set-upstream-to', '--unset-upstream', '--edit-description'], 'mMcCu')) R('write', 'renames or configures a branch');
      else if (positionals(rest, ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format']).length && !hasFlag(rest, ['--list'], 'l')) R('write', 'creates a branch');
      else R('read', 'lists branches');
      break;
    }
    case 'checkout': {
      const dd = rest.indexOf('--');
      const paths = dd >= 0 ? rest.slice(dd + 1) : positionals(rest, ['-b', '-B', '--orphan', '--conflict']);
      if (hasFlag(rest.slice(0, dd >= 0 ? dd : undefined), ['--force'], 'f')) R('destructive', 'discards local changes (git checkout -f)');
      else if (all(paths)) R('destructive', 'discards all uncommitted changes (git checkout -- .)');
      else if (dd >= 0) R('write', `discards uncommitted changes to ${clip(paths.join(' '), 50)}`);
      else if (paths.length >= 2) R('write', 'restores files from another commit');
      else R('write', 'switches branches');
      break;
    }
    case 'restore': {
      const paths = positionals(rest, ['-s', '--source']);
      if (hasFlag(rest, ['--staged'], 'S') && !hasFlag(rest, ['--worktree'], 'W')) R('write', 'unstages files (git restore --staged)');
      else if (all(paths)) R('destructive', 'discards all uncommitted changes (git restore .)');
      else R('write', `discards uncommitted changes to ${clip(paths.join(' '), 50)}`);
      break;
    }
    case 'reset':
      if (rest.includes('--hard')) R('destructive', 'discards all uncommitted changes (git reset --hard)');
      else R('write', 'moves HEAD or unstages files (git reset)');
      break;
    case 'clean':
      if (hasFlag(rest, ['--dry-run'], 'n')) R('read', 'lists untracked files (git clean -n)');
      else if (hasFlag(rest, ['--force'], 'f')) R('destructive', 'deletes untracked files (git clean -f)');
      else R('write', 'runs git clean');
      break;
    case 'stash':
      if (pos[0] === 'list' || pos[0] === 'show') R('read', 'shows stashes');
      else if (pos[0] === 'clear') R('destructive', 'drops every stash (git stash clear)');
      else R('write', pos[0] === 'drop' ? 'drops a stash' : 'stashes or restores changes (git stash)');
      break;
    case 'rm':
      if (hasFlag(rest, ['--dry-run'], 'n')) R('read', 'lists files git rm would delete');
      else if (hasFlag(rest, ['--cached'])) R('write', 'untracks files (git rm --cached)');
      else if (hasFlag(rest, [], 'r')) R('destructive', 'deletes files recursively (git rm -r)');
      else R('write', 'deletes tracked files (git rm)');
      break;
    case 'push': {
      const force = rest.some((x) => x === '--force' || x.startsWith('--force-with-lease') || x === '--force-if-includes' || /^-[A-Za-z]*f[A-Za-z]*$/.test(x) || /^\+/.test(x));
      if (force) c.v.block('git push --force rewrites remote history');
      else if (rest.some((x) => x === '--delete' || x === '-d' || x === '--mirror' || x === '--prune' || /^:/.test(x))) R('destructive', 'deletes remote branches (git push --delete)');
      else R('network', 'pushes commits to a remote');
      break;
    }
    case 'remote':
      if (!pos.length || pos[0] === 'get-url') R('read', 'lists remotes');
      else if (['show', 'update', 'prune'].includes(pos[0])) R('network', 'queries a remote');
      else R('write', 'changes remotes');
      break;
    case 'config':
      if (hasFlag(rest, ['--get', '--get-all', '--get-regexp', '--list', '--show-origin', '--get-urlmatch'], 'l') || ['get', 'list'].includes(pos[0])) R('read', 'reads git config');
      else if (positionals(rest, ['--file', '-f', '--type', '--default', '--blob']).length <= 1 && !hasFlag(rest, ['--unset', '--unset-all', '--add', '--replace-all', '--rename-section', '--remove-section', '--edit'], 'e')) R('read', 'reads git config');
      else R('write', 'changes git config');
      break;
    case 'tag':
      if (hasFlag(rest, ['--delete'], 'd')) R('write', 'deletes a tag');
      else if (!positionals(rest, ['-m', '-F', '--sort', '--format', '--contains', '--points-at', '-u']).length || hasFlag(rest, ['--list'], 'l')) R('read', 'lists tags');
      else R('write', 'creates a tag');
      break;
    case 'reflog':
      if (pos[0] === 'expire' || pos[0] === 'delete') R('destructive', 'expires reflog entries (loses recovery points)');
      else R('read', 'shows the reflog');
      break;
    case 'submodule':
      if (!pos.length || pos[0] === 'status' || pos[0] === 'summary' || pos[0] === 'foreach') R(pos[0] === 'foreach' ? 'write' : 'read', 'inspects submodules');
      else R('network', 'updates submodules');
      break;
    case 'worktree':
      R(pos[0] === 'list' ? 'read' : 'write', `manages worktrees (git worktree ${pos[0] ?? ''})`.trim());
      break;
    case 'filter-branch':
    case 'filter-repo':
      R('destructive', 'rewrites repository history');
      break;
    default:
      if (['diff', 'log', 'show', 'whatchanged'].includes(sub)) {
        for (let k = 0; k < rest.length; k++) {
          const x = rest[k];
          if (x === '--') break;
          if (x === '--output') a.writeTo(c, rest[++k] ?? '');
          else if (x.startsWith('--output=')) a.writeTo(c, x.slice('--output='.length));
          else if (x === '--ext-diff') R('write', `runs an external diff program (git ${sub} --ext-diff)`);
        }
      } else if (sub === 'grep') {
        for (const x of rest) {
          if (x === '--') break;
          const pager = x.startsWith('--open-files-in-pager=') ? x.slice('--open-files-in-pager='.length) : /^-O./.test(x) ? x.slice(2) : undefined;
          if (pager?.trim()) a.nested(c, pager);
          if (pager !== undefined || x === '-O' || x === '--open-files-in-pager') R('write', 'opens the matching files in a pager (git grep -O)');
        }
      }
      if (own(GIT_READ, sub)) R('read', own(GIT_READ, sub)!);
      else if (GIT_INSPECT.has(sub)) R('read', `inspects the repository (git ${sub})`);
      else if (own(GIT_NETWORK, sub)) R('network', own(GIT_NETWORK, sub)!);
      else R('write', own(GIT_WRITE, sub) ?? `runs git ${clip(sub, 30)}`);
  }
  a.escalateOutside(c, dir, start);
};

const rm: Handler = (a, c, args) => {
  const recursive = hasFlag(args, ['--recursive'], 'rR');
  if (args.includes('--no-preserve-root')) c.v.block('rm --no-preserve-root disables the guard against deleting /');
  const targets = positionals(args);
  if (!targets.length) c.v.add(recursive ? 'destructive' : 'write', recursive ? 'deletes files recursively' : 'deletes files');
  for (const t of targets) a.removePath(c, t, recursive);
};

/** chmod / chown / chgrp: first positional is the mode or owner. */
const permissions: Handler = (a, c, args, name) => {
  const recursive = hasFlag(args, ['--recursive'], 'R');
  const pos = positionals(args);
  const targets = args.some((x) => x.startsWith('--reference')) ? pos : pos.slice(1);
  const what = name === 'chmod' ? 'permissions' : 'ownership';
  if (!targets.length) return c.v.add('write', `changes ${what}`);
  for (const t of targets) {
    if (!recursive) {
      a.writeTo(c, t, `changes ${what} of`);
      continue;
    }
    const bad = a.catastrophicDir(t, c.dir);
    if (bad) c.v.block(`${name} -R changes ${what} of ${bad}`);
    else c.v.add('destructive', `changes ${what} recursively (${clip(t, 40)})`);
  }
};

const find: Handler = (a, c, args) => {
  let i = 0;
  while (i < args.length && ['-H', '-L', '-P', '-E', '-X', '-s', '-x'].includes(args[i])) i++;
  const starts: string[] = [];
  while (i < args.length && !args[i].startsWith('-') && !['(', '!', ')'].includes(args[i])) starts.push(args[i++]);
  if (!starts.length) starts.push('.');
  const massDelete = (how: string): void => {
    const bad = starts.map((s) => a.catastrophicDir(s, c.dir)).find(Boolean);
    if (bad) c.v.block(`${how} deletes files under ${bad}`);
    else c.v.add('destructive', `deletes the files find matches (${how})`);
  };
  for (let k = i; k < args.length; k++) {
    const t = args[k];
    if (t === '-delete') massDelete('find -delete');
    else if (['-exec', '-execdir', '-ok', '-okdir'].includes(t)) {
      let end = args.findIndex((x, j) => j > k && (x === ';' || x === '+'));
      if (end < 0) end = args.length;
      const inner = args.slice(k + 1, end);
      if (inner.length && ['rm', 'shred', 'unlink', 'srm'].includes(normaliseName(inner[0]))) massDelete(`find ${t} rm`);
      else a.dispatch(c, inner);
      k = end;
    } else if (['-fprint', '-fprint0', '-fprintf', '-fls'].includes(t) && args[k + 1] !== undefined) {
      a.writeTo(c, args[++k]);
    }
  }
  c.v.add('read', 'finds files');
  a.readsPaths(c, starts);
};

const sed: Handler = (a, c, args) => {
  let inPlace = false;
  let quiet = false;
  let fromFile = false;
  const scripts: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (x === '-i' || x === '--in-place') {
      inPlace = true;
      if (args[i + 1] === '' || /^\.[\w.-]{0,12}$/.test(args[i + 1] ?? '')) i++; // BSD: -i '' / -i .bak
    } else if (/^-i[^A-Za-z]/.test(x) || x.startsWith('--in-place=')) {
      inPlace = true;
    } else if (x === '-e' || x === '--expression') {
      scripts.push(args[++i] ?? '');
    } else if (x === '-f' || x === '--file') {
      fromFile = true;
      i++;
    } else if (x === '-n' || x === '--quiet' || x === '--silent') {
      quiet = true;
    } else if (/^-[A-Za-z]+$/.test(x)) {
      if (x.includes('i')) inPlace = true;
      if (x.includes('n')) quiet = true;
      if (x.endsWith('e')) scripts.push(args[++i] ?? '');
      else if (x.endsWith('f')) {
        fromFile = true;
        i++;
      }
    } else if (x.startsWith('-') && x !== '-') {
      continue;
    } else if (!scripts.length && !fromFile) {
      scripts.push(x);
    } else {
      files.push(x);
    }
  }
  if (inPlace) {
    if (!files.length) return c.v.add('write', 'edits files in place (sed -i)');
    for (const f of files) a.writeTo(c, f, 'edits');
    return;
  }
  const writes = scripts.some((s) => /(^|[^\\A-Za-z])[wW]\s+\S/.test(s) || /(^|[;\n{]\s*)e(\s|$)/.test(s));
  if (fromFile || writes) return c.v.add('write', fromFile ? 'runs a sed script file' : 'sed script writes files');
  c.v.add('read', quiet ? 'prints lines (sed -n)' : 'prints edited text (sed)');
};

const awk: Handler = (a, c, args, name) => {
  let program: string | undefined;
  let script = false;
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (x === '-f' || x === '--file') {
      script = true;
      i++;
    } else if (x === '-i' || x === '--include') {
      if (args[i + 1] === 'inplace') return c.v.add('write', `edits files in place (${name} -i inplace)`);
      i++;
    } else if (x === '-v' || x === '-F' || x === '--assign' || x === '--field-separator') i++;
    else if (x.startsWith('-') && x !== '-') continue;
    else if (program === undefined && !script) program = x;
  }
  if (script) return c.v.add('write', `runs an ${name} script file`);
  if (program && /\bprintf?\b[^;}]{0,200}?(>|\|)|\bsystem\s*\(|\|\s*getline/.test(program)) return c.v.add('write', `${name} program writes files or runs commands`);
  c.v.add('read', `processes text (${name})`);
};

const cd: Handler = (a, c, args, name) => {
  const target = positionals(args)[0];
  const next = target === undefined || target === '~' ? a.home : target === '-' ? undefined : a.resolve(target, c.dir);
  c.newDir = next;
  const cat = a.cat(next);
  if (cat === 'workspace' || cat === 'wsroot') c.v.add('read', 'changes directory', true);
  else if (cat === 'unknown') c.v.add('read', `changes to a computed directory (${clip(target ?? '~', 40)})`, true);
  else c.v.add('read', `leaves the workspace (${name} ${a.show(next!)})`);
};

const copyMove: Handler = (a, c, args, name) => {
  const pos = positionals(args, ['-t', '--target-directory', '-S', '--suffix']);
  const tIdx = args.findIndex((x) => x === '-t' || x === '--target-directory');
  const dest = tIdx >= 0 ? args[tIdx + 1] : pos.length >= 2 ? pos[pos.length - 1] : undefined;
  const verb = name === 'cp' ? 'copies into' : name === 'ln' ? 'links' : 'moves into';
  if (dest === undefined) return c.v.add('write', name === 'cp' ? 'copies files' : name === 'ln' ? 'creates links' : 'moves files');
  a.writeTo(c, dest, verb);
  // mv also removes its sources
  if (name === 'mv') for (const s of pos.filter((p) => p !== dest)) a.writeTo(c, s, 'moves');
};

/** touch, mkdir, tee, truncate, shred: every positional is written. */
function writesEach(verb: string, withValue: readonly string[] = [], extra?: [CommandRisk, string]): Handler {
  return (a, c, args) => {
    if (extra) c.v.add(extra[0], extra[1]);
    const targets = positionals(args, withValue);
    if (!targets.length && !extra) c.v.add('read', 'copies input to output', true);
    for (const t of targets) a.writeTo(c, t, verb);
  };
}

const dd: Handler = (a, c, args) => {
  c.v.add('destructive', 'dd copies raw bytes and can overwrite anything');
  for (const x of args) if (x.startsWith('of=')) a.writeTo(c, x.slice(3));
};

const kill: Handler = (_a, c, args) => {
  let i = 0;
  if (args[0] === '-s' || args[0] === '-n') i = 2;
  else if (args.length > 1 && /^-(\d+|[A-Z]+[A-Z0-9+-]*|SIG\w+)$/i.test(args[0])) i = 1;
  if (args[i] === '--') i++;
  if (args.slice(i).includes('-1')) return c.v.block('kill -1 signals every process you own');
  c.v.add('write', 'stops processes');
};

const sort: Handler = (a, c, args) => {
  const cp = args.findIndex((x) => x === '--compress-program');
  const cpAttached = args.find((x) => x.startsWith('--compress-program='));
  if (cp >= 0 || cpAttached) {
    const prog = cpAttached ? cpAttached.slice('--compress-program='.length) : (args[cp + 1] ?? '');
    if (prog.trim()) a.nested(c, prog);
    c.v.add('write', 'runs a compression program (sort --compress-program)');
  }
  const o = args.findIndex((x) => x === '-o' || x === '--output');
  const attached = args.find((x) => x.startsWith('--output=') || /^-o./.test(x));
  if (o >= 0 && args[o + 1] !== undefined) a.writeTo(c, args[o + 1]);
  else if (attached) a.writeTo(c, attached.replace(/^(--output=|-o)/, ''));
  else c.v.add('read', 'sorts lines');
  a.readsPaths(c, positionals(args, ['-o', '--output', '-k', '--key', '-t', '--field-separator', '-S', '--buffer-size', '-T', '--temporary-directory', '--compress-program', '--parallel', '--batch-size', '--random-source', '--files0-from']));
};

/** rg: read-only, except --pre runs a program on every file. */
const rg: Handler = (a, c, args, name) => {
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (x === '--') break;
    const pre = x === '--pre' ? (args[++i] ?? '') : x.startsWith('--pre=') ? x.slice('--pre='.length) : undefined;
    if (pre === undefined) continue;
    if (pre.trim()) a.nested(c, pre);
    c.v.add('write', 'runs a preprocessor program on every file (rg --pre)');
  }
  c.v.add('read', 'searches file contents');
  a.readsFiles(c, name, args);
};

/** trap 'CODE' SIGNAL: CODE runs later (on exit or a signal) in this shell. */
const trap: Handler = (a, c, args) => {
  const p = args[0] === '--' ? args.slice(1) : args;
  if (p.length >= 2 && !p[0].startsWith('-') && p[0].trim()) a.nested(c, p[0]);
  c.v.add('read', 'sets a signal trap', true);
};

/** alias name='CODE': CODE runs whenever the alias is used (shopt -s expand_aliases). */
const alias: Handler = (a, c, args) => {
  let defined = false;
  for (const x of args) {
    const m = /^[^=]+=([\s\S]*)$/.exec(x);
    if (!m) continue;
    defined = true;
    if (m[1].trim()) a.nested(c, m[1]);
  }
  c.v.add('read', defined ? 'defines an alias' : 'lists aliases', true);
};

/** export / declare / typeset / local / readonly: NAME=value assignments are checked like `NAME=value cmd`. */
const declareLike: Handler = (a, c, args, name) => {
  for (const x of args) {
    const m = /^([A-Za-z_]\w*)(?:\[[^\]]*\])?\+?=([\s\S]*)$/.exec(x);
    if (m) a.envAssign(c, m[1], m[2]);
  }
  if (!positionals(args).length) {
    return c.v.add('read', name === 'export' ? 'prints environment variables (may expose secrets)' : `prints shell variables (${name}; may expose secrets)`);
  }
  c.v.add('read', name === 'export' ? 'sets environment variables' : 'sets shell variables', true);
};

/** source FILE / . FILE */
const source: Handler = (a, c, args) => {
  const f = args[0] ?? '';
  if (c.subDownloads) return c.v.block('sources downloaded content (runs unreviewed remote code)');
  if (/(^|\/)bin\/activate(\.(sh|bash|zsh|fish|csh))?$/.test(f)) return c.v.add('read', 'activates the virtualenv', true);
  if (a.codeFromFile(c, f, 'source', 'shell')) return;
  c.v.add('write', `runs a shell script (${clip(f, 40)})`);
};

const curlLike: Handler = (a, c, args, name) => {
  let upload = false;
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (x === '-o' || x === '--output' || (name === 'wget' && (x === '-O' || x === '--output-document' || x === '-P' || x === '--directory-prefix'))) {
      const f = args[++i];
      if (f && f !== '-') a.writeTo(c, f, 'downloads into');
    } else if (/^--(output|output-document|directory-prefix)=/.test(x)) {
      const f = x.slice(x.indexOf('=') + 1);
      if (f !== '-') a.writeTo(c, f, 'downloads into');
    } else if (/^-[A-Za-z]+$/.test(x) && (x.endsWith('o') || (name === 'wget' && x.endsWith('O')))) {
      const f = args[++i]; // -sSLo out / -qO-
      if (f && f !== '-') a.writeTo(c, f, 'downloads into');
    } else if (['-d', '--data', '--data-binary', '--data-raw', '--data-urlencode', '-F', '--form', '-T', '--upload-file', '--json', '--post-data', '--post-file'].includes(x) || /^--(data|form|json|post)/.test(x)) {
      upload = true;
    }
  }
  c.v.add('network', upload ? `sends data over the network (${name})` : `downloads from the network (${name})`);
};

const rsyncScp: Handler = (a, c, args, name) => {
  const pos = positionals(args, ['-e', '--rsh', '-i', '-P', '-o', '-F', '--exclude', '--include', '--filter']);
  const remote = pos.some((p) => /^[^/]*:/.test(p) || p.includes('::'));
  if (args.some((x) => x.startsWith('--delete') || x === '--remove-source-files')) c.v.add('destructive', `deletes files (${name} --delete)`);
  if (remote) c.v.add('network', `copies files to or from a remote host (${name})`);
  const dest = pos[pos.length - 1];
  if (pos.length >= 2 && dest !== undefined && !/^[^/]*:/.test(dest)) a.writeTo(c, dest, 'copies into');
  else if (!remote) c.v.add('write', `copies files (${name})`);
};

const make: Handler = (_a, c, args) => {
  if (hasFlag(args, ['--dry-run', '--just-print', '--recon', '-n'])) return c.v.add('read', 'shows what make would run (dry run)');
  const targets = positionals(args, ['-C', '-f', '--directory', '--file', '-j', '--jobs', '-o', '-W', '-I']).filter((t) => !t.includes('='));
  c.v.add('write', `runs make${targets.length ? ' ' + clip(targets.join(' '), 40) : ''}`);
};

/** Formatters/linters that only report unless asked to fix: black, isort, ruff, eslint, prettier, ... */
function checker(label: string, opts: { checkFlags?: string[]; fixFlags?: string[]; writesByDefault?: boolean; readByDefault?: boolean }): Handler {
  return (_a, c, args) => {
    if (args.length === 1 && ['--version', '-V'].includes(args[0])) return c.v.add('read', `prints the ${label} version`);
    if (opts.checkFlags && hasFlag(args, opts.checkFlags)) return c.v.add('test', `checks code (${label} ${opts.checkFlags.find((f) => args.includes(f)) ?? '--check'})`);
    if (opts.fixFlags && hasFlag(args, opts.fixFlags)) return c.v.add('write', `rewrites files (${label} ${opts.fixFlags.find((f) => args.includes(f)) ?? '--fix'})`);
    if (opts.writesByDefault) return c.v.add('write', `reformats files (${label})`);
    if (opts.readByDefault) return c.v.add('read', `prints formatted output (${label})`);
    c.v.add('test', `runs ${label}`);
  };
}

const ruff: Handler = (a, c, args) => {
  const { sub, rest } = subcommand(args);
  if (sub === 'format') return checker('ruff format', { checkFlags: ['--check', '--diff'], writesByDefault: true })(a, c, rest, 'ruff');
  if (args.includes('--fix') || args.includes('--unsafe-fixes')) return c.v.add('write', 'rewrites files (ruff --fix)');
  if (args.length === 1 && ['--version', '-V'].includes(args[0])) return c.v.add('read', 'prints the ruff version');
  c.v.add('test', 'runs ruff');
};

const tsc: Handler = (_a, c, args) => {
  if (args.length === 1 && ['--version', '-v', '--help', '-h'].includes(args[0])) return c.v.add('read', 'prints the tsc version');
  if (args.includes('--noEmit') || args.includes('--noemit')) return c.v.add('test', 'type-checks TypeScript (tsc --noEmit)');
  c.v.add('write', 'compiles TypeScript (emits files)');
};

/** jest / vitest: tests, unless they update snapshots. */
const jsTestRunner: Handler = (_a, c, args, name) => {
  if (hasFlag(args, ['--updateSnapshot', '--update', '-u'])) return c.v.add('write', `updates test snapshots (${name} -u)`);
  c.v.add('test', `runs ${name}`);
};

const coverage: Handler = (a, c, args) => {
  const { sub, rest } = subcommand(args, ['--rcfile']);
  if (sub === 'run') {
    const m = rest.indexOf('-m');
    if (m >= 0 && PY_TOOL_MODULES.has(rest[m + 1] ?? '')) return a.dispatch(c, [rest[m + 1], ...rest.slice(m + 2)]);
    if (m >= 0 && own(PY_MODULES, rest[m + 1])?.[0] === 'test') return c.v.add('test', `runs ${rest[m + 1]} under coverage`);
    return c.v.add('write', 'runs a python script under coverage');
  }
  if (sub === 'report' || sub === 'debug' || sub === undefined) return c.v.add('read', 'prints a coverage report');
  c.v.add('write', `writes coverage output (coverage ${sub})`);
};

/** cargo / go / dotnet / mvn / gradle / swift / deno: test-ish subcommands are tests. */
function buildTool(label: string, table: { test: string[]; read?: string[]; network?: string[] }): Handler {
  return (_a, c, args) => {
    const { sub, rest } = subcommand(args, ['-C', '--manifest-path', '-p', '--package', '-f', '--file']);
    if (sub === undefined) return c.v.add('read', `shows ${label} info`);
    if (table.test.includes(sub)) {
      if (rest.includes('--fix')) return c.v.add('write', `rewrites files (${label} ${sub} --fix)`);
      return c.v.add('test', `runs ${label} ${sub}`);
    }
    if (sub === 'fmt' || sub === 'format') return c.v.add(rest.includes('--check') ? 'test' : 'write', rest.includes('--check') ? `checks formatting (${label} ${sub} --check)` : `reformats code (${label} ${sub})`);
    if (sub === 'mod' && label === 'go') return c.v.add(['download', 'tidy', 'get'].includes(rest[0] ?? '') ? 'network' : 'write', `manages modules (go mod ${rest[0] ?? ''})`.trim());
    if (table.read?.includes(sub)) return c.v.add('read', `inspects the project (${label} ${sub})`);
    if (table.network?.includes(sub)) return c.v.add('network', `downloads or publishes packages (${label} ${sub})`);
    c.v.add('write', `runs ${label} ${clip(sub, 30)}`);
  };
}

const systemctl: Handler = (_a, c, args, name) => {
  const { sub } = subcommand(args);
  if (['reboot', 'poweroff', 'halt', 'suspend', 'hibernate', 'kexec', '0', '6'].includes(sub ?? '')) return c.v.block('shuts down or reboots the machine');
  if (/^(status|show|list|is-|cat)/.test(sub ?? 'status')) return c.v.add('read', `inspects services (${name})`);
  c.v.add('write', `changes services (${name} ${sub})`);
};

const diskutil: Handler = (_a, c, args) => {
  const { sub } = subcommand(args);
  if (/^(erase|partition|zero|random|secureErase|reformat|apfs)/i.test(sub ?? '')) return c.v.block('erases or partitions a disk (diskutil)');
  c.v.add(sub === 'list' || sub === 'info' ? 'read' : 'write', 'manages disks (diskutil)');
};

const docker: Handler = (_a, c, args, name) => {
  const { sub } = subcommand(args, ['-H', '--host', '--context', '-c', '--config']);
  if (['ps', 'images', 'logs', 'inspect', 'version', 'info', 'stats', 'top', 'history', 'port', 'diff'].includes(sub ?? 'version')) return c.v.add('read', `inspects containers (${name} ${sub ?? ''})`.trim());
  if (['pull', 'push', 'login', 'search', 'build'].includes(sub!)) return c.v.add('network', `${name} ${sub} uses the network`);
  c.v.add('write', `runs ${name} ${clip(sub!, 30)}`);
};

/** The handler table: one entry per command whose class depends on its arguments. */
const HANDLERS: Readonly<Record<string, Handler>> = {
  // shell plumbing
  echo: (_a, c, args) => {
    let i = 0;
    while (i < args.length && /^-[neE]+$/.test(args[i])) i++;
    c.echo = args.slice(i).join(' ');
    c.v.add('read', 'prints text', true);
  },
  printf: (_a, c, args) => {
    c.echo = args.join(' ');
    c.v.add('read', 'prints text', true);
  },
  cd,
  pushd: cd,
  env: (a, c, args) => {
    let i = 0;
    for (; i < args.length; i++) {
      const x = args[i];
      if (x === '-u' || x === '--unset' || x === '-C' || x === '--chdir') i++;
      else if (x === '-S' || x === '--split-string') return a.nested(c, args.slice(i + 1).join(' '));
      else if (/^[A-Za-z_]\w*=/.test(x)) a.envAssign(c, x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1));
      else if (!x.startsWith('-')) break;
    }
    if (i < args.length) a.dispatch(c, args.slice(i));
    else c.v.add('read', 'prints environment variables (may expose secrets)');
  },
  export: declareLike,
  declare: declareLike,
  typeset: declareLike,
  local: declareLike,
  readonly: declareLike,
  trap,
  alias,
  set: (_a, c, args) => (args.length ? c.v.add('read', 'sets shell options', true) : c.v.add('read', 'prints shell variables (may expose secrets)')),
  source,
  '.': source,
  man: (a, c, args) => {
    for (let i = 0; i < args.length; i++) {
      const x = args[i];
      const pager = x === '-P' || x === '--pager' ? (args[++i] ?? '') : x.startsWith('--pager=') ? x.slice('--pager='.length) : /^-P./.test(x) ? x.slice(2) : undefined;
      if (pager === undefined) continue;
      if (pager.trim()) a.nested(c, pager);
      c.v.add('write', 'runs a custom pager (man -P)');
    }
    c.v.add('read', 'shows a manual page', true);
  },
  eval: (a, c, args) => {
    if (c.subDownloads) c.v.block('evaluates downloaded content (runs unreviewed remote code)');
    a.nested(c, args.join(' '));
    c.v.add('write', 'evaluates a dynamically built command');
  },
  command: (a, c, args) => (args[0] === '-v' || args[0] === '-V' ? c.v.add('read', 'locates a program') : wrapper()(a, c, args, 'command')),
  exec: wrapper(['-a']),
  builtin: wrapper(),
  nohup: wrapper(),
  time: wrapper(),
  nice: wrapper(['-n', '--adjustment']),
  timeout: wrapper(['-s', '--signal', '-k', '--kill-after'], 1),
  stdbuf: wrapper(['-i', '-o', '-e']),
  caffeinate: wrapper(['-t', '-w']),
  unbuffer: wrapper(),
  chronic: wrapper(),
  // watch runs its arguments through `sh -c` (unless -x)
  watch: (a, c, args) => {
    let i = 0;
    let exec = false;
    for (; i < args.length; i++) {
      const x = args[i];
      if (x === '-n' || x === '--interval') i++;
      else if (x === '-x' || x === '--exec') exec = true;
      else if (x === '--') {
        i++;
        break;
      } else if (!x.startsWith('-')) break;
    }
    if (exec) a.dispatch(c, args.slice(i));
    else a.nested(c, args.slice(i).join(' '));
  },
  xargs: (a, c, args) => {
    const withValue = ['-I', '-n', '-L', '-P', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace', '--max-lines'];
    let i = 0;
    for (; i < args.length; i++) {
      if (withValue.includes(args[i])) i++;
      else if (!args[i].startsWith('-')) break;
    }
    a.dispatch(c, i < args.length ? args.slice(i) : ['echo']);
  },
  // shells and interpreters
  sh: shell,
  bash: shell,
  zsh: shell,
  dash: shell,
  ksh: shell,
  fish: shell,
  csh: shell,
  tcsh: shell,
  python,
  node: interpreter(),
  ruby: interpreter(),
  perl: interpreter(),
  php: interpreter(),
  lua: interpreter(),
  Rscript: interpreter(),
  osascript: interpreter(),
  // python tooling
  flask,
  pip,
  uv,
  uvx: npx,
  poetry: projectManager('poetry'),
  pipenv: projectManager('pipenv'),
  pdm: projectManager('pdm'),
  hatch: projectManager('hatch'),
  rye: projectManager('rye'),
  conda: projectManager('conda'),
  mamba: projectManager('mamba'),
  micromamba: projectManager('micromamba'),
  coverage,
  black: checker('black', { checkFlags: ['--check', '--diff'], writesByDefault: true }),
  isort: checker('isort', { checkFlags: ['--check', '--check-only', '-c', '--diff'], writesByDefault: true }),
  ruff,
  autopep8: checker('autopep8', { fixFlags: ['--in-place', '-i'], readByDefault: true }),
  codespell: checker('codespell', { fixFlags: ['--write-changes', '-w'] }),
  // JS tooling
  npm: packageManager,
  pnpm: packageManager,
  yarn: packageManager,
  bun: packageManager,
  npx,
  bunx: npx,
  pnpx: npx,
  jest: jsTestRunner,
  vitest: jsTestRunner,
  tsc,
  eslint: checker('eslint', { fixFlags: ['--fix', '--fix-dry-run'] }),
  stylelint: checker('stylelint', { fixFlags: ['--fix'] }),
  prettier: checker('prettier', { checkFlags: ['--check', '-c', '--list-different', '-l'], fixFlags: ['--write', '-w'], readByDefault: true }),
  // other build tools
  make,
  gmake: make,
  cargo: buildTool('cargo', { test: ['test', 'check', 'clippy', 'bench'], read: ['tree', 'metadata', 'version', 'help', 'locate-project', 'pkgid', 'verify-project'], network: ['install', 'add', 'fetch', 'update', 'publish', 'search', 'login', 'vendor'] }),
  go: buildTool('go', { test: ['test', 'vet'], read: ['version', 'env', 'list', 'doc', 'help'], network: ['get', 'install'] }),
  dotnet: buildTool('dotnet', { test: ['test'], read: ['--info', '--version', 'help', 'list'], network: ['restore', 'add', 'nuget', 'tool'] }),
  mvn: buildTool('mvn', { test: ['test', 'verify'], network: ['install', 'deploy', 'dependency:resolve'] }),
  gradle: buildTool('gradle', { test: ['test', 'check'], read: ['tasks', 'dependencies', 'properties', 'help'], network: ['publish'] }),
  swift: buildTool('swift', { test: ['test'], network: ['package'] }),
  deno: buildTool('deno', { test: ['test', 'lint', 'check'], read: ['info', 'doc', 'help'], network: ['install', 'add', 'cache'] }),
  // files
  rm,
  rmdir: (a, c, args) => positionals(args).forEach((t) => a.removePath(c, t, false)),
  unlink: (a, c, args) => positionals(args).forEach((t) => a.removePath(c, t, false)),
  cp: copyMove,
  mv: copyMove,
  ln: copyMove,
  touch: writesEach('creates', ['-t', '-r', '-d', '-A']),
  mkdir: writesEach('creates', ['-m', '--mode']),
  tee: (a, c, args) => writesEach(hasFlag(args, ['--append'], 'a') ? 'appends to' : 'writes')(a, c, args, 'tee'),
  truncate: writesEach('truncates', ['-s', '--size', '-r', '--reference'], ['destructive', 'truncates files']),
  shred: writesEach('shreds', ['-n', '--iterations', '-s', '--size'], ['destructive', 'shreds files']),
  dd,
  chmod: permissions,
  chown: permissions,
  chgrp: permissions,
  find,
  sed,
  gsed: sed,
  awk,
  gawk: awk,
  mawk: awk,
  nawk: awk,
  sort,
  rg,
  // processes and the machine
  kill,
  systemctl,
  launchctl: (_a, c, args) => (args[0] === 'reboot' ? c.v.block('shuts down or reboots the machine') : c.v.add(args[0] === 'list' ? 'read' : 'write', 'manages launchd services')),
  init: (_a, c, args) => (['0', '6'].includes(args[0] ?? '') ? c.v.block('shuts down or reboots the machine') : c.v.add('write', 'runs init')),
  diskutil,
  crontab: (_a, c, args) => (args.includes('-r') ? c.v.add('destructive', 'removes all cron jobs (crontab -r)') : c.v.add(args.includes('-l') ? 'read' : 'write', 'manages cron jobs')),
  docker,
  podman: docker,
  // network
  curl: curlLike,
  wget: curlLike,
  fetch: curlLike,
  http: curlLike,
  https: curlLike,
  xh: curlLike,
  aria2c: curlLike,
  rsync: rsyncScp,
  scp: rsyncScp,
  git,
};

// =============================================================================================
// Public API
// =============================================================================================

export interface CommandGuardOptions {
  /** Home directory for ~ and $HOME (default: process.env.HOME). */
  home?: string;
  /** Directories where writes count as temp files (default: /tmp, /var/folders, $TMPDIR, ...). */
  tempDirs?: string[];
}

/**
 * Classifies run_command calls (Feature 5). Pure and synchronous: safe to call on every request.
 *
 *   new CommandGuard().assess('cd flask && .venv/bin/python -m pytest -q', '.', '/ws')
 *     -> { risk: 'test', blocked: false, reasons: ['runs pytest'] }
 */
export class CommandGuard implements CommandAssessor {
  private readonly home: string | undefined;
  private readonly temps: string[];

  constructor(opts: CommandGuardOptions = {}) {
    const env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {};
    const home = opts.home ?? env.HOME;
    this.home = home ? P.normalize(home).replace(/(.)\/+$/, '$1') : undefined;
    const temps = opts.tempDirs ?? [...DEFAULT_TEMP_DIRS, ...(env.TMPDIR ? [env.TMPDIR] : [])];
    this.temps = temps.filter(Boolean).map((t) => P.normalize(t).replace(/(.)\/+$/, '$1'));
  }

  assess(command: string, cwd: string, root: string): CommandAssessment {
    const absRoot = P.normalize(root || '/').replace(/(.)\/+$/, '$1');
    const dir = !cwd || cwd === '.' ? absRoot : cwd.startsWith('/') ? P.normalize(cwd).replace(/(.)\/+$/, '$1') : P.resolve(absRoot, cwd);
    let v: Verdicts;
    try {
      v = new Analyzer(absRoot, this.home, this.temps).run(command, dir, 0);
    } catch (e) {
      // Never let a parser bug approve something: fall back to "ask the user".
      return { risk: 'write', blocked: false, reasons: [`could not analyse the command (${e instanceof Error ? e.message : String(e)})`] };
    }
    return summarise(v.list);
  }
}

/** MAX risk, blocked if anything is, and the notable reasons (blocked first, then by risk). */
function summarise(list: Verdict[]): CommandAssessment {
  if (!list.length) return { risk: 'read', blocked: false, reasons: ['empty command'] };
  const blocked = list.some((x) => x.blocked);
  const major = list.filter((x) => !x.minor);
  // Minor parts (cd, echo, piped filters) are always 'read'; they must not turn `cd x && pytest` into 'read'.
  const max = (major.length ? major : list).reduce((m, x) => Math.max(m, rank(x.risk)), 0);
  const shown = (major.length ? major : list)
    .map((x, i) => ({ x, i }))
    .sort(
      (p, q) =>
        Number(!!q.x.blocked) - Number(!!p.x.blocked) ||
        rank(q.x.risk) - rank(p.x.risk) ||
        // secrets / outside-the-workspace reasons must survive the MAX_REASONS cut (auto-approve reads them)
        Number(NOT_AUTO_APPROVABLE.test(q.x.reason)) - Number(NOT_AUTO_APPROVABLE.test(p.x.reason)) ||
        p.i - q.i,
    )
    .map(({ x }) => (x.blocked ? `blocked: ${x.reason}` : x.reason));
  return { risk: blocked ? 'destructive' : RISK_ORDER[max], blocked, reasons: [...new Set(shown)].slice(0, MAX_REASONS) };
}
