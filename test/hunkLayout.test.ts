/**
 * Pure test of src/review/hunkLayout.ts (no vscode). Run:
 *   npx esbuild test/hunkLayout.test.ts --bundle --platform=node --outfile=/tmp/hl.js && node /tmp/hl.js
 */
import assert from 'node:assert/strict';
import { changedLines, clampLine, decisionsToResult, layoutHunk, minimalReplace } from '../src/review/hunkLayout';
import { applyHunks, computeHunks, computeProposal, rebaseChange, wholeFileLoss } from '../src/review/hunks';

const lines = (n: number, prefix = 'l') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n') + '\n';

// Insertion: anchor and added line point at the inserted line of the proposed text.
{
  const before = lines(8);
  const after = before.replace('l4\n', 'l4\nX\n');
  const [h] = computeHunks(before, after);
  assert.deepEqual(layoutHunk(h), { index: 0, anchorLine: 4, addedLines: [4] });
}
// Pure deletion: anchored on the line that follows the removed text.
{
  const before = lines(8);
  const after = before.replace('l5\n', '');
  const [h] = computeHunks(before, after);
  const l = layoutHunk(h);
  assert.deepEqual(l.addedLines, []);
  assert.equal(after.split('\n')[l.anchorLine], 'l6');
}
// New file, whole-file deletion, and "\ No newline at end of file" markers.
assert.deepEqual(layoutHunk(computeHunks('', 'a\nb\n')[0]), { index: 0, anchorLine: 0, addedLines: [0, 1] });
assert.deepEqual(layoutHunk(computeHunks('a\nb\n', '')[0]), { index: 0, anchorLine: 0, addedLines: [] });
assert.deepEqual(layoutHunk(computeHunks('a\nb', 'a\nc')[0]), { index: 0, anchorLine: 1, addedLines: [1] });
assert.equal(clampLine(10, 3), 2);
assert.equal(clampLine(-1, 3), 0);

// Property: every '+' line lands on the matching line of the proposed text; anchors are in range.
let seed = 7;
const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
for (let iter = 0; iter < 300; iter++) {
  const src = lines(5 + rnd(60)).split('\n').slice(0, -1);
  const out: string[] = [];
  for (const line of src) {
    const r = rnd(12);
    if (r === 0) continue; // delete
    if (r === 1) out.push(`${line}*`); // modify
    else out.push(line);
    if (r === 2) out.push(`new${iter}-${out.length}`); // insert
  }
  const before = src.join('\n') + '\n';
  const after = out.join('\n') + (out.length ? '\n' : '');
  const proposedLines = after.split('\n');
  const hunks = computeHunks(before, after);
  for (const h of hunks) {
    const l = layoutHunk(h);
    const plus = h.lines.filter((x) => x.startsWith('+')).map((x) => x.slice(1));
    assert.deepEqual(l.addedLines.map((i) => proposedLines[i]), plus, `iter ${iter} hunk ${h.index}`);
    assert.ok(l.anchorLine >= 0 && l.anchorLine <= Math.max(0, proposedLines.length - 1));
    if (plus.length) assert.ok(l.anchorLine <= l.addedLines[0]);
  }
  // minimalReplace reconstructs `after` and stays on line boundaries
  const r = minimalReplace(before, after);
  if (before === after) assert.equal(r, undefined);
  else {
    assert.ok(r);
    assert.equal(before.slice(0, r.start) + r.text + before.slice(r.end), after);
    assert.ok(r.start === 0 || before[r.start - 1] === '\n');
    assert.ok(r.end === before.length || before[r.end - 1] === '\n');
  }
  // changedLines points at real lines of `after`
  for (const i of changedLines(before, after)) assert.ok(i >= 0 && i < Math.max(1, proposedLines.length));
  // any subset of hunks still applies
  const subset = hunks.filter(() => rnd(2) === 0).map((h) => h.index);
  applyHunks(before, hunks, subset);
}

// minimalReplace: CRLF is never split, repeated lines, append at end.
{
  const before = 'a\r\nb\r\nc\r\n';
  const after = 'a\r\nB\r\nc\r\n';
  const r = minimalReplace(before, after)!;
  assert.deepEqual(r, { start: 3, end: 6, text: 'B\r\n' });
  assert.deepEqual(minimalReplace('a\n', 'a\na\n'), { start: 2, end: 2, text: 'a\n' });
  assert.deepEqual(minimalReplace('\nx', '\ny'), { start: 1, end: 2, text: 'y' });
  assert.equal(minimalReplace('same', 'same'), undefined);
}

// decisionsToResult: pending counts as rejected; indices come from Hunk.index.
{
  const hunks = computeHunks(lines(30), lines(30).replace('l2\n', 'L2\n').replace('l15\n', 'L15\n').replace('l28\n', 'L28\n'));
  assert.equal(hunks.length, 3);
  const res = decisionsToResult('c1', hunks, ['accepted', 'pending', 'rejected'], { note: 'n' });
  assert.deepEqual(res, { changeId: 'c1', decisions: ['accepted', 'rejected', 'rejected'], accepted: [0], rejected: [1, 2], note: 'n' });
  const cancelled = decisionsToResult('c1', hunks, [], { cancelled: true, note: 'run cancelled' });
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(cancelled.accepted, []);
}

// Context 0 (what the review uses): property test of layout and of applying any subset, against
// a reference that replaces old lines [oldStart-1, +oldLines) of the original in order.
for (let iter = 0; iter < 300; iter++) {
  const src = lines(3 + rnd(40)).split('\n').slice(0, -1);
  const out: string[] = [];
  for (const line of src) {
    const r = rnd(8);
    if (r === 0) continue;
    if (r === 1) out.push(`${line}*`);
    else out.push(line);
    if (r === 2) out.push(`ins${iter}-${out.length}`);
  }
  if (rnd(5) === 0) out.unshift(`top${iter}`);
  const before = src.join('\n') + '\n';
  const after = out.join('\n') + (out.length ? '\n' : '');
  const proposedLines = after.split('\n');
  const hunks = computeHunks(before, after, 'f', 0);
  for (const h of hunks) {
    assert.ok(h.lines.every((x) => x[0] === '+' || x[0] === '-'), `iter ${iter}: context-0 hunk has context lines`);
    const l = layoutHunk(h);
    const plus = h.lines.filter((x) => x.startsWith('+')).map((x) => x.slice(1));
    assert.deepEqual(l.addedLines.map((i) => proposedLines[i]), plus, `iter ${iter} hunk ${h.index}`);
    assert.ok(l.anchorLine >= 0 && l.anchorLine <= Math.max(0, proposedLines.length - 1));
  }
  const subset = hunks.filter(() => rnd(2) === 0).map((h) => h.index);
  const expected = src.slice();
  let shift = 0;
  for (const h of hunks) {
    if (!subset.includes(h.index)) continue;
    const at = Math.max(0, h.oldStart - 1) + shift;
    const added = h.lines.filter((x) => x[0] === '+').map((x) => x.slice(1));
    expected.splice(at, h.oldLines, ...added);
    shift += added.length - h.oldLines;
  }
  const want = expected.join('\n') + (expected.length ? '\n' : '');
  assert.equal(applyHunks(before, hunks, subset), want, `iter ${iter} subset ${subset}`);
  assert.equal(applyHunks(before, hunks, hunks.map((h) => h.index)), after);
}

// Task A shape (flask get_debug_flag): the docstring line and the return line are two unchanged
// lines apart, so context 3 (and even 1) merges them; context 0 gives two hunks.
{
  const fn = [
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
    '',
    'def get_load_dotenv(default: bool = True) -> bool:',
    '    pass',
    '',
  ].join('\n');
  const doc = '    The values "0", "false", "no", "off" and "n" (any case) are false.';
  const proposed = fn
    .replace('The default is ``False``.\n', 'The default is ``False``.\n' + doc + '\n')
    .replace('{"0", "false", "no"}', '{"0", "false", "no", "off", "n"}');
  assert.equal(computeHunks(fn, proposed).length, 1);
  assert.equal(computeHunks(fn, proposed, 'f', 1).length, 1);
  const hunks = computeHunks(fn, proposed, 'f', 0);
  assert.equal(hunks.length, 2);
  const docOnly = applyHunks(fn, hunks, [0]);
  assert.ok(docOnly.includes(doc) && docOnly.includes('{"0", "false", "no"})'), 'accept 1, reject 2 writes only the docstring line');
  const codeOnly = applyHunks(fn, hunks, [1]);
  assert.ok(!codeOnly.includes(doc) && codeOnly.includes('"off", "n"'));
  assert.equal(applyHunks(fn, hunks, [0, 1]), proposed);
  assert.equal(applyHunks(fn, hunks, []), fn);

  // The buffer changed above the function after the proposal: a zero-context insertion applied to
  // it directly lands at a stale offset; rebaseChange carries it over with context checks.
  const target = applyHunks(fn, hunks, [0]);
  const edited = fn.replace('import os\n', 'import os\nimport sys\n');
  const rebased = rebaseChange(fn, target, edited, 'f');
  assert.equal(rebased, edited.replace('The default is ``False``.\n', 'The default is ``False``.\n' + doc + '\n'));
  assert.equal(rebaseChange(fn, target, fn), target);
  // ...and refuses when the lines around the change were edited.
  const clash = fn.replace('    """\n    val', '    Extra.\n    """\n    val').replace(':envvar:', ':env:');
  assert.throws(() => rebaseChange(fn, target, clash, 'f'));
}

// new_content on an existing file: a rewrite that wipes most of it is refused, others go through.
{
  const big = Array.from({ length: 60 }, (_, i) => `line_${i} = ${i}`).join('\n') + '\n';
  const wipe = computeProposal(big, { path: 'tests/test_x.py', new_content: 'def test_new():\n    assert True\n' });
  assert.equal(wipe.proposedText, undefined);
  assert.match(wipe.error ?? '', /already exists \(61 lines\).*delete 60 of its lines.*edits/s);
  const appended = big + 'def test_new():\n    assert True\n';
  assert.equal(wholeFileLoss(big, appended), undefined);
  assert.equal(computeProposal(big, { path: 'tests/test_x.py', new_content: appended }).proposedText, appended);
  const small = 'a = 1\nb = 2\n';
  assert.equal(computeProposal(small, { path: 's.py', new_content: 'c = 3\n' }).proposedText, 'c = 3\n');
  assert.equal(computeProposal(undefined, { path: 'new.py', new_content: 'x = 1\n' }).isNewFile, true);
}

console.log('hunkLayout tests passed');
