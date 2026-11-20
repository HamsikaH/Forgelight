/**
 * F3 "Check this function" (⌥⌘X) and F4 "Overview of this function" (⌥⌘U). Each sends an
 * ordinary agent-mode request about the selection, or else the innermost function or method
 * around the cursor, with its current code (unsaved edits included). The answer streams into the
 * panel like any other run; nothing runs by itself, and nothing is written without review.
 */
import * as vscode from 'vscode';
import type { RunOutcome, RunRequest } from '../contracts';
import { extractSymbols } from '../context/indexer';
import { checkRequest, enclosingFunction, overviewRequest, type AskTarget } from './analysis';

export interface FunctionAskDeps {
  relativePath(absPath: string): string | undefined;
  isRunning: () => boolean;
  run: (req: RunRequest) => Promise<{ outcome: RunOutcome } | { error: string }>;
  revealPanel: () => Promise<void>;
}

const CANCEL_HINT = process.platform === 'darwin' ? '⌘⌥⌫' : 'Ctrl+Alt+Backspace';
const FENCE: Record<string, string> = {
  python: 'python',
  typescript: 'typescript',
  typescriptreact: 'tsx',
  javascript: 'javascript',
  javascriptreact: 'jsx',
};

export function registerFunctionAsk(context: vscode.ExtensionContext, deps: FunctionAskDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('forgelight.checkFunction', () => ask(deps, 'check')),
    vscode.commands.registerCommand('forgelight.overviewFunction', () => ask(deps, 'overview')),
  );
}

/** The selection, or the innermost function/method around the cursor; a string explains why not. */
export function askTarget(editor: vscode.TextEditor | undefined, relativePath: (abs: string) => string | undefined): AskTarget | string {
  if (!editor) return 'Open a file and put the cursor inside a function.';
  const doc = editor.document;
  if (doc.uri.scheme !== 'file') return 'Open the file itself (not a diff or preview) and put the cursor inside a function.';
  const rel = relativePath(doc.uri.fsPath);
  if (rel === undefined) return 'That file is outside the workspace folder.';
  const lang = FENCE[doc.languageId] ?? '';
  const sel = editor.selection;
  if (!sel.isEmpty) {
    const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
    const range = new vscode.Range(sel.start.line, 0, endLine, doc.lineAt(endLine).text.length);
    return { path: rel, startLine: sel.start.line + 1, endLine: endLine + 1, code: doc.getText(range), lang };
  }
  const lines = doc.getText().split(/\r?\n/);
  const fn = enclosingFunction(extractSymbols(rel, lines), sel.active.line + 1);
  if (!fn) {
    return lang === 'python' || lang.startsWith('t') || lang.startsWith('j')
      ? 'Put the cursor inside a function, or select the code to check.'
      : 'Select the code to check (functions are found automatically in Python, JavaScript and TypeScript).';
  }
  const range = new vscode.Range(fn.startLine - 1, 0, fn.endLine - 1, doc.lineAt(fn.endLine - 1).text.length);
  return { path: rel, name: fn.name, startLine: fn.startLine, endLine: fn.endLine, code: doc.getText(range), lang };
}

async function ask(deps: FunctionAskDeps, kind: 'check' | 'overview'): Promise<void> {
  const target = askTarget(vscode.window.activeTextEditor, (abs) => deps.relativePath(abs));
  if (typeof target === 'string') {
    void vscode.window.showInformationMessage(`Forgelight: ${target}`);
    return;
  }
  if (deps.isRunning()) {
    void vscode.window.showWarningMessage(`Forgelight is already running a request. Cancel it (${CANCEL_HINT}) before starting another one.`);
    return;
  }
  const text = kind === 'check' ? checkRequest(target) : overviewRequest(target);
  const label = target.name ? `\`${target.name}\`` : 'the selection';
  vscode.window.setStatusBarMessage(`Forgelight: ${kind === 'check' ? 'checking' : 'explaining'} ${label}… the answer streams into the panel.`, 6000);
  deps.revealPanel().catch(() => undefined);
  const res = await deps.run({ mode: 'agent', text });
  if ('error' in res) void vscode.window.showErrorMessage(`Forgelight: ${res.error}`);
  else if (res.outcome.status === 'error') void vscode.window.showErrorMessage(`Forgelight: ${res.outcome.message ?? 'the request failed.'}`);
}
