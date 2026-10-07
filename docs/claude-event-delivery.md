# Claude delivery without a persistent listener

Design proposal, 27 September 2026. The approved temporary Desktop probe was run and removed; no permanent hooks or live transport changes have been installed.

Illiana wants the chat to finish cleanly, without a listener task remaining open after the conversation. GPT already uses the existing Semaphore service and native engine rather than a chat-owned waiting command. Its transport does not need to change.

## Candidate to validate first

The official [hook reference](https://code.claude.com/docs/en/hooks) documents `SessionStart.watchPaths`, externally triggered `FileChanged` hooks, and command hooks with `asyncRewake`. An `asyncRewake` command exiting 2 can wake an idle session; plain asynchronous output waits for another interaction. FileChanged output by itself does not inject model context. [Desktop shares hook configuration with the CLI](https://code.claude.com/docs/en/desktop#shared-configuration).

**Inference to test:** combine the native file watcher with a short `FileChanged` command using `asyncRewake`. General documentation does not establish that this exact combination works in the installed Desktop runtime. Its event dispatch, wake handling and visible task lifecycle are the feasibility gate.

Proposed flow:

1. A session-start helper registers a private signal path belonging to that native session. This is a native watch registration, not a shell command waiting for messages. Accommodate chats that join a room after startup: either register the private path before binding, or make the one-time reload requirement explicit.
2. Semaphore saves the room message first, then updates that session's signal file. The signal contains no permission decision or executable command.
3. Claude's own watcher launches the hook. It validates the session, room binding, exact pending turn and unread revision, then claims a delivery batch under the existing room lock.
4. With pending input, the helper emits a short receipt notice and exits immediately through the tested wake mechanism. With no work, a stale binding or a duplicate event, it exits silently. It never waits for future messages.
5. Claude receives through the normal CLI. That receipt, rather than the file event or hook exit, marks the input read. The existing reply barrier remains the fallback.

The desired idle state has no Semaphore listener task and no periodic model check. The normal Claude app and Semaphore app still run; the filesystem watch belongs to the host app.

## Delivery contract

- Key a batch by room, native session, room turn and revision. Concurrent file events must not create duplicate wakes. Never treat a lost hook outcome as permission for an unlimited retry loop.
- Signal only durable changes requiring attention. Do not watch room.json, which is also rewritten by receipts and status notes; that would generate unnecessary events and potential loops.
- Preserve provenance: the notice points to saved human input or a collaborator message. Hook context adds no authority and answers no approvals.
- A take-back or handoff invalidates the old turn. An already-issued notice must fail its stale receipt safely.
- Keep helpers bounded and local. Set a short timeout and stop on malformed input, missing bindings or an unavailable room lock. Registration and reconnect must reconcile pending input so a missed filesystem event cannot lose a message.
- Keep native credentials inside their owning session. This candidate needs neither exported session tokens nor a change to inbound-message permission settings.

## Comparison and fallback

| Route | Persistent chat task | Idle delivery | Recommendation |
| --- | --- | --- | --- |
| Native file event + short wake hook | None intended | Must be proved in Desktop | Test first |
| Hooks at work boundaries + manual continuation | None | Human opens the chat and continues | Honest fallback if native event wake fails |
| Listener with a timeout | Present until it exits | Automatic only while waiting | Optional compatibility mode, not the main answer |

The after-step fallback should prefer `PostToolBatch` when the installed runtime supports it, with `UserPromptSubmit` and a bounded Stop check covering startup and finishing races. Stop must never continue a quiet conversation merely to poll.

A timeout does not resolve the user's main objection. If a listener is retained as an explicit compatibility option, end it immediately when the stick returns to the human, the conversation pauses or the turn budget ends. A timer is only a secondary bound while an AI-to-AI exchange is still active.

The [session inbox documentation](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket) also describes hooks posting to their own session under native inbound controls. That is distinct from an outside service borrowing session credentials. However, the page does not specify the complete message payload contract, so it is a secondary research route, not a production promise. Do not globally set inbound messaging to accept as a shortcut.

## UI and installation

Use capability and actual connection evidence, not an old process marker or a missing periodic heartbeat, to distinguish states:

- **Working:** input can guide the current turn; show Sending, Delivered and Read separately.
- **Ready:** a tested native wake route is registered for this open session. An idle chat needs no task spinner.
- **Resting:** no live wake route. With pending input, show “Message saved · open Claude to continue”; confirm whether opening alone suffices before promising it.
- **Needs reconnecting / unavailable:** an installed route is broken or its runtime changed. This is different from normal rest.

Prepare a small, reversible hook configuration with exact paths and preserved unrelated settings. Keep registration narrowly scoped to joined room identities. Global hook installation is a separate user-visible setup change; this design review does not install it. Prefer one startup registration plus event-driven work over launching a helper after every step in every unrelated chat.

## Desktop proof before implementation

Claude should first check the installed runtime's support for all three building blocks and prepare a disposable, narrowly scoped probe. Do not resume the existing native chat from another process.

The probe must demonstrate idle wake with no open waiter; delivery after a long running tool; burst-event deduplication; explicit receive before Read; no action after a stale turn or take-back; recovery after reopening; and no residual background task after returning to the human. A failure must leave the message saved without automatic permission changes or a retry storm.

If that composition fails, report the observed limit and recommend the listener-free manual fallback, or offer the bounded listener as an explicit tradeoff. Do not substitute an untested twenty-minute wait and call the problem solved.

## Desktop probe results, 27 September 2026 (Claude)

With Illiana's OK, a temporary project-local hook was run in Claude's own desktop chat (bundled Claude Code 2.1.280, started from the desktop app with user, project and local settings) and then removed. Scripts: `dev/claude-wake-probe/`. Redacted log: `docs/claude-wake-probe-2026-09-27.jsonl`.

| Check | Result |
| --- | --- |
| **Wake after the model turn ended** | Claude ended its turn at 22:40:06. A detached timer, not a task Claude was tracking, changed the signal at 22:40:43. The hook ran at 22:40:44.135 and exited 2, and the chat's new turn began at 22:40:44.139 with the notice. Claude acted at 22:40:49. The room listener remained a background task. This establishes hook-triggered wake, but a repeat with no background task is needed to exclude any dependency on the listener keeping the session alive. |
| **Guidance while working** | A signal at 22:39:50 ran the hook within a second, and the notice arrived before Claude's next step. **Works.** |
| **Burst** | Five writes within about a second produced one hook run, with the last content, and one notice. The watcher coalesces them, but Semaphore should still batch, since the docs promise no deduplication. |
| **Absolute path outside the working folder** | A CwdChanged hook returning `hookSpecificOutput.watchPaths` registered it at 22:42:29. A write at 22:42:32 ran the matcher-less FileChanged group at 22:42:33, and the notice arrived at the next step. **Works.** |

**Findings the implementation must respect**
- **Where the output goes.** `watchPaths` must be inside `hookSpecificOutput`: the installed runtime says "Hook output can include hookSpecificOutput.watchPaths". A top-level `watchPaths`, as the CwdChanged docs table can be read, was silently ignored.
- **Literal matchers follow the chat's current folder,** which moves when Claude runs `cd`. Use absolute `watchPaths`, from SessionStart for new or resumed chats, and repeat them from CwdChanged, since a CwdChanged list replaces the dynamic list.
- **Settings reach a running chat late.** A newly created settings file took about 15 to 100 seconds to reach a running chat. Install hooks before chats start. Existing chats register on their next SessionStart (resume, clear or compact) or directory change.
- **The label.** The chat labels the notice "Stop hook blocking error from command "FileChanged"". It is harmless, but it looks alarming, so the notice text should say plainly that it is Semaphore delivering a saved message.
- **Cleanup.** The temporary settings, signals, timer and test folder were removed. The room listener remained only as a safety net during the idle test.

## Final acceptance and proposed rollout (Astra)

The evidence is promising enough to recommend this design, subject to one remaining native check: stop the old room listener and all probe-owned background tasks, record the empty task list, end the model turn, and trigger the same signal once from a short detached timer. Record the wake notice, then verify no task remains after the helper exits. This is a repeat within Illiana's approved temporary probe scope, not a request to install global hooks. Do not stop unrelated user work to achieve the empty-task condition; use an otherwise idle test context if necessary.

Permanent setup, if Illiana chooses it after that check:

1. Add three command-hook entries to `~/.claude/settings.json`, preserving every unrelated setting: SessionStart and CwdChanged call a shared registration handler; FileChanged calls the bounded wake handler with `asyncRewake: true`. Use the stable installed Semaphore command so retained release paths do not become stale.
2. Register an absolute per-session signal under `~/.semaphore`. A new unjoined chat can register the inert path at startup; only an explicit Semaphore room binding can authorize notices. Both registration events use `hookSpecificOutput.watchPaths`.
3. Add durable signaling, batch claiming and registration checks to Semaphore. Room turn/revision receipts and host approval ownership stay unchanged.
4. Remove listener instructions from successfully registered Claude seats. Keep manual listening as an explicit compatibility option, not a silent permanent fallback. Retire this room's old listener after confirming the new route.
5. Show ordinary Ready, Working and Resting states. Deliver notices with a clear “Semaphore: saved room message” explanation because the native host currently labels this wake mechanism as a hook error.
6. Test a full real room round, active guidance, duplicate events, take-back, reopening and cleanup; keep installation reversible through a configuration backup and removal of only Semaphore-owned entries.

The approved probe was temporary and project-local. Permanent user-level hooks apply to native session events in all Claude Code chats, although unjoined chats must never receive room content. That broader persistent configuration is the distinct change to put to Illiana once the final check and exact install plan are ready. There is no reason to ask again for the same temporary test.

### Final check with no background task (Claude), 27 September 2026

This repeated the approved temporary probe with the room listener stopped. Before going idle, the chat's only child process was the recording command itself, and no listener ran for this room. The only other process involved was the detached one-shot writer, whose parent was the system.

- **22:46:49** Claude's turn ended.
- **22:47:28** The writer changed the signal file and exited.
- **22:47:29.487** The FileChanged `asyncRewake` hook ran and exited 2.
- **22:47:29.491** The idle chat started a new turn with the notice.
- **22:47:34** Claude acted.
- **After the wake** The chat again had no child task and the writer was gone.

**Idle wake with no background task: passed.** The temporary settings and signal files were removed. The redacted entries were appended to `docs/claude-wake-probe-2026-09-27.jsonl`.

## Implementation for 0.12.0 (Claude), 27 September 2026

Illiana approved the permanent install ("yes, INSTALL THE HOOKS!"). Built as proved:

- **`lib/claude-registry.mjs`**
  - `registerSession` backs SessionStart and CwdChanged. It gives each chat a private signal file (0600) at `~/.semaphore/claude/signals/<session>` and a record in `sessions/`, and returns `hookSpecificOutput.watchPaths`. The record is refreshed at most once a minute on folder changes.
  - `signalSession` writes the signal in place, and only for registered chats.
- **`lib/claude-wake.mjs`**
  - `wakeCheck` backs FileChanged with `asyncRewake: true`. It exits 0 at once unless the event is this chat's own signal. It then looks only at rooms where this chat is the Claude seat:
    - A queued turn gets the receive command, and the hook records an observation, as a listener does, so the app shows "starting in the Claude app".
    - New input in a received turn is revealed under the room lock, which sets the review revision, with a bounded wait of up to 2 s.
    - A take-back gets a stop notice.
  - Each notice is claimed durably under the room lock before returning hook output. Concurrent events and later signals cannot replay it. One review stays outstanding until explicitly received; later human input cannot invalidate its receipt. An ambiguous hook exit is not retried; the saved room and reply barrier remain available.
  - `ClaudeSignalPump` runs in the app. It signals a turn, new input or a take-back. It re-signals an unclaimed notice at most once a minute, then stops once the hook claims it. These retries are local file writes, not model turns. Rooms are reparsed only when their file or input journal changes, including SQLite WAL writes. Input sequence numbers include intervening AI messages.
  - The installer adds exactly three entries through the stable command (`'<home>/bin/semaphore' hook register|wake`), preserves everything else, keeps the file's permissions, writes a unique backup, replaces stale entries from a moved installation, and uninstalls only its own commands, including within mixed groups. Both hook-only and full uninstall revoke registrations and leave other settings intact. It never changes `disableAllHooks`.
- **CLI**
  - `hook register|wake` is run by Claude Code. It stays quiet, and on any trouble exits 0.
  - `hooks status|install|uninstall` is run by people.
- **Wording.** For a registered chat, the envelope, reply, stick, join and notices say "no listener is needed". The skill and the invitation follow what `join` says.
- **App.** A registered Claude seat reports `wake: "automatic"`. It gets no "isn't listening" guide, shows "wakes automatically", and counts as reachable now. A queued turn reads "waking Claude's chat". After a minute without the turn starting, it reads "Claude's chat hasn't started this turn · press Wake Claude, or open it in the Claude app", and the banner offers **Wake Claude** (see below). The render signature includes that timeout even when no room file changes. A claimed input notice reads "Saved · waiting for Claude to acknowledge"; it is not confirmed delivery. Only explicit `receive` marks Read.
- **Tests.** The initial implementation passed 209 tests. Astra's review adds regression coverage for concurrent native hook processes, serialized revisions, SQLite WAL input after AI replies, settings preservation and uninstall revocation, and unconfirmed delivery status. The initial tests cover:
  - the registration shape and permissions;
  - silence for foreign files and chats;
  - turn, input and take-back notices and their deduplication;
  - pump retry and stop rules;
  - installer merge, idempotence, moves and uninstall;
  - the real CLI hook commands and no-listener guidance.

**Rollout order.** Release 0.12.0 first, because the installed command must know `hook`. Then run `semaphore hooks install`. Running chats register on their next start, resume or folder change. Finally, verify a real round in this room with no listener running.

### Review before release (Astra)

The room-lock claims live on the pending turn as `claudeHook`, scoped to its Claude session. No timestamp expiration permits replay. The pump may retry an unclaimed signal after a minute (including take-back after a busy lock), but a saved claim survives an app restart. Once a human-input receipt is pending, the hook leaves `reviewThrough` unchanged until the chat acknowledges it, after which the next batch is offered.

The hook cannot confirm that the native app accepted its output after exit. Claims are conservative delivery attempts, not acknowledgments; an ambiguous outcome remains saved and is not sent twice. The initial-turn observation retains the existing listener's advisory semantics. Native `receive` remains the only read receipt.

Validation after review: all **214 tests pass** (`npm test`); `git diff --check`, `node --check web/app.js` and `node --check lib/claude-wake.mjs` pass. The full suite includes an eight-process concurrent hook test and a live SQLite WAL regression. Permanent hook installation and the production native round remain the next release step; this review did not change the running app or global Claude settings.

## Wake Claude (October 2026)

A hook claim is never replayed on its own, so a chat that was signaled but never ran `receive` (for example, the notice reached a chat that was ending its turn, or the app reloaded it) stayed stuck until the person typed in the Claude chat. GPT's banner already offered *Open chat ↗* for the same situation.

- **Button.** For a registered Claude seat, the banner shows *Wake Claude* once a queued turn hasn't started for a minute, or once a received turn has had no acknowledgment or status-note update for five minutes. `POST /api/rooms/<room>/wake/claude` is the only route; GPT's chat is still reopened from its link.
- **Effect.** `requestClaudeWake` records `wakeRequestedAt` on the turn's `claudeHook` claim and a `wake-requested` event, then the pump signals at once. An unacknowledged turn is offered again with its receive command, noting that the person pressed Wake Claude. An acknowledged turn gets one check-in notice with its reply and note commands. Human input revealed while a request is outstanding answers it; no second notice follows.
- **Bounds.** One press, one replay: the answer is recorded under the room lock (`turnAt` or `checkInAt` at or after the request). Requests are refused unless Claude holds an `awaiting-reply` turn in a hooked chat. Receipts, revisions and the reply barrier are unchanged.

## Stop check: no silent stop while holding a turn (October 2026)

On 6 October a Claude chat holding a received turn had an action blocked by its host. It explained only in the native chat and ended its turn, so the room looked stuck to a person following it in the companion. Alongside the skill rule (*Blocked means report and pass*) and the app's quiet-holder banner, a fourth hook entry guards the exit:

- **Entry.** `Stop` runs `semaphore hook stop` (no `asyncRewake`, timeout 10 s). `hooks install` adds it beside the other three and leaves unrelated hooks, including other Stop hooks, untouched. An install from before this change reports `present.Stop: false` until `hooks install` is run again; uninstall removes only Semaphore's entries.
- **Check.** `stopCheck` looks only at rooms where this registered session is the Claude seat and holds a received, unanswered `awaiting-reply` turn in a room that hasn't ended. Under the room lock it records `claudeHook.stopReminderAt` and returns the documented `{ "decision": "block", "reason": … }`. The reason gives the reply command, a `--blocking` ask command for a blocked turn, and the note command for deliberate background work.
- **Bounds.** At most one reminder per turn. The durable claim, not `stop_hook_active`, is the loop guard, because Semaphore's own FileChanged wakes arrive in the desktop app as stop-hook feedback, so that flag can already be true on an ordinary room turn. A busy lock (2 s), a damaged room, bad input or any error lets the chat stop without using up the reminder. Nothing is replied, passed or released on the chat's behalf, and the reminder never signals or wakes the chat.
- **Evidence.** CLI fixtures cover single, repeated and three concurrent hook processes (exactly one reminder), queued, replied, taken, ended, busy and damaged rooms, upgrade from a three-entry install, and malformed input. A native proof (a real desktop Claude chat stopping while it holds a turn) needs `hooks install` on this machine after the release and is still pending.
