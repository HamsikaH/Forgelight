# Forgelight: an editor-native coding agent on TrueForge

TrueFoundry Forge-a-thon, Techfest IIT Bombay 2026-27 · Round 1 write-up · Repository: <https://github.com/HamsikaH/Forgelight> · Demo video: <https://youtu.be/HKwAiuZrsNs>

## 1. Team

**Code Blooded**

- Hanmathgundam Hamsika (team leader): VIT-AP University, B.Tech CSE. GitHub `@HamsikaH`.
- Samuel Christ (team member): IIT Madras, BS. GitHub `@samuelmorningstar23`.

## 2. Starting point

Forgelight was built from scratch. No editor project was forked, so there is no upstream agent loop to remove and no upstream licence to carry. Open-source code is used only as ordinary npm dependencies: `@truefoundry/trueforge-sdk` (TrueForge client), `@modelcontextprotocol/sdk` (MCP server), `diff` (jsdiff, hunk computation and patch application) and `zod`. The diff UI is VS Code's built-in diff editor (`vscode.diff`).

## 3. Architecture on TrueForge

- TrueForge 0.185.1 runs the agent loop in local mode (`npx @truefoundry/trueforge@0.185.1`, SQLite). The extension is a client: for each request it creates a session with an inline agent spec built from `agent/forgelight.agent.json` (agent mode) or `agent/forgelight-inline.agent.json` (inline edits), sends a turn with `sessions.createTurnStream`, and renders the streamed events. It never calls a model provider directly.
- The editor is an MCP server. On activation the extension starts a streamable-HTTP MCP server on `127.0.0.1` with a secret per-activation header and registers it in TrueForge as `forgelight-editor`. Tools: `read_file`, `search_code`, `find_symbol`, `list_files`, `repo_map`, `retrieve_context` (read-only) and `propose_edit`, `run_command` (write). The agent decides what to read and change.
- Diff review uses TrueForge's tool approval. `propose_edit` and `run_command` are listed in `require_approval_for_tools`. When the model calls `propose_edit`, TrueForge pauses the turn with `tool.approval_required`. Forgelight looks up the call's arguments, computes the hunks against the live buffer and opens the hunk-by-hunk review. The approval event cannot carry per-hunk data, so Forgelight stores the user's per-hunk decisions under a hash of the arguments and answers with `user.tool_approval`: allow if any hunk was accepted, otherwise deny with a reason the model can read. Only then does TrueForge execute the tool, and the MCP handler applies exactly the accepted hunks through one `WorkspaceEdit`. The review happens during the pause, never inside the tool call, because MCP calls time out after 120 s.
- Verify loop: in agent mode the agent runs the tests with `run_command`, with the project's `.venv` on PATH. If a turn ends while the last command it ran was failing, or while the tests of its newest shadow run still fail when Forgelight re-runs them on the workspace (the agent's own `pytest … | tail` can hide a failure), Forgelight sends a follow-up turn on the same session (history kept) with the failing output, asking it to fix the cause and re-run, at most twice. A turn that ends announcing a step it never took ("let me wait for the sub-agent") gets one nudge to continue.
- Differentiators:
  - *Verified diffs:* the tests covering a change run on a sandboxed shadow copy with the whole proposal applied (no writes to the workspace or home, no network), and the review card shows the result. In a recorded Task B run this flagged the agent's broken test 17 s before the agent's own pytest run did.
  - *Run checkpoints:* **Revert this run** restores every file a run changed, newest first, and deletes files it created.
  - *Outage-proof sessions:* retries, then switches the same TrueForge session to another model with full history, even mid-task (section 5).
  - *Context X-ray:* input/output tokens and TrueForge's input breakdown against the context length per model call, and context read vs returned per sub-agent (Task B: the context-scout read 11.9k tokens and handed 380 to the root agent, −97 %).
  - *Command guard:* rates every `run_command` as test / read / write / network / destructive and refuses catastrophic patterns, even inside `bash -c`, `trap`, `xargs`, `BASH_ENV` or `git -c`.
- Harness features used: with *dynamic sub-agents*, the root agent delegates exploration to a `context-scout` sub-agent (`create_sub_agent`), which reads files in its own context and returns a short list of edit sites, so whole-file reads never enter the root context. The TrueForge session view shows it as a sub-agent thread. *Compaction* is on, with an explicit 40k-token trigger as a guard for the 64k-context local model. *Tool approval* is the review mechanism above. *Deferred tool loading* is off (`preload: true`): with only eight small tool schemas it saves almost nothing, and on a small local model the `call_tool` indirection caused malformed calls.
## 4. How context is selected

Retrieval is deterministic and runs in the extension, so it does not depend on the model:

1. The index covers every text file up to 300 KB (skipping VCS, virtualenvs, build output), with symbols extracted per language (Python classes/functions/methods, JS/TS, Markdown/RST headings). Flask 3.1.3 indexes in about 0.13 s, and changed files are re-indexed on save.
2. Scoring gives each file points for symbol-name matches, path matches, BM25 over content, distinctive string literals, phrases (`--help`, `flask config`) and CLI command definitions. Every signal produces a reason shown to the user.
3. Pairing adds tests of the chosen source files (by name or import) when tests are requested, docs that mention the source's symbols or share its name when docs are requested, and CLI command definitions for CLI requests. A paired file can never outrank its source on the boost alone.
4. Packing fills a budget of 6,000 tokens by default (4 characters per token). Explicit `@file`/`@symbol` mentions go in first. Each file gets its best line window, then more windows round-robin within a per-file share (45/30/22/18/15 %). Files below 55 % of the top score are cut, and everything that did not fit is listed as dropped.

The pack is attached to the user message and rendered as the Context picked card (files, tokens, reasons, budget meter). For Task B it picks `src/flask/cli.py`, `tests/test_cli.py` and `docs/cli.rst` first, with the existing built-in command definitions as snippets. The context-scout calls the same engine during the turn as the `retrieve_context` tool.

## 5. Model setup

| Model | Where it ran | Cost |
|---|---|---|
| Qwen 3.6 35B-A3B (`qwen3.6:35b-a3b`, Q4_K_M, 64k context) as `ollama/qwen3-6-35b` | Locally, Ollama on an Apple M2 Max (64 GB), via a TrueForge `custom` OpenAI-compatible provider | ₹0 |
| `unreachable/broken-model` (dead loopback port) | Nowhere: used only to demonstrate fallback in Task C | ₹0 |

Users switch models with the `forgelight.models` setting, a priority list (`["primary", "fallback", …]`). On a model error Forgelight retries the same model with exponential backoff, then switches the same TrueForge session to the next model (`sessions.update` with the new inline spec) and continues with the full history, even after edits were applied. Accepted edits are never re-applied and approvals are never re-sent. A circuit breaker skips a recently failed model for `forgelight.circuitBreakerMinutes` (reset when the models setting changes). Forgelight starts a new session only if the session switch itself fails and nothing has been applied yet. Any TrueForge catalog provider works (`config/models.example.json` includes a free Gemini Flash-Lite entry); no key is committed.

## 6. Scorecard

| Criterion | Video | Claim |
|---|---|---|
| A1 Inline edit | 0:18 | Diff in the editor, per-hunk Accept / Reject (CodeLens, editor-title buttons, panel) |
| A2 Agent mode | 0:41–2:14 | Task B edits cli.py, test_cli.py and docs/cli.rst; no file named in the prompt |
| A3 Streaming & cancel | 0:02–0:16 | Tokens stream; Cancel ends the turn in milliseconds; `git status` clean |
| B1 Context assembly | 0:41 | Context picked card: files, reasons, tokens within the 6,000 budget |
| B2 Diff safety | 0:18, 0:34 | Nothing written before review; per-hunk decisions; Undo restores the file |
| B3 Resilience | 3:09–3:31 | Unreachable primary retried with backoff, then the same session switched to the fallback model, history kept; workspace unchanged |
| B4 TrueForge depth | 2:18 | Turn pauses for approval, then review; session view shows tool calls and the context-scout sub-agent |
| C1 Video | 0:00–3:51 | Tasks A, B, C in order, each verified on screen |
| C2 Write-up | n/a | This document: architecture, context strategy, model setup, trade-offs, scorecard, limitations |

## 7. Tools used

VS Code 1.84, TrueForge 0.185.1, Ollama 0.40, Node 22, TypeScript, esbuild. We wrote, tested and reviewed the code with an AI coding assistant (Claude Code). All design decisions are ours and are documented here.

## 8. Known limitations and what we would do with another month

- Qwen on a laptop takes 15 to 20 s per step, so Task B takes minutes (sped up in the video). With credits: a hosted primary, Qwen as fallback.
- Ranking uses only lexical and structural signals, so it misses synonyms and semantic intent. Next: embeddings and a call graph.
- Each TrueForge instance has one MCP server name and port, so it serves one VS Code window at a time.
- The panel has no visual regression tests (the agent loop has a headless harness against a real TrueForge). Next: per-hunk approval payloads upstream in TrueForge, live `run_command` output, multi-root workspaces.
