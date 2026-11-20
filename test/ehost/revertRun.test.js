// Extension-host check of Feature 2, run checkpoints (no model, no TrueForge run).
// Through the reviewProposal test hook, run 9000 edits b.py, then run 9001 edits a.py twice,
// edits b.py once and creates newpkg/c.py. 'Forgelight: Revert Last Run' must restore a.py to its
// text before run 9001's first edit, b.py to its text after run 9000, and delete c.py. Then
// run 9000 is reverted by id, and run 9002's edit is reverted after a later "user" edit elsewhere
// in the file, which must survive; run 9003's two edits with a user edit in between are reverted
// edit by edit, keeping the user edit.
//
// Run (VS Code 1.84+; build first with `npm run build`):
//   "<VS Code.app>/Contents/MacOS/Electron" --extensionDevelopmentPath=<repo> \
//     --extensionTestsPath=<repo>/test/ehost/revertRun.test.js --user-data-dir=<short tmp dir> \
//     --disable-workspace-trust --disable-extensions --new-window
// Put {"update.mode": "none"} in <user-data-dir>/User/settings.json first: a fresh profile otherwise
// downloads a VS Code update after ~30 s and Squirrel tries to install it over this VS Code on exit.
// Results are written to <os tmpdir>/forgelight-revertRun.result.json.
// Note: activating Forgelight re-registers its MCP server with a running TrueForge, so do not run
// this while another Forgelight window is in the middle of a run.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.tmpdir(), 'forgelight-revertRun.result.json');
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
/** Resolves with the promise's value, or with `fallback` after `ms` (e.g. a modal blocked it). */
const within = (promise, ms, fallback) => Promise.race([promise, sleep(ms).then(() => fallback)]);

const lines = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}_${i + 1} = ${i + 1}`).join('\n') + '\n';
const A0 = lines('a', 20);
const B0 = lines('b', 12);
const C1 = 'def created():\n    return "made by run 9001"\n';

const reviewTab = (name) =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .find((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === 'forgelight-proposed' && t.label.includes(` ${name} (`));

/** Review `proposedText` for `absPath` as a change of run `runId`, accept every hunk, wait for the apply. */
async function proposeAndAccept(api, id, runId, absPath, proposedText) {
  const name = path.basename(absPath);
  const done = api.reviewProposal({ id, absPath, proposedText, runId });
  const tab = await until(() => reviewTab(name), 10000);
  if (!tab) throw new Error(`the review of ${name} (${id}) did not open`);
  await vscode.commands.executeCommand('forgelight.acceptAll', id);
  const res = await done;
  // the next review of the same file must not find this tab
  await until(() => !reviewTab(name), 5000);
  return res;
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);

exports.run = async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgelight-ehost-revert-'));
  const fileA = path.join(dir, 'a.py');
  const fileB = path.join(dir, 'b.py');
  const fileC = path.join(dir, 'newpkg', 'c.py');
  try {
    fs.writeFileSync(fileA, A0);
    fs.writeFileSync(fileB, B0);
    const ext = vscode.extensions.getExtension('forgelight.forgelight');
    const api = await ext.activate();
    check(api && typeof api.reviewProposal === 'function' && typeof api.revertRun === 'function', 'extension API exposes reviewProposal and revertRun');
    const commands = await vscode.commands.getCommands(true);
    check(commands.includes('forgelight.revertLastRun'), 'forgelight.revertLastRun is registered');

    // run 9000: an earlier run edits b.py
    const B_X = B0.replace('b_2 = 2', 'b_2 = 200  # run 9000');
    const r0 = await proposeAndAccept(api, 'rv-9000-b', 9000, fileB, B_X);
    check(!!r0.record && r0.record.runId === 9000, `run 9000 record carries runId (${r0.record && r0.record.runId})`);
    check(read(fileB) === B_X, 'run 9000 applied to b.py');

    // run 9001: a.py, b.py, created c.py, a.py again
    const A1 = A0.replace('a_3 = 3', 'a_3 = 300  # run 9001 first edit');
    const B1 = B_X.replace('b_10 = 10', 'b_10 = 1000  # run 9001');
    const A2 = A1.replace('a_15 = 15', 'a_15 = 1500  # run 9001 second edit');
    const r1 = await proposeAndAccept(api, 'rv-9001-a1', 9001, fileA, A1);
    const r2 = await proposeAndAccept(api, 'rv-9001-b', 9001, fileB, B1);
    const r3 = await proposeAndAccept(api, 'rv-9001-c', 9001, fileC, C1);
    const r4 = await proposeAndAccept(api, 'rv-9001-a2', 9001, fileA, A2);
    check([r1, r2, r3, r4].every((r) => r.record && r.record.runId === 9001), 'run 9001 records carry runId 9001');
    check(!!r3.record && r3.record.createdFile === true, 'c.py was recorded as created');
    check(read(fileA) === A2 && read(fileB) === B1 && read(fileC) === C1, 'run 9001 applied on disk (a.py twice, b.py, new c.py)');

    // revert the last run (9001) with the command
    const reverted = await within(vscode.commands.executeCommand('forgelight.revertLastRun'), 20000, 'timeout');
    check(reverted !== 'timeout', 'Revert Last Run finished without asking (no modal)');
    const paths = Array.isArray(reverted) ? reverted.map((r) => path.basename(r.path)) : [];
    check(JSON.stringify(paths) === JSON.stringify(['a.py', 'a.py', 'c.py', 'b.py']), `reverted run 9001's 4 changes, newest file first: ${JSON.stringify(paths)}`);
    check(Array.isArray(reverted) && reverted.every((r) => r.runId === 9001), 'only records of run 9001 were reverted');
    await sleep(300);
    check(read(fileA) === A0, 'a.py is back to its text before run 9001 (both edits undone)');
    check(read(fileB) === B_X, "b.py is back to its text before run 9001 (run 9000's edit kept)");
    check(read(fileC) === undefined, 'c.py, created by run 9001, was deleted');

    const again = await within(api.revertRun(9001), 10000, 'timeout');
    check(Array.isArray(again) && again.length === 0, 'reverting run 9001 again reverts nothing');

    // run 9000 by id
    const rev0 = await within(api.revertRun(9000), 20000, 'timeout');
    check(Array.isArray(rev0) && rev0.length === 1 && path.basename(rev0[0].path) === 'b.py', 'revertRun(9000) reverted b.py');
    check(read(fileB) === B0, 'b.py is back to its original text');

    // run 9002, then a later edit elsewhere in a.py by "the user": only Forgelight's line is reverted
    const A3 = A0.replace('a_2 = 2', 'a_2 = 222  # run 9002');
    const r5 = await proposeAndAccept(api, 'rv-9002-a', 9002, fileA, A3);
    check(!!r5.record && read(fileA) === A3, 'run 9002 applied to a.py');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fileA));
    const USER = 'a_18 = 18  # edited by the user after the run';
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, doc.lineAt(17).range, USER);
    check(await vscode.workspace.applyEdit(edit), 'user edit applied');
    await doc.save();
    check(read(fileA) === A3.replace('a_18 = 18', USER), 'user edit saved');
    const rev2 = await within(api.revertRun(), 20000, 'timeout');
    check(rev2 !== 'timeout', 'revertRun() (last run) finished without asking (no modal)');
    check(Array.isArray(rev2) && rev2.length === 1 && rev2[0].runId === 9002, 'revertRun() with no id reverted the newest run, 9002');
    check(read(fileA) === A0.replace('a_18 = 18', USER), "a.py: run 9002's line reverted, the later user edit kept");

    // run 9003 edits a.py twice with a user edit in between: reverted edit by edit, the user edit kept
    const base = read(fileA);
    const MID = 'a_9 = 9  # edited by the user during the run';
    await proposeAndAccept(api, 'rv-9003-a1', 9003, fileA, base.replace('a_2 = 2', 'a_2 = 2222  # run 9003'));
    const docA = await vscode.workspace.openTextDocument(vscode.Uri.file(fileA));
    const midEdit = new vscode.WorkspaceEdit();
    midEdit.replace(docA.uri, docA.lineAt(8).range, MID);
    check(await vscode.workspace.applyEdit(midEdit), 'mid-run user edit applied');
    await docA.save();
    const r6 = await proposeAndAccept(api, 'rv-9003-a2', 9003, fileA, read(fileA).replace('a_15 = 15', 'a_15 = 15000  # run 9003'));
    check(!!r6.record && r6.record.runId === 9003, 'run 9003 second edit applied');
    const rev3 = await within(api.revertRun(9003), 20000, 'timeout');
    check(Array.isArray(rev3) && rev3.length === 2, `revertRun(9003) reverted both edits (${Array.isArray(rev3) ? rev3.length : rev3})`);
    check(read(fileA) === base.replace('a_9 = 9', MID), "a.py: run 9003's two lines reverted, the mid-run user edit kept");

    const none = await within(vscode.commands.executeCommand('forgelight.revertLastRun'), 10000, 'timeout');
    check(Array.isArray(none) && none.length === 0, 'Revert Last Run with nothing applied: nothing to revert');
  } catch (err) {
    log('FAIL exception: ' + ((err && err.stack) || err));
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  log('DONE');
};
