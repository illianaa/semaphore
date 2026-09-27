# Speaking while an AI works, 27 September 2026

Illiana: “if I send a reply while the current agent is working, it should be treated as an immediate interruption to whichever agent is currently working. When I interject, usually I'm sending a crucial tidbit of information that will guide your current work.”

Through 0.10, a message sent during a turn was saved at once but reached the AI only when it tried to reply: the reply check refused the reply until the AI had read it. The message also chose who spoke *after* that AI, which once bounced Claude's handoff back to Claude. Claude built the shared behaviour and Claude's route; Astra added GPT steering. These changes are live in 0.11.0.

## Behaviour (both AIs)

- **Guidance, not routing.** Input during a turn is for the AI at work. The web composer sends it to that AI and names it (“To Claude”) instead of offering a choice. In core, input naming the AI at work, or the opening's first speaker while the opening waits, leaves the handoff to that AI and clears any earlier routing. Only input naming the *other* AI (possible from the CLI or API) still routes the stick there after the reply. The latest input decides. The turn, the reply limit and the receive/revision checks are unchanged.
- **The reply check stays as the fallback.** However input arrives, a reply is refused until the AI has received every newer human message.

## Claude: at its next step

Claude's background listener now keeps running through Claude's own turn.
- **New input.** When the human writes, the listener sets the turn's review revision (as a reply attempt would, marking nothing read), prints only the new input with `receive … --revision N`, and finishes. Claude's app reports a finished background task to the working chat at its next step, between tool calls. Claude then receives the revision, starts the listener again and applies the input.
- **Taking the stick back.** If the human takes the stick mid-turn, the listener says so. Claude should stop working on that turn and not reply to it.
- **Handing off.** When Claude's own reply passes the stick, the listener doesn't finish; it waits for Claude's next turn. That avoids a spurious wake-up.

The skill, envelopes and invitation now say: start the listener after joining, right after each receive, and whenever it finishes.

**Evidence, in the Claude desktop app itself.**
1. A plain background task that finished during a 12-second foreground command was reported right after that command, inside the same turn.
2. In a disposable room with its own root, this chat joined as Claude, and a terminal played the human:
   - input sent during Claude's work was reported at Claude's next step, and the notice held only the new message;
   - after `receive --revision 2` and a restarted listener, Claude's reply to the human did not end the listener;
   - the next turn woke it normally;
   - taking the stick mid-turn produced the stop notice.

The room and its listeners were removed afterwards.

**Limits.**
- It arrives at the next step, not mid-tool: a long-running command delays it, and tools that already ran are not undone.
- It needs the listener running. A chat that didn't restart it falls back to the reply check, and the app then says “Saved · Claude will read this before replying”.

## The app

- **The composer** during a turn reads “To Claude” (or “To GPT”). The hint says whether the message reaches the AI now (“at its next step”) or before its reply.
- **Message status.** Under the message: “Sending to Claude…”, then “Delivered to Claude · reading it at its next step” (the room view's `pending.deliveredThrough`, from the listener's review revision), then “Read by Claude”. GPT's delivery indicator instead requires a successful native steering response or a matching native history receipt. Preparing a review revision alone never marks GPT input delivered.
- **GPT availability.** The next-step hint requires a fresh pump inspection of the exact received native turn, in the verified loaded runtime. An ended/replaced native turn, uncertain send, missing binding or stale runtime snapshot uses the saved-before-reply wording.

## GPT: guidance inside the current native turn

`lib/steering.mjs` uses the installed app-server's [`turn/steer`](https://developers.openai.com/codex/app-server#steer-an-active-turn). It runs through the existing wake pump and never starts or resumes a native turn.

1. After an authenticated native `receive`, the CLI inspects the newest native turn. An `inProgress` turn binds the room's work to that exact thread, turn and verified runtime process. Join, reply, or a background observer cannot rebind it to whichever turn happens to be active later. A failure to inspect disables steering while leaving ordinary wake available.
2. While that same room/native turn is still active, the pump drains saved input and prepares its review revision. It saves a batch intent before calling `turn/steer`, with `expectedTurnId` and a stable `clientUserMessageId`.
3. The short notice tells GPT to run the exact revision receipt before its next work step. The receipt supplies the human message and authorization context. The notice itself carries no new authorization. Only `receive` marks input read.
4. A second batch waits until the first is explicitly received, preventing newer input from invalidating an in-flight receipt revision. Input saved while the room lock is held remains in the durable ingress journal.
5. A timeout/disconnect is uncertain, never permission to retry. Native history can confirm the exact batch's client ID in its exact turn; absence cannot disprove acceptance. The reply check remains the fallback. A stale/ended native turn is never replaced by starting or steering a different turn.

**Installed-runtime evidence.** `dev/probe-codex-steer.mjs --run` ran one disposable native turn on a private Unix socket using `codex-cli 0.155.0-alpha.16.4`. It did not attach to the desktop socket, resume any existing chat, change desktop settings, or restart the live engine. The probe archived its test thread and stopped its own process. The [saved report](steering-probe-2026-09-27.json) records:

- A second, unsubscribed client could inspect the active native turn and steer it while an approval was pending.
- A wrong expected turn was rejected. The same native turn applied the new guidance after the viewing client declined the harmless test command. There was exactly one native turn, with the expected final response.
- The approval request reached the viewing client only; the steering client received no approval requests and answered none.
- **Client IDs do not deduplicate steering.** Sending the same ID twice created two user messages. The production path therefore saves intent and never retries a batch.
- Accepted messages were absent from history while approval was pending and appeared after processing. Reconciliation must tolerate delayed visibility.
- Steering the completed turn returned “no active turn to steer”.

**Limits.** Delivery happens at a native processing boundary, including after a pending approval or a long tool call. It does not abort or undo tools. Manual/foreground GPT connections retain the before-reply fallback. GPT take-back notifications are not added here; Claude's listener has that separate behavior. The released native binding and live steering availability were verified in Astra's existing chat. An actual human interjection during work is still needed for full desktop end-to-end acceptance; the isolated protocol probe and local integration tests are complete.

## Tests

Validation: the full suite passed 198 tests after steering landed. After adding the API-status test and avoiding idle room rewrites, the affected suites passed all 35 tests (the suite now contains 199 tests). Syntax checks and `git diff --check` passed. Astra added steering and API status coverage:

- Durable intent before send; one batch per receipt; exact native-turn binding.
- Response loss before and after acceptance, delayed history visibility, and crash after intent.
- Native turn ending during the request, replaced runtime/chat, missing binding and human take-back.
- Fresh/stale capability reporting and API delivery status separated from review preparation.
- Existing reply barrier, turn ownership, budget and approval isolation remain in force.
- **Core.**
  - Guidance versus routing, including queued input and the opening.
  - `revealInput`: nothing before receipt; shown revision; idempotent; only the working chat; the reply check until received.
  - Three older tests now route with the other AI, where they had named the holder.
- **CLI, with real background processes.**
  - The listener finishes with only the new input, then lets Claude's own handoff pass and returns the next turn.
  - It reports a take-back.
  - Astra's foreground listener still returns guidance at once while Astra works.

## Joint review, 27 September (Claude, of the GPT route)

**Approved, with one fix.**
- **Native-turn binding.** It is only made by an authenticated receive inside the chat, and it is checked against the engine's process, start time and socket, the loaded thread and the stick on every tick.
- **Intent before sending.** Intent is saved before `turn/steer`, and a batch is never resent (the probe showed `clientUserMessageId` doesn't deduplicate). Only exact-turn history can confirm an uncertain send.
- **One outstanding batch per receive.** That keeps the delivered revision from going stale.
- **Delivered versus read.** "Delivered" means the working chat was handed the notice: for Claude, its listener printed it; for GPT, the engine accepted the steer. "Read" comes only from `receive --revision`. The two routes agree.
- **The fix.** The pump cleared its steering snapshot at the start of every 1.5-second tick and refilled it room by room. The app reads that snapshot between the tick's awaits, so its hint and message status could flicker back to the before-reply wording while a tick ran. The pump now builds the snapshot during the tick and swaps it in at the end. A room skipped because another process holds its lock keeps its last answer, which `canSteer` still checks against the room's current turn. The new test pauses a tick mid-inspection; it fails on the old code and passes now.
- **Tests.** 200 pass. Released as 0.11.0.

### Availability expiry follow-up (Astra)

The atomic snapshot fixes the flicker, but retaining a room's answer across `ROOM_LOCKED` must also retain its original inspection time. Otherwise repeated successful engine checks renew the global snapshot age while that room's native turn is never rechecked. A long lock could leave the next-step hint on after the native turn ended.

Each room's cached answer now includes its own inspection timestamp. Short locks keep the hint steady; after the existing freshness window (10 seconds at the default interval), the hint falls back until inspection succeeds again. This changes availability reporting only, not delivery or receipts. A regression test proved the old behavior failed and the fix passed. All 22 steering/wake-delivery tests pass; this follow-up awaits Claude's review and the next release.
