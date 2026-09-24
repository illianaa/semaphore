# Backend review for the three UX proposals

Prepared by Astra for Claude's design deck, 23 September 2026. These are proposals, not implemented behavior. Updated after Illiana clarified that Claude and Astra will do the engineering and the human must be able to send a message at any time. Sizing describes intended build rounds, with completion determined by validation and available native app support.

> Historical proposal review. See [the implementation and rollout](ux-implementation.md) for what shipped, including the user-controlled reply limit.

## Recommendation

Ship proposal 1, use proposal 2 as the product target, and fund a short feasibility experiment before committing to proposal 3. Preserve the user's choice of first speaker throughout. Claude owns design and the deck.

## 1. Polish the current flow

**Build: a prompt or two. Risk: low to medium, mainly turn ordering.**

Keep the current inbox transports. Improve the composer and remember the first-speaker choice per room. Add a persisted opening request that can exist before a seat joins. Show its state separately from a dispatched turn. A join can trigger the first dispatch exactly once under the existing room lock, using the request ID for deduplication.

The existing server rejects sends to an unbound seat in `assertLive()`. The core immediately dispatches after saving a human message, and `join()` only saves the binding. There is no deferred-send mechanism today. Merely enabling Send before connection would be incorrect.

For the default group start, wait for all selected members to join before sending to the chosen first speaker. Otherwise that speaker may immediately hand off to a missing seat. An explicit “start with available members” option could relax this. The ready check must use successful native binding, not a clicked launch link.

During an exchange, the human can send, not merely save a draft. Append the message to the room journal immediately with a unique client request ID, display it immediately, and preserve the current owner. Before committing an AI reply, check under the room lock for newer human messages. If any exist, return them for acknowledgment and review under the same turn before accepting a revised reply. Keep receipt revisions separate from delivery IDs so duplicate retries cannot repeat a dispatch or commit stale text. Sending does not interrupt an in-flight tool call or reverse edits. Show both saved and read states.

The latest explicit human Reply next choice overrides the agent's nomination at the next handoff, subject to pause, required human input, the four-turn cap, and recipient availability. Mid-turn messages do not reset the cap. At the cap or while delivery is unresolved, preserve the pending choice and messages for explicit continuation. A new exchange after human continuation resets the budget. Selected @mentions use this same route; ordinary quoted mentions should not silently change it.

Compact invitations can rely on the installed skill after verifying setup. Keep a complete fallback. A short invitation still needs an unambiguous room locator: an explicit root or a local connection token resolving to the exact root. Do not omit a custom root just to save text. The current invitation intentionally works without the skill installed.

Presence wording must distinguish “connected,” “waiting for acknowledgment,” and “received.” A listener PID or transport receipt does not prove the model is working. “Received your turn” is supported by the acknowledgment. A precise live “working” indicator needs an additional status signal. Taking the stick rejects subsequent stale replies but does not guarantee native work or filesystem writes stop immediately.

## 2. Start with one message

**Build: a few prompts. Risk: medium, mainly connection recovery. Fully automatic connection is conditional.**

Add an idempotent create-and-start endpoint with a client request ID. Save the room, opening message, chosen first speaker, and selected members before launching any apps. Keep a connection record for each seat: needs connection, opening, joined, needs attention. A refresh or repeated click resumes that operation rather than creating another room or dispatching the opening twice.

The transcript and composer improvements do not need new model transports. A native integration can reduce setup clicks when the host supports it. Otherwise the UI must show the remaining native Send or folder-confirmation action accurately. “Connect both” is a guided operation, not a promise of silent connection.

Use one native thread per participant per room. This matches the existing room-local binding, cursor, and pending turn. A shared native thread serving several rooms would require a multiplexer, scheduling, room-qualified acknowledgments, and context separation. A foreground listener for one room can also starve the others. It is a poor default for this stage.

Keep reply handling tied to the tuple of room ID, turn ID, speaker, native session, and binding generation. A reconnect must not let an old thread acknowledge or answer a newer binding. Existing identity checks and idempotent replies are useful foundations.

## 3. Start inside either native app

**Build: a short feasibility test, then a few prompts if native app support permits it. Risk: higher, because the host integration remains unproven.**

Use a local coordinator and plugin/MCP tools for joining, receiving, replying, and reporting state. Separate reusable app connection capability from the actual per-room native conversation. Keep one conversation per participant per room, with explicit links back to the shared room.

An MCP wrapper can remove visible shell plumbing, but MCP alone does not wake an idle chat. Native thread creation and wake-up remain separate adapter capabilities. Validate creation, first response, subsequent wake-up, host approval handling, restart recovery, and receipt identity before promising invitation-free startup.

Official Codex app-server documentation supports `thread/start` followed by `turn/start` to create a conversation and initiate generation. That establishes a custom-client capability. It does not establish that a Semaphore process may control the exact runtime of an already-open desktop chat. Never resume an open chat from a second process.

The installed CLI exposes managed daemon and proxy commands. A read-only daemon-version query found no running control socket at the default location on this machine. I did not enable or change any daemon setting. I could not substantiate `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` as a supported desktop integration contract in the fetched docs. Treat the flag as an experiment, not a product dependency or a guaranteed fix. Assess lifecycle, host compatibility, auth/approval routing, and version upgrades in the experiment.

Claude identified a possible private messaging socket. That remains an unverified collaborator observation and must not become a shipping dependency without a supported contract and testing.

Multiple rooms editing the same folder need additional coordination. The current stick is scoped to one room, so it does not serialize writes across rooms. Use a workspace write lease or separate worktrees if simultaneous editing becomes a supported feature.

## Invariants and evaluation

- Persist before dispatch and preserve the human's selected first speaker.
- Treat transport acceptance, native acknowledgment, and completed reply as different events.
- Deduplicate a retry of an already-committed operation. Freeze uncertain delivery rather than silently sending another model turn.
- Preserve bounded exchanges and human pause/recovery. A compact surface must not weaken ownership checks.
- Measure time and native confirmation count to the first shared answer, opening-message loss/duplication, and whether a new user can identify whose turn it is. These are proposed evaluation measures, not measured results.

## Evidence

- `lib/core.mjs`: `send()`, `run()`, `receive()`, `commitReply()` and recovery semantics.
- `server.mjs`: `assertLive()`, message request IDs, connection and progress view.
- `cli.mjs`: `join()` and native session validation.
- `lib/live.mjs`: binding, delivery acknowledgment, listener, and deduplication ledger.
- `lib/invite.mjs` and `lib/paths.mjs`: portable invitation and root resolution.
- `docs/LIVE-CONTRACT.md`: protocol guarantees.
- [Official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server), fetched 23 September 2026.
- Local read-only inspection: `codex app-server --help`, daemon/proxy help, and `codex app-server daemon version`.
