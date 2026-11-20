/**
 * The Forgelight actions and their keys (PURE: no vscode). Used by the menu (F1); the keys
 * themselves are contributed in package.json, and test/assist.test.ts checks the two agree.
 */

export interface ForgeAction {
  /** Command id. */
  command: string;
  label: string;
  /** Codicon name. */
  icon: string;
  /** Key on macOS and on Windows/Linux, as shown to the user ('' when there is none). */
  mac: string;
  other: string;
  /** package.json key strings (VS Code syntax), checked against the contributed keybindings. */
  macKey?: string;
  key?: string;
  detail: string;
}

export const ACTIONS: ForgeAction[] = [
  {
    command: 'forgelight.inlineEdit',
    label: 'Edit the selection',
    icon: 'edit',
    mac: '⌥⌘E',
    other: 'Ctrl+Alt+E',
    macKey: 'cmd+alt+e',
    key: 'ctrl+alt+e',
    detail: 'Describe a change to the selected code; review it hunk by hunk.',
  },
  {
    command: 'forgelight.checkFunction',
    label: 'Check this function',
    icon: 'bug',
    mac: '⌥⌘X',
    other: 'Ctrl+Alt+X',
    macKey: 'cmd+alt+x',
    key: 'ctrl+alt+x',
    detail: 'Possible bugs, indentation that changes the meaning, simpler logic with the reason, another way.',
  },
  {
    command: 'forgelight.overviewFunction',
    label: 'Overview of this function',
    icon: 'book',
    mac: '⌥⌘U',
    other: 'Ctrl+Alt+U',
    macKey: 'cmd+alt+u',
    key: 'ctrl+alt+u',
    detail: 'What it does, how it works, an example call, where it is used and tested.',
  },
  {
    command: 'forgelight.focusPanel',
    label: 'Ask the agent',
    icon: 'comment-discussion',
    mac: '',
    other: '',
    detail: 'Open the Forgelight panel and describe a change across files.',
  },
  {
    command: 'forgelight.acceptHunk',
    label: 'Accept the next change',
    icon: 'check',
    mac: '⌥⌘Y',
    other: 'Ctrl+Alt+Y',
    macKey: 'cmd+alt+y',
    key: 'ctrl+alt+y',
    detail: 'In a review: accept the next undecided hunk and show the one after it.',
  },
  {
    command: 'forgelight.rejectHunk',
    label: 'Reject the next change',
    icon: 'close',
    mac: '⌥⌘N',
    other: 'Ctrl+Alt+N',
    macKey: 'cmd+alt+n',
    key: 'ctrl+alt+n',
    detail: 'In a review: reject the next undecided hunk.',
  },
  {
    command: 'forgelight.applyReview',
    label: 'Apply the review',
    icon: 'save',
    mac: '⌥⌘↩',
    other: 'Ctrl+Alt+Enter',
    macKey: 'cmd+alt+enter',
    key: 'ctrl+alt+enter',
    detail: 'Write the accepted hunks; the undecided ones are rejected.',
  },
  {
    command: 'forgelight.undoLastApplied',
    label: 'Undo the last Forgelight change',
    icon: 'discard',
    mac: '⌥⌘Z',
    other: 'Ctrl+Alt+Z',
    macKey: 'cmd+alt+z',
    key: 'ctrl+alt+z',
    detail: 'Restore the file as it was before the last applied change.',
  },
  {
    command: 'forgelight.revertLastRun',
    label: 'Revert the last run',
    icon: 'history',
    mac: '',
    other: '',
    detail: 'Restore every file the last run changed; files it created are deleted.',
  },
  {
    command: 'forgelight.cancel',
    label: 'Cancel the run',
    icon: 'debug-stop',
    mac: 'Esc or ⌥⌘⌫',
    other: 'Esc or Ctrl+Alt+Backspace',
    macKey: 'cmd+alt+backspace',
    key: 'ctrl+alt+backspace',
    detail: 'Stop the current request; nothing unaccepted is written.',
  },
  {
    command: 'forgelight.openSession',
    label: 'Open the session in TrueForge',
    icon: 'link-external',
    mac: '',
    other: '',
    detail: 'See turns, tool calls, sub-agents and approvals in the TrueForge UI.',
  },
];

export const MENU_KEY = { mac: '⌥⌘/', other: 'Ctrl+Alt+/' };
