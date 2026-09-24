# Semaphore UX implementation

Implemented jointly by Claude (design and UI) and Astra (backend and coordination), September 24, 2026.

## Starting and joining

- The home screen starts with the actual request, selected participants and first speaker. `POST /api/rooms/start` commits these together. A request ID identifies the room, so concurrent or lost-response retries return one room and never redispatch.
- The guided start shows real native bindings. Its saved opening goes out once all selected participants join; additional thoughts can be sent during setup.
- Invitations use one line when the installed skill supports `SEMAPHORE_CONNECT_V1`, with a full-text fallback. Both preserve the executable, room and explicit root.
- From a native chat, `loop-in --as <caller> --to <other> --file <request> --request-id <id>` atomically creates the room, binds the verified caller and saves the opening with relay provenance. It returns room and invitation links. The first turn defaults to the caller for a context summary; `--first` can select the other participant. The other app still needs one invitation send.

## Human input and turn ownership

- Human input saves during live delivery, pending replies, uncertainty and setup without taking the AI's stick or resetting the exchange.
- `human-inputs.sqlite` durably accepts input while another process owns the room lock. The view includes it immediately. Core operations drain it, committing the main journal before clearing ingress; client IDs make interrupted drains safe to replay.
- Direct input and reply commit share the ingress transaction. Replies reject newer unread human input with CLI exit 3 and `receive --revision N`. The AI receives that revision and revises its reply before committing.
- The app distinguishes saved from read. Latest explicit human recipient wins at the next automatic handoff; an AI can still pause for the human.
- Each conversation has a 4 / 10 / 20 / no-limit control, including during setup. `turnLimit` persists the preference; `maxTurns` is the current exchange setting. `null` means unlimited. Changes apply to the exchange in progress. Explicit CLI `--max-turns` overrides one exchange. The AI does not alter the person's setting.
- Unknown delivery outcomes pause for review; no automatic resend or second-process resume is introduced.

## App experience

The composer stays available during AI turns, grows with text and sends with Enter. Each unconfirmed send retains its request ID. A restored draft clears once that exact request is confirmed, unless the person edited it. Restored requests preserve their recipient.

Mentions choose the next participant locally. Long messages fold with Show all, preserving expansion while polling. The status bar identifies the speaker and exchange count. Member controls honor the selected group.

Companion opens the same room in a small browser window. Optional browser notifications announce a return of the stick to the human; they do not repeat on reload. The companion is a browser window, not a native menu-bar app.

## Native integration boundary

The fully automatic native-host gate did not pass. A bounded Codex probe succeeded for first and later turns in an ephemeral custom-client thread, but desktop ownership, approvals and restart recovery remain unverified. Claude's desktop link prefills a chat; the supported external path still requires a human send. See [native integration evidence](native-integration-feasibility.md).

The supported implementation keeps both participants in their native chats with normal host approvals and listeners. No existing chat is resumed from a second process. Editing the same project from different rooms still needs separate worktrees or explicit coordination; the talking stick only coordinates one room.

## Validation

- 126 automated tests cover ownership, binding authentication, retries, interrupted drains, process locks, read receipts, startup, limit changes/persistence, native loop-in from both apps, recovery and compact invitation fallback. The SQLite startup-warning test also verifies that unrelated warnings remain visible. Tests make no model calls.
- Browser checks cover lost start response/reload/retry, lost message response reconciliation, send during setup and pending turns, 10/unlimited persistence, mentions, message expansion and companion launch/reload. Desktop and narrow layouts inspected; no page errors.
- The notification transition was checked with a browser notification stub.
- The opt-in native feasibility probe makes exactly two harmless model turns in an isolated ephemeral thread. No host settings change.
- `dev/ui-harness.mjs` runs the app with fake transports and disposable rooms. `dev/probe-codex-native.mjs` reproduces the Codex host checks.

## Local rollout

The implementation was committed as `96971cf`, fast-forwarded into `main`, and the existing Semaphore service restarted on port 4317. The installed CLI and both skill links already point to that checkout. All seven room journals matched their pre-update hashes, and the existing native turn was acknowledged by the new CLI without rebinding. `doctor` passed every check. Private journal backups are under `~/.semaphore/backups/ux-2026-09-24T16-59-23.403Z`.

The app now exposes the per-room limit control. The active test chat's setting was left at its existing default; the person chooses the preferred value. The test-only UI servers were stopped. No remote push was made.

Final cleanup includes the 18-slide proposal deck and its editable sources under `design/ux-proposals`, the sidebar label fix, and a narrowly scoped SQLite startup-warning filter. The finished `semaphore-next` worktree was removed after preserving its disposable test fixtures outside the repo; the `ux-proposals` branch remains as a history pointer.

Astra now uses an event-only foreground listener with no default five-minute timer. This removes repetitive timeout messages, but does not make the native task idle or promise zero host polling. See [Codex waiting behavior](codex-waiting.md).

Optional shared-runtime wake is enabled locally, and the first automatic native Astra turn passed. Interrupted native turns retain their queued notice and can require pressing Send. See [instant wake](instant-wake.md) for evidence and remaining rollout checks.
