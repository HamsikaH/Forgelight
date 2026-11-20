/**
 * F1: the Forgelight menu (⌥⌘/): every action with its key, in one quick pick. It doubles as the
 * cheat sheet. The list is in ./actions.
 */
import * as vscode from 'vscode';
import { ACTIONS, MENU_KEY } from './actions';

const isMac = process.platform === 'darwin';

export function registerMenu(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('forgelight.showMenu', async () => {
      type Item = vscode.QuickPickItem & { command: string };
      const items: Item[] = ACTIONS.map((a) => ({
        label: `$(${a.icon}) ${a.label}`,
        description: isMac ? a.mac : a.other,
        detail: a.detail,
        command: a.command,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        title: `Forgelight (${isMac ? MENU_KEY.mac : MENU_KEY.other})`,
        placeHolder: 'Pick an action; the key for each is on the right',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (pick) await vscode.commands.executeCommand(pick.command);
    }),
  );
}
