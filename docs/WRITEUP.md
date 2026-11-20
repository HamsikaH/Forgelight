# Forgelight: an editor-native coding agent on TrueForge

TrueFoundry Forge-a-thon, Techfest IIT Bombay 2026-27 · Round 1 write-up · Repository: <https://github.com/samuelmorningstar23/forgelight> · Demo: `<VIDEO_URL>`

## 1. Team

**Code Blooded**

- Samuel Christ (team member): IIT Madras, BS in Data Science and Applications (online). GitHub `@samuelmorningstar23`.
- Hanmathgundam Hamsika (team leader): VIT-AP University, B.Tech CSE. GitHub `@<HAMSIKA_GITHUB>`.

## 2. Starting point

**From scratch.** No editor project was forked, so there is no upstream agent loop to remove and no upstream licence to carry. Open-source code is used only as ordinary npm dependencies: `@truefoundry/trueforge-sdk` (TrueForge client), `@modelcontextprotocol/sdk` (MCP server), `diff` (jsdiff, hunk computation and patch application) and `zod`. The diff UI is VS Code's own diff editor (`vscode.diff`), not a re-implementation.

## 3. Architecture on TrueForge

- **TrueForge runs the loop.** TrueForge 0.185.1 runs in local mode (`npx @truefoundry/trueforge@0.185.1`, SQLite). The extension is a client: for each request it creates a session with an **inline agent spec** built from `agent/forgelight.agent.json` (agent mode) or `agent/forgelight-inline.agent.json` (inline edits), sends a turn with `sessions.createTurnStream`, and renders the streamed events. It never calls a model provider directly.
- **The editor is an MCP server.** On activation the extension starts a streamable-HTTP MCP server on `127.0.0.1` (secret per-activation header) and registers it in TrueForge as `forgelight-editor`. Tools: `read_file`, `search_code`, `find_symbol`, `list_files`, `repo_map`, `retrieve_context` (read-only) and `propose_edit`, `run_command` (write). The agent decides what to read and change.
- **TrueForge approval drives the diff review.** `propose_edit` and `run_command` are listed in `require_approval_for_tools`. When the model calls `propose_edit`, TrueForge pauses the turn with `tool.approval_required`. Forgelight looks up the call's arguments, computes the hunks against the live buffer and opens the hunk-by-hunk review. The user's per-hunk decisions are stored under a hash of the arguments, and Forgelight answers with `user.tool_approval` (allow if any hunk was accepted, otherwise deny with a reason the model can read). Only then does TrueForge execute the tool. The MCP handler applies exactly the accepted hunks through one `WorkspaceEdit`. The approval event cannot carry per-hunk data, hence the decision store; the review happens during the pause, never inside the tool call, because MCP calls time out after 120 s.
- **Verify loop.** In agent mode the agent runs the tests with `run_command`. If a turn ends while the last command it ran was failing, Forgelight sends a follow-up turn on the same session (history kept) asking it to fix the cause and re-run, at most twice. A turn that ends announcing a step it never took ("let me wait for the sub-agent") gets one nudge to continue.
- **Differentiators.**
  - *Verified diffs:* the tests covering a change run on a sandboxed shadow copy with the whole proposal applied (no writes to the workspace or home, no network); the result is on the review card. In a recorded Task B run it flagged the agent's broken test 17 s before the agent's own pytest run did.
  - *Run checkpoints:* **Revert this run** restores every file a run changed, newest first; files it created are deleted.
  - *Outage-proof sessions:* retry, then the same TrueForge session switches model with full history, even mid-task (section 5).
  - *Context X-ray:* per model call, input/output tokens and TrueForge's input breakdown against the context length; per sub-agent, context read vs returned (Task B: the context-scout read 11.9k tokens and handed 380 to the root agent, −97 %).
  - *Command guard:* every `run_command` is rated test / read / write / network / destructive; catastrophic patterns are refused, even inside `bash -c`, `trap`, `xargs`, `BASH_ENV` or `git -c`.
- **Harness features used.** *Dynamic sub-agents:* the root agent delegates exploration to a `context-scout` sub-agent (`create_sub_agent`), which reads files in its own context and returns a short list of edit sites, so whole-file reads never enter the root context. It shows in the TrueForge session view as a sub-agent thread. *Compaction* is on with an explicit 40k-token trigger as a guard for the 64k-context local model. *Tool approval* is the review mechanism above. *Deferred tool loading* is deliberately **off** (`preload: true`): with only eight small tool schemas it saves almost nothing, and on a small local model the `call_tool` indirection caused malformed calls.

## 4. How context is selected

Retrieval is deterministic and runs in the extension, so it does not depend on the model:

1. **Index.** Every text file up to 300 KB (skipping VCS, virtualenvs, build output), with symbols extracted per language (Python classes/functions/methods, JS/TS, Markdown/RST headings). Flask 3.1.3 indexes in about 0.13 s and re-indexes changed files on save.
2. **Score with explainable signals.** Each file gets points for symbol-name matches, path matches, BM25 over content, distinctive string literals, phrases (`--help`, `flask config`) and CLI command definitions. Every signal produces a reason shown to the user.
3. **Pair.** Tests of the chosen source files (by name or import) are added when tests are requested, docs that mention the source's symbols or share its name when docs are requested, and CLI command definitions for CLI requests. A paired file can never outrank its source on the boost alone.
4. **Pack under a budget.** Default **6,000 tokens** (4 characters per token). Explicit `@file`/`@symbol` mentions go in first. Each file gets its best line window, then more windows round-robin within a per-file share (45/30/22/18/15 %). Files below 55 % of the top score are cut, and everything that did not fit is listed as dropped.

The pack is attached to the user message and rendered as the **Context picked** card (files, tokens, reasons, budget meter). For Task B it picks `src/flask/cli.py`, `tests/test_cli.py` and `docs/cli.rst` first, with the existing built-in command definitions as snippets. The same engine is the `retrieve_context` tool the context-scout calls during the turn.

## 5. Model setup

| Model | Where it ran | Cost |
|---|---|---|
| Qwen 3.6 35B-A3B (`qwen3.6:35b-a3b`, Q4_K_M, 64k context) as `ollama/qwen3-6-35b` | Locally, Ollama on an Apple M2 Max (64 GB), via a TrueForge `custom` OpenAI-compatible provider | ₹0 |
| `unreachable/broken-model` (dead loopback port) | Nowhere: used only to demonstrate fallback in Task C | ₹0 |

Users switch models with the `forgelight.models` setting, a priority list (`["primary", "fallback", …]`). On a model error Forgelight retries the same model with exponential backoff, then switches the same TrueForge session to the next model (`sessions.update` with the new inline spec) and continues with the full history, even after edits were applied. Accepted edits are never re-applied and approvals are never re-sent. A circuit breaker skips a recently failed model for `forgelight.circuitBreakerMinutes` (reset when the models setting changes). Only if the session switch itself fails does it start a new session, and only while nothing has been applied. Any TrueForge catalog provider works (`config/models.example.json` includes a free Gemini Flash-Lite entry); no key is committed.

## 6. Scorecard

| Criterion | Video | Claim |
|---|---|---|
| A1 Inline edit | `<t>` | Diff in the editor, per-hunk Accept / Reject (CodeLens, editor-title buttons, panel) |
| A2 Agent mode | `<t>` | Task B edits cli.py, test_cli.py and docs/cli.rst; no file named in the prompt |
| A3 Streaming & cancel | `<t>` | Tokens stream; Cancel ends the turn in milliseconds; `git status` clean |
| B1 Context assembly | `<t>` | Context picked card: files, reasons, tokens within the 6,000 budget |
| B2 Diff safety | `<t>` | Nothing written before review; per-hunk decisions; Undo restores the file |
| B3 Resilience | `<t>` | Unreachable primary → retry with backoff → same session switched to the fallback model, history kept; workspace unchanged |
| B4 TrueForge depth | `<t>` | Turn pauses for approval → review; session view shows tool calls and the context-scout sub-agent |
| C1 Video | 0:00-`<end>` | Tasks A, B, C in order, each verified on screen |

## 7. Tools used

VS Code 1.84, TrueForge 0.185.1, Ollama 0.40, Node 22, TypeScript, esbuild. The code was written with an AI coding assistant (Claude Code), which we used for implementation, testing and review; all design decisions are ours and documented here.

## 8. Known limitations and what we would do with another month

- **Local model speed.** Qwen on a laptop takes 15–20 s per step, so Task B takes minutes (sped up in the video). With credits: a hosted primary, Qwen as fallback.
- **Lexical retrieval.** Ranking is lexical plus structural signals; synonyms and semantic intent are missed. Next: embeddings and a call graph.
- **One window.** One MCP server name and port per TrueForge instance means one VS Code window at a time.
- **No visual regression tests** for the panel (the agent loop has a headless harness against a real TrueForge). Next: per-hunk approval payloads upstream in TrueForge, live `run_command` output, multi-root workspaces.
