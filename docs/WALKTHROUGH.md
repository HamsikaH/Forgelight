# Forgelight code walkthrough (for the shortlist call)

Before the shortlist is final, each team gets a **10-minute video call**: walk through the code and **repeat Task A live with a model the organisers choose**. A team that cannot explain its own submission is replaced. This page is what you need to know. Read it with the code open.

## The one-sentence version

Forgelight is a VS Code extension that **turns the editor into MCP tools** for a TrueForge agent. **TrueForge's approval pause is where the user reviews each change hunk by hunk**, and only accepted hunks are ever written.

## Map of the code (`src/`)

| File | What it does | VS Code? |
|---|---|---|
| `extension.ts` | Entry point. Creates everything, starts the MCP server, registers it and the agents in TrueForge, routes panel messages and commands. | yes |
| `contracts.ts` | Shared types: config, edits, hunks, review results, events, panel messages. Start here when reading. | no |
| `trueforge/runner.ts` | **The heart.** Creates a TrueForge session per request, streams the turn, answers approvals (edit → review + shadow test run, command → guard + ask), retries and switches the session's model on model errors, reports context usage, cancels, runs the verify loop. | no |
| `trueforge/setup.ts` | REST calls to TrueForge: health, register the MCP server and agents, list models, session page URL. | no |
| `mcp/server.ts`, `mcp/tools.ts` | The editor MCP server (HTTP on 127.0.0.1 with a secret header) and its 8 tools. `propose_edit` applies only the hunks the user accepted. | no |
| `decisions.ts` | Remembers the review decision between "TrueForge paused" and "TrueForge executes the tool"; tracks the active run so a cancelled run can't write. | no |
| `review/hunks.ts` | Pure diff maths: apply search/replace edits, split into hunks, apply any subset of hunks. | no |
| `review/reviewController.ts` | The diff view: opens `vscode.diff`, per-hunk Accept/Reject (CodeLens, editor-title buttons), applies with one `WorkspaceEdit`, undo stack. | yes |
| `context/indexer.ts`, `retrieval.ts`, `mentions.ts` | The context engine: indexes the repo, ranks files with explainable reasons, packs snippets under the token budget, resolves `@file`/`@symbol`. | no |
| `panel/agentPanel.ts` + `media/panel.js/.css` | The Forgelight side panel (webview): streaming, folded steps, context card, review and approval cards, finish card, banners, Cancel/Undo. | yes |
| `inline/inlineEdit.ts` | ⌘⌥E: selection + instruction → inline run. | yes |
| `vscodeHost.ts` | Reads settings; reads files (preferring unsaved editor text); asks the user before commands. | yes |
| `verify/shadow.ts` | Verified diffs: picks the tests covering a changed file, copies the workspace (from its realpath) to a temp shadow dir, writes the whole proposal there and runs them under the macOS sandbox (`sandbox-exec`: no writes outside the shadow/temp dirs, no outbound network but loopback, never the TrueForge port, secret-looking env vars removed; skipped where there is no sandbox). Process group killed on cancel/timeout, dir always deleted. | no |
| `safety/commandGuard.ts` | Command guard: a small shell lexer + rule table rating every `run_command` test/read/write/network/destructive, with hard blocks for catastrophic patterns. | no |

Agent definitions: `agent/forgelight.agent.json` (agent mode, with the context-scout instructions) and `agent/forgelight-inline.agent.json` (inline edit: only `read_file` and `propose_edit`, no sub-agents).

**Why "no VS Code" matters:** the whole agent loop runs headlessly too (`test/headless/runTask.ts`), which is how we tested Tasks A/B/C against a real TrueForge.

## What happens on an inline edit (Task A)

1. `inlineEdit.ts`: you select code and press ⌘⌥E, type the instruction.
2. `runner.run({mode:'inline'})` → builds a message `INLINE EDIT / File / Selected lines / Selected code / Instruction`.
3. It creates a TrueForge **session with an inline spec** from `forgelight-inline.agent.json`, with the model set to the first entry of `forgelight.models`, then streams the turn (`createTurnStream`). Tokens go to the panel as they arrive.
4. The model calls `propose_edit`. Because `propose_edit` is in `require_approval_for_tools`, **TrueForge pauses** and emits `tool.approval_required`.
5. The runner reads the call's arguments, computes the proposed text and the hunks (`hunks.ts`; `wholeFileLoss` refuses a `new_content` that would wipe most of an existing file, which a local model once did to `tests/test_cli.py`), and calls `review.review(change)`. The diff opens. You accept or reject each hunk.
6. The decision is stored in `DecisionStore` under a hash of the arguments. The runner answers TrueForge `allow` (if any hunk was accepted) or `deny` with a reason.
7. TrueForge now executes `propose_edit` on **our** MCP server. The handler finds the stored decision by the same hash and applies **exactly the accepted hunks** through one `WorkspaceEdit`, then saves.
8. The turn ends; the panel shows what was applied. Undo pops the record and restores the file.

**Why the decision store?** TrueForge's approval message can only say allow or deny. It cannot carry "hunks 1 and 3". So we remember the per-hunk decision ourselves, and the tool looks it up. **Why review during the pause and not inside the tool?** TrueForge abandons an MCP tool call after 120 s; the pause has no limit.

## What happens in agent mode (Task B)

1. Before the turn, the runner asks the context engine for a **context pack** under the 6,000-token budget, shows it as the *Context picked* card and attaches it to the message.
2. The agent's instructions tell it to **delegate exploration to a `context-scout` sub-agent** (`create_sub_agent`, a TrueForge built-in). The scout calls `retrieve_context`, `search_code`, `find_symbol`, `read_file` in its own context and returns "path:lines, why" pointers. This keeps whole-file reads out of the main agent's context. You can see the sub-agent in the TrueForge session view.
3. The main agent reads the exact ranges and proposes one edit per file. Each goes through the same pause → review → apply chain.
4. It runs the tests with `run_command`, which also pauses for approval (*Allow once* / *Allow for 10 min* / *Deny*). The command guard rates the command first: blocked patterns are refused without asking, and with `autoApproveSafeCommands` test/read commands run straight away, except reads of secrets or of files outside the workspace.
5. **Verify loop:** if the agent stops while the last command it ran was failing, Forgelight sends a follow-up turn on the same session: "this still fails, fix it and re-run" (at most twice). **Stall nudge:** if a turn ends announcing a step it never took ("let me wait for the sub-agent"), or an inline run answers in text without calling `propose_edit`, one follow-up turn asks it to continue (`looksUnfinished` / `stallFollowUp` in `runner.ts`). Small local models do this now and then.

## How the panel stays readable

A Task B run streams thousands of events (one recording: 80 tool calls, 60 thoughts, 14 commands), so the panel (`media/panel.js`) groups them instead of listing them:

- **Steps.** Thoughts, the agent's one-line narration and exploration calls (`read_file`, `search_code`, `find_symbol`, `list_files`, `repo_map`, `create_sub_agent`) go into the thread's current *step* (`stepAppend`). While it works, only its last three rows show under **Working…**. Anything that needs the user or must stay visible ends the step first (`endStep`): a `propose_edit` or `run_command` row (its card goes right under it), a sub-agent group, a banner, the end of the run. The finished step folds to one line: the agent's own last sentence (or counts when the model wrote none), the counts and the time. A failure inside shows as a red "N failed". The agent's closing message is moved out of the step so it stays visible.
- **Sub-agents** fold to their head and the savings footer when they finish, unless the user toggled them or a card in them still waits.
- **Resolved cards** fold to one line about half a second after the decision; denied and blocked commands stay open as evidence. The DOM is kept, so later updates (undo, revert, a late shadow result) still land.
- **The finish card** sums up a run that ended `done`: files, the last test command (amber if it failed: never a green card over a failing test), shadow runs, context, and Revert / Open in TrueForge / Copy summary.
- **Motion** plays only for live events: each node animates once, when it is first inserted (`fl-in`), never for the history the extension replays when the view is reopened.
- **Checks.** `test/panel-preview` replays recorded runs; with `&checks=1` it watches every DOM change and records any moment where a pending card, the streaming block or a banner is hidden, and `&asHistory=1` sends a recording in one burst with old timestamps, as the extension does on reload. All recordings pass, live and as history, in both themes.

## How the context engine ranks (B1)

Per file it adds up signals, each producing a human-readable reason:
- symbol names that match the request;
- path matches;
- BM25 over content;
- distinctive string literals;
- phrases like `--help`;
- CLI command definitions.

Then it pairs:
- **tests** of chosen source files, when tests are asked for;
- **docs** that mention the source's symbols, when docs are asked for.

Finally it packs the best line windows into the budget and lists what didn't fit. The snippets have no line numbers on purpose, so the model can copy exact text into search/replace edits.

## Cancel and resilience

- **Cancel** aborts the stream and calls `sessions.cancel` (the turn ends within milliseconds). It also closes open reviews and clears stored decisions. Any late `propose_edit` is refused because the run is marked cancelled. Edits only ever happen after acceptance, so a cancelled run cannot leave a half-applied edit.
- **Outage-proof sessions:** if a turn ends with a model error, the runner retries the same model on the same session with exponential backoff (`model.retry`). If it still fails, that model's circuit breaker opens (`model.health` down, skipped by later runs for the current value of `forgelight.circuitBreakerMinutes`; 0 turns it off, changing the models setting resets it), and the runner switches the **same** session to the next model with `sessions.update` (new inline agent spec, `model.fallback` + `model.resume`). The failed turn's request is already in the session history, so the next turn sends only a short note (the failed turn produced nothing) or tells the new model what happened and to continue; the session keeps the whole history, and accepted edits are already on disk, so this also works mid-task. Typical causes are an unreachable endpoint, a bad key, a rate limit or a 5xx. It never calls a model provider itself: TrueForge does.
- **Run checkpoints:** every applied change is recorded with its run id; *Revert this run* restores all files of a run in one serialized step (newest first, created files deleted), keeping edits made after the run where they don't overlap.

## Repeating Task A live with the organisers' model

1. They give a model (and key). In the TrueForge UI (<http://localhost:8790> → Settings → Models), add the provider and key. Or add it to `config/models.json` and run `node scripts/setup-models.mjs`.
2. In VS Code settings set `"forgelight.models": ["<provider>/<model-name>"]` (exact name from TrueForge's model list).
3. Open `src/flask/helpers.py` on a clean Flask 3.1.3 tree, select `get_debug_flag`, press ⌘⌥E, paste the Task A instruction, accept the hunks, run the `FLASK_DEBUG=off` check.

The inline agent is deliberately minimal (two tools, one instruction), so it works with most models.

## Questions judges are likely to ask

- **"Where does the agent loop run?"** In TrueForge. We create sessions and turns with the TypeScript SDK and render its events. The extension never calls a model API.
- **"How are editor capabilities exposed?"** As MCP tools on a local streamable-HTTP server that the extension registers in TrueForge (`forgelight-editor`).
- **"How does approval connect to the diff?"** `require_approval_for_tools: ["propose_edit","run_command"]` → `tool.approval_required` → our review → `user.tool_approval` → TrueForge executes the tool → we apply the accepted hunks.
- **"Which harness features did you use and why?"** Dynamic sub-agents, as the context-scout: it keeps big file reads out of the main context. Tool approval drives the review. Compaction is on as a guard for the 64k local context. Deferred tool loading is off on purpose: only 8 small tools, and it confused a small model.
- **"Why from scratch and not a Cline fork?"** Removing a fork's own loop is an eligibility risk and a lot of code. Ours is small enough to explain, and reuses VS Code's diff editor.
- **"What would you do with another month?"** Embedding-based retrieval, streaming command output live, multi-window support, and an upstream TrueForge PR for per-hunk approval payloads.
