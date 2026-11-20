// Extension-host check of per-hunk review on a Task-A-shaped change (no model, no TrueForge run).
// A get_debug_flag-like file gets a docstring line and a code change two unchanged lines apart;
// the review must show 2 hunks, and accepting hunk 1 + rejecting hunk 2 must write only the
// docstring line.
//
// Run (VS Code 1.84+; build first with `npm run build`):
//   "<VS Code.app>/Contents/MacOS/Electron" --extensionDevelopmentPath=<repo> \
//     --extensionTestsPath=<repo>/test/ehost/perHunk.test.js --user-data-dir=<short tmp dir> \
//     --disable-workspace-trust --disable-extensions --new-window
// Put {"update.mode": "none"} in <user-data-dir>/User/settings.json first: a fresh profile otherwise
// downloads a VS Code update after ~30 s and Squirrel tries to install it over this VS Code on exit.
// Results are written to <os tmpdir>/forgelight-perHunk.result.json.
// Note: activating Forgelight re-registers its MCP server with a running TrueForge, so do not run
// this while another Forgelight window is in the middle of a run.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.tmpdir(), 'forgelight-perHunk.result.json');
const results = [];
const log = (m) => {
  results.push(m);
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
};
const check = (ok, what) => log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return undefined;
    await sleep(step);
  }
}

const ORIGINAL = [
  'import os',
  '',
  '',
  'def get_debug_flag() -> bool:',
  '    """Get whether debug mode should be enabled for the app, indicated by the',
  '    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.',
  '    """',
  '    val = os.environ.get("FLASK_DEBUG")',
  '    return bool(val and val.lower() not in {"0", "false", "no"})',
  '',
].join('\n');
const DOC = '    The values "0", "false", "no", "off" and "n" (any case) are false.';
const PROPOSED = ORIGINAL.replace('The default is ``False``.\n', 'The default is ``False``.\n' + DOC + '\n').replace(
  '{"0", "false", "no"}',
  '{"0", "false", "no", "off", "n"}',
);

exports.run = async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgelight-ehost-'));
  const file = path.join(dir, 'helpers_task_a.py');
  try {
    fs.writeFileSync(file, ORIGINAL);
    const ext = vscode.extensions.getExtension('forgelight.forgelight');
    const api = await ext.activate();
    check(api && typeof api.reviewProposal === 'function', 'extension API exposes reviewProposal');

    const id = 'ehost-per-hunk';
    const done = api.reviewProposal({ id, absPath: file, proposedText: PROPOSED });
    const tab = await until(
      () =>
        vscode.window.tabGroups.all
          .flatMap((g) => g.tabs)
          .find((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === 'forgelight-proposed'),
      10000,
    );
    check(!!tab && /\(2 hunks\)/.test(tab.label), `review tab opened with 2 hunks: "${tab && tab.label}"`);
    check(fs.readFileSync(file, 'utf8') === ORIGINAL, 'nothing written before the decisions');

    await vscode.commands.executeCommand('forgelight.acceptHunk', id, 0);
    check(fs.readFileSync(file, 'utf8') === ORIGINAL, 'nothing written after accepting only hunk 1 (hunk 2 pending)');
    await vscode.commands.executeCommand('forgelight.rejectHunk', id, 1);

    const res = await done;
    check(res.hunks === 2, `computed ${res.hunks} hunks`);
    check(JSON.stringify(res.result.accepted) === '[0]' && JSON.stringify(res.result.rejected) === '[1]', `decisions: ${JSON.stringify(res.result)}`);
    const after = fs.readFileSync(file, 'utf8');
    const expected = ORIGINAL.replace('The default is ``False``.\n', 'The default is ``False``.\n' + DOC + '\n');
    check(after === expected, 'only the docstring line was written (the return line is unchanged)');
    check(!!res.record && !res.record.createdFile && res.record.runId === 0, 'apply record returned (recorded under run 0)');

    await vscode.commands.executeCommand('forgelight.undoLastApplied');
    await sleep(300);
    check(fs.readFileSync(file, 'utf8') === ORIGINAL, 'undo restored the original on disk');
  } catch (err) {
    log('FAIL exception: ' + ((err && err.stack) || err));
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  log('DONE');
};
