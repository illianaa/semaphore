# Human attention: asks and ending a conversation (proposal, 6 October 2026)

Branch `human-attention` in `~/Projects/playground/semaphore-attention`. Items 1–3 of the person's request are done (Wake Claude, GPT naming, remembered Stop after). This note proposes items 4 and 5. Both are open for revision; the AIs are the users of item 4.

## Item 4: asks ("Needs you")

The person doesn't read every message. When busy they don't skim the chat at all. A question buried in a reply may never be seen, so anything an AI needs from the person is filed as an **ask**: a small structured record that the app shows apart from the transcript until the person answers it or the AI withdraws it.

### Data

`room.asks[]`, saved in the room journal under the room lock:

```json
{
  "id": "uuid",
  "from": "claude",
  "turnId": "the turn it was filed in",
  "kind": "decision | approval | info | review",
  "title": "One self-contained line, ≤ 160 chars, readable with no context",
  "detail": "Optional Markdown, ≤ 2,000 chars: background, trade-offs, a link to a deliverable",
  "options": ["Optional", "choices", "≤ 6, each ≤ 80 chars"],
  "blocking": true,
  "status": "open | answered | withdrawn | closed",
  "createdAt": "…", "answeredAt": "…", "answer": { "text": "…", "option": 1, "seq": 42 },
  "withdrawnAt": "…", "reason": "…"
}
```

- `blocking: true` means "we can't continue without this". The app sorts and colors those first.
- At most 5 open asks per AI per room, so a flood stays readable.
- `closed` is set when the conversation ends (item 5).

### CLI (the AIs' side)

Asks need the received turn, like `note`, so only the stick holder files them:

```
semaphore ask <room> --turn <id> [--kind decision|approval|info|review] [--blocking]
    [--option "<choice>"]… [--file <detail.md>] "<title>"
semaphore ask <room> list                                  # JSON, open first
semaphore ask <room> withdraw --turn <id> --id <ask> ["<reason>"]
```

Filing an ask never sends a message or passes the stick. Usually the AI files it and then passes to `human`, but it may also keep working on something else and let the ask wait.

### Answering (the person's side)

`POST /api/rooms/<room>/asks/<id>/answer {option?, text?, clientId}` appends one human message, quoting the ask, for example:

> **Answer to Claude:** “Which database for the prototype?” → **SQLite**. Keep it single-file.

The message carries `answers: <ask id>` and is addressed to the AI that asked. If the person holds the stick, it goes to that AI like any message. If an AI holds it, it's an interjection read at that AI's next step (the existing path). `POST …/asks/<id>/dismiss` closes an ask without an answer and tells the asker at its next turn.

### App

- A **Needs you** tray pinned above the transcript, amber like the approval banner. One card per open ask: avatar, kind tag, the title in large type, a collapsible detail, option buttons, a one-line reply field and *Dismiss*. Blocking asks first.
- The stick banner, when the person holds the stick with open asks, says “Your turn · 2 things need you” and focuses the tray.
- Sidebar: a count badge on each room with open asks, and a *Needs you* row at the top listing every open ask across conversations.
- Companion window: open asks, all rooms.
- *Notify me*: a notification per new ask. Tab title: `(2) Semaphore`.

### Guidance to the AIs

Added to the skill, the invitation and every turn envelope's footer (one line there):

> The person doesn't read every message; when busy they don't skim at all. If you need anything from them — a decision, an approval, missing information, a review — file it with `semaphore ask`. That's the only thing guaranteed to reach them. Make the title readable with no context, offer options when you can, mark it `--blocking` only if work can't continue, withdraw asks that no longer apply, and don't ask the person what the other AI can answer.

## Item 5: end a conversation

*Take the stick* pauses; it doesn't stop a project. GPT's foreground listener keeps its Codex task active, and a standing goal can resume. **End conversation** stops the loop for good until the person reopens it.

- `Semaphore.end()` takes the stick (the pending turn becomes uncertain, so a late reply is rejected), sets `room.ended = { at, by: "human" }`, closes open asks, clears the status note and records an `ended` event.
- Every AI-facing command refuses work in an ended room with one clear line: `receive`, `reply`, `note`, `ask`, `artifact add`. `stick` exits 3 with “The person ended this conversation. Stop working on it and end your turn.” `listen` returns at once with the same text (its existing `stopWhen`), so GPT's foreground wait ends. The Claude hook sends a one-time “ended” notice to a chat that had received its turn, like take-back.
- Human messages, pass and opening are refused until reopened.
- `Semaphore.reopen()` clears `ended`; the person holds the stick. An uncertain turn from before the end still needs *Review & continue*.
- App: *End conversation…* in the conversation header, with a confirmation. An ended room shows a calm grey banner (“You ended this conversation”), replaces the composer with *Reopen*, and moves to an *Ended* group at the bottom of the sidebar.
- CLI: `semaphore end <room>` and `semaphore reopen <room>` for the person, so “stop the project” said in either chat works. The skill: “If the person says to end or stop the conversation for good, run `semaphore end <room>`.”

## GPT review and implementation (6 October 2026)

Item 5 is implemented on this branch. `end` is idempotent, retains an interrupted turn as uncertain, closes open asks, and blocks work until explicit reopening and recovery. The app has an End conversation confirmation, an ended sidebar group/banner, and a Reopen composer. Both inbox listeners exit. Claude's hook delivers a one-time stop notice; verified GPT native work receives one durable `turn/steer` stop notice into the exact turn authenticated by `receive`. No native chat is resumed or started to stop it. Ambiguous steering is not retried. The existing wake pump removes obsolete queued wakes. Already running tools cannot be undone, and a disconnected native app may not receive a stop notice until it reconnects/checks the room.

Feedback for item 4:

- Keep the persistent tray, cross-room count and self-contained question/choices. Include what is blocked and a recommended answer in the detail when useful. A collapsed question must still tell the person what response is needed.
- Use “visible until resolved” instead of promising a guaranteed response/delivery: the person may ignore it, notifications may be disabled, and native app approval cannot be supplied by another AI or by answering a Semaphore ask. An approval card should name the native app and provide its existing chat link when possible.
- Add a caller-provided request ID or idempotency key to `ask`: a CLI retry after a lost response must not create duplicate cards/notifications. Permit updating or withdrawing an existing ask rather than filing a replacement.
- Make answer/dismiss atomic and idempotent with the human message. Reject answers to closed/withdrawn asks, including after end/reopen; do not silently reopen them. Dismissal is not approval and doesn't satisfy a blocking dependency.
- Answer routing needs care when the other AI holds the stick. The current interjection path goes to the working AI and only nominates a future recipient. Preserve the answer in the transcript and ensure the asker receives it on its next valid turn; never steal the current turn or promise immediate delivery to the asker. A blocking ask should normally pass to human.
- A separate all-asks sidebar page may wait; a persistent tray plus room badges and companion display covers the immediate need. Keep limits and defaults small. Document whether `--blocking` only prioritizes a card or actively gates dispatch; don't imply a gate without enforcing it.

The GPT display names and compact invitations read correctly. Real CLI integration tests exercise `--as gpt`, `--to gpt`, aliases, and preserved `astra` storage. The installed release stays unchanged while this branch is reviewed.

## Item 4 as built (Claude, 6 October 2026)

Built on this branch with GPT's feedback folded in.

- **Data.** `room.asks[]` (`lib/asks.mjs`, `Semaphore.fileAsk/withdrawAsk/dismissAsk/answerAsk`), saved under the room lock. Statuses: `open`, `answered`, `dismissed`, `withdrawn`, `closed` (by End). Each resolution records `resolvedAt` and `resolvedThrough` (the message count), so the asker's next envelope can report it once.
- **Idempotent filing.** Every ask has a `requestId`: `--request-id` when given, otherwise derived from turn, speaker and title. A retry with the same fields returns the existing ask; the same ID with different fields is refused and points to `--id <ask>`, which updates an open ask in place. Five open asks per AI.
- **Answering.** `POST /api/rooms/<room>/asks/<id>/answer {option?, text?, clientId}` resolves the ask and appends one human message quoting it (`answers: <id>`) in the same save. A retry with the same `clientId` is a no-op. When the person holds the stick, the message goes to the asker and starts its turn. While an AI holds the stick, it is an ordinary interjection addressed to that AI, so it never sets `replyNext` or takes the turn; the asker reads it in the transcript on its next turn. Answers to non-open asks are refused, including after End and Reopen.
- **Dismissing.** `POST …/dismiss` closes an ask without a message. It isn't an answer or an approval, and the asker's next envelope lists it under “Closed without an answer”.
- **Blocking.** `--blocking` only sorts and marks the card. Nothing gates dispatch; the skill says to pass to `human` when work can't continue.
- **Approval kind.** The card says a permission prompt still appears in the asker's own app. Answering is a reply in the room, never a native approval.
- **Guidance.** The skill has a *What you need from the person* section, every turn envelope carries one line plus the exact `ask` command and the asker's open/closed asks, and the full invitation says the person doesn't read every message. Wording is “stays visible until resolved”, never a guaranteed response.
- **App.** An amber *Needs you* tray under the stick banner (blocking first, choices as buttons, a reply field, Dismiss with confirmation, foldable per conversation until a new ask arrives, drafts kept through polling), a count badge per conversation in the sidebar, `(n)` in the window title, a notification per new ask with *Notify me*, and “Your turn · n requests need you below” in the banner. The tray scrolls within the conversation's height so it never covers the composer. A cross-room page is left for later, as GPT suggested.

## Final GPT review — 0.13.0 candidate

All five improvements are implemented, including End in the companion top bar. Review found and fixed four backend cases: answering preserves a previous human handoff choice; answer/dismiss require the exact displayed request revision so changed choices cannot reinterpret a click; a retried answer with conflicting content is rejected; and mid-turn dismissal remains visible until the asker receives its closure notice, independent of the transcript message cursor. The answer/dismiss HTTP bodies now include `revision` from the open-request view.

Keyboard Enter in a request's text box sends only the written answer rather than implicitly clicking its first option. An isolated 420×760 companion check also exposed stacked connection/status/request panels covering the composer; the complete stack now scrolls within the message area. Verified the simulated registered-Claude Wake button and resulting check-in status, and a free-text answer with no implicit option. No live chat was woken for this UI check.

The full suite passed all 240 tests after the backend and keyboard fixes. The final layout fix was checked in the browser. Version metadata is prepared as 0.13.0; staging and smoke checks use isolated data and do not activate it. Installation remains the pending human decision because it restarts Semaphore's background app for open conversations.

## Blocked-agent safeguards — follow-up approved 7 October 2026

The person answered the Needs you request with **Add all three safeguards**. GPT implemented the reporting rule and quiet-holder alerts; Claude's bounded pre-exit reminder remains the next implementation step.

- **Report and pass.** The skill and full received-turn envelope require an agent that cannot make useful progress to report the blocked action and actual reason, file a blocking request with the person's next step, and reply to `human` before ending its native turn. A note or a native-chat explanation alone is insufficient. Native permission issues use an information request to visit the named app; the room does not replace host approvals. If Semaphore itself is unavailable, report that failure in the native chat without claiming a handoff succeeded.
- **Quiet holder.** After five minutes without a reply or fresh status note on a received turn, either agent gets an amber “has gone quiet” banner, a sidebar subtitle, and recovery controls. GPT exposes Open chat; registered Claude exposes Wake Claude. Both expose Take the stick. Copy explains that work may still be running. Fresh notes and explicit Claude wake requests give a new five-minute grace; approval notes keep their distinct banner. Ended, taken, queued, delivering, uncertain and stale-lock states do not count as quiet received turns.
- **Notifications.** With browser notification permission already granted, background pages notify once per quiet turn. The room/turn marker is stored locally, shared by same-origin windows and retained across reloads; an in-memory fallback prevents repeated alerts when browser storage is unavailable. Notification API failures do not break polling and remain eligible for retry. This is a browser notification, so the page must be running and the OS must allow notifications; no new permission is requested automatically.
- **Verification.** All 246 tests pass. The skill validator passes. An isolated harness with a fake registered Claude session verified the 420×760 companion: dark Claude warning, Wake Claude clearing it, light GPT warning and its Open chat link. No live participant was woken. Notification timing/deduplication/error behavior is covered by unit tests; an actual OS notification was not requested during the browser check.

`dev/ui-harness.mjs 4334 --attention` adds the quiet fixtures when run with a fresh temporary `SEMAPHORE_HOME`. It refuses the default data home; its Claude pump is a no-op. The previews are saved in this room's shared workspace as `quiet-claude-companion.jpg` and `quiet-gpt-companion.jpg`.

## Safeguard 2 as built (Claude, 7 October 2026)

A Claude Code `Stop` hook (`semaphore hook stop`, `lib/claude-wake.mjs` `stopCheck`) blocks a registered Claude chat from ending its native turn once per turn while it holds a received, unanswered room turn. The reminder lists the reply, blocking-request and note commands. It is claimed under the room lock, never replies or passes for the chat, and fails open. See [Claude event delivery](claude-event-delivery.md#stop-check-no-silent-stop-while-holding-a-turn-october-2026) for the contract, bounds and evidence. Activating it needs `semaphore hooks install` after the release, which edits `~/.claude/settings.json` with a backup. That is a separate approval from the release itself.

## Reading long requests (Claude, 8 October 2026)

A user working in the main desktop window reported that long requests couldn't be read in full. They had to go back to the source chat to see what was being asked.

**Audit** (dev harness, 1280×800, worst-case request: 152-character title, 1,835 characters of Markdown, six options of about 76 characters each):
- The whole message area is about 385 px tall, and the Needs you stack (banner plus cards) scrolled inside about 370 px.
- The long card was about 450 px collapsed and about 1,100 px with "Details" open, so about five lines of detail were visible at a time.
- The question and choices scrolled away while reading, and the stick banner scrolled away with the cards.
- Screenshots: `workspace/needs-you-audit/before-*.jpg` in this room.

**Design review.** Three sub-agent critics reviewed the proposal before it was built (product/UX, visual design, accessibility/robustness), and a fourth reviewed the build. They agreed on these points:
- a modal reader, not the Deliverables popover, which shares the same cramped height and closes on any outside click;
- no options pinned in the footer, which would recreate the cramped problem inside the reader;
- detail and answer side by side on wide windows;
- one answer model everywhere (pick, then send);
- a summary card for long requests;
- the reader kept outside the tray, which re-renders every poll;
- no silent swap when an AI updates a request.

**As built** (`web/requests.mjs`, `web/app.js`, `web/styles.css`, `#ask-reader` in `web/index.html`):
- **Long requests** have more than 60 words of detail, more than three options, or any option over 32 characters. They show a summary card:
  - the title (a button, clamped to 3 lines);
  - a 3-line plain-text preview of the first prose paragraph, never a heading, table or code;
  - **Read & answer**;
  - "281 words · 6 options";
  - "Answer not sent" while a draft or choice exists;
  - Dismiss.
- **Short requests** answer in the card with radio choices: pick, then send. Enter in the note sends; Safari's IME keyCode 229 is ignored.
- **The tray** keeps the stick banner and its header pinned; only the request list scrolls, with a fade when more sits below. Its header offers *Review all (n)*.
- **The reader** is a native modal `<dialog>`:
  - head: Needs you · n of N, ‹ › pager, ×, the full title, and a notice region;
  - at 1000 px and wider: the detail on the left (15 px/1.7, 70ch) and the answer on the right (option rows numbered 1–9, Clear choice, a growing note);
  - narrower windows and the companion: one scroll;
  - footer: "Answer: …" (or "Pick an answer ↓"), Dismiss request, Send answer;
  - long requests get the full height; short ones size to fit.
- **Keyboard and focus.** Keys 1–9 pick an option, and Cmd/Ctrl+Enter sends. Focus opens on the detail region and returns to the card on close. Esc closes and keeps the draft and choice.
- **Live updates.**
  - A request changed by its AI: the reader keeps the text the person is reading, blocks Send and offers *Show the new version*, which clears the choice (the options may have shifted) and keeps the note.
  - A request answered, withdrawn or dismissed elsewhere: Send is disabled and the note stays to copy.
  - Switching rooms or going home closes the reader.
- **After sending.** Sending or dismissing moves to the next open request ("Answer sent to Claude. Next request:"), or closes the reader and confirms.
- **Writing guidance.** The skill now asks for titles of about 100 characters, a first detail sentence "What's blocked: …", then the recommendation, and short option labels (about 40 characters) explained in the detail.

**Checked** in the harness at 1280×800 and 420×760 companion, dark and light:
- the summary card, short-card answering and the pager;
- send moving to the next request;
- the revision notice and *Show the new version*;
- focus return and Esc;
- the Dismiss confirmation stacking over the reader (with a real click; Chrome groups Esc for script-opened dialogs).

Screenshots: `after-*.jpg`. Safari wasn't run here.

### GPT review (8 October 2026)

Two additional independent critics reviewed the reader's usability and answer lifecycle. Their findings were fixed before release:

- Empty or cleared choice storage no longer creates a false “changed request” warning or blocks a note-only answer. A regression test covers absent, cleared, malformed, current and stale saved choices.
- A delayed answer or dismissal cannot replace a different request, a reopened reader or its stale-version warning. Each filled reader has a generation; only its own response can advance it.
- Answer fields are locked while their submission is pending. A failed submission unlocks the current view even if the request was closed and reopened while waiting, and preserves the draft.
- Paging resets every scroll region. If multiple requests disappear, the pager still reaches the remaining requests.
- Long unbroken option labels wrap inside both inline cards and the reader.

The correctness critic rechecked the fixes with isolated delayed-response mocks, including reopened-reader failure and stale-reader restrictions. In the isolated browser harness, GPT verified the long detail reaches its final paragraph at 1280×800 with Send visible, the 760×800 single-column reader reaches its answer and returns to scroll position zero on paging, and a short card submits a note without an option or false revision warning. The reviewed desktop screenshot is `workspace/needs-you-audit/gpt-reader-reviewed-1280x800.jpg` in this room. No live conversation was answered or woken in these checks. Safari remains untested.

All 267 tests pass, along with the JavaScript syntax check, diff whitespace check and skill validator.

The human subsequently requested fewer false asleep warnings and cross-conversation recovery indicators. These are the next coordinated change before the combined release; the installed app remains 0.14.2.

## Alerts that need the person, on evidence only (Claude, 8 October 2026)

The person reported that the "has gone quiet / might be asleep" alert had been wrong every time. They also asked for a sidebar alert when another conversation is waiting on them to wake an AI.

**Cause.** `quietTurn()` fired when a turn had been *received* and five minutes passed without a reply or note. A received turn means the AI is working in its chat, and silence there is normal. It drove the amber banner, the sidebar subtitle, the member description, Claude's Open chat offer and an OS notification.

**Rule.** `lib/attention.mjs`, computed in the server view, is the one source of truth. The banner, sidebar row, sidebar toggle and notifications all read `room.attention`. Two critics reviewed the design (false alarms; sidebar UX) and a third reviewed the build.

- **No silence-based alerts.** A received turn with no evidence never alerts. After 20 minutes the banner says "working in the Claude app · no update for 25 min" in plain text, with no colour and no notification.
- **Evidence, held for a grace period.** The grace is timed from when this server first saw the reason for this room and turn, not from when the turn was queued. One calm snapshot resets it, and a restarted app starts calm.
  - **Approval** (no grace): a current `--approval` note, retained until the agent replaces/clears it or the room turn ends. Native stop/idle is not an answer.
  - **GPT, turn not received yet.** None of these fires if the chat already has the notice, its listener is running, or it replied in the last 90 s.
    - The engine reports the chat `unloaded` (45 s): "Open GPT to continue".
    - `reconnect` (60 s): "Reconnect GPT's chat".
    - Manual transport or `needs-send` (30 s): "Press Send in ChatGPT".
    - Wake delivery `uncertain` (2 min): "Check GPT's chat".
    - Wake off with no listener (60 s): "Open GPT to continue".
    - Engine `unavailable` (3 min): "Check ChatGPT is open".
  - **GPT, turn received.**
    - The chat is unloaded (45 s), or `reconnect` with a native-bound turn (60 s).
    - **GPT stopped:** the wake engine inspected the exact bound chat, and no native turn is running at all (90 s). A new turn the person started there doesn't count, and a missing or stale snapshot is not evidence.
  - **Claude, turn not received yet.**
    - Hooked: alerts only if the hook hasn't claimed or observed the turn since it last needed delivering (when queued, after an Open chat or Wake request, or after the chat restarted following a claim). Grace 2 min: "Open Claude to continue". A delivered turn is calm even if Claude is busy for a long time.
    - Without hooks: no listener (60 s).
  - **Claude stopped** (60 s): the Stop hook reminded the chat once, and it stopped anyway. This doesn't apply if Claude posted any status note this turn, or took a notice/check-in or native prompt after the stop.
- **Self-healing restarts.** `semaphore hook register` records `startedAt` on SessionStart `startup` or `resume`, but not `clear`, `compact` or a missing source. A notice claimed before a restart is offered again once: the turn if it wasn't received, a check-in if it was. A lost notice therefore recovers without the person.

**App.**
- **Sidebar rows:** one indicator per row (request count, then an amber dot, then the green reply dot). The action label replaces the subtitle in amber text, with a screen-reader description. Rows never move, and the mark clears as soon as the state does; there is no "mark as read".
- **Sidebar toggle:** an 8 px amber dot while the sidebar is hidden and *another* conversation needs the person. Its accessible name says how many, and its tooltip lists them.
- **Notifications:** one per room, turn and reason, with *Notify me* on and the app in the background.
- **Banner:** the label, its explanation and the action (Open chat ↗ or Check setup).

**Evidence of correctness.**
- Unit tests for every reason and the calm cases: an hour of silence, a listener gap, a chat that already has the notice, a just-replied AI, a note this turn, activity after a stop.
- Debounce tests: grace timed from first sighting, and a reset on a calm snapshot.
- Restart-replay tests: once per restart, not on compaction.
- The isolated harness at 1280×800, with graces off for preview, showed:
  - the sidebar labels;
  - the toggle dot and its label "Show sidebar, 3 conversations need you";
  - the Open GPT banner;
  - calm "went quiet" rooms (received, with an 8-minute-old note).

Screenshots: `needs-you-audit/attention-*.jpg`. Not exercised live: a real ChatGPT unload, and a real Claude restart replay.

### Final GPT review

The additional correctness critic identified three cases, fixed before staging:

- A room lock could keep an old GPT idle observation fresh while global engine polling continued. Idle records now carry their own inspection time, which a lock cannot renew. The regression test resumes native work while the room is locked, expires its old evidence, then verifies a fresh active inspection clears it.
- A manual message in an already-open Claude chat could leave its old stopped warning visible. A fifth installed hook, `UserPromptSubmit → semaphore hook activity`, records only an activity timestamp for an already-registered session. It stores no prompt, emits no context or decision, and never starts or resumes a model. A prompt after the stop clears the warning; a later stop can alert again. Existing SessionStart/CwdChanged registration preserves this timestamp. The [official hook contract](https://code.claude.com/docs/en/hooks#userpromptsubmit) also covers native background continuations. Hook settings migration preserves other prompt hooks and unrelated settings and is idempotent.
- Native stopping or going idle no longer dismisses an explicit approval note. Approval stays actionable until explicitly cleared/replaced or the room turn ends.

The desktop browser review at 1280×800 verified an amber Open GPT row and banner, calm received turns with old notes, and the collapsed sidebar's accessible dot/count for other conversations. Screenshots: `needs-you-audit/gpt-attention-sidebar-reviewed.jpg` and `gpt-attention-toggle-reviewed.jpg`. The preview uses isolated data and zero alert grace; production grace periods are covered by tests. All 278 tests pass; syntax, whitespace and skill validation pass. The critic independently checked the three fixes, silent activity CLI behavior, hook ownership and four-to-five-hook migration. Real OS notifications, unload/restart behavior and the new prompt hook still need ordinary native-use observation.
