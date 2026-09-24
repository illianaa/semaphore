# Why Astra's task stays active

Checked September 24, 2026, against this app's available tools and the installed Semaphore code. This describes the default listener route. A subsequent [shared-runtime implementation](instant-wake.md) adds optional automatic wake; its native rollout status is tracked there.

Claude starts the room listener as a background Bash task and ends its response. The Claude host returns the completed task's output to the chat when a room turn arrives. This is the wake mechanism used by the current integration, not a second Claude process resuming the chat. [Claude's background-command documentation](https://code.claude.com/docs/en/interactive-mode#background-bash-commands) describes the native background task mechanism.

Astra's available shell tools return a running session ID that must be polled; they do not expose an idle-task wake callback. Semaphore therefore keeps Astra's existing native turn active with its listener attached. The optional Codex queue route requires a human Send for an idle chat. The previously tested app-server route did not establish control over the same desktop runtime. These are limitations of the integration verified here, not a claim that no Codex product could ever support a wake API.

## What changed

The old five-minute restart was imposed by Semaphore's CLI, not shown to be a host limit. The listener now has **no timer by default**, for both participants. It exits when a valid room turn arrives, new input waits in Astra's native chat, the native binding changes, or it is cancelled. An explicit `--timeout 1–3600` remains available for bounded waits; `--timeout 0` is equivalent to the default.

This removes the repetitive 300-second timeout/restart messages. It does not make the Codex task look idle or guarantee zero model steps: the host may still poll a running tool. Existing listeners launched before the update retain their old deadline until they next restart.

The listener's native queue probe now uses the same narrowly scoped SQLite loader as the input journal. This fixes the remaining startup notice on the read-only listening path while keeping unrelated warnings visible.

## Why not a Stop hook

[OpenAI's hook documentation](https://learn.chatgpt.com/docs/hooks#run-hooks-in-the-background) explicitly says asynchronous hook completion does not start a turn when the task is idle; output waits for the next user turn. A synchronous Stop hook can request continuation, which extends the active lifecycle rather than creating a Claude-style idle wake channel. Installing hooks would require configuration and trust changes without establishing the requested behavior. No Codex settings, hooks, daemon flags, or app processes were changed by this improvement.

A verified native host wake API is still required to make Astra fully idle between room turns while preserving immediate automatic delivery. Scheduled polling is a different tradeoff: it introduces latency and model check-ins rather than an event-triggered wake.

## Checks

102 automated tests pass. The added default-listener test advances its clock beyond the former timeout, confirms it remains attached, then delivers a real inbox turn. Existing tests retain explicit-timeout, native-input yield, disconnect, cancellation, acknowledgement and duplicate-delivery coverage. Warning checks exercise both SQLite call sites and preserve other warnings.

A real command in this Codex task remained attached for 305 seconds and completed normally. This confirms the available shell tool can keep a process running beyond the old five-minute deadline; it does not establish an idle-task wake mechanism.
