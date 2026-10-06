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
