// Extension-host check of the live assist features (no model, no TrueForge run):
//  F1 the menu command and the keys in VS Code's keybinding table, F2 the instant Python
//  indentation/syntax check, and the review keys (accept/reject with no argument = next hunk).
//
// Run it like perHunk.test.js, but open a workspace folder with a Python venv in it (last arg):
//   mkdir -p /tmp/flws && ln -s <flask>/.venv /tmp/flws/.venv
//   "<VS Code.app>/Contents/MacOS/Electron" --extensionDevelopmentPath=<repo> \
//     --extensionTestsPath=<repo>/test/ehost/assist.test.js --user-data-dir=<short tmp dir> \
//     --disable-workspace-trust --disable-extensions --new-window /tmp/flws
// Results are written to <os tmpdir>/forgelight-assist.result.json.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.tmpdir(), 'forgelight-assist.result.json');
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
const ours = (uri) => vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'Forgelight');

async function setText(doc, text) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
  await vscode.workspace.applyEdit(edit);
}

exports.run = async function run() {
  const root = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri.fsPath;
  const created = [];
  try {
    check(!!root, 'a workspace folder is open: ' + root);
    const ext = vscode.extensions.getExtension('forgelight.forgelight');
    const api = await ext.activate();

    // ---------------------------------------------------------------- F1: commands and keys
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['forgelight.showMenu', 'forgelight.checkFunction', 'forgelight.overviewFunction']) check(cmds.includes(c), c + ' registered');
    await vscode.commands.executeCommand('workbench.action.openDefaultKeybindingsFile');
    await sleep(1200);
    const kbText = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.getText() : '';
    const norm = (k) => k.split('+').sort().join('+');
    const entries = [...kbText.matchAll(/"key":\s*"([^"]+)",\s*"command":\s*"([^"]+)"/g)].map((m) => ({ key: norm(m[1]), command: m[2] }));
    const want = {
      'forgelight.showMenu': 'cmd+alt+/',
      'forgelight.checkFunction': 'cmd+alt+x',
      'forgelight.overviewFunction': 'cmd+alt+u',
      'forgelight.acceptHunk': 'cmd+alt+y',
      'forgelight.rejectHunk': 'cmd+alt+n',
      'forgelight.applyReview': 'cmd+alt+enter',
      'forgelight.undoLastApplied': 'cmd+alt+z',
    };
    for (const [command, key] of Object.entries(want)) {
      const bound = entries.filter((e) => e.key === norm(key));
      check(bound.some((e) => e.command === command), `${key} -> ${command} in VS Code's keybinding table`);
      const others = bound.filter((e) => e.command !== command && !e.command.startsWith('-')).map((e) => e.command);
      // ⌥⌘↩ is also Replace All, but only while the find widget is open (our key excludes that).
      const allowed = key === 'cmd+alt+enter' ? ['editor.action.replaceAll', 'search.action.replaceAll'] : [];
      check(others.every((o) => allowed.includes(o)), `${key} has no other binding: ${JSON.stringify(others)}`);
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    // ---------------------------------------------------------------- F2: instant checks
    const broken = path.join(root, 'assist_broken.py');
    created.push(broken);
    fs.writeFileSync(broken, 'def f(x):\n    if x:\n    return 1\n    return 0\n');
    const doc = await vscode.workspace.openTextDocument(broken);
    await vscode.window.showTextDocument(doc);
    let diags = await until(() => (ours(doc.uri).length ? ours(doc.uri) : undefined), 8000);
    check(!!diags, 'a Forgelight diagnostic appears for a missing indented block');
    if (diags) {
      const d = diags[0];
      check(/^Indentation: expected an indented block after 'if' statement on line 2/.test(d.message), 'message: ' + d.message);
      check(d.range.start.line === 2 && d.severity === vscode.DiagnosticSeverity.Error, `on line 3 as an error (line ${d.range.start.line + 1})`);
    }
    // Fixing the text clears it, without saving.
    await setText(doc, 'def f(x):\n    if x:\n        return 1\n    return 0\n');
    check(!!(await until(() => ours(doc.uri).length === 0, 5000)), 'fixed (unsaved) text clears the diagnostic');
    // A syntax error while typing.
    await setText(doc, 'def f(x)\n    return x\n');
    diags = await until(() => (ours(doc.uri).length ? ours(doc.uri) : undefined), 5000);
    check(!!diags && /^Syntax: /.test(diags[0].message) && diags[0].range.start.line === 0, 'missing colon: ' + (diags && diags[0].message));
    // Tabs and spaces mixed: warnings (and Python's own TabError or IndentationError).
    await setText(doc, 'def f(x):\n        a = 1\n\tb = 2\n        return a\n');
    diags = await until(() => (ours(doc.uri).some((d) => d.severity === vscode.DiagnosticSeverity.Warning) ? ours(doc.uri) : undefined), 5000);
    check(!!diags, 'mixed tabs and spaces flagged: ' + (diags && diags.map((d) => d.message.slice(0, 40)).join(' | ')));
    // The setting turns it off and clears the marks.
    await vscode.workspace.getConfiguration('forgelight').update('instantChecks', false, vscode.ConfigurationTarget.Workspace);
    check(!!(await until(() => ours(doc.uri).length === 0, 4000)), 'forgelight.instantChecks=false clears the marks');
    await vscode.workspace.getConfiguration('forgelight').update('instantChecks', undefined, vscode.ConfigurationTarget.Workspace);
    check(!!(await until(() => ours(doc.uri).length > 0, 5000)), 'turning it back on checks again');
    // A file outside the workspace is not checked.
    const outside = path.join(os.tmpdir(), `forgelight-outside-${process.pid}.py`);
    created.push(outside);
    fs.writeFileSync(outside, 'def g(:\n');
    const odoc = await vscode.workspace.openTextDocument(outside);
    await vscode.window.showTextDocument(odoc);
    await sleep(1500);
    check(ours(odoc.uri).length === 0, 'a file outside the workspace is not checked');
    await doc.save(); // a dirty file would stop "close all" at a save prompt
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    check(!!(await until(() => ours(doc.uri).length === 0, 4000)), 'closing the file removes its marks');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(broken));
    check(!!(await until(() => ours(doc.uri).length > 0, 5000)), 'reopening the file checks it again');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    // ------------------------------------------------- review keys: next hunk, no argument
    const file = path.join(root, 'assist_review.py');
    created.push(file);
    const ORIGINAL = ['a = 1', 'b = 2', 'c = 3', 'd = 4', 'e = 5', 'f = 6', 'g = 7', 'h = 8', ''].join('\n');
    const PROPOSED = ORIGINAL.replace('a = 1', 'a = 10').replace('h = 8', 'h = 80');
    fs.writeFileSync(file, ORIGINAL);
    const done = api.reviewProposal({ id: 'ehost-keys', absPath: file, proposedText: PROPOSED });
    const tab = await until(
      () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === 'forgelight-proposed'),
      10000,
    );
    check(!!tab && /\(2 hunks\)/.test(tab.label), 'review with 2 hunks opened: ' + (tab && tab.label));
    await vscode.commands.executeCommand('forgelight.acceptHunk'); // ⌥⌘Y: no argument
    check(fs.readFileSync(file, 'utf8') === ORIGINAL, 'nothing written after the first key (one hunk still undecided)');
    await vscode.commands.executeCommand('forgelight.rejectHunk'); // ⌥⌘N
    const res = await done;
    check(JSON.stringify(res.result.accepted) === '[0]' && JSON.stringify(res.result.rejected) === '[1]', 'keys decided hunk 1 then hunk 2: ' + JSON.stringify(res.result));
    check(fs.readFileSync(file, 'utf8') === ORIGINAL.replace('a = 1', 'a = 10'), 'only the accepted hunk was written');
    await vscode.commands.executeCommand('forgelight.undoLastApplied'); // ⌥⌘Z
    await sleep(300);
    check(fs.readFileSync(file, 'utf8') === ORIGINAL, 'undo restored the file');
    // With no review open the keys do nothing harmful.
    await vscode.commands.executeCommand('forgelight.acceptHunk');
    check(fs.readFileSync(file, 'utf8') === ORIGINAL, 'accept with no review open changes nothing');
  } catch (err) {
    log('FAIL exception: ' + ((err && err.stack) || err));
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const f of created) fs.rmSync(f, { force: true });
    if (root) fs.rmSync(path.join(root, '.vscode'), { recursive: true, force: true });
  }
  log('DONE');
};
