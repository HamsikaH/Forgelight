/**
 * F2: instant indentation and syntax check for Python while you type. No model: the unsaved text
 * is parsed by the project's own Python (ast.parse never runs the code), and indentation that
 * mixes tabs and spaces is flagged. Results show as squiggles (source "Forgelight") and in the
 * Problems list. Setting: forgelight.instantChecks (on by default).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { PY_CHECK, mixedIndentLines, parsePyCheck, syntaxMessage } from './analysis';

const DEBOUNCE_MS = 400;
const TIMEOUT_MS = 2000;
const MAX_BYTES = 300 * 1024;

export interface InstantCheckDeps {
  /** Workspace-relative path of an absolute path, or undefined outside the workspace. */
  relativePath(absPath: string): string | undefined;
  /** Workspace root ('' when there is none). */
  root(): string;
}

export function registerInstantChecks(context: vscode.ExtensionContext, deps: InstantCheckDeps): void {
  const checker = new InstantChecker(deps);
  context.subscriptions.push(checker);
  checker.start();
}

/** First `name` on PATH, or '' when there is none. */
function findOnPath(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return '';
}

class InstantChecker implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('forgelight');
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly procs = new Map<string, ChildProcess>();
  private readonly subs: vscode.Disposable[] = [];
  /** Interpreter that failed to start (missing): stay silent instead of retrying on every key. */
  private broken = new Set<string>();

  constructor(private readonly deps: InstantCheckDeps) {}

  start(): void {
    this.subs.push(
      vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d, 0)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) this.schedule(e.document, DEBOUNCE_MS);
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.forget(d.uri)),
      // VS Code keeps a document loaded for a while after its tab closes: clear the marks when the
      // last tab showing the file closes, and check again when the file is shown again.
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        for (const t of e.closed) {
          const uri = t.input instanceof vscode.TabInputText ? t.input.uri : undefined;
          if (uri && !this.shown(uri)) this.forget(uri);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (ed && !this.diagnostics.has(ed.document.uri)) this.schedule(ed.document, 0);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('forgelight.instantChecks')) return;
        if (this.enabled) for (const d of vscode.workspace.textDocuments) this.schedule(d, 0);
        else this.clearAll();
      }),
    );
    for (const d of vscode.workspace.textDocuments) this.schedule(d, 0);
  }

  /** Whether any editor tab still shows `uri`. */
  private shown(uri: vscode.Uri): boolean {
    const key = uri.toString();
    return vscode.window.tabGroups.all.some((g) =>
      g.tabs.some((t) => (t.input instanceof vscode.TabInputText || t.input instanceof vscode.TabInputTextDiff ? (t.input instanceof vscode.TabInputText ? t.input.uri : t.input.modified).toString() === key : false)),
    );
  }

  private get enabled(): boolean {
    return vscode.workspace.getConfiguration('forgelight').get<boolean>('instantChecks', true) !== false;
  }

  private eligible(doc: vscode.TextDocument): boolean {
    return (
      this.enabled &&
      doc.languageId === 'python' &&
      doc.uri.scheme === 'file' &&
      this.deps.relativePath(doc.uri.fsPath) !== undefined &&
      Buffer.byteLength(doc.getText(), 'utf8') <= MAX_BYTES
    );
  }

  private schedule(doc: vscode.TextDocument, delay: number): void {
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    if (!this.eligible(doc)) {
      if (doc.uri.scheme === 'file') this.forget(doc.uri);
      return;
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.check(doc);
      }, delay),
    );
  }

  private async check(doc: vscode.TextDocument): Promise<void> {
    const key = doc.uri.toString();
    const version = doc.version;
    const text = doc.getText();
    const out: vscode.Diagnostic[] = [];

    // A: indentation that mixes tabs and spaces (in TypeScript, instantly).
    for (const i of mixedIndentLines(text, 20)) {
      const line = doc.lineAt(i);
      const ws = line.firstNonWhitespaceCharacterIndex;
      const d = new vscode.Diagnostic(
        new vscode.Range(i, 0, i, Math.max(1, ws)),
        'Indentation mixes tabs and spaces in this file; Python may nest this line differently from how it looks.',
        vscode.DiagnosticSeverity.Warning,
      );
      d.source = 'Forgelight';
      out.push(d);
    }

    // B: the project's Python parses the text (the first error only: the parser stops there).
    const problems = await this.parse(key, text);
    if (doc.isClosed || doc.version !== version) return; // newer text is on its way
    for (const p of problems ?? []) {
      const lineNo = Math.min(Math.max(0, p.line - 1), doc.lineCount - 1);
      const line = doc.lineAt(lineNo);
      const start = line.isEmptyOrWhitespace ? 0 : line.firstNonWhitespaceCharacterIndex;
      const end = Math.max(start + 1, line.range.end.character);
      const d = new vscode.Diagnostic(new vscode.Range(lineNo, start, lineNo, end), syntaxMessage(p), vscode.DiagnosticSeverity.Error);
      d.source = 'Forgelight';
      d.code = p.kind;
      out.push(d);
    }
    this.diagnostics.set(doc.uri, out);
  }

  /** The workspace's Python: .venv, then venv, then python3 on PATH ('' when there is none). */
  private pythonPath(): string {
    const root = this.deps.root();
    const win = process.platform === 'win32';
    for (const dir of ['.venv', 'venv']) {
      const p = path.join(root, dir, win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python');
      if (root && fs.existsSync(p)) return p;
    }
    const onPath = findOnPath(win ? 'python.exe' : 'python3');
    // On a Mac without the developer tools, /usr/bin/python3 is a stub that opens an install
    // dialog: never start it from a keystroke.
    if (onPath === '/usr/bin/python3' && !fs.existsSync('/Library/Developer/CommandLineTools/usr/bin/python3') && !fs.existsSync('/Applications/Xcode.app')) return '';
    return onPath;
  }

  private parse(key: string, text: string): Promise<ReturnType<typeof parsePyCheck>> {
    const py = this.pythonPath();
    if (!py || this.broken.has(py)) return Promise.resolve(undefined);
    // Only the newest text matters: stop the previous parse of this document.
    this.procs.get(key)?.kill('SIGKILL');
    return new Promise((resolve) => {
      let stdout = '';
      let done = false;
      let child: ChildProcess | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (v: ReturnType<typeof parsePyCheck>) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (child && this.procs.get(key) === child) this.procs.delete(key);
        resolve(v);
      };
      try {
        // -I: isolated (no PYTHON* variables, no user site, no script directory on sys.path), run
        // from a temp folder so a workspace file named ast.py or json.py cannot be imported.
        child = spawn(py, ['-I', '-c', PY_CHECK], { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      } catch {
        this.broken.add(py);
        finish(undefined);
        return;
      }
      this.procs.set(key, child);
      timer = setTimeout(() => {
        child?.kill('SIGKILL');
        finish(undefined);
      }, TIMEOUT_MS);
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') this.broken.add(py);
        finish(undefined);
      });
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (c: string) => {
        stdout += c;
      });
      child.on('close', () => finish(parsePyCheck(stdout)));
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(text, 'utf8');
    });
  }

  private forget(uri: vscode.Uri): void {
    const key = uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.procs.get(key)?.kill('SIGKILL');
    this.procs.delete(key);
    this.diagnostics.delete(uri);
  }

  private clearAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const p of this.procs.values()) p.kill('SIGKILL');
    this.procs.clear();
    this.diagnostics.clear();
  }

  dispose(): void {
    this.clearAll();
    for (const s of this.subs) s.dispose();
    this.diagnostics.dispose();
  }
}
