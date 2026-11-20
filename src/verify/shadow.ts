/**
 * Feature 1, verified diffs ("test before you accept"). PURE Node, no vscode.
 *
 * While a proposed change is under review, ShadowVerifier copies the workspace into a temporary
 * SHADOW directory (os.tmpdir()/forgelight-shadow-*), writes the FULL proposal into the copy and
 * runs the tests that cover the changed file there. Forgelight itself only reads the real
 * workspace: the copy is made from it (from its realpath, so a symlinked root is copied, not
 * linked), the test files are scanned in it, and the shadow directory is always deleted afterwards.
 *
 * The proposal is agent-written code that nobody has reviewed yet, and running the tests runs it.
 * So the test command runs under the macOS sandbox (sandbox-exec, see sandboxProfile()): no writes
 * outside the shadow and temp directories (never the workspace or the home directory), no
 * outbound network except loopback (and never the TrueForge port), secret-looking environment
 * variables removed. Where that sandbox is not available (non-macOS) or cannot be applied, the
 * proposal is NOT run and the result is 'skipped'.
 *
 * Python imports must resolve to the COPY even when the project is installed in editable mode
 * (a .pth entry pointing at the real src/): PYTHONPATH=<copy>/<package root>:<copy>/src:<copy> is
 * searched before site-packages, so the copy wins. test/shadow.test.ts proves it with a broken proposal.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ForgeConfig, ProposedChange, Verifier, VerifyResult, VerifyStatus, WorkspaceIO } from '../contracts';

export interface ShadowVerifierOptions {
  config: () => ForgeConfig;
  /** Raw output of the shadow run (plus a short header), e.g. for an output channel. */
  onOutput?: (chunk: string) => void;
}

/** Prefix of the temporary shadow directories under os.tmpdir(). */
export const SHADOW_DIR_PREFIX = 'forgelight-shadow-';

/** Directory names never copied into the shadow (VCS data, dependencies, caches). */
const SKIP_NAMES = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', '.tox', '.nox', '.eggs', '.DS_Store',
]);
/** Build output and caches, skipped only at the workspace root (a source package may be called "build"). */
const ROOT_SKIP_DIRS = new Set(['target', 'dist', 'build', '.next', '.nuxt', 'coverage', 'htmlcov', '.gradle', '.cache']);
/** Skipped only when they really are virtual environments (a source dir may be called "env"). */
const VENV_NAMES = new Set(['venv', 'env']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Guards against copying a huge workspace on every review. */
const MAX_COPY_FILES = 20_000;
const MAX_COPY_BYTES = 512 * 1024 * 1024;
const TAIL_LINES = 40;
const OUTPUT_KEEP_CHARS = 256 * 1024;
/** Test files scanned for imports of the changed module, at most. */
const MAX_SCAN_FILES = 3000;
const MAX_SCAN_BYTES = 1024 * 1024;
const MAX_TESTS = 3;
/** After a workspace was too large to copy, skip shadow runs for it for this long (no copy churn per review). */
const TOO_LARGE_RECHECK_MS = 10 * 60 * 1000;
/** Name of the copy inside the shadow dir: fixed, so a ':' in the workspace's folder name cannot split PYTHONPATH. */
const COPY_DIR_NAME = 'ws';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
/** Summary of a shadow run that did not happen because the proposal could not be run sandboxed. */
export const NOT_SANDBOXED_SUMMARY = 'not run: no sandbox for test runs on this platform (macOS only); run the tests yourself after accepting';
/** Environment variables that look like secrets are not passed to the shadow run. */
const SECRET_ENV_RE = /(^|_)(KEYS?|TOKENS?|SECRETS?|PASSWORDS?|PASSWD|CREDENTIALS?)$|(token|secret|password)$|^(TRUEFORGE_|AWS_)|^SSH_AUTH_SOCK$/i;

const PY_TEST_RE = /(^|\/)(test_[^/]*\.py|[^/]*_test\.py)$/;
const JS_TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const JS_EXT_RE = /\.[cm]?[jt]sx?$/;
const CODE_EXT_RE =
  /\.(py|pyi|[cm]?[jt]sx?|go|rs|java|kts?|scala|rb|php|cs|c|cc|cpp|cxx|h|hh|hpp|m|mm|swift|dart|exs?|erl|hs|lua|pl|r|jl|clj)$/i;

type PlanKind = 'pytest' | 'custom';
interface DetailedPlan {
  command?: string;
  tests: string[];
  kind: PlanKind;
  skipReason?: string;
  /** Python: directory (relative) that holds the changed file's top-level package, when it is not src/ or the root. */
  importRoot?: string;
}

class TooLargeError extends Error {}

export class ShadowVerifier implements Verifier {
  /** Workspace roots that were too large to copy, and when that was found. */
  private readonly tooLarge = new Map<string, number>();

  constructor(
    private readonly io: WorkspaceIO,
    private readonly opts: ShadowVerifierOptions,
  ) {}

  /**
   * Which tests would run for this change. `command` is undefined when nothing can run (then
   * `tests` is [] too and verify() resolves 'skipped').
   */
  async plan(change: ProposedChange): Promise<{ command?: string; tests: string[] }> {
    const p = await this.planDetailed(change, this.opts.config());
    return p.command ? { command: p.command, tests: p.tests } : { tests: [] };
  }

  async verify(change: ProposedChange, signal: AbortSignal): Promise<VerifyResult> {
    const t0 = Date.now();
    const cfg = this.opts.config();
    const done = (status: VerifyStatus, summary: string, extra: Partial<VerifyResult> = {}): VerifyResult => ({
      changeId: change.id,
      status,
      tests: [],
      summary,
      durationMs: Date.now() - t0,
      ...extra,
    });
    if (!cfg.verifyBeforeAccept) return done('skipped', 'verification is off (forgelight.verifyBeforeAccept)');
    if (signal.aborted) return done('cancelled', 'cancelled');

    let plan: DetailedPlan;
    try {
      plan = await this.planDetailed(change, cfg);
    } catch (e) {
      return done('error', `could not plan the test run: ${errText(e)}`);
    }
    if (!plan.command) return done('skipped', plan.skipReason ?? `no tests cover ${relOf(this.io.root, change)}`);
    const command = plan.command;
    // Shown on the review card: workspace paths relative ("'.venv/bin/python' -m pytest …"), not /Users/<name>/….
    const shown = command.split(path.resolve(this.io.root) + path.sep).join('');
    const base = { command: shown, tests: plan.tests };
    if (signal.aborted) return done('cancelled', 'cancelled', base);
    // Running the tests runs the unreviewed proposal: never without the sandbox.
    const noSandbox = await sandboxUnavailable();
    if (noSandbox) return done('skipped', noSandbox, base);
    const bigAt = this.tooLarge.get(this.io.root);
    if (bigAt !== undefined && Date.now() - bigAt < TOO_LARGE_RECHECK_MS) {
      return done('skipped', `workspace too large for a shadow copy (more than ${MAX_COPY_FILES} files or ${MAX_COPY_BYTES >> 20} MB)`, base);
    }
    if (signal.aborted) return done('cancelled', 'cancelled', base);

    let tmp: string | undefined;
    try {
      const shadow = await makeShadowDir(this.io.root);
      tmp = shadow.tmp;
      const copy = path.join(tmp, COPY_DIR_NAME);
      const tCopy = Date.now();
      const copied = await copyWorkspace(shadow.realRoot, copy);
      // A custom command (vitest, .venv/bin/pytest, ...) needs the dependencies it was set up with.
      if ((cfg.verifyCommand ?? '').trim()) await linkDependencies(shadow.realRoot, copy);
      if (signal.aborted) return done('cancelled', 'cancelled', base);
      // Paths stay relative to io.root (change.absPath lives under it, even when it is a symlink).
      await writeProposal(copy, relOf(this.io.root, change), change.proposedText);
      if (signal.aborted) return done('cancelled', 'cancelled', base);
      this.opts.onOutput?.(
        `[forgelight] shadow copy of ${copied.files} files in ${Date.now() - tCopy} ms: ${copy} (sandboxed)\n$ ${command}\n`,
      );

      const run = await runInShadow({
        command,
        copy,
        tmp,
        protect: [shadow.realRoot, path.resolve(this.io.root)],
        importRoot: plan.importRoot,
        blockPorts: localPorts(cfg),
        timeoutMs: Math.max(1, cfg.verifyTimeoutSec) * 1000,
        abort: signal,
        onOutput: this.opts.onOutput,
      });
      const verdict = classify(plan.kind, run, Math.max(1, cfg.verifyTimeoutSec));
      return done(verdict.status, verdict.summary, {
        ...base,
        ...(verdict.status === 'failed' || verdict.status === 'error' ? { outputTail: tail(run.output, TAIL_LINES) } : {}),
      });
    } catch (e) {
      if (signal.aborted) return done('cancelled', 'cancelled', base);
      if (e instanceof TooLargeError) {
        this.tooLarge.set(this.io.root, Date.now());
        return done('skipped', e.message, base);
      }
      return done('error', errText(e), base);
    } finally {
      if (tmp) await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
    }
  }

  /** Delete shadow directories left behind by a crashed extension host (older than maxAgeMs). */
  static async sweepStale(maxAgeMs = 60 * 60 * 1000): Promise<number> {
    let removed = 0;
    const dir = os.tmpdir();
    const names = await fsp.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.startsWith(SHADOW_DIR_PREFIX)) continue;
      const full = path.join(dir, name);
      try {
        const st = await fsp.lstat(full);
        if (st.isDirectory() && Date.now() - st.mtimeMs > maxAgeMs) {
          await fsp.rm(full, { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* raced with another window: ignore */
      }
    }
    return removed;
  }

  // -------------------------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------------------------

  private async planDetailed(change: ProposedChange, cfg: ForgeConfig): Promise<DetailedPlan> {
    const root = this.io.root;
    const rel = relOf(root, change);
    const custom = (cfg.verifyCommand ?? '').trim();
    const isPy = /\.pyi?$/.test(rel);
    const isJs = JS_EXT_RE.test(rel);
    const noTests = `no tests cover ${rel}`;

    let tests: string[] = [];
    if (PY_TEST_RE.test(rel)) tests = [rel];
    else if (isJs && JS_TEST_RE.test(rel)) tests = [rel];
    else if (isPy) tests = await findPythonTests(root, rel);
    else if (isJs && custom) tests = await findJsTests(root, rel);

    if (custom) {
      const usesTests = custom.includes('{tests}');
      if (usesTests && tests.length === 0) return { tests: [], kind: 'custom', skipReason: noTests };
      if (!usesTests && tests.length === 0 && !CODE_EXT_RE.test(rel)) return { tests: [], kind: 'custom', skipReason: noTests };
      const python = isPy || custom.includes('{python}') ? await findPython(root) : 'python3';
      const command = custom
        .split('{python}').join(shQuote(python))
        .split('{tests}').join(tests.map(shQuote).join(' '))
        .split('{file}').join(shQuote(rel));
      return { command, tests, kind: /\bpytest\b/.test(command) ? 'pytest' : 'custom', importRoot: isPy ? pythonImportRoot(root, rel) : undefined };
    }
    if (isPy) {
      if (tests.length === 0) return { tests: [], kind: 'pytest', skipReason: noTests };
      const python = await findPython(root);
      const command = `${shQuote(python)} -m pytest -q -x -p no:cacheprovider ${tests.map(shQuote).join(' ')}`;
      return { command, tests, kind: 'pytest', importRoot: pythonImportRoot(root, rel) };
    }
    if (tests.length) {
      const ext = path.extname(rel) || rel;
      return { tests: [], kind: 'custom', skipReason: `no test command for ${ext} files (set forgelight.verifyCommand)` };
    }
    return { tests: [], kind: 'custom', skipReason: noTests };
  }
}

// ---------------------------------------------------------------------------------------------
// Test discovery (reads the real workspace only)
// ---------------------------------------------------------------------------------------------

/** True for files pytest / jest / vitest / mocha treat as tests. */
export function isTestPath(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  return (PY_TEST_RE.test(p) && p.endsWith('.py')) || JS_TEST_RE.test(p);
}

/**
 * Dotted module name of a Python file: follows the __init__.py chain upwards
 * (src/flask/cli.py -> flask.cli; src/flask/__init__.py -> flask); without packages, the path
 * minus a leading src/ or lib/.
 */
export function pythonModuleName(rel: string, hasInit: (relDir: string) => boolean): string {
  const parts = rel.replace(/\\/g, '/').replace(/\.pyi?$/, '').split('/');
  const leaf = parts.pop()!;
  const pkg: string[] = [];
  for (let i = parts.length; i > 0; i--) {
    const dir = parts.slice(0, i).join('/');
    if (!hasInit(dir)) break;
    pkg.unshift(parts[i - 1]);
  }
  let segs: string[];
  if (pkg.length) segs = [...pkg, leaf];
  else segs = [...(parts[0] === 'src' || parts[0] === 'lib' ? parts.slice(1) : parts), leaf];
  if (segs[segs.length - 1] === '__init__') segs.pop();
  return segs.filter(Boolean).join('.');
}

/** How strongly a test file's source refers to `mod` (0 = not at all). */
export function importScore(source: string, mod: string): number {
  if (!mod) return 0;
  const segs = mod.split('.');
  const leaf = segs[segs.length - 1];
  const parent = segs.slice(0, -1).join('.');
  let score = 0;
  if (segs.length > 1) {
    // flask.cli, from flask.cli import x, import flask.cli, monkeypatch "flask.cli.y"
    score += (source.match(new RegExp(`(?<![\\w.])${escapeRe(mod)}(?![\\w])`, 'g')) ?? []).length;
  } else {
    score += (source.match(new RegExp(`^[ \\t]*(?:from[ \\t]+${escapeRe(mod)}(?:[ \\t.])|import[ \\t]+(?:[\\w.]+[ \\t]*,[ \\t]*)*${escapeRe(mod)}\\b)`, 'gm')) ?? []).length;
  }
  if (parent) {
    // from flask import cli / from flask import (x, cli as c)
    const re = new RegExp(`^[ \\t]*from[ \\t]+${escapeRe(parent)}[ \\t]+import[ \\t]+(?:\\(([^)]*)\\)|([^\\n#]*))`, 'gm');
    for (const m of source.matchAll(re)) {
      const names = (m[1] ?? m[2] ?? '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim());
      if (names.includes(leaf)) score += 2;
    }
  }
  return score;
}

/**
 * Directory holding the top-level package of a Python file (lib/pkg/mod.py -> 'lib'), so the copy of
 * that package is imported even when the project is installed in editable mode. Undefined when the
 * file is not in a package, or the directory is the root or src/ (always on the shadow PYTHONPATH).
 */
export function pythonImportRoot(root: string, rel: string): string | undefined {
  if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) return undefined;
  const parts = rel.split('/');
  parts.pop();
  let i = parts.length;
  while (i > 0 && fs.existsSync(path.join(root, ...parts.slice(0, i), '__init__.py'))) i--;
  if (i === parts.length) return undefined;
  const dir = parts.slice(0, i).join('/');
  if (!dir || dir === 'src' || dir.includes(':') || dir.split('/').includes('..')) return undefined;
  return dir;
}

async function findPythonTests(root: string, rel: string): Promise<string[]> {
  const testFiles = await listTestFiles(root, (p) => PY_TEST_RE.test(p) && p.endsWith('.py'));
  if (testFiles.length === 0) return [];
  const base = path.posix.basename(rel).replace(/\.pyi?$/, '');
  const stem = base === '__init__' ? path.posix.basename(path.posix.dirname(rel)) : base;
  const depth = (p: string) => p.split('/').length;
  const nameMatches = testFiles
    .filter((p) => {
      const b = path.posix.basename(p);
      return b === `test_${stem}.py` || b === `${stem}_test.py`;
    })
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));

  const mod = pythonModuleName(rel, (dir) => fs.existsSync(path.join(root, dir, '__init__.py')));
  const importers: Array<{ p: string; score: number; size: number }> = [];
  if (mod) {
    for (const p of testFiles) {
      if (nameMatches.includes(p) || p === rel) continue;
      try {
        const abs = path.join(root, p);
        const st = await fsp.stat(abs);
        if (st.size > MAX_SCAN_BYTES) continue;
        const score = importScore(await fsp.readFile(abs, 'utf8'), mod);
        if (score > 0) importers.push({ p, score, size: st.size });
      } catch {
        /* unreadable: ignore */
      }
    }
  }
  importers.sort((a, b) => b.score - a.score || a.size - b.size || a.p.localeCompare(b.p));
  const picked = [...nameMatches, ...importers.slice(0, 2).map((x) => x.p)];
  return [...new Set(picked)].slice(0, MAX_TESTS);
}

async function findJsTests(root: string, rel: string): Promise<string[]> {
  const dir = path.posix.dirname(rel);
  const stem = path.posix.basename(rel).replace(JS_EXT_RE, '');
  const exts = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'];
  const found: string[] = [];
  for (const d of [dir, `${dir}/__tests__`]) {
    for (const kind of ['test', 'spec']) {
      for (const ext of exts) {
        const cand = path.posix.normalize(`${d}/${stem}.${kind}.${ext}`);
        if (fs.existsSync(path.join(root, cand))) found.push(cand);
      }
    }
  }
  if (found.length < MAX_TESTS) {
    const all = await listTestFiles(root, (p) => JS_TEST_RE.test(p));
    for (const p of all) if (path.posix.basename(p).startsWith(`${stem}.`)) found.push(p);
  }
  return [...new Set(found)].slice(0, MAX_TESTS);
}

/** Test files under <root>/tests and <root>/test (workspace-relative, forward slashes). */
async function listTestFiles(root: string, match: (rel: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  let seen = 0;
  const walk = async (relDir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(path.join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > MAX_SCAN_FILES) return;
      const rel = `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (SKIP_NAMES.has(e.name) || VENV_NAMES.has(e.name) || e.name.endsWith('.egg-info')) continue;
        await walk(rel);
      } else if (e.isFile() && match(rel)) out.push(rel);
    }
  };
  for (const d of ['tests', 'test']) await walk(d);
  return out.sort();
}

/** <root>/.venv/bin/python, else <root>/venv/bin/python, else python3 (absolute path, not resolved). */
async function findPython(root: string): Promise<string> {
  for (const rel of ['.venv/bin/python', 'venv/bin/python']) {
    const p = path.join(root, rel);
    try {
      await fsp.access(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return 'python3';
}

// ---------------------------------------------------------------------------------------------
// Shadow copy
// ---------------------------------------------------------------------------------------------

/** The shadow dir (realpath) and the realpath of the workspace root. */
async function makeShadowDir(root: string): Promise<{ tmp: string; realRoot: string }> {
  // realpath: on macOS os.tmpdir() is behind the /var -> /private/var symlink; pytest compares paths.
  const tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), SHADOW_DIR_PREFIX)));
  const realRoot = await fsp.realpath(root).catch(() => path.resolve(root));
  if (isInside(realRoot, tmp)) {
    await fsp.rm(tmp, { recursive: true, force: true });
    throw new Error(`the temp directory ${tmp} is inside the workspace; refusing to create a shadow copy there`);
  }
  return { tmp, realRoot };
}

/**
 * Copy the workspace (`realRoot` must be a realpath: a symlinked root would otherwise be copied as
 * a link to the real tree), skipping VCS data, dependencies, caches, virtualenvs, root-level build
 * output and files > 5 MB. Throws TooLargeError past MAX_COPY_FILES / MAX_COPY_BYTES.
 */
async function copyWorkspace(realRoot: string, dest: string): Promise<{ files: number; bytes: number }> {
  const src = realRoot;
  let files = 0;
  let bytes = 0;
  await fsp.cp(src, dest, {
    recursive: true,
    // Keep relative symlinks relative, so they point inside the copy instead of at the real tree.
    verbatimSymlinks: true,
    filter: (from: string) => {
      if (from === src) return true;
      const name = path.basename(from);
      if (SKIP_NAMES.has(name) || name.endsWith('.egg-info')) return false;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(from);
      } catch {
        return false;
      }
      if (st.isDirectory()) {
        if (ROOT_SKIP_DIRS.has(name) && path.dirname(from) === src) return false;
        return !(VENV_NAMES.has(name) && isVirtualEnv(from));
      }
      if (st.isSymbolicLink()) return true;
      if (!st.isFile()) return false; // sockets, FIFOs, devices
      if (st.size > MAX_FILE_BYTES) return false;
      files++;
      bytes += st.size;
      if (files > MAX_COPY_FILES || bytes > MAX_COPY_BYTES) {
        throw new TooLargeError(
          `workspace too large for a shadow copy (more than ${MAX_COPY_FILES} files or ${MAX_COPY_BYTES >> 20} MB)`,
        );
      }
      return true;
    },
  });
  // The copy must be a real directory: everything written later is checked against it.
  const st = await fsp.lstat(dest);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('shadow copy is not a real directory');
  return { files, bytes };
}

/**
 * Only for custom verify commands: link the root-level dependency dirs the copy skipped
 * (node_modules, .venv, venv/env virtualenvs) back to the real ones, read-only by intent.
 * The automatic pytest command does not need them (it runs the venv's python by absolute path).
 */
async function linkDependencies(realRoot: string, copy: string): Promise<void> {
  for (const name of ['node_modules', '.venv', 'venv', 'env']) {
    const real = path.join(realRoot, name);
    const st = await fsp.lstat(real).catch(() => undefined);
    if (!st?.isDirectory()) continue;
    if (VENV_NAMES.has(name) && !isVirtualEnv(real)) continue; // a source dir: already copied
    await fsp.symlink(path.resolve(real), path.join(copy, name), 'dir').catch(() => undefined);
  }
}

function isVirtualEnv(dir: string): boolean {
  return ['pyvenv.cfg', 'conda-meta', 'bin/activate', 'Scripts/activate'].some((f) => fs.existsSync(path.join(dir, f)));
}

/**
 * Write the full proposed text into the copy, never following a link out of it. `copy` is a real
 * directory under the realpath'd shadow dir (copyWorkspace checks it), so it is its own realpath.
 */
async function writeProposal(copy: string, rel: string, text: string): Promise<void> {
  const target = path.resolve(copy, rel);
  if (!isInside(copy, target) || target === copy) throw new Error(`refusing to write outside the shadow copy: ${rel}`);
  const dir = path.dirname(target);
  // Before creating anything: the deepest existing ancestor of `dir` must resolve inside the copy,
  // or mkdir could create directories in the real tree through an absolute link in the workspace.
  let existing = dir;
  while (existing !== copy && !(await fsp.lstat(existing).then(() => true, () => false))) existing = path.dirname(existing);
  const realExisting = await fsp.realpath(existing).catch(() => undefined);
  if (!realExisting || !isInside(copy, realExisting)) throw new Error(`${rel} resolves outside the shadow copy`);
  await fsp.mkdir(dir, { recursive: true });
  const realDir = await fsp.realpath(dir);
  if (!isInside(copy, realDir)) throw new Error(`${rel} resolves outside the shadow copy`);
  const st = await fsp.lstat(target).catch(() => undefined);
  if (st?.isSymbolicLink()) await fsp.unlink(target);
  await fsp.writeFile(target, text, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// Sandbox (macOS sandbox-exec)
// ---------------------------------------------------------------------------------------------

let sandboxCheck: Promise<string | undefined> | undefined;

/**
 * Why shadow runs cannot be sandboxed here, or undefined when they can (sandbox-exec exists and a
 * profile applies). Checked once per process.
 */
export function sandboxUnavailable(): Promise<string | undefined> {
  sandboxCheck ??= (async () => {
    if (process.platform !== 'darwin') return NOT_SANDBOXED_SUMMARY;
    try {
      await fsp.access(SANDBOX_EXEC, fs.constants.X_OK);
    } catch {
      return NOT_SANDBOXED_SUMMARY;
    }
    const probe = await new Promise<{ code: number | null; out: string }>((resolve) => {
      let out = '';
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(SANDBOX_EXEC, ['-p', '(version 1)\n(allow default)\n(deny network-outbound)', '/usr/bin/true'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        resolve({ code: null, out: errText(e) });
        return;
      }
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.stdout?.on('data', (d) => (out += String(d)));
      child.stderr?.on('data', (d) => (out += String(d)));
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: null, out: errText(e) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out });
      });
    });
    if (probe.code === 0) return undefined;
    return clip(`not run: the macOS sandbox for test runs could not be applied (${probe.out.trim() || `exit code ${probe.code}`})`);
  })();
  return sandboxCheck;
}

/** What the sandbox of one shadow run may write, must protect and must not connect to. */
export interface SandboxSpec {
  /** The shadow directory (realpath): writable. */
  shadow: string;
  /** Temp directories (realpaths): writable unless inside `protect`. */
  temps: string[];
  /** Never writable, even inside a temp dir: the workspace and the home directory (realpaths). */
  protect: string[];
  /** Loopback ports that must not be reached (TrueForge). */
  blockPorts: number[];
}

/**
 * SBPL profile for sandbox-exec. In SBPL the LAST matching rule wins, so the order is: deny all
 * writes, allow /dev and temp dirs, deny the protected dirs again (they may live under a temp dir),
 * allow the shadow dir; deny outbound network, allow loopback, deny the blocked ports again.
 * Exported for tests.
 */
export function sandboxProfile(spec: SandboxSpec): string {
  const lit = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const subpaths = (dirs: string[]) =>
    [...new Set(dirs.filter((d) => path.isAbsolute(d)))].map((d) => `(subpath ${lit(d)})`).join(' ');
  const rules = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (subpath "/dev") ${subpaths(spec.temps)})`,
  ];
  if (spec.protect.length) rules.push(`(deny file-write* ${subpaths(spec.protect)})`);
  rules.push(
    `(allow file-write* ${subpaths([spec.shadow])})`,
    '(deny network-outbound)',
    '(allow network-outbound (remote ip "localhost:*"))',
    ...[...new Set(spec.blockPorts)].filter((p) => Number.isInteger(p) && p > 0 && p < 65536).map((p) => `(deny network-outbound (remote ip "localhost:${p}"))`),
    // No way out through other processes: Apple Events, `open` (LaunchServices), launchd jobs, sudo.
    '(deny appleevent-send)',
    '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/bin/launchctl") (literal "/usr/bin/sudo") (literal "/usr/bin/su"))',
  );
  return rules.join('\n');
}

/** Loopback ports of TrueForge and the editor MCP server (from the config), blocked in the sandbox. */
function localPorts(cfg: ForgeConfig): number[] {
  const ports: number[] = [];
  try {
    const u = new URL(cfg.trueforgeUrl);
    if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(u.hostname)) ports.push(Number(u.port || (u.protocol === 'https:' ? 443 : 80)));
  } catch {
    /* no URL: nothing to block */
  }
  if (Number(cfg.mcpPort) > 0) ports.push(Number(cfg.mcpPort));
  return ports;
}

/** Realpath, or the resolved path when it does not exist. */
async function real(p: string): Promise<string> {
  return fsp.realpath(p).catch(() => path.resolve(p));
}

/** Writable temp dirs: os.tmpdir() (and on macOS the per-user /var/folders/../ dir around it), /tmp, /var/tmp. */
async function tempDirs(): Promise<string[]> {
  const t = await real(os.tmpdir());
  const dirs = [t, '/private/tmp', '/private/var/tmp'];
  if (path.basename(t) === 'T' && t.startsWith('/private/var/folders/')) dirs.push(path.dirname(t));
  return dirs;
}

/** process.env without secret-looking variables, with HOME-relative caches moved into the shadow dir. */
function shadowEnv(tmp: string, pyPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV_RE.test(k)) env[k] = v;
  const cache = path.join(tmp, 'cache');
  return {
    ...env,
    PYTHONPATH: env.PYTHONPATH ? `${pyPath}:${env.PYTHONPATH}` : pyPath,
    PYTHONDONTWRITEBYTECODE: '1',
    XDG_CACHE_HOME: cache,
    PIP_CACHE_DIR: path.join(cache, 'pip'),
    MPLCONFIGDIR: path.join(cache, 'matplotlib'),
    npm_config_cache: path.join(cache, 'npm'),
    YARN_CACHE_FOLDER: path.join(cache, 'yarn'),
  };
}

// ---------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------

interface RunOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

interface ShadowRun {
  command: string;
  /** The copy (cwd of the command). */
  copy: string;
  /** The shadow dir that holds the copy (realpath). */
  tmp: string;
  /** Real workspace paths, never writable from the run. */
  protect: string[];
  importRoot?: string;
  blockPorts: number[];
  timeoutMs: number;
  abort: AbortSignal;
  onOutput?: (chunk: string) => void;
}

async function runInShadow(run: ShadowRun): Promise<RunOutcome> {
  const { command, copy, tmp, timeoutMs, abort, onOutput } = run;
  const pyPath = [run.importRoot ? `${copy}/${run.importRoot}` : '', `${copy}/src`, copy].filter(Boolean).join(':');
  const env = shadowEnv(tmp, pyPath);
  await fsp.mkdir(path.join(tmp, 'cache'), { recursive: true }).catch(() => undefined);
  const home = os.homedir();
  const profile = sandboxProfile({
    shadow: tmp,
    temps: await tempDirs(),
    protect: [...new Set([...run.protect, ...(await Promise.all(run.protect.map(real))), home, await real(home)])],
    blockPorts: run.blockPorts,
  });
  // A login shell may rewrite PYTHONPATH or the cwd from the user's profile; re-assert both so
  // imports always resolve to the copy.
  const q = shQuote(pyPath);
  const script =
    `case "\${PYTHONPATH:-}" in ${q}*) ;; *) export PYTHONPATH=${q}"\${PYTHONPATH:+:\$PYTHONPATH}" ;; esac\n` +
    `export PYTHONDONTWRITEBYTECODE=1\ncd ${shQuote(copy)} || exit 97\n${command}`;

  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const timers: NodeJS.Timeout[] = [];

    const append = (chunk: Buffer | string) => {
      const s = chunk.toString();
      output += s;
      if (output.length > OUTPUT_KEEP_CHARS * 2) output = output.slice(-OUTPUT_KEEP_CHARS);
      try {
        onOutput?.(s);
      } catch {
        /* a broken listener must not break the run */
      }
    };

    let child: ReturnType<typeof spawn>;
    const finish = (spawnError?: string) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      abort.removeEventListener('abort', onAbort);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      // Reap anything the command left running in its group (e.g. a background server) before
      // the shadow directory is deleted under it.
      if (child?.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* group already gone */
        }
      }
      resolve({
        exitCode: exitInfo?.code ?? null,
        signal: exitInfo?.signal ?? null,
        output,
        timedOut,
        aborted,
        spawnError,
      });
    };
    const killGroup = () => {
      const pid = child?.pid;
      if (!pid) return;
      const kill = (sig: NodeJS.Signals) => {
        try {
          process.kill(-pid, sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            /* already gone */
          }
        }
      };
      kill('SIGTERM');
      timers.push(setTimeout(() => kill('SIGKILL'), 400));
      // Never hang on a process that ignores both signals.
      timers.push(setTimeout(() => finish(), 3000));
    };
    function onAbort() {
      if (settled || aborted) return;
      aborted = true;
      killGroup();
    }

    try {
      // sandbox-exec applies the profile and execs bash in place: same pid, same process group.
      child = spawn(SANDBOX_EXEC, ['-p', profile, '/bin/bash', '-lc', script], {
        cwd: copy,
        detached: true,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ exitCode: null, signal: null, output, timedOut, aborted, spawnError: errText(e) });
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (e) => finish(errText(e)));
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      // Normally 'close' follows at once; a grandchild holding the pipes must not keep us waiting.
      timers.push(setTimeout(() => finish(), 300));
    });
    child.on('close', (code, signal) => {
      exitInfo ??= { code, signal };
      finish();
    });
    timers.push(
      setTimeout(() => {
        if (settled) return;
        timedOut = true;
        killGroup();
      }, timeoutMs),
    );
    if (abort.aborted) onAbort();
    else abort.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------------------------
// Verdicts and summaries (pure)
// ---------------------------------------------------------------------------------------------

function classify(kind: PlanKind, run: RunOutcome, timeoutSec: number): { status: VerifyStatus; summary: string } {
  if (run.aborted) return { status: 'cancelled', summary: 'cancelled' };
  if (run.spawnError) return { status: 'error', summary: `could not start the test command: ${run.spawnError}` };
  // sandbox-exec itself failed (65: bad profile, 71: sandbox_apply refused): nothing ran.
  if ((run.exitCode === 65 || run.exitCode === 71) && /^sandbox-exec:|sandbox_apply/m.test(run.output)) {
    return { status: 'skipped', summary: clip(`not run: the macOS sandbox for test runs could not be applied (${lastLine(run.output) ?? `exit code ${run.exitCode}`})`) };
  }
  if (run.timedOut) {
    const s = kind === 'pytest' ? pytestSummaryLine(run.output) : undefined;
    return { status: 'error', summary: `timed out after ${timeoutSec}s${s ? ` (${s})` : ''}` };
  }
  return summarizeOutput(kind, run.exitCode, run.signal, run.output);
}

/** Status and one-line summary of a finished run (exported for tests). */
export function summarizeOutput(
  kind: 'pytest' | 'custom',
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  output: string,
): { status: VerifyStatus; summary: string } {
  if (exitCode === null) return { status: 'error', summary: `test process was terminated${signal ? ` by ${signal}` : ''}` };
  if (exitCode === 97) return { status: 'error', summary: 'could not enter the shadow copy' };
  if (exitCode === 127) return { status: 'error', summary: clip(`command not found: ${lastLine(output) ?? ''}`) };
  if (kind === 'pytest') {
    if (/No module named pytest\b/.test(output)) return { status: 'error', summary: 'pytest is not installed for this Python' };
    const line = pytestSummaryLine(output);
    if (exitCode === 0) return { status: 'passed', summary: line ?? 'tests passed' };
    if (exitCode === 5) return { status: 'skipped', summary: line ?? 'no tests collected' };
    // The package no longer imports with the proposal applied (conftest imports it): the proposal's fault, not the tool's.
    if ((exitCode === 3 || exitCode === 4) && /ImportError while loading conftest/.test(stripAnsi(output))) {
      return { status: 'failed', summary: clip(['ImportError while loading conftest', firstExceptionLine(output)].filter(Boolean).join(' · ')) };
    }
    if (exitCode === 3 || exitCode === 4) {
      return { status: 'error', summary: clip(`pytest ${exitCode === 3 ? 'internal' : 'usage'} error: ${firstError(output) ?? line ?? `exit code ${exitCode}`}`) };
    }
    const first = firstFailure(output);
    return { status: 'failed', summary: clip([line ?? `exit code ${exitCode}`, first].filter(Boolean).join(' · ')) };
  }
  const last = lastLine(output);
  if (exitCode === 0) return { status: 'passed', summary: clip(last ?? 'command succeeded') };
  return { status: 'failed', summary: clip(`exit code ${exitCode}${last ? `: ${last}` : ''}`) };
}

/** pytest's final summary ('1 failed, 58 passed in 0.31s') without the '=' padding. */
export function pytestSummaryLine(output: string): string | undefined {
  const lines = stripAnsi(output).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim().replace(/^=+\s*/, '').replace(/\s*=+$/, '');
    if (!l) continue;
    if (
      /(^|\s)in \d+(\.\d+)?s\b/.test(l) &&
      /\b(passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?|no tests ran)\b/.test(l)
    ) {
      return l;
    }
  }
  return undefined;
}

function firstFailure(output: string): string | undefined {
  const m = stripAnsi(output).match(/^(FAILED|ERROR) (\S+)/m);
  return m ? `${m[1]} ${m[2]}` : undefined;
}

/** First pytest 'E   ...' line (the exception of a traceback). */
function firstExceptionLine(output: string): string | undefined {
  const m = stripAnsi(output).match(/^E\s+(\S.*)$/m);
  return m?.[1].trim();
}

function firstError(output: string): string | undefined {
  const m = stripAnsi(output).match(/^ERROR: (.+)$/m);
  return m?.[1].trim();
}

function lastLine(output: string): string | undefined {
  const lines = stripAnsi(output).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1];
}

function tail(output: string, n: number): string {
  const lines = stripAnsi(output).replace(/\s+$/, '').split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function relOf(root: string, change: ProposedChange): string {
  let rel = change.path;
  if (!rel || path.isAbsolute(rel)) rel = path.relative(root, change.absPath);
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isInside(parent: string, child: string): boolean {
  const r = path.relative(parent, child);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

/** POSIX shell quoting; plain paths stay readable. */
export function shQuote(s: string): string {
  return /^[A-Za-z0-9_\/.:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function clip(s: string, max = 200): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
