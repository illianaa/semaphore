# Native integration: September 24, 2026

The hands-free native integration has not passed its gate. The working fallback stays inside the current desktop chats and uses their listeners, with a compact invitation for the second participant.

## Codex evidence

- Tested the app's bundled executable: `/Applications/ChatGPT.app/Contents/Resources/codex`, version `0.154.0-alpha.6.2`.
- The read-only `app-server daemon version` probe failed because the default control socket was absent. No daemon was enabled and no settings changed.
- `node dev/probe-codex-native.mjs --roundtrip` started an isolated custom-client runtime, created an ephemeral read-only thread, and received `semaphore-first` followed by `semaphore-later` from two successive turns. The probe then closed that runtime. No existing desktop thread was resumed.
- Result: custom-client creation and later turns work. This does **not** establish that the desktop owns the same runtime. Desktop creation, native approval display, and recovery after desktop restart remain unverified. The probe never requested tool execution and its client declines any approval request.
- Official [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server) describes custom clients, thread/turn APIs, event streams, and approvals. It does not establish access from Semaphore to the runtime of an already-open desktop chat. A new app-server process is therefore not a replacement for the connected native participant.

Reproducible probe: `dev/probe-codex-native.mjs`. Without `--roundtrip` it only checks version and daemon availability. The roundtrip is explicitly limited to two harmless text turns in one ephemeral thread.

## Claude evidence

Read-only inspection of Claude.app 2.7032.0 and its bundled Claude Code 2.1.280. Nothing was opened, sent or changed.

- `claude://code/new` accepts `q`/`prompt` (up to 14,336 characters) and `folder`. It only prefills a new Code chat. There is no auto-send, model or permission parameter, so creating a Claude seat costs one Enter.
- `claude://resume?session=<uuid>` imports a Code session started from the command line and opens it. It does not start a turn.
- The in-app session tools that can start a chat immediately, or deliver a message into another chat, are available only to Claude chats inside the app. The immediate start is also behind a feature flag that is off for this account. Neither is reachable from Semaphore's server or CLI.
- The only outside wake path found is an undocumented local peer channel. It needs session credentials and a live chat process, and it would present Semaphore's turns as messages from another Claude session. It is off-limits: no supported contract, and it touches credential material.
- Result: no supported way for an outside process to create a Claude chat that starts working without the person pressing Enter, or to wake an idle Claude chat. The background listener stays the wake mechanism. The untested idea of running a first turn headlessly and then importing the session is not pursued: it adds a second process to the seat's lifecycle, and its listener would not survive the import.

## Available fallback

`loop-in --as astra --to claude --file request.md --request-id <uuid>` runs from the user's current native chat. It creates the room, binds the verified caller and saves the user's opening in one commit, including `via` provenance. It returns a room link and invitation for the other participant. The caller then listens. The saved opening starts once both participants have joined.

The first turn defaults to the initiating AI, which can reply with a clearly labelled context summary before passing to the other AI. `--first claude` can send the opening straight to Claude instead. Retries preserve request identity, binding, and opening; they never repeat a dispatch. A caller already connected to a different group is directed to reuse it or open a separate native chat.

The other participant still needs to send its invitation in its app. This limitation is visible and intentional. Approvals remain in each participant's normal native host. There is no app-server transport replacing a live member, no background resume of an open chat, and no silent retry of uncertain delivery.

## Still needed

A final native end-to-end check after cutover. Claude's host findings are above; the compact companion is built (`/?view=companion`). Cross-room editing of the same project must use separate worktrees or explicit coordination; a per-room talking stick is not a cross-room write lock.
