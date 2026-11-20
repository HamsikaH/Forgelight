# Forgelight

**An editor-native coding agent for VS Code whose agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge).**
Forgelight shows its work: which files it read and why, and every hunk it wants to write, before anything touches disk.

Built for the TrueFoundry Forge-a-thon at Techfest, IIT Bombay (2026-27) by team **Code Blooded**.

- **Starting point:** written from scratch (no fork). Upstream code reused only as ordinary npm dependencies: `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk`, `diff` (jsdiff), `zod`.
- **Tested with:** TrueForge 0.185.1 (local mode; `scripts/start-trueforge.sh` pins this version), `@truefoundry/trueforge-sdk` 0.185.0, VS Code 1.84+, Node 22.

## What it does

| Capability | How Forgelight does it |
|---|---|
| **Inline edit** | Select code, press <kbd>⌘⌥E</kbd> (<kbd>Ctrl+Alt+E</kbd>), type an instruction. The proposed change opens as a diff in the editor with **Accept / Reject on every hunk**. |
| **Agent mode** | One request in the Forgelight panel drives a TrueForge agent through a tool loop (read, search, propose edit, run command) until done. It finds the files itself. |
| **Context assembly** | `@path/to/file.py` and `@symbol` mentions, plus automatic retrieval under a **token budget**. A *Context picked* card lists every file chosen, its tokens and the reasons. |
| **Diff review** | Every change is reviewed hunk by hunk in VS Code's diff editor; each separate change region is its own hunk. Nothing is written before you accept. A whole-file `new_content` for an existing file that would delete most of it is refused before review, and the model is told to send search/replace edits instead. Applied changes can be undone with *Forgelight: Undo Last Applied Change* (panel header), which also saves the file; <kbd>⌘Z</kbd> in the file works too but only changes the editor buffer until you save (<kbd>⌘S</kbd>). |
| **Streaming & cancellation** | Tokens (including the model's thinking) stream in from TrueForge events. *Cancel* (button, <kbd>Esc</kbd> or <kbd>⌘⌥⌫</kbd>) stops the run at once and discards unaccepted edits, so the workspace is never half-edited. While a diff review is open, <kbd>Esc</kbd> is left to the editor; use <kbd>⌘⌥⌫</kbd> or *Reject all*. |
| **Verify loop** | In agent mode the agent runs the tests itself. If it stops while the last command it ran is still failing, Forgelight sends up to two follow-up turns on the same session asking it to fix the cause and re-run. If a turn ends announcing a step it never took ("let me wait for the sub-agent…"), or an inline run answers in text without proposing an edit, one nudge turn asks it to continue. |
| **Outage-proof sessions** | If a model fails (unreachable endpoint, bad key, rate limit), Forgelight retries it with backoff, then **switches the same TrueForge session to the next model in `forgelight.models` and continues with the full history**, even mid-task. A circuit breaker skips a model that just failed for `forgelight.circuitBreakerMinutes` (reset when the models setting changes); the panel shows each model's health. |
| **Verified diffs** | While you review a change, Forgelight runs the tests that cover the changed file on a **temporary shadow copy of the workspace with the whole proposal applied** and shows the result on the review card (`forgelight.verifyBeforeAccept`, `verifyCommand`, `verifyTimeoutSec`). The proposal's code runs only in that temporary copy, under a macOS sandbox that blocks writes to your workspace and home directory and blocks outbound network access (secret-looking environment variables are removed); on other platforms the proposal is not run before you accept it. |
| **Run checkpoints** | *Revert this run* (panel) or *Forgelight: Revert Last Run* restores every file a run changed in one step, newest first; files the run created are deleted, and later edits of yours are kept. |
| **Context X-ray** | Per model call, the panel shows input/output tokens and TrueForge's input breakdown (harness, instructions, tool definitions, messages) against the model's context length, and for each sub-agent how much context it read versus how much it returned to the main agent. |
| **Command guard** | Every `run_command` is classified (test / read / write / network / destructive) and shown with a risk badge; catastrophic patterns (`rm -rf /`, `sudo`, `curl … \| sh`, `git push --force`, also when hidden in `bash -c`, `trap`, `alias`, `xargs`, `BASH_ENV`, `git -c core.fsmonitor=…`) are refused. With `forgelight.autoApproveSafeCommands`, test and read commands run without asking, except reads of secrets or of files outside the workspace. |

## Architecture

```
 VS Code extension (Forgelight)                          TrueForge (local mode, :8790)
 ┌──────────────────────────────────────────┐            ┌───────────────────────────────┐
 │ Agent panel (webview) · Inline edit cmd  │  sessions,  │ agent loop: model calls,      │
 │ AgentRunner ── @truefoundry/trueforge-sdk├────turns──▶ │ MCP tools, approvals,         │
 │   streams events, answers approvals      │◀──events─── │ sub-agents, compaction        │
 │                                          │             └──────────────┬────────────────┘
 │ Editor MCP server (127.0.0.1, token) ◀───┼──── MCP tool calls ────────┘   model provider
 │   read_file · search_code · find_symbol  │                                (Ollama / any
 │   list_files · repo_map · retrieve_context                                 catalog model)
 │   propose_edit* · run_command*           │   * gated: TrueForge pauses for approval
 │ Review controller: diff + per-hunk gate  │
 └──────────────────────────────────────────┘
```

- The extension is a **client of a TrueForge agent**: it creates sessions and sends turns with the TypeScript SDK, and renders the streamed events.
- The editor's capabilities are **MCP tools** served by the extension itself (streamable HTTP on `127.0.0.1`, per-activation secret header). The agent, not the extension, decides what to read and change.
- `propose_edit` and `run_command` are listed in `require_approval_for_tools`. When the model calls `propose_edit`, **TrueForge pauses the turn**; Forgelight computes the hunks against the live buffer and opens the hunk-by-hunk review; the user's decisions are recorded and the approval is sent back. Only then does TrueForge execute the tool, which applies **exactly the accepted hunks** through a `WorkspaceEdit` (undoable).
- Agent definitions live in [`agent/`](agent/): `forgelight.agent.json` (agent mode, with a `context-scout` sub-agent) and `forgelight-inline.agent.json` (inline edits). Both are registered in TrueForge on activation, and each run uses them as an inline session spec so the model can be swapped for fallback.

## Setup (from a clean clone)

Prerequisites: Node ≥ 22.14, VS Code ≥ 1.84, and either [Ollama](https://ollama.com) (free, local) or an API key for a model provider supported by TrueForge.

```bash
git clone <this repo> forgelight && cd forgelight
npm install
npm run build
```

### 1. Start TrueForge locally

```bash
scripts/start-trueforge.sh
```

This runs `npx @truefoundry/trueforge@0.185.1` (the tested version; `TRUEFORGE_VERSION=latest scripts/start-trueforge.sh` opts in to the newest) on <http://localhost:8790>. TrueForge's local mode blocks outbound requests to loopback addresses by default; the script sets `OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'` so TrueForge can reach the extension's MCP server and a local Ollama. Nothing else is exposed. It also raises TrueForge's model timeouts (`MODEL_HTTP_HEADERS_TIMEOUT_MS=600000`, `MODEL_HTTP_BODY_TIMEOUT_MS=300000`; the default 20 s header timeout is too short for a local model reading a long prompt or loading cold). Started with plain `npx @truefoundry/trueforge`, TrueForge rejects the MCP registration with "Outbound URL blocked"; Forgelight then tells you to use the script.

### 2. Configure models in TrueForge

```bash
cp config/models.example.json config/models.json   # git-ignored; put keys here, never commit them
node scripts/setup-models.mjs                       # registers the providers, lists available models
```

The example registers:

| Provider | Model FQN | Notes |
|---|---|---|
| `ollama` (custom, OpenAI-compatible) | `ollama/qwen3-6-35b` | Local Qwen 3.6 35B-A3B. Create the 64k-context variant once: `ollama pull qwen3.6:35b-a3b && ollama create forge-qwen3.6-64k -f config/ollama/Modelfile` |
| `google-gemini` (optional) | `google-gemini/gemini-3-5-flash-lite` | Free Google AI Studio key; skipped while the key is a placeholder |
| `unreachable` (custom) | `unreachable/broken-model` | Points at a dead port; used to demonstrate fallback (Task C) |

You can also add providers in the TrueForge UI under **Settings → Models**.

### 3. Run the extension

Open this folder in VS Code and press <kbd>F5</kbd> (*Run Forgelight*), then in the new window use **File → Open Folder…** to open your project (e.g. the Flask checkout below), or:

```bash
code --extensionDevelopmentPath="$PWD" /path/to/your/project
```

On activation Forgelight starts its MCP server, registers it in TrueForge as `forgelight-editor`, and registers both agent definitions. Open the **Forgelight** view in the activity bar.

### 4. Choose models

Setting `forgelight.models` is the priority list (primary first):

```json
"forgelight.models": ["ollama/qwen3-6-35b"]
```

Other settings: `forgelight.trueforgeUrl`, `forgelight.contextBudgetTokens` (default 6000), `forgelight.retryAttempts`, `forgelight.retryBackoffMs`, `forgelight.circuitBreakerMinutes` (default 5, 0 = off), `forgelight.mcpPort`, `forgelight.commandTimeoutSec`, `forgelight.verifyBeforeAccept` / `verifyCommand` / `verifyTimeoutSec`, `forgelight.autoApproveSafeCommands`.

With a custom `forgelight.verifyCommand` (for example `npx vitest run {tests}` or `npm test`), the shadow copy links the workspace's `node_modules` / `.venv` back to the real ones. The sandbox makes them read-only, so a tool that writes a cache inside them (vitest's `node_modules/.vite`) reports a permission error; point such caches at a temp directory, or leave the setting empty for the built-in pytest detection.

## Reproducing the three fixed tasks

Repository: `pallets/flask` at tag `3.1.3` (commit `22d92470`), with a virtualenv outside version control:

```bash
git clone --branch 3.1.3 https://github.com/pallets/flask.git && cd flask
python3 -m venv .venv && .venv/bin/pip install -e . pytest==9.0.2 python-dotenv
echo ".venv/" >> .git/info/exclude
```

- **Task A (inline edit):** open `src/flask/helpers.py`, select `get_debug_flag`, press <kbd>⌘⌥E</kbd>, give the instruction, then accept the hunks one by one (the docstring line and the changed `return` line are separate hunks). Verify: `FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → `False`.
- **Task B (agent mode):** in the panel, with no files mentioned, give the instruction; review and accept the hunks. Verify: `.venv/bin/python -m pytest tests/test_cli.py -q`, then `.venv/bin/flask --app /path/to/forgelight/demo/app.py config` (masked JSON) and `.venv/bin/flask --help`.
- **Task C (resilience):** first reset the checkout so earlier tasks do not show up: `git stash -u` (keeps the Task A/B changes recoverable; `.venv` is excluded, so it stays), and check that `git status` is clean. Warm the local model so the fallback does not start cold: `ollama run forge-qwen3.6-64k "" --keepalive 60m`. Then set `"forgelight.models": ["unreachable/broken-model", "ollama/qwen3-6-35b"]` and repeat Task A. Forgelight reports the failure, retries, then switches the same TrueForge session to the fallback automatically; `git status` stays clean until you accept (show it again before accepting). **Before every take of Task C**, set `forgelight.models` to `["ollama/qwen3-6-35b"]` and then back to the pair: this resets the circuit breaker, which otherwise skips the broken model (no retry, no switch) for `forgelight.circuitBreakerMinutes` after a failure. Or set `forgelight.circuitBreakerMinutes` to `0` before the first take.

## Headless harness

The agent loop has no VS Code dependency, so it can be exercised from Node with automatic review policies:

```bash
npm run build
node dist/test/headless/runTask.js --root /path/to/flask --task "<instruction>"
```

Pure tests (no VS Code, no TrueForge):

```bash
npx esbuild test/hunkLayout.test.ts --bundle --platform=node --outfile=/tmp/hl.js && node /tmp/hl.js
npx esbuild test/toolPreview.test.ts --bundle --platform=node --outfile=/tmp/tp.js && node /tmp/tp.js
npx esbuild test/commandGuard.test.ts --bundle --platform=node --outfile=/tmp/cg.js && node /tmp/cg.js
npx esbuild test/runnerFeatures.test.ts --bundle --platform=node --outfile=/tmp/rf.js && node /tmp/rf.js
npx esbuild test/shadow.test.ts --bundle --platform=node --target=node18 --outfile=/tmp/shadow.test.js && node /tmp/shadow.test.js   # reads the Flask checkout, macOS
```

`test/ehost/perHunk.test.js` checks per-hunk review inside a real extension host (how to run it is in its header).

## License

MIT, see [LICENSE](LICENSE).
