import * as esbuild from 'esbuild';
const watch = process.argv.includes('--watch');
const common = { bundle: true, platform: 'node', target: 'node18', format: 'cjs', sourcemap: true, logLevel: 'info' };
const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...common, entryPoints: ['test/headless/runTask.ts'], outfile: 'dist/test/headless/runTask.js', external: ['vscode'] },
];
for (const b of builds) {
  if (watch) { const ctx = await esbuild.context(b); await ctx.watch(); }
  else { try { await esbuild.build(b); } catch (e) { process.exitCode = 1; } }
}
