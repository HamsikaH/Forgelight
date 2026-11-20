/**
 * Inline edit (VS Code only): select code, describe the change, and the agent proposes an edit to
 * that file through TrueForge. The proposal goes through the normal hunk review.
 */
import * as vscode from 'vscode';
import type { InlineTarget, RunOutcome, RunRequest } from '../contracts';
import type { VscodeWorkspaceIO } from '../vscodeHost';

export interface InlineEditDeps {
  io: VscodeWorkspaceIO;
  isRunning: () => boolean;
  /** Starts a run (TrueForge registration included); `error` when it could not start. */
  run: (req: RunRequest) => Promise<{ outcome: RunOutcome } | { error: string }>;
  /** Show the agent panel without taking focus from the editor. */
  revealPanel: () => Promise<void>;
  /** Fires true while a proposed change waits for the user's review, false when the review closes. */
  onDidChangeReviewing?: vscode.Event<boolean>;
}

const CANCEL_HINT = process.platform === 'darwin' ? '⌘⌥⌫' : 'Ctrl+Alt+Backspace';
const REVIEW_HINT = process.platform === 'darwin' ? '⌥⌘Y accept · ⌥⌘N reject' : 'Ctrl+Alt+Y accept · Ctrl+Alt+N reject';
const THINKING_TEXT = `$(sync~spin) Forgelight: thinking… (${CANCEL_HINT} to cancel)`;
const THINKING_TIP = 'Forgelight is working on the inline edit. Click to cancel.';
const REVIEW_TEXT = `$(diff) Forgelight: waiting for your review (${REVIEW_HINT})`;
const REVIEW_TIP = 'A proposed change is open in the diff editor. Accept or reject each hunk; click to cancel the run.';

export function registerInlineEdit(context: vscode.ExtensionContext, deps: InlineEditDeps): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  const thinking = () => {
    status.text = THINKING_TEXT;
    status.tooltip = THINKING_TIP;
  };
  thinking();
  status.command = 'forgelight.cancel';
  // While a proposal waits for the user, the model is not thinking: say what is expected instead.
  const reviewSub = deps.onDidChangeReviewing?.((reviewing) => {
    if (reviewing) {
      status.text = REVIEW_TEXT;
      status.tooltip = REVIEW_TIP;
    } else thinking();
  });
  if (reviewSub) context.subscriptions.push(reviewSub);

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand('forgelight.inlineEdit', async () => {
      const editor = vscode.window.activeTextEditor;
      const target = selectionTarget(deps.io);
      if (typeof target === 'string') {
        void vscode.window.showErrorMessage(`Forgelight: ${target}`);
        return;
      }
      if (deps.isRunning()) {
        void vscode.window.showWarningMessage(`Forgelight is already running a request. Cancel it (${CANCEL_HINT}) before starting another one.`);
        return;
      }
      const text = await vscode.window.showInputBox({
        prompt: 'Forgelight: describe the edit for the selection',
        placeHolder: "e.g. Treat the values 'off' and 'n' as false as well",
        ignoreFocusOut: true,
      });
      if (!text?.trim()) return;
      // The target is captured; collapse the selection so a single Esc cancels the run (Esc with
      // a selection only clears the selection).
      try {
        if (editor && !editor.selection.isEmpty) editor.selection = new vscode.Selection(editor.selection.end, editor.selection.end);
      } catch {
        // the editor was closed while the input box was open; nothing to collapse
      }
      // Not awaited: the command returns at once and the run streams into the panel.
      void runInline(deps, status, text.trim(), target);
    }),
  );
}

async function runInline(deps: InlineEditDeps, status: vscode.StatusBarItem, text: string, target: InlineTarget): Promise<void> {
  status.text = THINKING_TEXT;
  status.tooltip = THINKING_TIP;
  status.show();
  deps.revealPanel().catch(() => undefined);
  try {
    const res = await deps.run({ mode: 'inline', text, inlineTarget: target });
    if ('error' in res) {
      void vscode.window.showErrorMessage(`Forgelight: ${res.error}`);
      return;
    }
    const { outcome } = res;
    if (outcome.status === 'error') {
      void vscode.window.showErrorMessage(`Forgelight: ${outcome.message ?? 'the inline edit failed.'}`);
    } else if (outcome.status === 'cancelled') {
      vscode.window.setStatusBarMessage('Forgelight: inline edit cancelled; nothing was written.', 4000);
    } else {
      const hunks = outcome.applied.reduce((n, r) => n + r.hunksApplied.length, 0);
      vscode.window.setStatusBarMessage(
        hunks ? `Forgelight: applied ${hunks} hunk${hunks === 1 ? '' : 's'} to ${target.path}.` : 'Forgelight: inline edit finished; no changes were applied.',
        5000,
      );
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`Forgelight: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    status.hide();
  }
}

/** The active editor's selection as an InlineTarget (whole lines), or an error message. */
function selectionTarget(io: VscodeWorkspaceIO): InlineTarget | string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return 'open a file and select the code to edit first.';
  const sel = editor.selection;
  if (sel.isEmpty) return 'select the code to edit first.';
  const doc = editor.document;
  if (!io.hasWorkspace) return 'open a folder first; inline edits work on files inside the workspace.';
  const rel = doc.uri.scheme === 'file' ? io.relativePath(doc.uri.fsPath) : undefined;
  if (!rel) return 'inline edits work only on saved files inside the workspace folder.';
  // A selection that ends at column 0 does not include that line.
  const lastLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
  const range = new vscode.Range(sel.start.line, 0, lastLine, doc.lineAt(lastLine).text.length);
  return { path: rel, startLine: sel.start.line + 1, endLine: lastLine + 1, selectedText: doc.getText(range) };
}
