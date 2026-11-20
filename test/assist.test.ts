// Live assist (F1-F4) unit checks: no VS Code, no model.
// Run: npx esbuild test/assist.test.ts --bundle --platform=node --target=node18 --outfile=<tmp>/assist.js && node <tmp>/assist.js
// FLASK_ROOT (default ../forge-a-thon-sandbox/flask) with a .venv enables the real-Python checks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractSymbols } from '../src/context/indexer';
import { ACTIONS } from '../src/assist/actions';
import {
  MAX_CODE_LINES,
  PY_CHECK,
  checkRequest,
  enclosingFunction,
  mixedIndentLines,
  overviewRequest,
  parsePyCheck,
  syntaxMessage,
  type AskTarget,
} from '../src/assist/analysis';

let checks = 0;
const ok = (cond: unknown, what: string) => {
  assert.ok(cond, what);
  checks++;
};

// ------------------------------------------------------------------ F2: mixed indentation
ok(mixedIndentLines('def f():\n    a = 1\n    return a\n').length === 0, 'spaces only: nothing flagged');
ok(mixedIndentLines('def f():\n\ta = 1\n\treturn a\n').length === 0, 'tabs only: nothing flagged');
assert.deepEqual(mixedIndentLines('def f():\n    a = 1\n\tb = 2\n    return a\n'), [2]);
checks++;
assert.deepEqual(mixedIndentLines('def f():\n\t    a = 1\n'), [1], 'tab then spaces on one line');
checks++;
ok(mixedIndentLines('def f():\n\n    \n    a = 1\n').length === 0, 'blank and whitespace-only lines ignored');
ok(mixedIndentLines(Array.from({ length: 200 }, (_, i) => (i % 2 ? '\tx' : '    y')).join('\n'), 20).length === 20, 'capped');

// ------------------------------------------------------------------ F2: Python's report
const parsed = parsePyCheck('[{"line": 3, "col": 5, "endLine": null, "endCol": null, "kind": "IndentationError", "msg": "expected an indented block after \'if\' statement on line 2"}]');
ok(parsed && parsed.length === 1 && parsed[0].line === 3 && parsed[0].endLine === undefined, 'parsePyCheck reads one problem');
ok(syntaxMessage(parsed![0]) === "Indentation: expected an indented block after 'if' statement on line 2", 'indentation message');
ok(syntaxMessage({ line: 1, col: 1, kind: 'TabError', msg: 'inconsistent use of tabs and spaces in indentation' }).startsWith('Tabs and spaces: '), 'tab message');
ok(syntaxMessage({ line: 1, col: 1, kind: 'SyntaxError', msg: 'invalid syntax' }) === 'Syntax: invalid syntax', 'syntax message');
assert.deepEqual(parsePyCheck('[]'), []);
checks++;
ok(parsePyCheck('Traceback (most recent call last):') === undefined, 'garbage is undefined, not a crash');
ok(parsePyCheck('{"line":1}') === undefined, 'non-array is undefined');

// The real interpreter, when the Flask checkout's venv is there.
const flask = path.resolve(process.env.FLASK_ROOT ?? '../forge-a-thon-sandbox/flask');
const py = path.join(flask, '.venv', 'bin', 'python');
if (fs.existsSync(py)) {
  const run = (text: string) => {
    const r = spawnSync(py, ['-I', '-c', PY_CHECK], { input: text, cwd: os.tmpdir(), encoding: 'utf8', timeout: 5000 });
    return parsePyCheck(r.stdout);
  };
  assert.deepEqual(run('def f(x):\n    if x:\n        return 1\n    return 0\n'), []);
  checks++;
  const missing = run('def f(x):\n    if x:\n    return 1\n');
  ok(missing && missing[0].kind === 'IndentationError' && missing[0].line === 3, 'missing indented block found on line 3');
  ok(/expected an indented block/.test(missing![0].msg), 'message from Python: ' + missing![0].msg);
  const unindent = run('def f(x):\n    a = 1\n  b = 2\n');
  ok(unindent && unindent[0].kind === 'IndentationError' && unindent[0].line === 3, 'unindent mismatch found');
  const tab = run('def f(x):\n        a = 1\n\tb = 2\n');
  ok(tab && (tab[0].kind === 'TabError' || tab[0].kind === 'IndentationError'), 'tab/space mix reported: ' + (tab && tab[0].kind));
  const syn = run('def f(x)\n    return x\n');
  ok(syn && syn[0].kind === 'SyntaxError' && syn[0].line === 1, 'missing colon is a syntax error on line 1');
  // ast.parse never runs the code: a side effect in the text must not happen.
  const marker = path.join(os.tmpdir(), `forgelight-assist-${process.pid}.txt`);
  assert.deepEqual(run(`open(${JSON.stringify(marker)}, "w").write("ran")\n`), []);
  ok(!fs.existsSync(marker), 'the parsed code is not executed');
  // A workspace-style ast.py next to the working directory cannot shadow the stdlib (-I, temp cwd).
  const unicode = run('名前 = "värde"\nprint(名前)\n');
  ok(unicode && unicode.length === 0, 'unicode source parses');
} else {
  console.log('assist.test: no Flask venv at ' + py + ', skipping the real-Python checks');
}

// ------------------------------------------------------------------ F3/F4: the function
const SRC = [
  'import os',
  '',
  'def get_debug_flag() -> bool:',
  '    """Get whether debug mode should be enabled."""',
  '    val = os.environ.get("FLASK_DEBUG")',
  '    return bool(val and val.lower() not in {"0", "false", "no"})',
  '',
  'class App:',
  '    def run(self, port=5000):',
  '        def inner():',
  '            return port',
  '        return inner()',
  '',
].join('\n');
const syms = extractSymbols('src/flask/helpers.py', SRC.split('\n'));
const fn = enclosingFunction(syms, 5);
ok(fn && fn.name === 'get_debug_flag' && fn.startLine === 3 && fn.endLine === 6, 'cursor in get_debug_flag');
const inner = enclosingFunction(syms, 11);
ok(inner && inner.name === 'inner', 'innermost function wins: ' + (inner && inner.name));
const method = enclosingFunction(syms, 12);
ok(method && method.name === 'run', 'method around the cursor');
ok(enclosingFunction(syms, 1) === undefined, 'outside any function');
ok(enclosingFunction(syms, 8) === undefined, 'a class line is not a function');

const target: AskTarget = { path: 'src/flask/helpers.py', name: 'get_debug_flag', startLine: 3, endLine: 6, code: SRC.split('\n').slice(2, 6).join('\n'), lang: 'python' };
const check = checkRequest(target);
ok(check.startsWith('Check the function `get_debug_flag` in `src/flask/helpers.py` (lines 3-6).'), 'check request head');
for (const part of ['Possible bugs', 'Indentation', 'Simpler or safer logic', 'Another way', 'none found', 'Do not create a sub-agent', 'do not change any file']) {
  ok(check.includes(part), 'check request mentions ' + part);
}
ok(check.includes('```python\ndef get_debug_flag() -> bool:'), 'code is fenced with its language');
ok(!/(^|\s)@\w/.test(check.split('```')[0]), 'no @mention outside the code (would pull whole files into context)');
const over = overviewRequest({ ...target, name: undefined });
ok(over.startsWith('Give a quick overview of the selected code in `src/flask/helpers.py`'), 'overview of a selection');
ok(over.includes('which tests cover it'), 'overview asks for tests');
const long = checkRequest({ ...target, code: Array.from({ length: 300 }, (_, i) => 'x = ' + i).join('\n'), endLine: 302 });
ok(long.includes(`cut after ${MAX_CODE_LINES} lines`) && !long.includes('x = 200'), 'long code is cut with a note');
const ticks = checkRequest({ ...target, code: 'doc = """```python\\nx\\n```"""' });
ok(/````python/.test(ticks), 'fence longer than backticks inside the code');

// ------------------------------------------------------------------ F1: menu keys agree with package.json
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8').toString());
const bindings: { command: string; key: string; mac?: string }[] = pkg.contributes.keybindings;
const commands = new Set<string>(pkg.contributes.commands.map((c: { command: string }) => c.command));
for (const a of ACTIONS) {
  ok(commands.has(a.command), `${a.command} is a contributed command`);
  if (!a.macKey) continue;
  const b = bindings.find((k) => k.command === a.command && (k.mac ?? k.key) === a.macKey);
  ok(b && b.key === a.key, `${a.command}: menu shows ${a.mac}, package.json binds ${b ? b.mac + '/' + b.key : 'nothing'}`);
}
ok(bindings.some((k) => k.command === 'forgelight.showMenu' && k.mac === 'cmd+alt+/'), 'menu key bound');
const macKeys = bindings.filter((k) => k.mac).map((k) => (k.mac as string) + '|' + ((k as { when?: string }).when ?? ''));
ok(new Set(macKeys).size === macKeys.length, 'no key bound twice with the same condition');

console.log(`assist.test: all ${checks} checks passed`);
