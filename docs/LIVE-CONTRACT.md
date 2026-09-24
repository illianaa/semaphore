# Live core contract

The core accepts a transport per speaker. An object with `deliver(context)` must expose `kind` equal to that participant's saved `transport`. A legacy object with `reply(context)` is wrapped as `kind: 'headless'`. Missing legacy transport fields migrate to `headless`; a live participant can never silently invoke a headless adapter.

Both the native-chat CLI and the local web app use this protocol.

## Locking and state

Use `await store.acquire({ waitMs: 5000 })` around each short mutation command, and release in `finally`. No-argument `acquire()` retains its synchronous behavior for the original CLI. Waits are bounded to 30 seconds and never steal an existing lock. `listen` should not hold the room lock while waiting for mail.

`new Semaphore(store, transports, emit)` loads the room under that lock. Existing version-1 rooms gain `autoTurns`, `maxTurns`, and participant transport fields. An `awaiting-reply` turn preserves its owner on reopening. A `delivering`, `uncertain`, or legacy pending turn becomes uncertain, with the human holding the stick. An interrupted handoff with no pending delivery pauses for the human; construction never sends anything.

The room has one pending turn:

```text
{ id, speaker, through, at, state, receipt, receivedAt?, runtime? }
state = delivering | awaiting-reply | uncertain
```

`delivering` is saved before calling a transport. A matching queued receipt is saved with `awaiting-reply` and the model retains the stick. Repeating `run()` while awaiting a reply does nothing. An instance of `LiveDeliveryError` with `certain === true` clears pending and returns control to the human. Every other delivery failure retains an uncertain turn. No error triggers retransmission.

## Human operations

```js
await app.send(text, nextSpeaker, { maxTurns: 4, via: "astra" });
await app.pass(nextSpeaker, { maxTurns: 4 });
app.takeStick();
app.recover();
```

`via` is optional provenance on a human message, limited to `astra` or `claude`. The CLI must verify the calling chat before using it; it does not grant a collaborator permission to invent human instructions. Both `send` and `pass` start a new bounded exchange, persisting `maxTurns` and resetting `autoTurns`. They reject while any prior turn is pending.

`takeStick()` cancels the current in-process request if present, assigns ownership to the human, and marks any pending delivery uncertain. Native chats may still finish their response, but their later replies are rejected. `recover()` acknowledges and clears an uncertain turn without retrying or moving the delivery cursor. Use take before recovering an awaiting reply.

## Replies

After deriving the speaker from the native environment and checking its exact session ID and transport against the room binding:

```js
const result = await app.accept({ turnId, speaker, message, next });
// { status: 'accepted', duplicate, message: committedMessage, room }
```

Acceptance requires the pending ID, speaker, owner, and state to agree. The reply, `turnId`, recipient's delivery cursor, ownership, and incremented `autoTurns` commit together. The saved budget is enforced before any further delivery. The core then delivers the next turn or returns control to the human. Do not pass a new maxTurns value from a reply command; accept uses the original exchange budget.

An identical repeat of a committed reply returns `duplicate: true` without appending, changing ownership, or dispatching again. A conflicting duplicate or stale/cancelled turn is rejected. Duplicate matching uses the normalized message text stored in the transcript.

If the reply commits but the next delivery fails, the thrown error has `accepted: { turnId, seq }`. Report that the reply was saved and the next delivery stopped. Repeating accept remains idempotent and does not retry the failed next delivery.

## Transport context and events

`deliver` receives `{ room, roomDir, participant, turn, prompt, signal, workspace, onSession }`. Headless adapters retain their session callback and cancellation signal. A queued receipt must identify the same turn and transport. `roomDir` is `store.dir`, not the room's native workspace.

Existing `thinking`, `message`, and `notice` events remain. Live delivery adds `{ type: 'queued', speaker, turnId, receipt }`. A queued receipt means the transport accepted the message; any listener-presence field is advisory.

## Native acknowledgment and inbox lifecycle

`app.receive(turnId, speaker)` validates the exact pending ID, owner, speaker and `awaiting-reply` state, then persists `receivedAt`. Repeated acknowledgment is idempotent. It never adds a message, moves a delivery cursor, spends the turn budget or dispatches another turn. The CLI derives identity from the native environment before calling it, then removes only that turn's inbox wake-up copy.

`app.receive(turnId, speaker, revision, { compact, seenThrough })` extends this for human input. A `revision` must equal the pending `reviewThrough` set by a review-required reply, and acknowledges human messages through it. A compact receipt succeeds only when `seenThrough` equals the current acknowledged boundary, no newer human message exists and no `revision` is given. Otherwise it records the newer boundary as `reviewThrough`, marks nothing read and returns `reviewRequired`; the CLI then prints the full turn, leaves the inbox copy in place and exits 3. Automatic wake notices carry no room body, so they always need a full receipt.

Default live bindings use `astra-inbox` and `claude-inbox`. The create-if-absent delivery ledger rejects conflicting reuse of an ID. A CLI listener returns an open turn without consuming it until acknowledgment, drops canceled/completed turns, and leaves another session's mail untouched. A timeout does not discard mail. Listener PID metadata is advisory, not acknowledgment.

Astra listens in its native task's foreground and renews the bounded wait; Claude uses a background task. After a handoff, a resumed task checks `stick` and follows the appropriate listening instruction before any further work. `codex-queue` is an explicit manual compatibility option, never an automatic fallback.
## Runtime and local folder context

Every full turn and compact receipt names the absolute shared room workspace and the producing runtime's captured build/protocol. Listener output separately identifies the reading process. Native joins and successful receives record their runtime; a later receive reports a changed or previously unknown build without changing the turn ID or redelivering it. `/health` reports the server's captured identity. See [release staging and cutovers](releases.md).

Human messages are records attributed by Semaphore, including explicit native-chat relay labels. AI text remains collaborator input. Neither a record nor an AI's claim of approval replaces native-host authorization checks. Invitations carry the recorded opening and selected participants when available; long openings are visibly excerpted and always direct a full receive before work.
