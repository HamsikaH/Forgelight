# Demo video script (max 4:00)

Rules that shape this script (problem statement p. 5-6):
- Tasks **A, B, C in that order**, each followed by its on-screen verification.
- Show the **TrueForge session** briefly during Task B.
- You may cut model *waiting* time, but **never cut between giving an instruction and the diff appearing**. Speed those stretches up instead (2x-8x) with a small "sped up ×4" label.
- Upload as YouTube **unlisted** or Google Drive "anyone with the link can view". It must be public at the deadline.

## Before recording (checklist)

1. `scripts/start-trueforge.sh` running (terminal 1). `ollama ps` shows nothing stuck.
2. Warm up Qwen once so the first call is not a cold load: run any short inline edit, then reset.
3. Flask checkout at tag 3.1.3, clean: `git status --short` prints nothing. `.venv` is excluded (`.git/info/exclude`).
4. VS Code: open the Flask folder with Forgelight running (F5 from the Forgelight repo, or `code --extensionDevelopmentPath=...`). Zoom to 125-150 % (`⌘=`) so text is legible in a 1080p recording. Close unrelated panels and notifications. Use a dark or light theme consistently.
5. Settings for A and B: `"forgelight.models": ["ollama/qwen3-6-35b"]`. **Before every take of Task C**, set `forgelight.models` to `["ollama/qwen3-6-35b"]` and then back to the pair: this resets the circuit breaker (otherwise the broken model is skipped for `forgelight.circuitBreakerMinutes` after the previous take, and there is no retry and no switch to show). Or set `forgelight.circuitBreakerMinutes` to `0` before the first take.
6. Integrated terminal open at the Flask root (for verification commands). Keep the Forgelight panel visible on the left or right.
7. Have `http://localhost:8790/sessions` open in a browser tab, ready for the Task B session.
8. Screen recorder: 1080p or higher, 30 fps, system cursor visible. Optional mic narration.

## Scene 1: Task A, inline edit (target 0:00-0:55)

1. Open `src/flask/helpers.py`, select the whole `get_debug_flag` function.
2. Press **⌘⌥E**, type exactly:
   `Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.`
3. Show the panel: tokens streaming under the shimmering **Working…** line ("Thinking…" then text), the orange bar sliding under the header and the glowing input box. **Cancel demo (A3):** press **Esc** (or ⌘⌥⌫) mid-stream, then show "Cancelled" and run `git status --short` (empty). Re-run the same inline edit.
4. The diff opens in the editor (`Forgelight review: src/flask/helpers.py`). On the panel's review card, hold 2-3 s on the **Shadow test run** line (`tests/test_helpers.py · 35 passed`): the tests already ran on a sandboxed temporary copy with the proposal applied, before anything was accepted. Show the per-hunk **Accept hunk / Reject** controls; accept the hunk (if there are two hunks, accept them one at a time). About half a second after the last decision the card folds to one line (path, `2/2 hunks`, `+N −M`, `tests pass`); click the line to open it again. The run ends with the **finish card**: the file, the shadow test run and the context used.
5. Verify in the terminal:
   `FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → `False`
6. **Undo demo (B2):** click **Undo last change** in the panel → file restored; `git diff --stat` empty. (Task C repeats Task A, so the tree must be clean anyway.)

## Scene 2: Task B, agent mode (target 0:55-2:55)

1. In the Forgelight panel, with **no files mentioned**, type exactly:
   `Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`
2. Pause on the **Context picked** card for 2-3 seconds (files, reasons, "N / 6,000 tokens"). This is the B1 moment.
3. Show the **context-scout** sub-agent group appear and work (its latest three rows under **Working…**). When it finishes it folds by itself to its head (files read, time, ✓) and its footer: hold 2-3 s on the footer (`context-scout read ~11.9k tokens of context, returned ~380 to the main agent · −97%`). Then **click the Context X-ray strip** under the header to open it (it starts closed and shows the token count and a small bar) and hold 2-3 s on the breakdown (input tokens per model call, split into harness / instructions / tool definitions / messages, against the 64k context).
4. For each proposed file (`src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`, maybe `docs/api.rst`): the diff opens, review the hunks (each card shows its **Shadow test run** result), accept. Speed up waiting. Between edits the agent's reading folds into one-line steps labelled with its own sentence and counts (files read, searches, thoughts, time); click one to show what it read.
5. If the agent asks to run tests: the command approval card appears with its **risk badge** (`test · runs pytest`) → **Allow once** (or *Allow for 10 min*). Safe test commands that ran without asking show as one line, `Auto-approved · TEST · <command>`.
6. Click **Open in TrueForge** in the panel → the session page: show turns, tool calls, the **Sub-agent: context-scout** step and the approval events (3-5 seconds). Switch back.
7. Verify in the terminal:
   - `.venv/bin/python -m pytest tests/test_cli.py -q` → all passed
   - `.venv/bin/flask --app <forgelight>/demo/app.py config` → JSON with `***` for SECRET/PASSWORD/TOKEN/KEY
   - `.venv/bin/flask --help` → lists `config`
   - `git status --short` → three or more modified files
8. Hold 2 s on the **finish card** at the end of the run: the files changed, *Last test run passed*, the shadow test runs and the context totals. (If the last test run failed, the card is amber and says so.)

## Scene 3: reset (target 2:55-3:00)

Click **Revert this run (N files)** on the Task B finish card (restores every file the run changed, newest first; files it created are deleted), then `git status --short` → empty. (Fallback: `git stash -u`.)

## Scene 4: Task C, resilience (target 3:00-3:50)

1. Show the setting change: `"forgelight.models": ["unreachable/broken-model", "ollama/qwen3-6-35b"]` (the first model points at a dead endpoint, `http://127.0.0.1:9/v1`, configured in TrueForge). For a retake, first set it to `["ollama/qwen3-6-35b"]` and back (resets the circuit breaker), or set `forgelight.circuitBreakerMinutes` to `0` beforehand.
2. Repeat Task A exactly (select `get_debug_flag`, ⌘⌥E, same instruction).
3. Show: the amber **retry** banner, then the green **"Session kept: switched unreachable/broken-model → ollama/qwen3-6-35b mid-task; continuing with full history"** banner (same TrueForge session); the header chip of the broken model turns red **"down · retry hh:mm"**. Scroll the editor / click around to show it stays responsive.
4. Before accepting, run `git status --short` → empty (workspace unchanged during failure). Then accept and stop recording, or reject to keep the tree clean.

## After recording

- Trim to ≤ 4:00. Add "sped up" labels where you sped up.
- Note the timestamps of: Task A diff and shadow test line, cancel, Task B context card, sub-agent and its savings footer, X-ray strip, risk badge, TrueForge session, finish card, Revert this run, Task C retry and Session kept banners. Put them in the write-up scorecard (`docs/WRITEUP.md` section 6), then rebuild the PDF: `python3 scripts/build_writeup_pdf.py`.
