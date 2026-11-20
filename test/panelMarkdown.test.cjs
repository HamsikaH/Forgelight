// Panel markdown (media/panel.js renderMarkdown/mdInline): tables, nested lists, italics.
// Run: npx tsx test/panelMarkdown.test.ts
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'media', 'panel.js'), 'utf8');
const a = src.indexOf('  function escapeHtml(s)');
const b = src.indexOf('  // ------------------------------------------------------------------ state');
const { renderMarkdown, mdInline } = new Function(src.slice(a, b) + '\nreturn { renderMarkdown, mdInline };')();
let fail = 0;
const t = (name, got, want) => { const ok = typeof want === 'function' ? want(got) : got === want; if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '\n   got: ' + got)); };
// tables
t('table', renderMarkdown('Usage:\n| Location | Line | Purpose |\n|---|---|---|\n| `src/flask/app.py` | 628 | Sets **debug** |\n| cli.py | 369, 981 | run & shell |\n\nCovered by tests.'),
  (h) => h.includes('<div class="md-table"><table><thead><tr><th>Location</th><th>Line</th><th>Purpose</th></tr></thead><tbody><tr><td><code>src/flask/app.py</code></td><td>628</td><td>Sets <strong>debug</strong></td></tr><tr><td>cli.py</td><td>369, 981</td><td>run &amp; shell</td></tr></tbody></table></div>') && h.startsWith('<p>Usage:</p>') && h.endsWith('<p>Covered by tests.</p>'));
t('table aligned seps, no outer pipes', renderMarkdown('a | b\n:--|--:\n1 | 2'), (h) => h.includes('<th>a</th><th>b</th>') && h.includes('<td>1</td><td>2</td>'));
t('escaped pipe in cell', renderMarkdown('| x |\n|---|\n| a \\| b |'), (h) => h.includes('<td>a | b</td>'));
t('short row padded', renderMarkdown('| a | b |\n|---|---|\n| 1 |'), (h) => h.includes('<td>1</td><td></td>'));
t('hr after pipe text is not a table', renderMarkdown('a | b\n---'), (h) => !h.includes('<table>'));
t('no separator, no table', renderMarkdown('| a | b |\n| c | d |'), (h) => !h.includes('<table>'));
// lists
t('flat list unchanged', renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
t('ordered start kept', renderMarkdown('2. x\n3. y'), '<ol start="2"><li>x</li><li>y</li></ol>');
t('nested bullets under ordered', renderMarkdown('1. **cli.py**\n2. tests:\n   - Creates an app\n   - Invokes the CLI\n3. docs'),
  '<ol><li><strong>cli.py</strong></li><li>tests:<ul><li>Creates an app</li><li>Invokes the CLI</li></ul></li><li>docs</li></ol>');
t('two-space nesting', renderMarkdown('- a\n  - b\n    - c\n- d'), '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
t('continuation line', renderMarkdown('- a\n  more\n- b'), '<ul><li>a more</li><li>b</li></ul>');
t('type switch same level', renderMarkdown('- a\n1. b'), '<ul><li>a</li></ul><ol><li>b</li></ol>');
t('list then para', renderMarkdown('- a\n\ntext'), '<ul><li>a</li></ul><p>text</p>');
t('1-space jitter stays flat', renderMarkdown('- a\n - b'), '<ul><li>a</li><li>b</li></ul>');
t('streaming fence', renderMarkdown('x\n```py\ndef f():'), '<p>x</p><pre><code>def f():</code></pre>');
// inline
t('italic', mdInline('it is *not* in the set'), 'it is <em>not</em> in the set');
t('math stays', mdInline('2 * 3 * 4'), '2 * 3 * 4');
t('a*b*c stays', mdInline('a*b*c'), 'a*b*c');
t('bold + italic', mdInline('**bold** and *it*'), '<strong>bold</strong> and <em>it</em>');
t('code not italic', mdInline('`*x*` and *y*'), '<code>*x*</code> and <em>y</em>');
t('bullet-like star alone', mdInline('* not a list'), '* not a list');
t('html escaped', renderMarkdown('| <b> |\n|---|\n| x |'), (h) => h.includes('<th>&lt;b&gt;</th>'));
console.log(fail ? 'panelMarkdown: ' + fail + ' FAILED' : 'panelMarkdown: all checks passed');
process.exit(fail ? 1 : 0);
