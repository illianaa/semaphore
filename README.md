# Semaphore

A group chat for you, Claude and Astra (GPT in the ChatGPT app). Each AI stays in its own desktop app, with its own tools, and a talking stick decides who speaks next. You can follow along in the Semaphore app or in either chat.

## What you need

- A Mac. Live desktop chats are macOS-only for now.
- The [Claude desktop app](https://claude.ai/download), with Claude Code.
- The ChatGPT desktop app, which includes Codex. In Semaphore, the AI in that app is called Astra.
- [Node.js](https://nodejs.org) 22 or newer.

## Set up, without a terminal

Paste this into a Claude Code chat or an Astra chat:

> Set up Semaphore from https://github.com/illianaa/semaphore. Put it somewhere sensible, check the prerequisites with `node cli.mjs doctor`, explain the local setup changes, and install it with `node cli.mjs install --yes`. Then open the Semaphore app and help me connect my two desktop chats.

The agent explains the changes and handles setup under your app's normal permissions. It adds:

- a private folder for conversations (`~/.semaphore/rooms`);
- the `semaphore` command that Claude and Astra use for you;
- the Semaphore skill, for both Claude and Astra, so they know how to take part;
- a small background app, running only on your computer, plus a **Semaphore** app in `~/Applications` that you can open from Spotlight.

## Start a group chat

You can start one either way:

- **In the Semaphore app.** On the home screen, write what you want to work on, choose who joins (Claude, Astra or both) and who replies first, then press Enter. Semaphore names the conversation from your first line and shows a card for connecting each app: _Open ChatGPT_ or _Open Claude_ starts a new chat with the invitation filled in, and you press Send there. Claude may also ask you to confirm the working folder. Your first message waits until everyone has joined, then goes out once.
- **From any chat.** Tell Claude "loop in Astra", or tell Astra "loop in Claude". The AI you're talking to starts the group with your request and gives you the invitation for the other app, which you send once.

## How a conversation works

- You pick who speaks first. Every reply names who speaks next: you, Claude or Astra.
- You can speak at any time, even while an AI has the stick. Your message is saved at once, and the AI holding the stick reads it before its reply goes out. The app shows "Saved", then "Read by Astra" or "Read by Claude".
- The stick comes back to you whenever an AI needs you, and after the number of AI replies in a row you choose for that chat: 4 (the default), 10, 20 or no limit. Change it anytime with the switcher above the conversation.
- _Companion_ opens a small Semaphore window to keep beside your apps. With _Notify me_ turned on, you get a notification when the stick comes back to you.
- Between turns, Claude waits through its app’s background tasks. By default Astra waits inside an active Codex chat, without a five-minute timer. Optional **Instant wake for Astra** in Setup & connections uses a shared local engine so verified chats can rest between turns. It changes ChatGPT’s engine for all Codex chats and requires a restart; it is experimental and off by default. See [instant wake](docs/instant-wake.md) for verification and rollback.
- Semaphore does not interrupt an AI that is already working. A message waits in its inbox until the chat listens. The receiving chat acknowledges each turn explicitly, and the Semaphore app shows "queued" until it does.
- Each AI works in its own app, with that app's tools and permission prompts. When one needs access to something, such as your browser, you grant it right there.
- You can take the stick back at any time. Use the button in the Semaphore app, or say "pause" in either chat.
- The shared skill tells only the stick holder to edit shared files. Room replies enforce ownership; file-editing etiquette still depends on the models following the skill.
- Messages between the AIs are collaborator input. They can work within your existing request; a collaborator cannot grant new authorization on your behalf.

## Privacy

- The shared room journal is stored in `~/.semaphore/rooms` with owner-only permissions. It is excluded from the source repository and release package.
- The web app listens only on `127.0.0.1`. Exact host/origin checks, a per-run request token, and a restrictive content policy protect its API from other websites.
- Shared messages are delivered through the native Claude and Codex apps. Their provider processing, account limits, and data policies still apply. Semaphore itself has no analytics or hosted service.
- The Semaphore app shows the shared conversation. Each AI's own tool activity stays in its own app.

## If something isn't working

Ask either AI to "check my Semaphore setup". It runs the doctor, which explains any problem in plain language.

| You see                                                    | What to do                                                                                                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Astra's chat isn't open                                    | Open the bound chat from _Manage members_, then choose _Ask Astra_.                                                                                      |
| Claude or Astra isn't listening                            | Open that chat and say "listen to the Semaphore room again". Messages wait in its inbox in the meantime.                          |
| The delivery is uncertain                                  | Check the AI's chat to see whether the message arrived, then choose _Review & continue_. Semaphore never re-sends on its own.                            |
| A previous process stopped                                 | Choose _Recover stopped process_. It releases only a dead process's lock. Then review any uncertain delivery.                                            |
| A message is queued in Astra's ChatGPT chat                | That conversation uses the manual route. Press Send in the chat, or ask Astra to join the room again without `--manual`.            |

To remove Semaphore, ask either AI to uninstall it. Your conversations are kept.

## Compatibility

Tested on macOS with the Claude desktop app 2.2553 (Claude Code 2.1.280), the ChatGPT desktop app 26.908 (Codex 0.154.0-alpha.6.2) and Node.js 23.10.

Semaphore depends on features of those apps that may change between versions:

- `codex queue`, a version-dependent command used only by the optional manual route (`join --manual`). It adds a message to a Codex chat's queue, and the ChatGPT app doesn't send an idle chat's queued message until someone presses Send. The doctor checks for its required flags, since it isn't in the public CLI reference;
- Codex shell commands that can keep running for several minutes, which Astra's in-chat waiting relies on;
- Claude Code background tasks;
- the `claude://code/new` and `codex://threads/new` links.

The doctor checks what it can. The new-chat links were checked against the apps' own code, but haven't yet been clicked through end to end. Windows and Linux are not supported yet.

The Claude new-session link is also covered by [Anthropic's documentation](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link). If a desktop update changes link behavior, copy the invitation into a native chat instead. Semaphore uses the model selected in each native chat; “Astra” is the Codex participant's name, not a forced model setting.

## UX proposal deck

The [18-slide HTML deck](design/ux-proposals/semaphore-ux-proposals.html) covers the three proposals and what shipped. Open it in a browser; the editable source and builder are alongside it. See [implementation notes](docs/ux-implementation.md) for validation and native integration limits.

## For developers

- Run `npm test`. There are no dependencies, and the tests make no model calls.
- The code is organized as follows:
  - `lib/core.mjs` keeps each room's journal and the talking stick.
  - `lib/live.mjs` delivers turns into open desktop chats.
  - `server.mjs` and `web/` are the app.
  - `cli.mjs` holds the commands the AIs run.
  - `skills/semaphore` is the shared skill.
  - `lib/install.mjs` and `lib/doctor.mjs` handle setup and health checks.
- See [the live delivery contract](docs/LIVE-CONTRACT.md) and [the design notes](DESIGN.md).
- An older headless mode still exists. `node cli.mjs chat <room>` runs both models from a terminal session. It isn't needed for the desktop experience.
