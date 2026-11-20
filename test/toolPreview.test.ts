/**
 * Pure test of the tool-result previews the runner sends to the panel (no vscode, no TrueForge). Run:
 *   npx esbuild test/toolPreview.test.ts --bundle --platform=node --outfile=/tmp/tp.js && node /tmp/tp.js
 */
import assert from 'node:assert/strict';
import { toolPreview, toolResultText } from '../src/trueforge/runner';

// TrueForge 0.185 wraps isError results as {"error":[content parts]}; a denial's text is itself JSON.
const envelope = (text: string) => JSON.stringify({ error: [{ type: 'text', text }] });
const denial = (reason: string) => envelope(JSON.stringify({ error: `User denied tool call: ${reason}` }));

assert.equal(
  toolResultText('propose_edit', denial('The user rejected all hunks of this edit.')),
  'Not applied: The user rejected all hunks of this edit.',
);
assert.equal(toolResultText('run_command', denial('The user declined to run this command.')), 'Not run: The user declined to run this command.');
assert.equal(
  toolResultText('propose_edit', envelope('Edit #1: the search block was not found in src/a.py.')),
  'Error: Edit #1: the search block was not found in src/a.py.',
);
// successful results (plain text or other JSON) pass through unchanged
assert.equal(toolResultText('read_file', 'src/a.py (lines 1-2 of 2)\nx\ny'), 'src/a.py (lines 1-2 of 2)\nx\ny');
assert.equal(toolResultText('x', '{"error":"plain","other":1}'), '{"error":"plain","other":1}');
assert.equal(toolResultText('x', ''), '');

// run_command keeps the command, the exit code and the last output lines (pytest's summary)
const out = ['$ .venv/bin/python -m pytest tests/test_cli.py -q', 'exit code: 1', ...Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(20)}`), 'FAILED tests/test_cli.py::test_config', '1 failed in 0.05s'].join('\n');
const p = toolPreview('run_command', out);
const lines = p.split('\n');
assert.equal(lines[0], '$ .venv/bin/python -m pytest tests/test_cli.py -q');
assert.equal(lines[1], 'exit code: 1');
assert.equal(lines[lines.length - 1], '1 failed in 0.05s');
assert.ok(p.length < 800);
// other tools are clipped to 300 characters
assert.equal(toolPreview('read_file', 'y'.repeat(1000)).length, 300);

console.log('toolPreview tests passed');
