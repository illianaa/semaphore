# Semaphore

A group chat for you, Claude and GPT (the model in the ChatGPT app). Each AI stays in its own desktop app, with its own tools, and a talking stick decides who speaks next. You can follow along in the Semaphore app or in either chat.

## What you need

- A Mac. Live desktop chats are macOS-only for now.
- The [Claude desktop app](https://claude.ai/download), with Claude Code.
- The ChatGPT desktop app, which includes Codex. In Semaphore, the AI in that app is called GPT, whichever model you pick there.
- [Node.js](https://nodejs.org) 22 or newer.

## Set up, without a terminal

Paste this into a Claude Code chat or an GPT chat:

> Set up Semaphore from https://github.com/illianaa/semaphore. Put it somewhere sensible, run `npm ci --omit=dev`, check the prerequisites with `node cli.mjs doctor`, explain the local setup changes, and install it with `node cli.mjs install --yes`. Then open the Semaphore app and help me connect my two desktop chats.

The agent explains the changes and handles setup under your app's normal permissions. It adds:

- a private folder for conversations (`~/.semaphore/rooms`);
- the `semaphore` command that Claude and GPT use for you;
- the Semaphore skill, for both Claude and GPT, so they know how to take part;
- a small background app, running only on your computer, plus a **Semaphore** app in `~/Applications` that you can open from Spotlight.

## Start a group chat

You can start one either way:

- **In the Semaphore app.** On the home screen, write what you want to work on, choose who joins (Claude, GPT or both), who replies first and when they stop (_Stop after_, under the box), then press Enter. Semaphore names the conversation from your first line (the first AI may suggest a shorter name once; rename it anytime with ✎ next to the title) and shows a card for connecting each app: _Open ChatGPT_ or _Open Claude_ starts a new chat with the invitation filled in, and you press Send there. Claude may also ask you to confirm the working folder: Semaphore suggests the conversation's shared folder, and you can pick a project folder instead. Your first message waits until everyone has joined, then goes out once.
- **From any chat.** Tell Claude "loop in GPT", or tell GPT "loop in Claude". The AI you're talking to starts the group with your request and gives you the invitation for the other app, which you send once.

## How a conversation works

- You pick who speaks first. Every reply names who speaks next: you, Claude or GPT.
- You can speak at any time, even while an AI has the stick. Your message goes to the AI that is working and guides its work at the next step: Claude through its background listener, GPT through a verified Instant wake connection. The app distinguishes "Sending", "Delivered" and "Read". If live delivery is unavailable, the message stays saved and must be read before the AI can reply. A message sent through the app during a turn leaves the next speaker to the AI. To stop an AI instead, take the stick: Claude is told at its next step.
- The stick comes back to you whenever an AI needs you, and when the AIs reach the number of replies in a row you choose for that chat: 4 (the default), 10, 20 or never. Pick it when you start, and change it anytime with _Stop after_ under the message box.
- Messages support clickable web/email links, emphasis, headings, nested lists, quotes, code, and simple pipe tables. Image Markdown becomes a link; raw HTML stays text. Wide tables scroll within the message.
- Semaphore follows your computer's light or dark appearance. The button in the top-right corner switches between System, Light and Dark, and every open Semaphore window follows it.
- _Companion_ opens a small Semaphore window to keep beside your apps. With _Notify me_ turned on, you get a notification when the stick comes back to you.
- Between turns, Claude needs nothing running once Semaphore's Claude Code hooks are installed (`semaphore hooks install`, with your OK): the Claude app watches a small private file per chat, and Semaphore changes it to wake a joined chat, idle or working. The app may label these wake-ups as a hook error; they are Semaphore delivering a saved message. `semaphore hooks uninstall` removes only Semaphore's entries. Without the hooks, Claude waits through its app’s background tasks. By default GPT waits inside an active Codex chat, without a five-minute timer. Optional **Instant wake for GPT** in Setup & connections uses a shared local engine so verified chats can rest between turns. It changes ChatGPT’s engine for all Codex chats and requires a restart; it is experimental and off by default. See [instant wake](docs/instant-wake.md) for verification and rollback.
- New room turns wait for the receiving chat to acknowledge them. Guidance during an acknowledged turn arrives at a native processing boundary; it cannot stop or undo a tool that already ran. See [live interjections](docs/interjections.md) for delivery checks and fallback behavior.
- Each AI works in its own app, with that app's tools and permission prompts. When one needs your approval, such as access to your browser, the prompt appears in that app (Claude's in the Claude app, GPT's in ChatGPT), not in Semaphore, and you grant it right there. While an AI has the stick, the Semaphore app reminds you where its approvals appear.
- When Claude or GPT finishes something for you to look at, it appears in the conversation's _Deliverables_ panel: which version is ready, who reviewed it and how, and any link they report publishing. If its files change afterwards, the panel says so, and a new version starts as a draft. A web page can be opened with _Open preview_: a separate, locked-down copy of exactly that version, which you can view at desktop or phone width. Later edits never appear in it, and each link works for 30 minutes.
- You don't have to read the conversation. When Claude or GPT needs something from you — a decision, a sign-off, missing information or a review — it files a request, which waits in the amber **Needs you** tray at the top of the conversation until you answer or dismiss it. Each card says who's asking and why, offers choices when there are any, and takes a short reply. Conversations with open requests show a count in the sidebar, the window title shows the total, and with _Notify me_ on you get a notification for each new one. Your answer joins the conversation as your message. A request marked _Blocking_ comes first. Answering a request never stands in for a permission prompt in Claude's or ChatGPT's own app.
- An AI working on something longer can post a short status note, such as "Comparing the three pricing pages", which shows under whose turn it is. When one is waiting for your approval in its app, the conversation turns amber and says where to go. With _Notify me_ on, you also get a notification.
- **End conversation** in the conversation header stops the loop, rejects late replies, closes open requests and releases waiting listeners. Messages and files are kept. **Reopen conversation** returns the stick to you without restarting work; any interrupted delivery still needs review. You can also say “end this conversation” in either chat (`semaphore end <room>`). Tools already running cannot be undone.
- You can take the stick back at any time. Use the button in the Semaphore app, or say "pause" in either chat.
- Each conversation has a shared folder on your Mac, `~/.semaphore/rooms/<room>/workspace`, named in every turn. Claude and GPT put files for each other there and name them when they hand off. It isn't synced anywhere. Work on an existing project happens in that project's own folder instead.
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
| GPT's chat isn't open                                    | Open the bound chat from _Manage members_, then choose _Ask GPT_.                                                                                      |
| Claude or GPT isn't listening                            | Open that chat and say "listen to the Semaphore room again". Messages wait in its inbox in the meantime.                          |
| The delivery is uncertain                                  | Check the AI's chat to see whether the message arrived, then choose _Review & continue_. Semaphore never re-sends on its own.                            |
| A previous process stopped                                 | Choose _Recover stopped process_. It releases only a dead process's lock. Then review any uncertain delivery.                                            |
| A message is queued in GPT's ChatGPT chat                | Press Send on the notice there. This is expected on the manual route, and can also happen after a native turn is interrupted during restart.            |

To remove Semaphore, ask either AI to uninstall it. Your conversations are kept.

## Compatibility

Tested on macOS with the Claude desktop app 2.2553 (Claude Code 2.1.280), the ChatGPT desktop app 26.908 (Codex 0.154.0-alpha.6.2) and Node.js 23.10.

Semaphore depends on features of those apps that may change between versions:

- `codex queue`, a version-dependent command used only by the optional manual route (`join --manual`). It adds a message to a Codex chat's queue, and the ChatGPT app doesn't send an idle chat's queued message until someone presses Send. The doctor checks for its required flags, since it isn't in the public CLI reference;
- Codex shell commands that can keep running for several minutes, which GPT's in-chat waiting relies on;
- Claude Code background tasks;
- the `claude://code/new` and `codex://threads/new` links.

The doctor checks what it can. The new-chat links were checked against the apps' own code, but haven't yet been clicked through end to end. Windows and Linux are not supported yet.

The Claude new-session link is also covered by [Anthropic's documentation](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link). If a desktop update changes link behavior, copy the invitation into a native chat instead. Semaphore uses the model selected in each native chat; “GPT” names the ChatGPT seat, not a forced model setting. Internally that seat is stored as `astra`, and commands accept `gpt` or `astra`.

## UX proposal deck

The [18-slide HTML deck](design/ux-proposals/semaphore-ux-proposals.html) covers the three proposals and what shipped. Open it in a browser; the editable source and builder are alongside it. See [implementation notes](docs/ux-implementation.md) for validation and native integration limits.

## Credits

Semaphore's typefaces are bundled with the app, so it never fetches fonts from the internet. Both are under the SIL Open Font License 1.1:

- The interface uses [Outfit](https://github.com/Outfitio/Outfit-Fonts), © 2021 The Outfit Project Authors; see `web/fonts/Outfit-OFL.txt`.
- The wordmark uses [Jersey 10](https://github.com/scfried/soft-type-jersey), © 2023 The Soft Type Project Authors; see `web/fonts/Jersey10-OFL.txt`.

## For developers

- Run `npm ci`, then `npm test`. Instant wake uses `ws`; the ordinary CLI and app still start without it. The tests make no model calls.
- `node cli.mjs version` reports the running process's captured build and protocol. See [release staging and cutovers](docs/releases.md) before changing a running installation.
- The code is organized as follows:
  - `lib/core.mjs` keeps each room's journal and the talking stick.
  - `lib/live.mjs` delivers turns into open desktop chats.
  - `server.mjs` and `web/` are the app.
  - `cli.mjs` holds the commands the AIs run. `receive` acknowledges a turn and prints it in full; `--compact --seen-through <N>` skips the reprint only for that exact revision with no newer human input. `reply` takes `--file <path>`, `--file -` for stdin, or short quoted text, and keeps the text exactly as written. `node cli.mjs help` lists everything.
  - `skills/semaphore` is the shared skill.
  - `lib/install.mjs` and `lib/doctor.mjs` handle setup and health checks.
- See [the live delivery contract](docs/LIVE-CONTRACT.md) and [the design notes](DESIGN.md).
- An older headless mode still exists. `node cli.mjs chat <room>` runs both models from a terminal session. It isn't needed for the desktop experience.
