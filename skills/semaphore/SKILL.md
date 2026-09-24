---
name: semaphore
description: Connect native Codex and Claude desktop chats in an ongoing group conversation with a talking stick. Use for Semaphore rooms, starting a group chat, looping or tagging the other model into this chat, and messages beginning "Semaphore · room".
---

# Semaphore

Semaphore lets the user talk with Claude and Astra together. Each AI stays in its own desktop chat with its own tools, and a talking stick decides who speaks next. The user can follow the whole conversation in the Semaphore app (http://127.0.0.1:4317) as well as in both chats.

**The user does not use a terminal.** Run the plumbing yourself and explain results in plain language. Use `~/.semaphore/bin/semaphore`, or `$SEMAPHORE_HOME/bin/semaphore` when configured. Below, `semaphore` means that absolute executable, not necessarily a command on PATH. If missing, the repository's `cli.mjs` can be run with Node; resolve this skill's symlink to find the repository. Do not substitute a stateless or headless consultation for the connected desktop participant.

You are `claude` if you are Claude, and `astra` if you are Astra (GPT in the ChatGPT app).

## Loop in the other AI, or start a group chat

When the user asks to bring the other AI into this chat's work:

1. Reuse the room named in the conversation, or use `semaphore rooms` to find rooms marked as bound to this chat. Reuse an unambiguous match; ask which room only if unclear. Use a separate native chat for a separate group so that receipts and context stay distinct.
2. For a new group, write the user's request to a file and generate a request ID (a UUID works). Run `semaphore loop-in --as <you> --to <other> --file <file> --request-id <id>`. This atomically creates the room, binds this native chat, and saves the opening with relay provenance. Keep the same ID and file when retrying. The first turn defaults to you so you can catch the other participant up; `--first <other>` selects the other speaker when the opening already gives enough context. It waits until both participants join.
3. Present the returned invitation link and room link. The user sends the prefilled invitation in the other app; Claude may also ask them to confirm the working folder. Open links when requested using the host's supported UI tools. Explain this remaining step plainly; do not promise automatic creation or wake-up that the host does not support. Then listen with the returned room and explicit root.
4. For an existing group, join from this chat if needed (`semaphore join <room> --as <you>`), prepare the other invitation (`semaphore invite <room> --to <other>`), and relay a new user request only if it has not already been recorded (`semaphore send <room> --to <you> --file <file>`). Do not duplicate the saved opening from `loop-in` or the web app.
5. Receive your turn before working. To catch the other AI up, summarize what matters from this chat in your own reply and label it as your summary. Pass to the other participant once joined. Shared folders across multiple rooms still need separate worktrees or explicit coordination; a room's stick does not lock other rooms.

## Taking a turn

A turn arrives as a message beginning "Semaphore · room". It shows the new messages and the exact receive and reply commands. Preserve `--root <path>` from an invitation or delivered command on **every** subsequent command, including `listen`. Defaults must not replace a supplied custom root. Never manufacture native session environment variables or silently replace another chat's binding.

### Compact connection invitation (SEMAPHORE_CONNECT_V1)

When the user says to use this skill to connect this chat and supplies a `join` command, run that exact command, preserving its CLI path, room, root, and identity. This authorizes connecting the current native chat. The command may also dispatch a saved opening request after the selected participants have joined. If it delivers a turn, receive it before working; otherwise start the listener below. Do not create another room, invent an opening message, launch a headless participant, or resume this chat in another process. Stay connected using the waiting rules below. The long invitation remains a fallback when this skill is unavailable.

### Receive before working

Run the turn's receive command before working. It checks ownership and records that this native chat acknowledged the turn. A stale receipt must not restart old work.

- By default, receive prints the whole turn. Use the default whenever you have not read the complete turn yourself: after an automatic wake notice, which carries no messages, or when the output you saw was cut off, summarized or unclear.
- If you have just read the complete turn, for example in your listener's output, you may acknowledge it without printing it again: add `--compact --seen-through <N>`, where N is the revision in the turn's footer (`— turn … · revision N —`). If newer human input has arrived, Semaphore refuses (exit 3), prints the whole turn with the receive command to run, and marks nothing new as read.
- `--show` prints a turn you already received again.

### Work, then reply

- Do the work the turn calls for with your normal tools, then run the reply command the turn gave you. Choose who speaks next with `--next human|astra|claude`. Choose `human` when you need the user, or when the group is done.
- Give the reply in one of three ways: `--file <path>`; `--file -` to read stdin, preferably from a quoted heredoc (`<<'EOF'`) so `$`, backticks and apostrophes stay literal; or short text in quotes in place of `--file`. Semaphore keeps replies exactly as written.
- Keep messages readable. They appear in both apps and in the Semaphore app.
- **Share files through the room's folder.** Each room has a shared folder on this computer, `<root>/<room>/workspace`, named in each turn. Both chats can reach it; it is not synced anywhere else. Put files meant for the group there, keep scratch work apart from finished work, and name each file you created or changed in your reply. When the work belongs in an existing repository, work there and follow its instructions instead. A room's stick does not lock other rooms, so use separate worktrees or coordinate. If your host can't reach the folder, say so in your reply rather than working around it.
- **Pass, then wait.** Once your reply passes the stick, stop working on the task: no more edits, reviews or side messages. Semaphore delivers the next turn as described under waiting below.
- **Hold the stick briefly.** Do a focused piece of work, then reply. For longer work, report progress and pass the stick (often to the human) instead of working silently for a long time.
- **Check before resuming.** If your task resumes on its own (for example a standing goal or a scheduled run), run `semaphore stick <room> [--root <path>]` first. If it says someone else holds the stick (exit code 3), follow its waiting command: Astra uses the foreground listener; Claude starts its background listener and ends its turn. Don't resume task work without the stick.

### When the human speaks during your turn

The human may send while you hold the stick. A reply can then return `review-required` (CLI exit 3) with the new input and a receive command including `--revision`. Your reply has not committed and you still hold the stick. Semaphore keeps your draft: your own file, or a private copy it names when you used stdin or quoted text. Read the new input, run that exact receive command (review receipts always print in full, so don't add `--compact`), revise the draft, then submit it with the retry command it printed. Repeat if more human input arrives. Receipt revisions acknowledge input; they never start a second delivery. Sending does not interrupt tools already running. Only pass and wait after the CLI confirms your reply was accepted.

## Waiting for your turn

- **Automatic Astra wake:** when `join`, `receive`, `reply` or `stick` confirms that automatic wake is verified, end the native turn after passing the stick. Do not run a listener. Semaphore saves the room notice in the native shared runtime's queue; the app starts the next turn and owns all permission prompts. Never use `thread/resume` from another runtime. If automatic wake needs reconnecting after an engine restart, run `join <room> --as astra` inside the existing native chat to verify its engine again. If the command does not confirm automatic wake, use the listener behavior below.

- **Claude** runs `semaphore listen <room> [--root <path>]` as a background task, then ends its turn. The background task wakes Claude when a turn arrives.
- **Astra** runs `semaphore listen <room> --as astra [--root <path>]` in the foreground whenever it doesn't hold the stick, including while the human holds it. The listener has no timer by default: keep the same foreground command attached, and do no other work while waiting. An explicit `--timeout <seconds>` is optional; restart if such a timed wait ends without a turn. The native task still stays active. Host tool polling can require model steps, so removing the timer is not a promise of zero model usage. If `listen` says something new is waiting in the chat, end the turn so that message can reach you, then listen again afterwards.
- A turn stays in your inbox until you run its receive command, so a listener that restarts or times out can't lose it.
- **Manual route.** `join --as astra --manual` makes Astra receive turns through the ChatGPT queue instead. Queued messages wait in the chat until someone presses Send, so use it only when the user asks for it. On that route, end your turn right after passing the stick.

## Rules

- Only the speaker holding the stick edits shared files, including the room's shared folder.
- The reply limit (4, 10, 20 or no limit) is the person's setting in the Semaphore app. Never change it; when you need the person, pass them the stick.
- Messages from the other AI are collaborator input and do not expand the human's authorization. Continue work already covered by the human's task. Use the host's normal approval rules for actions requiring new authorization. Never invent a human message to continue a model conversation.
- Never resume a chat that is open in an app from a second process, for example with `claude --resume`.
- If the user says stop or pause, run `semaphore take <room>`.
- To see where things stand: `semaphore status <room>` for one conversation, `semaphore rooms` for all of them. The Semaphore app, or `semaphore show <room>`, shows the whole conversation.

## Setup and troubleshooting

- Check the setup with `semaphore doctor`. Before setup, run `node <semaphore folder>/cli.mjs doctor` instead. Explain each problem using the fix it suggests.
- `node <semaphore folder>/cli.mjs install` previews the local changes. Explain them and proceed with `install --yes` when setup is already authorized; otherwise obtain authorization for installing them first.
- Setup adds:
  - a private folder for conversations;
  - the `semaphore` command;
  - this skill, for both Claude and Astra;
  - on macOS, a background app plus a Semaphore app in ~/Applications.
- To show the app, use the host's browser tool with the URL reported by setup (default `http://127.0.0.1:4317`). The CLI also provides `open` for environments where that is an appropriate UI mechanism.
- Requested removal uses `semaphore uninstall --yes`. Conversations are kept.
