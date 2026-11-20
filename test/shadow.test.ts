/**
 * Test of src/verify/shadow.ts (Feature 1, verified diffs) against the real Flask sandbox, which it
 * only READS. Run:
 *   npx esbuild test/shadow.test.ts --bundle --platform=node --target=node18 --outfile=/tmp/shadow.test.js && node /tmp/shadow.test.js
 * Override the sandbox with FLASK_ROOT=/path/to/flask.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CONFIG, type ForgeConfig, type ProposedChange, type WorkspaceIO } from '../src/contracts';
import {
  SHADOW_DIR_PREFIX,
  ShadowVerifier,
  importScore,
  isTestPath,
  pythonModuleName,
  pytestSummaryLine,
  pythonImportRoot,
  sandboxProfile,
  sandboxUnavailable,
  shQuote,
  summarizeOutput,
} from '../src/verify/shadow';

// A Flask 3.1.3 checkout with a .venv; run from the repo root or set FLASK_ROOT.
const ROOT = path.resolve(process.env.FLASK_ROOT ?? '../forge-a-thon-sandbox/flask');

const ioFor = (root: string): WorkspaceIO => ({
  root,
  readText: async (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return undefined;
    }
  },
});

const mkChange = (root: string, rel: string, proposedText: string, id = rel): ProposedChange => {
  const abs = path.join(root, rel);
  const exists = fs.existsSync(abs);
  return {
    id,
    runId: 1,
    path: rel,
    absPath: abs,
    isNewFile: !exists,
    originalText: exists ? fs.readFileSync(abs, 'utf8') : '',
    proposedText,
    hunks: [],
    argsKey: id,
  };
};

const cfg = (over: Partial<ForgeConfig> = {}): ForgeConfig => ({ ...DEFAULT_CONFIG, verifyBeforeAccept: true, verifyCommand: '', verifyTimeoutSec: 90, ...over });

const shadowDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(SHADOW_DIR_PREFIX));

/** path -> size:mtime of every file and directory under root, except .git and .venv. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (!rel && (e.name === '.git' || e.name === '.venv')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const st = fs.lstatSync(path.join(root, r));
      out.set(r, `${st.size}:${st.mtimeMs}`);
      if (e.isDirectory()) walk(r);
    }
  };
  walk('');
  return out;
}

const timings: string[] = [];
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  const r = await fn();
  const ms = Date.now() - t;
  const v = r as unknown as { status?: string; summary?: string };
  const extra = v && typeof v === 'object' && typeof v.status === 'string' ? ` -> ${v.status}: ${v.summary}` : '';
  timings.push(`${label.padEnd(44)} ${String(ms).padStart(6)} ms${extra}`);
  return r;
}

async function main() {
  // ------------------------------------------------------------------------------------------
  // Pure helpers
  // ------------------------------------------------------------------------------------------
  assert.equal(isTestPath('tests/test_cli.py'), true);
  assert.equal(isTestPath('tests/unit/test_x.py'), true);
  assert.equal(isTestPath('pkg/foo_test.py'), true);
  assert.equal(isTestPath('src/a/b.test.ts'), true);
  assert.equal(isTestPath('src/a/b.spec.jsx'), true);
  assert.equal(isTestPath('src/flask/cli.py'), false);
  assert.equal(isTestPath('tests/conftest.py'), false);

  const inits = new Set(['src/flask', 'src/flask/sansio']);
  assert.equal(pythonModuleName('src/flask/cli.py', (d) => inits.has(d)), 'flask.cli');
  assert.equal(pythonModuleName('src/flask/sansio/app.py', (d) => inits.has(d)), 'flask.sansio.app');
  assert.equal(pythonModuleName('src/flask/__init__.py', (d) => inits.has(d)), 'flask');
  assert.equal(pythonModuleName('app.py', () => false), 'app');
  assert.equal(pythonModuleName('src/nspkg/mod.py', () => false), 'nspkg.mod');

  assert.ok(importScore('from flask.cli import FlaskGroup\n', 'flask.cli') > 0);
  assert.ok(importScore('import flask.cli\n', 'flask.cli') > 0);
  assert.ok(importScore('from flask import cli\n', 'flask.cli') > 0);
  assert.ok(importScore('from flask import (\n    Flask,\n    cli as c,\n)\n', 'flask.cli') > 0);
  assert.ok(importScore('monkeypatch.setattr("flask.cli.load_dotenv", f)\n', 'flask.cli') > 0);
  assert.equal(importScore('from flask.client import x\nfrom flask import client\n', 'flask.cli'), 0);
  assert.equal(importScore('import myflask.cli\n', 'flask.cli'), 0);
  assert.ok(importScore('import os, app\n', 'app') > 0);
  assert.equal(importScore('app.config["X"] = 1\n', 'app'), 0);

  assert.equal(pytestSummaryLine('....\n58 passed in 0.45s\n'), '58 passed in 0.45s');
  assert.equal(pytestSummaryLine('x\n========= 1 failed, 57 passed, 1 warning in 0.50s =========\n'), '1 failed, 57 passed, 1 warning in 0.50s');
  assert.equal(pytestSummaryLine('no tests ran in 0.01s\n'), 'no tests ran in 0.01s');
  assert.equal(pytestSummaryLine('hello\n'), undefined);
  assert.equal(summarizeOutput('pytest', 5, null, 'no tests ran in 0.01s\n').status, 'skipped');
  assert.equal(summarizeOutput('pytest', 4, null, 'ERROR: file or directory not found: tests/x.py\n').status, 'error');
  assert.equal(summarizeOutput('pytest', 2, null, '!!! Interrupted: 1 error during collection !!!\n1 error in 0.10s\n').status, 'failed');
  // a proposal that breaks the package import fails in conftest (exit 4): blame the proposal, not the tool
  const imp = summarizeOutput(
    'pytest',
    4,
    null,
    "ImportError while loading conftest '/t/tests/conftest.py'.\ntests/conftest.py:7: in <module>\n    from flask import Flask\nE   NameError: name 'config_command' is not defined\n",
  );
  assert.deepEqual(imp, { status: 'failed', summary: "ImportError while loading conftest · NameError: name 'config_command' is not defined" });
  assert.equal(summarizeOutput('pytest', 1, null, '/x/python: No module named pytest\n').status, 'error');
  const f = summarizeOutput('pytest', 1, null, 'FAILED tests/t.py::test_a - AssertionError\n1 failed, 2 passed in 0.1s\n');
  assert.deepEqual(f, { status: 'failed', summary: '1 failed, 2 passed in 0.1s · FAILED tests/t.py::test_a' });
  assert.equal(summarizeOutput('custom', 0, null, 'ok\nall good\n').summary, 'all good');
  assert.equal(summarizeOutput('custom', null, 'SIGKILL', '').status, 'error');
  assert.equal(shQuote('/a/b.py'), '/a/b.py');
  assert.equal(shQuote("it's here"), `'it'\\''s here'`);
  // sandbox profile: SBPL's last matching rule wins, so the protected dirs are denied AFTER the temp
  // dirs are allowed, and the shadow dir is allowed after that; TrueForge's port is denied after loopback.
  const prof = sandboxProfile({ shadow: '/private/tmp/s', temps: ['/private/tmp'], protect: ['/Users/u', '/Users/u/ws'], blockPorts: [8790, 0] });
  const lines = prof.split('\n');
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
  assert.ok(at(/^\(deny file-write\*\)$/) < at(/^\(allow file-write\* \(subpath "\/dev"\) \(subpath "\/private\/tmp"\)\)$/));
  assert.ok(at(/^\(allow file-write\* \(subpath "\/dev"/) < at(/^\(deny file-write\* \(subpath "\/Users\/u"\) \(subpath "\/Users\/u\/ws"\)\)$/));
  assert.ok(at(/^\(deny file-write\* \(subpath "\/Users\/u"/) < at(/^\(allow file-write\* \(subpath "\/private\/tmp\/s"\)\)$/));
  assert.ok(at(/^\(allow network-outbound \(remote ip "localhost:\*"\)\)$/) < at(/^\(deny network-outbound \(remote ip "localhost:8790"\)\)$/));
  assert.ok(!prof.includes('localhost:0'));
  assert.match(sandboxProfile({ shadow: '/t/a"b\\c', temps: [], protect: [], blockPorts: [] }), /\(subpath "\/t\/a\\"b\\\\c"\)/, 'quotes escaped');
  console.log('pure helpers ok');

  assert.equal(await sandboxUnavailable(), undefined, 'this test needs the macOS sandbox (sandbox-exec)');

  // ------------------------------------------------------------------------------------------
  // Against the real Flask sandbox (read-only)
  // ------------------------------------------------------------------------------------------
  assert.ok(fs.existsSync(path.join(ROOT, 'src/flask/helpers.py')), `Flask sandbox not found at ${ROOT}`);
  const gitStatus = () => execFileSync('git', ['-C', ROOT, 'status', '--short'], { encoding: 'utf8' }).trim();
  assert.equal(gitStatus(), '', 'Flask sandbox must be clean before the test');
  const strayBefore = shadowDirs();
  const snapBefore = snapshot(ROOT);

  let config = cfg();
  let output = '';
  const verifier = new ShadowVerifier(ioFor(ROOT), { config: () => config, onOutput: (c) => (output += c) });
  const never = new AbortController().signal;

  // (a) planning
  const pCli = await timed('(a) plan src/flask/cli.py', () => verifier.plan(mkChange(ROOT, 'src/flask/cli.py', '')));
  assert.equal(pCli.tests[0], 'tests/test_cli.py', JSON.stringify(pCli));
  assert.ok(pCli.tests.length <= 3);
  assert.match(pCli.command ?? '', /\/\.venv\/bin\/python -m pytest -q -x -p no:cacheprovider tests\/test_cli\.py/);
  console.log('plan cli.py:', JSON.stringify(pCli));
  const pDocs = await verifier.plan(mkChange(ROOT, 'docs/cli.rst', 'x'));
  assert.deepEqual(pDocs, { tests: [] });
  const pTest = await verifier.plan(mkChange(ROOT, 'tests/test_cli.py', 'x'));
  assert.deepEqual(pTest.tests, ['tests/test_cli.py']);
  const pHelpers = await verifier.plan(mkChange(ROOT, 'src/flask/helpers.py', 'x'));
  assert.equal(pHelpers.tests[0], 'tests/test_helpers.py');
  console.log('plan helpers.py:', JSON.stringify(pHelpers));
  const pJs = await verifier.plan(mkChange(ROOT, 'web/app.test.ts', 'x'));
  assert.deepEqual(pJs, { tests: [] }, 'JS/TS without verifyCommand has nothing to run');
  config = cfg({ verifyCommand: 'npx vitest run {tests}' });
  const pJs2 = await verifier.plan(mkChange(ROOT, 'web/app.test.ts', 'x'));
  assert.deepEqual(pJs2, { command: 'npx vitest run web/app.test.ts', tests: ['web/app.test.ts'] });
  config = cfg({ verifyCommand: '{python} -m pytest {tests} --tb=short # {file}' });
  const pCustom = await verifier.plan(mkChange(ROOT, 'src/flask/cli.py', 'x'));
  assert.match(pCustom.command ?? '', /^\/\S+\/\.venv\/bin\/python -m pytest tests\/test_cli\.py.* --tb=short # src\/flask\/cli\.py$/);
  assert.deepEqual(await verifier.plan(mkChange(ROOT, 'docs/cli.rst', 'x')), { tests: [] }, '{tests} with no tests -> nothing');
  config = cfg();

  // skipped paths create no shadow at all
  const rDocs = await timed('(a) verify docs/cli.rst', () => verifier.verify(mkChange(ROOT, 'docs/cli.rst', 'x', 'docs'), never));
  assert.equal(rDocs.status, 'skipped');
  assert.equal(rDocs.summary, 'no tests cover docs/cli.rst');
  assert.equal(rDocs.changeId, 'docs');
  const rJs = await verifier.verify(mkChange(ROOT, 'web/app.test.ts', 'x'), never);
  assert.equal(rJs.status, 'skipped');
  assert.match(rJs.summary, /no test command for \.ts files/);
  config = cfg({ verifyBeforeAccept: false });
  const rOff = await verifier.verify(mkChange(ROOT, 'src/flask/helpers.py', 'x'), never);
  assert.equal(rOff.status, 'skipped');
  config = cfg();

  // (b) harmless proposal -> passed
  const helpers = fs.readFileSync(path.join(ROOT, 'src/flask/helpers.py'), 'utf8');
  const FALSE_SET = '{"0", "false", "no"}';
  assert.ok(helpers.includes(FALSE_SET));
  const harmless = helpers.replace(FALSE_SET, '{"0", "false", "no", "off", "n"}');
  const rOk = await timed('(b) verify harmless helpers.py', () => verifier.verify(mkChange(ROOT, 'src/flask/helpers.py', harmless, 'ok'), never));
  assert.equal(rOk.status, 'passed', JSON.stringify(rOk));
  assert.ok(rOk.tests.includes('tests/test_helpers.py'));
  assert.match(rOk.summary, /^\d+ passed in [\d.]+s$/);
  assert.equal(rOk.outputTail, undefined);
  assert.equal(rOk.changeId, 'ok');
  assert.ok(rOk.command?.includes('-m pytest'));

  // (c) broken proposal -> failed: proves the COPY (not the editable-installed real src) is imported
  const broken = helpers.replace('val = os.environ.get("FLASK_DEBUG")', 'raise RuntimeError("forgelight shadow probe")');
  assert.notEqual(broken, helpers);
  const rBad = await timed('(c) verify broken helpers.py', () => verifier.verify(mkChange(ROOT, 'src/flask/helpers.py', broken, 'bad'), never));
  assert.equal(rBad.status, 'failed', JSON.stringify(rBad));
  assert.match(rBad.summary, /\b\d+ (failed|errors?)\b/); // a fixture error ('1 error') is a failure too
  assert.ok(rBad.outputTail && rBad.outputTail.includes('forgelight shadow probe'), 'tail shows the probe error');
  assert.ok(rBad.outputTail!.split('\n').length <= 40);

  // (c2) direct proof: inside the shadow run, `import flask` resolves to the temp copy
  config = cfg({
    verifyCommand: `{python} -c 'import flask, flask.helpers as h; print("FLASKFILE=" + flask.__file__); print("PROBE=" + str(chr(34) + "off" + chr(34) in open(h.__file__).read()))'`,
  });
  output = '';
  const rWhere = await timed('(c2) verify import location', () => verifier.verify(mkChange(ROOT, 'src/flask/helpers.py', harmless, 'where'), never));
  config = cfg();
  assert.equal(rWhere.status, 'passed', JSON.stringify(rWhere));
  const flaskFile = /^FLASKFILE=(.*)$/m.exec(output)?.[1] ?? '';
  const tmpReal = fs.realpathSync(os.tmpdir());
  assert.ok(flaskFile.startsWith(path.join(tmpReal, SHADOW_DIR_PREFIX)), `flask imported from ${flaskFile}`);
  assert.ok(!flaskFile.startsWith(ROOT));
  assert.match(output, /^PROBE=True$/m, 'the proposed text is what got imported');
  console.log('shadow import location:', flaskFile);
  console.log(output.split('\n')[0].replace(/: \/.*/, ''));

  // performance: a change to cli.py runs test_cli.py (+ importers) well under 5 s
  const cli = fs.readFileSync(path.join(ROOT, 'src/flask/cli.py'), 'utf8');
  const rCli = await timed('(perf) verify cli.py (test_cli + importers)', () =>
    verifier.verify(mkChange(ROOT, 'src/flask/cli.py', `${cli}\n# forgelight probe\n`, 'cli'), never),
  );
  assert.equal(rCli.status, 'passed', JSON.stringify(rCli));
  assert.ok(rCli.tests.includes('tests/test_cli.py'));
  assert.ok(rCli.durationMs < 5000, `cli verify took ${rCli.durationMs} ms`);
  config = cfg({ verifyCommand: '{python} -m pytest -q -x -p no:cacheprovider tests/test_cli.py' });
  const rCliOnly = await timed('(perf) verify test_cli.py only', () => verifier.verify(mkChange(ROOT, 'src/flask/cli.py', cli, 'clionly'), never));
  config = cfg();
  assert.equal(rCliOnly.status, 'passed');
  assert.match(rCliOnly.summary, /^58 passed/);
  assert.ok(rCliOnly.durationMs < 5000);

  // new test file in a new nested directory (mkdir -p in the copy)
  const rNew = await timed('verify new nested test file', () =>
    verifier.verify(mkChange(ROOT, 'tests/forgelight_probe_dir/test_probe_new.py', 'def test_new():\n    assert 1 + 1 == 2\n', 'new'), never),
  );
  assert.equal(rNew.status, 'passed', JSON.stringify(rNew));
  assert.deepEqual(rNew.tests, ['tests/forgelight_probe_dir/test_probe_new.py']);
  assert.match(rNew.summary, /^1 passed/);

  // (e) abort mid-run -> cancelled quickly, process group killed
  const SLEEPER = 'import time\n\ndef test_sleep():\n    time.sleep(30)\n';
  const ac = new AbortController();
  let abortedAt = 0;
  setTimeout(() => {
    abortedAt = Date.now();
    ac.abort();
  }, 1500);
  const rAbort = await timed('(e) verify aborted after 1.5 s', () =>
    verifier.verify(mkChange(ROOT, 'tests/test_forgelight_abort_probe.py', SLEEPER, 'abort'), ac.signal),
  );
  const cancelLatency = Date.now() - abortedAt;
  timings.push(`${'(e) abort -> resolved latency'.padEnd(44)} ${String(cancelLatency).padStart(6)} ms`);
  assert.equal(rAbort.status, 'cancelled', JSON.stringify(rAbort));
  assert.ok(cancelLatency < 1500, `cancel took ${cancelLatency} ms`);
  const pg = spawnSync('pgrep', ['-f', 'test_forgelight_abort_probe']);
  assert.notEqual(pg.status, 0, `sleeping pytest survived the abort: ${pg.stdout}`);
  // aborted before anything started
  const pre = new AbortController();
  pre.abort();
  assert.equal((await verifier.verify(mkChange(ROOT, 'src/flask/helpers.py', harmless), pre.signal)).status, 'cancelled');

  // timeout -> error, process killed
  config = cfg({ verifyTimeoutSec: 1 });
  const rTimeout = await timed('verify timeout (1 s)', () => verifier.verify(mkChange(ROOT, 'tests/test_forgelight_timeout_probe.py', SLEEPER, 'to'), never));
  config = cfg();
  assert.equal(rTimeout.status, 'error', JSON.stringify(rTimeout));
  assert.match(rTimeout.summary, /^timed out after 1s/);
  assert.ok(rTimeout.durationMs < 4000);
  assert.notEqual(spawnSync('pgrep', ['-f', 'test_forgelight_timeout_probe']).status, 0);

  // a background process left behind by the command is killed with its group
  config = cfg({ verifyCommand: '(sleep 31.4159 &); echo bg-started' });
  const rBg = await timed('verify leaves a background process', () => verifier.verify(mkChange(ROOT, 'src/flask/helpers.py', harmless, 'bg'), never));
  config = cfg();
  assert.equal(rBg.status, 'passed', JSON.stringify(rBg));
  assert.equal(rBg.summary, 'bg-started');
  assert.ok(rBg.durationMs < 3000);
  assert.notEqual(spawnSync('pgrep', ['-f', 'sleep 31.4159']).status, 0, 'background process survived');

  // concurrent verifications stay independent
  const [c1, c2] = await timed('verify 2 in parallel', () =>
    Promise.all([
      verifier.verify(mkChange(ROOT, 'src/flask/helpers.py', harmless, 'p1'), never),
      verifier.verify(mkChange(ROOT, 'src/flask/helpers.py', broken, 'p2'), never),
    ]),
  );
  assert.equal(c1.status, 'passed');
  assert.equal(c2.status, 'failed');

  // (d) the real workspace is untouched and every shadow dir is gone
  assert.equal(gitStatus(), '', 'git status of the sandbox must stay empty');
  assert.deepEqual(shadowDirs().filter((d) => !strayBefore.includes(d)), [], 'shadow dirs left behind');
  const snapAfter = snapshot(ROOT);
  const changed = [...new Set([...snapBefore.keys(), ...snapAfter.keys()])].filter((k) => snapBefore.get(k) !== snapAfter.get(k));
  assert.deepEqual(changed, [], 'files or dirs changed in the real workspace');
  console.log('(d) sandbox git status clean, no shadow dirs left, real tree unchanged');

  // ------------------------------------------------------------------------------------------
  // Copy filter + link safety on a small scratch workspace
  // ------------------------------------------------------------------------------------------
  const fx = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forgelight-fixture-')));
  try {
    const ws = path.join(fx, 'ws');
    fs.mkdirSync(path.join(ws, 'env'), { recursive: true }); // a source dir called "env": kept
    fs.writeFileSync(path.join(ws, 'env/settings.py'), 'X = 1\n');
    fs.mkdirSync(path.join(ws, 'venv/bin'), { recursive: true }); // a real virtualenv: not copied (linked for custom commands)
    fs.writeFileSync(path.join(ws, 'venv/pyvenv.cfg'), 'home = /usr/bin\n');
    fs.mkdirSync(path.join(ws, 'node_modules/x'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'node_modules/x/i.js'), '');
    fs.mkdirSync(path.join(ws, 'pkg.egg-info'));
    fs.writeFileSync(path.join(ws, 'big.bin'), Buffer.alloc(6 * 1024 * 1024));
    fs.writeFileSync(path.join(ws, 'small.txt'), 'small\n');
    fs.writeFileSync(path.join(fx, 'outside.txt'), 'OUTSIDE\n');
    fs.mkdirSync(path.join(fx, 'outsidedir'));
    fs.symlinkSync('../outside.txt', path.join(ws, 'link.py')); // only code changes run a test-less custom command
    fs.symlinkSync(path.join(fx, 'outsidedir'), path.join(ws, 'abslink'));
    fs.mkdirSync(path.join(ws, 'build')); // root-level build output: not copied
    fs.writeFileSync(path.join(ws, 'build/out.txt'), 'x');
    fs.mkdirSync(path.join(ws, 'pkgsrc/build'), { recursive: true }); // a nested "build" package: copied
    fs.writeFileSync(path.join(ws, 'pkgsrc/build/x.py'), 'X = 1\n');
    const fxv = new ShadowVerifier(ioFor(ws), {
      config: () =>
        cfg({
          verifyCommand:
            'test -f env/settings.py && test -L venv && test -L node_modules && test -f node_modules/x/i.js && test ! -e pkg.egg-info && test ! -e big.bin && test -f small.txt && test ! -e build && test -f pkgsrc/build/x.py && test "$(cat link.py)" = PROPOSED && echo copy-ok',
        }),
    });
    const rFilter = await fxv.verify(mkChange(ws, 'link.py', 'PROPOSED'), never);
    assert.equal(rFilter.status, 'passed', JSON.stringify(rFilter));
    assert.equal(rFilter.summary, 'copy-ok');
    assert.equal(fs.readFileSync(path.join(fx, 'outside.txt'), 'utf8'), 'OUTSIDE\n', 'symlink target outside was written');
    // removing the shadow (with its dependency links) must not touch the real dependency dirs
    assert.ok(fs.existsSync(path.join(ws, 'node_modules/x/i.js')) && fs.existsSync(path.join(ws, 'venv/pyvenv.cfg')), 'cleanup followed a link');
    const rEscape = await fxv.verify(mkChange(ws, 'abslink/evil.py', 'EVIL'), never);
    assert.equal(rEscape.status, 'error', JSON.stringify(rEscape));
    assert.match(rEscape.summary, /outside the shadow copy/);
    assert.deepEqual(fs.readdirSync(path.join(fx, 'outsidedir')), [], 'wrote through an absolute symlink');
    // mkdir must not create directories in the real tree through an absolute link either
    const rMkdir = await fxv.verify(mkChange(ws, 'abslink/newdir/deeper/evil.py', 'EVIL'), never);
    assert.equal(rMkdir.status, 'error', JSON.stringify(rMkdir));
    assert.match(rMkdir.summary, /outside the shadow copy/);
    assert.deepEqual(fs.readdirSync(path.join(fx, 'outsidedir')), [], 'mkdir went through an absolute symlink');
    const rTrav = await fxv.verify(mkChange(ws, '../escape.py', 'EVIL'), never);
    assert.equal(rTrav.status, 'error');
    assert.ok(!fs.existsSync(path.join(fx, 'escape.py')));
    console.log('copy filter and link safety ok');

    // F1 regression: a SYMLINKED workspace root is copied (not linked), and the proposal never
    // reaches the real file. Before the fix the "copy" was a link to the real tree (0 files).
    const realWs = path.join(fx, 'realws');
    fs.mkdirSync(path.join(realWs, 'tests'), { recursive: true });
    const MOD = 'def sub(a, b):\n    return a + b\n';
    fs.writeFileSync(path.join(realWs, 'mod.py'), MOD);
    fs.writeFileSync(path.join(realWs, 'tests/test_mod.py'), 'from mod import sub\n\ndef test_sub():\n    assert sub(1, 1) == 2\n');
    const linkWs = path.join(fx, 'linkws');
    fs.symlinkSync(realWs, linkWs);
    let linkOut = '';
    const lv = new ShadowVerifier(ioFor(linkWs), {
      config: () => cfg({ verifyCommand: 'grep -c PROPOSAL mod.py' }),
      onOutput: (c) => (linkOut += c),
    });
    const rLink = await lv.verify(mkChange(linkWs, 'mod.py', 'def sub(a, b):\n    return a - b  # PROPOSAL\n'), never);
    assert.equal(rLink.status, 'passed', JSON.stringify(rLink));
    const nCopied = Number(/shadow copy of (\d+) files/.exec(linkOut)?.[1] ?? 0);
    assert.ok(nCopied > 0, `copied ${nCopied} files: ${linkOut.split('\n')[0]}`);
    assert.equal(fs.readFileSync(path.join(realWs, 'mod.py'), 'utf8'), MOD, 'the real file got the proposal');
    assert.ok(fs.lstatSync(linkWs).isSymbolicLink());
    console.log('symlinked root ok');

    // F7: a package outside src/ (lib/pkg) that is importable from the REAL tree (an editable
    // install's .pth, simulated with PYTHONPATH) must still be imported from the copy.
    const libWs = path.join(fx, 'libws');
    fs.mkdirSync(path.join(libWs, 'lib/pkg'), { recursive: true });
    fs.mkdirSync(path.join(libWs, 'tests'));
    fs.writeFileSync(path.join(libWs, 'lib/pkg/__init__.py'), '');
    fs.writeFileSync(path.join(libWs, 'lib/pkg/mod.py'), 'VALUE = 1\n');
    fs.writeFileSync(path.join(libWs, 'tests/test_mod.py'), 'from pkg.mod import VALUE\n\ndef test_value():\n    assert VALUE == 1\n');
    assert.equal(pythonImportRoot(libWs, 'lib/pkg/mod.py'), 'lib');
    assert.equal(pythonImportRoot(libWs, 'tests/test_mod.py'), undefined);
    assert.equal(pythonImportRoot(ROOT, 'src/flask/cli.py'), undefined, 'src/ is always on the path');
    const savedPyPath = process.env.PYTHONPATH;
    process.env.PYTHONPATH = path.join(libWs, 'lib');
    try {
      const libv = new ShadowVerifier(ioFor(libWs), {
        config: () => cfg({ verifyCommand: `${path.join(ROOT, '.venv/bin/python')} -m pytest -q -p no:cacheprovider {tests}` }),
      });
      const rLib = await libv.verify(mkChange(libWs, 'lib/pkg/mod.py', 'VALUE = 2\n'), never);
      assert.equal(rLib.status, 'failed', `the real lib/pkg was imported instead of the copy: ${JSON.stringify(rLib)}`);
    } finally {
      if (savedPyPath === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = savedPyPath;
    }
    console.log('import root ok');

    // F3: the proposal runs sandboxed. A proposed test that tries to write the real workspace and the
    // home directory, reach the network and TrueForge, and read a secret from the environment gets
    // nowhere; loopback still works (tests may start local servers).
    const sbWs = path.join(fx, 'sbws');
    fs.mkdirSync(path.join(sbWs, 'tests'), { recursive: true });
    fs.symlinkSync(path.join(ROOT, '.venv'), path.join(sbWs, '.venv')); // auto plan: <root>/.venv/bin/python -m pytest
    const homeProbe = path.join(os.homedir(), `.forgelight-sandbox-probe-${process.pid}`);
    const tfPort = Number(new URL(DEFAULT_CONFIG.trueforgeUrl).port);
    const EVIL = [
      'import os, pathlib, socket',
      '',
      'def test_contained():',
      '    r = {}',
      `    for name, target in [("ws", ${JSON.stringify(path.join(sbWs, 'escaped.txt'))}), ("home", ${JSON.stringify(homeProbe)})]:`,
      '        try:',
      '            pathlib.Path(target).write_text("escaped")',
      '            r[name] = "WROTE"',
      '        except OSError:',
      '            r[name] = "denied"',
      `    for name, addr in [("net", ("1.1.1.1", 80)), ("trueforge", ("127.0.0.1", ${tfPort}))]:`,
      '        try:',
      '            socket.create_connection(addr, timeout=3).close()',
      '            r[name] = "CONNECTED"',
      '        except OSError:',
      '            r[name] = "denied"',
      '    r["secret"] = os.environ.get("FORGELIGHT_PROBE_TOKEN", "absent")',
      '    srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen()',
      '    socket.create_connection(srv.getsockname(), timeout=3).close()',
      '    pathlib.Path("written-in-copy.txt").write_text("ok")',
      '    assert r == {"ws": "denied", "home": "denied", "net": "denied", "trueforge": "denied", "secret": "absent"}, r',
      '',
    ].join('\n');
    process.env.FORGELIGHT_PROBE_TOKEN = 'probe-secret';
    try {
      const sbv = new ShadowVerifier(ioFor(sbWs), { config: () => cfg() });
      const plan = await sbv.plan(mkChange(sbWs, 'tests/test_evil.py', EVIL));
      assert.match(plan.command ?? '', /\.venv\/bin\/python -m pytest/);
      const rSb = await sbv.verify(mkChange(sbWs, 'tests/test_evil.py', EVIL, 'evil'), never);
      assert.equal(rSb.status, 'passed', JSON.stringify(rSb));
      assert.ok(!fs.existsSync(path.join(sbWs, 'escaped.txt')), 'the shadow run wrote the real workspace');
      assert.ok(!fs.existsSync(path.join(sbWs, 'tests/test_evil.py')), 'the proposal reached the real workspace');
      assert.ok(!fs.existsSync(homeProbe), 'the shadow run wrote the home directory');
    } finally {
      delete process.env.FORGELIGHT_PROBE_TOKEN;
      fs.rmSync(homeProbe, { force: true });
    }
    console.log('sandbox containment ok');
  } finally {
    fs.rmSync(fx, { recursive: true, force: true });
  }
  assert.deepEqual(shadowDirs().filter((d) => !strayBefore.includes(d)), [], 'shadow dirs left behind (fixture)');
  assert.equal(gitStatus(), '');

  console.log('\nTimings:');
  for (const t of timings) console.log('  ' + t);
  console.log('\nshadow.test: ALL PASSED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
