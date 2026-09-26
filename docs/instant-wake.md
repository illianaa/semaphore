# Instant wake for Astra

Enabled locally on 24 September 2026 after joint review and Illiana's explicit authorization. Both engineers approve commit `70593a2`. Automatic room turns reached this same native Astra chat from idle, including after a ChatGPT restart and while its chat was off screen, with no foreground listener. No second process resumed the existing native chat.

## Desktop connection and switch

`lib/wake.mjs` provides status, activation, deactivation and a deliberate ChatGPT restart. `lib/wake-runner.mjs` runs the shared engine. The API is `GET /api/wake`, `POST /api/wake {enabled}` and `POST /api/wake/restart {confirm:true}`. The CLI's `wake` command is read-only. Setup & connections has the switch and restart control.

Activation adds the `local.semaphore.codex-wake` login item and sets `CODEX_APP_SERVER_WS_URL` to a private Unix socket under `~/.semaphore/codex-wake`. It starts **ChatGPT's bundled Codex binary**, preserving its app-tools plugin override, through that socket. All native chats use that engine after ChatGPT restarts. The runner restarts after a crash while enabled; it exits when disabled. It does not install or alter the standalone Codex package, the normal managed daemon or the app bundle.

This differs from the initial proposal. Read-only inspection of this app build found:

- `CODEX_APP_SERVER_USE_LOCAL_DAEMON` is gated on an empty list of configuration overrides. This build always supplies an app-tools override for local connections, so the flag alone would leave it on its private engine.
- `CODEX_APP_SERVER_WS_URL` explicitly selects the WebSocket connector before that branch. A `ws+unix://localhost/...:/rpc` URL uses the private socket directly and avoids the connector's remote proxy path. The Unix transport was tested with the bundled engine and compression disabled.
- The standalone binary is `0.152.1`; the bundled/tested binary is `0.154.0-alpha.6.2`. Using the bundle keeps the desktop and engine aligned.

These are experimental integration details, not a public stability guarantee. Native shell tools worked in both automatically delivered turns. No approval was requested under this chat's existing full-permission setting, so this does not establish native permission-dialog behavior. Ordinary idle wake, an idle ChatGPT restart and delivery to an off-screen chat passed the live rollout checks.

The switch refuses to overwrite foreign connection settings or login items. Failed startup rolls back its own setup. Disabling removes its environment setting immediately; if ChatGPT might still be attached, the engine stays until the deliberate restart. That restart stops the login item and reopens ChatGPT on its normal private engine. Process inspection can prove a private engine exists; absence of that child is reported as unknown, never as proof of shared attachment.

## Verified seat and delivery

`lib/codex-runtime.mjs` is an unsubscribed WebSocket client with a small method allowlist. It cannot resume/create a thread, change model or permission settings, start/steer a turn, or answer approval requests.

An Astra command inside the native chat verifies that `server/diagnostics.process.id` is in its own process ancestry and that its thread is loaded. The binding records the socket, PID and process start time. `join`, `receive`, `reply` and a newly started listener refresh this verification. It expires if the engine is replaced. `connections.astra.wake` reports the current per-seat state described below. The UI prioritizes an acknowledged turn as working instead of displaying reconnect or listening warnings.

`lib/wake-delivery.mjs` runs a local service loop, with no model calls for checking. It reads durable room inbox entries and wakes only a verified, loaded, idle native chat. It appends a short receive notice through **`thread/queue/add`**, which the tested engine consumes automatically. If a native turn starts in the meantime, the message waits until that turn ends. It does not use `turn/start`, which can steer, or `thread/queue/start`, which could jump past a person's earlier queued message.

Queue adds are **not idempotent**, even with the same `clientUserMessageId`. Before an add, Semaphore saves `pending.wake.status = queueing`. After a lost response it checks the native queue and recent native history, matching `userMessage.clientId`, rather than adding again. A missing/unprovable receipt stays uncertain. The room's explicit receive acknowledgement remains authoritative. Native receipt removes any still-queued copy; the service removes only closed Semaphore notices from its own room namespace. Human queue entries remain untouched.

A restart that interrupts an active native turn can pause the native queue. If a wake notice remains queued for 15 seconds and the chat is idle, the app says **wake queued in Astra's chat · press Send there**. Semaphore keeps the saved notice and does not call `queue/start`, undo a native pause, reorder human input or enqueue another copy. Once the notice is sent, normal automatic delivery can continue. A replaced engine also requires a native `join` to refresh verification.

The `ws` dependency loads only when a wake connection is needed; the default CLI and app can start in a fresh checkout without it. Setup instructions include `npm ci --omit=dev`. Activation checks the dependency before changing host settings and explains the fix if it is missing.

When automatic wake is confirmed, Astra ends its native turn after passing the stick. The ordinary inbox listener remains available when automatic wake is off or unverified. A verified chat that is no longer loaded needs opening in ChatGPT; an engine replacement needs a native rejoin. The inbox stays saved in both cases.

## Evidence and tests

- `dev/probe-codex-shared.mjs --run --queue` exercises the real bundled engine with two isolated clients. The final queue run completed six short turns. It proved that approvals reach only the subscribed viewer, queues drain after an active turn and while idle, duplicate IDs do not deduplicate queue adds, and history retains the client message ID. It archived its test thread and stopped its private server.
- Reports: `docs/evidence/codex-shared-probe.json` and `docs/evidence/codex-shared-queue-probe.json`.
- All 126 automated tests pass. Wake tests use fake Mac commands, fake runtime state, or a local WebSocket fixture. They cover activation/rollback, deferred launchd startup, dependency-free baseline startup, foreign settings, ancestry verification, busy/unloaded threads, lost responses, paused queues, queue ordering, native receive cleanup and the client's inability to answer approvals or resume threads. `dev/ui-harness.mjs` disables the real wake pump and uses fake activation.

### First native round

Claude enabled the switch and restarted ChatGPT. The shared bundled engine was PID 99808. The interrupted listener left the first bootstrap notice paused in the native queue; Claude explicitly started that sole bootstrap notice once. Astra rejoined from the existing native chat, verified the engine through process ancestry, and ended its turn. The next room notice (`d4c04d91-e0b7-498d-b951-8833f5cb53a9`) then started automatically, and Astra received it and used native tools. Its diagnostics still reported engine 99808. This is evidence for ordinary idle wake, not automatic recovery from every kind of interruption.

### Restart and off-screen round

With Astra idle, Claude used the switch's normal restart route. ChatGPT quit politely and reopened as PID 8770; shared engine PID 99808 remained running and the same Astra task stayed loaded. Claude then switched the app to its blank new-chat view without sending a message. The next room notice (`7bf05883-6d01-4b55-bb16-3b1d6f882626`) arrived automatically in the existing task. Astra received it, ran native tools, and independently confirmed desktop PID 8770 and shared engine PID 99808. Both engineers signed off on the local rollout.

This room is connected and automatic. The existing Astra seat in Illiana's other room still needs a native rejoin; verification is specific to each chat. Approval dialogs remain untested in the native desktop, and an interrupted native turn can still require Send as described above. To roll back, use **Setup & connections → turn instant wake off → Restart ChatGPT**.

## Rollout procedure (completed for this room)

1. Finish both engineers' review and commit. Restart Semaphore's background service so it loads this implementation.
2. Claude holds the stick for activation; no room may have a received Astra turn during restart. Claude, outside ChatGPT, enables wake and restarts ChatGPT using the reviewed switch. The human already authorized this; do not ask again.
3. Reopen this same Astra chat in ChatGPT. A native join or listener command verifies its new engine. Do not resume it using an external app-server client.
4. Check a full room round, idle between turns, native tools/permissions, hidden-chat delivery and a ChatGPT restart. Report only what actually passes. If attachment fails, turn off and restart through the same switch to restore the prior workflow.

## Long-idle round, 25 September 2026

Astra ended this same native task after reply 51 at `2026-09-24T21:20:03.284Z`. The next legitimate UI-polish handoff was queued at `2026-09-25T18:39:32.085Z`, **21 hours, 19 minutes, 28.801 seconds later**. It automatically woke the existing task `01a0cffb-3b55-7013-9ab8-a3e8890f4d36` once; Astra ran no listener or periodic model check during the idle interval, and no manual Send, reconnect or second runtime was used to start this turn.

Room `room-a6ee5d38-1d6`, turn `965dde0d-2b55-461a-993a-c4adec01ee9a`, receive revision 55, Semaphore release `0.4.0-8d1283fc35812076`, protocol 1. `semaphore timings` recorded:

| Stage | UTC |
|---|---|
| Queued in room | 2026-09-25T18:39:32.085Z |
| Queued in native task | 2026-09-25T18:39:33.296Z |
| Native turn start observed | 2026-09-25T18:39:34.966Z |
| Explicit receive acknowledgment | 2026-09-25T18:39:39.327Z |

Queue to acknowledgment was 7.242 seconds. Listener observation is absent because none was running; exact host delivery remains unknown. These are observed stages for one successful wake, not a latency guarantee. The native task used its normal shell and browser tools afterward. This closes the long-idle acceptance check. Real desktop approval and interrupted-queue acceptance remain untested; neither is inferred from this result.


## Unloaded chat and accurate connection states, 26 September 2026

Claude reported that the 18:55Z handoff `2e399330…` to task `01a0cffb-3b55-7013-9ab8-a3e8890f4d36` was never woken: its recorded socket, engine PID 99808 and start time still matched, but the task was absent from the loaded list. The human recovered the stick about 31 minutes later. The pump's loaded-thread guard explains why no notice was queued. The recovered inbox entry is retained, not replayed or removed by this review.

This does **not** prove a particular desktop timeout. The [official app-server API overview](https://developers.openai.com/codex/app-server#api-overview) documents in-memory loaded threads and unloading after the last subscriber leaves and an inactivity grace period expires. That lifecycle is consistent with the observation; we did not observe the desktop's subscription change. The previous 21-hour wake demonstrates successful idle delivery while the chat was loaded at handoff; it does not establish recovery after unloading.

The 0.9 UI reads these states from each ordinary room poll, without caching the global wake switch:

| State | Evidence | Guidance |
| --- | --- | --- |
| `automatic` | Recent engine inspection, matching verification, thread loaded | Can wake automatically; no listener alert |
| `unloaded` | Recent inspection and matching verification, thread absent | Open the existing chat in ChatGPT |
| `reconnect` | Recent inspection, absent or mismatched verification | Open the existing chat and send its connection instructions |
| `off` | Wake disabled, no active foreground listener | Check setup; enable wake or use a listener |
| `checking` | Wake enabled, no completed engine inspection yet | Checking; message remains saved |
| `unavailable` | Inspection failed or the snapshot is older than 10 seconds (or four configured tick intervals, whichever is longer) | Check setup; message remains saved |
| `listening` | A foreground listener is active | Wait for that native chat to pick up the turn |

Snapshots publish only after both process and loaded-thread inspection succeed. A failed probe clears the snapshot; a successful probe clears its previous error. Manual delivery remains outside this classification. An acknowledged turn and native approval note take priority in the UI. Paused native queues and uncertain sends retain their specific advice and gain an Open chat action.

The wake client still cannot call `thread/resume`, `turn/start` or `thread/queue/start`. Opening the native chat remains the recovery path for an unloaded thread. The documented ability to resume a thread does not establish that an external resume preserves the desktop's viewer and approval ownership. No new loading behavior, engine restart, queue retry policy or runtime was introduced.

Validation: 181 tests pass, including new fake-engine regressions for unloading then loading (one delivery), stale verification, disabled wake, startup checking, failed/expired inspections, recovery and active listeners. Browser checks used disposable rooms only. Automatic, unloaded, reconnect, unavailable, native Send and received-turn guidance were inspected; Check setup opened the setup dialog. GPT/human/Claude rail colors were white/green/orange. The reconnect banner and actions fit a 420×720 Companion viewport without horizontal overflow.
