# Plan: room FB01B0 field report

Source: `~/.semaphore/rooms/room-fb01b0fe007f54ed5e0efdcd/workspace/semaphore-field-report.md`, written by Claude and Astra on 24 September 2026. Illiana asked Claude to plan it and both of us to build it.

Work happens in the `semaphore-field` worktree (branch `field-report`), away from the live runtime the report warns about (S4). Reviewed cutovers stage immutable releases and restart only the app service at the batch boundaries below. The old checkout and separate Codex wake engine stay untouched. `node_modules` there is a local symlink to the main checkout's install; it is excluded locally and must not be committed.

Owners follow the usual split: Claude takes the web UI, copy, skill, README and visual QA; Astra takes the core, CLI, server, envelopes and runtime. Each item keeps the report's check as its acceptance test.

## Already addressed

- **A1 idle wake.** Instant wake shipped and was verified live today. It covered idle wake without a listener, a ChatGPT restart while idle, and an off-screen chat. Still open from A1's check: a 10+ minute idle test, a native approval prompt, and the paused queue after an interrupted turn, which is now shown as "press Send there".
- **A2 waiting noise.** Largely gone for rooms with automatic wake, because Astra no longer polls. The skill's guidance to report the connection once still applies to listener fallback.

## Batch 1: correctness (small, independent)

| ID | What | Owner |
|---|---|---|
| A6 | Room URL, heading, sidebar and composer always agree. Handle `hashchange` and `popstate`, push history on room switches, and treat unknown links as home plus a notice | Claude |
| S2 | Always print `--root` with the absolute path in hints, envelopes and receive output | Astra |
| S10 | One state-aware renderer for join, receive, stick and reply hints. No listen hint when join delivers a turn | Astra |
| S8 | `--file -` reads stdin. Document inline text. Keep drafts reliable for retries that need review | Astra |
| S7 | Compact acknowledgment when the exact delivery revision was already shown, never hiding newer human input | Astra |

## Batch 2: room context in every envelope

| ID | What | Owner |
|---|---|---|
| S5 | Absolute `workspace/` path in every envelope. Skill rule: shared files go there, handoffs name them, only the stick holder edits | Astra (envelope), Claude (skill, README) |
| S4 | Stamp the running process's version or protocol in envelopes. `receive` says when it changed since join. Write down the release and transition approach before building it | Astra |
| S1 (1, 2, 4) | Provenance: distinguish a human message recorded by Semaphore from AI text in the envelope footer, without claiming higher trust. Web note that approvals happen in each native app. Carry the opening request into invitations | Astra (envelope), Claude (web copy) |

## Batch 3: status notes and approval waits

| ID | What | Owner |
|---|---|---|
| S3 + S1(3) | `semaphore note <room> "<text>"` for the stick holder, bound to its turn. It shows in the app and in `status`, clears on reply, take or rebind, and never counts as a reply. A "waiting for your approval in the Claude app" note is its main use | Astra (core, CLI, API), Claude (UI, skill guidance) |

## Batch 4: shared deliverables

| ID | What | Owner |
|---|---|---|
| A4 | A lightweight artifact record: id, canonical path, content hash or revision, title, optional published URL, and review status (source or visual, by whom, at which revision) | Astra (record, CLI), Claude (design) |
| A5 | A room-level "Deliverables" panel and completion indicator, so the human sees finished work immediately without extra model turns | Claude |
| S6/A3 | A preview path both hosts accept: isolated origin, sandboxed, artifact-scoped, no control credentials. Otherwise "source-only" said plainly | Astra (server security), Claude (UI) |

## Batch 5: names and measurement

| ID | What | Owner |
|---|---|---|
| S9 | Server-side titles cut at a word boundary with an ellipsis. Rename in the app. `semaphore title` for the first AI, one-time and editable, never delaying the opening | Claude (UI), Astra (CLI and server) |
| S11 | Separate queued, listener-observed, acknowledged and replied timestamps. Measure before optimizing | Astra |

## Order

Batch 1, then 2, 3, 4 and 5. Each batch ends with tests, a harness check where it touches the UI, and a note here. Cutover happens once batches 1–3 pass, then again after 4–5, with a heads-up to Illiana because it restarts the background service.

## Progress

- **A6: done (Claude).** `web/app.js` now treats the address as the source of truth. `setRoute()` pushes history on room and home switches and replaces on start-up. `followRoute()` handles `hashchange` and `popstate`. Unknown or malformed links go home with a notice and a corrected address. Harness check: a same-tab link, Back/Forward with the draft kept per room, a sidebar click then Back, an unknown link, a malformed link and reload all showed the same room in the address, heading and sidebar. 126 tests pass.
- [x] **S2: done (Astra).** Generated commands always carry an absolute, shell-quoted `--root`, including the default folder. Executable regression checks cover default/custom roots, spaces and an apostrophe, plus running a printed receive command with a different `SEMAPHORE_HOME`.
- [x] **S10: done (Astra).** Shared command and turn-guidance renderers cover join, stick, receive and reply. A join that delivers its own opening prints the envelope without a contradictory immediate listen hint. Duplicate joins and `listen` after receipt direct the holder to continue and reply. Manual delivery and explicit timed waits remain covered; the default wait hint says there is no timer.
- [x] **S8: done (Astra).** `--file -` reads stdin; CLI help and envelopes document positional short text and quoted heredocs. Replies preserve literal Markdown, Unicode, dollar signs, apostrophes, backticks and trailing newlines across stdin/file/positional forms. Retries of legacy trimmed replies remain idempotent. A review-required stdin or inline reply saves a private draft under `<room>/drafts/<speaker>/<turn>.md` and prints a file-based retry; existing file drafts stay in place.
- [x] **S7: done (Astra).** `receive --compact --seen-through N` is an explicit claim that revision N was read. The default and `--show` print the full turn. A mismatched revision or newer human input forces full output and exit 3, without advancing the receipt or marking the new input read. Review-revision receipts always require full output; the recovery command is printed. Invalid revisions cannot change the acknowledged boundary.

**Batch 1 validation:** all 134 automated tests pass in the worktree. The eight added CLI regressions include literal draft recovery, compact receipts, repeated join/listen behavior and cross-environment command execution. No live files were changed and no service was restarted. Claude's A6 harness checks above cover the only UI changes in this batch.

**Batch 1 review (Claude):** approved. Compact receipts never mark newer human input read, and a mismatch or a review revision always forces the full turn. Drafts are written atomically with owner-only permissions, and the retry command is exact. Stored replies keep their trailing newlines, and the web formatter trims each block, so the app shows no extra blank lines. Optional follow-up: remove a Semaphore-owned draft once its retry commits.

- [x] **S5 skill and README: done (Claude).** A new skill rule, "Share files through the room's folder": the folder is local and not synced, scratch stays apart from finished work, handoffs name each file, an existing repository takes precedence, and an unreachable folder is reported rather than worked around. Only the stick holder edits it. The README describes the folder. Both assume Astra's envelope names the absolute path.
- [x] **S1 web copy: done (Claude).** While an AI has the stick, the banner says where it works ("working in the Claude app" or "working in ChatGPT"). The composer hint adds "Approvals for Claude happen in the Claude app" (or ChatGPT for Astra). The keyboard hint no longer wraps mid-phrase. Checked in the harness at desktop and phone widths with no horizontal overflow. The README explains where approval prompts appear.
- [x] **S7/S8 guidance: done (Claude).** The skill now has "Receive before working", "Work, then reply" and "When the human speaks during your turn". Full receive is the default for wake notices and for cut-off, summarized or unclear output. `--compact --seen-through N` is only for a complete turn just read, and review receipts never use it. The skill lists all three reply forms, with a quoted heredoc for stdin, and explains where the draft is kept. `docs/LIVE-CONTRACT.md` documents revision and compact receipts, and the README's developer notes list the forms.
- [x] **S5 envelope: done (Astra).** Full turns and compact receipts print the absolute, shell-quoted `Shared room folder`, distinct from the project selected by a native invitation. Tests cover custom roots, spaces and an apostrophe. This establishes local path discovery; it does not claim that a restricted native host will grant access.
- [x] **S1 provenance and invitation context: done (Astra).** The footer distinguishes recorded human input (and native-chat relay labels) from AI collaborator text, while preserving each host's approval rules. Both invitation forms include the selected participants and recorded human opening when available, never an AI's invented approval. Context over 2,000 Unicode characters is visibly excerpted and directs a full receive. Existing invitations without an opening stay compact.
- [x] **S4 identity and staging: done (Astra); live cutover follows Batch 3.** The release approach was recorded in `docs/releases.md` before implementation. Candidate version is 0.3.0, protocol 1. Each process captures its release-source fingerprint once at startup; envelopes, listeners, `/health` and `version` identify the actual process, rather than querying Git on every message. Joins and successful receipts record their build; a changed or previously unstamped receive explains the transition. `dev/stage-release.mjs` stages a verified, read-only snapshot with locked production dependencies and no activation side effects. The first cutover must explicitly migrate the existing owned links and legacy CLI paths, retaining the old checkout while pending commands still name it.

**Batch 2 validation:** all 141 automated tests pass. A multi-process regression leaves an old server and listener running, changes the candidate sources, restarts the server, then receives and replies to the same pending turn through the new CLI exactly once. Each process reports its own captured build. Staging tests cover locked dependency installation, reuse without rewriting, interrupted staging cleanup, source changes, symlinks and modified manifests. A real temporary staging smoke check also installed `ws` within the frozen release, ran its CLI successfully, and verified its release identity. No live release was activated and no live service or native app restarted.

**Release approach review (Claude):** approved, with three cutover conditions recorded here:
1. The Codex wake engine (`local.semaphore.codex-wake`) also runs from the old checkout (`lib/wake-runner.mjs`), and its files are unchanged in this branch. The cutover must not restart or repoint it, because restarting that engine disconnects every Codex chat in ChatGPT until ChatGPT restarts. The old checkout stays in place for it. Moving it to a release is a separate step, done while Astra is idle and followed by a ChatGPT restart.
2. After cutover, envelopes and invitations name the snapshot's `cli.mjs`. Either name the stable installed command (`~/.semaphore/bin/semaphore`), so the next cutover never leaves a chat on a retired snapshot, or keep every snapshot that a binding or pending envelope still names.
3. The service, wake engine and command wrapper pin `/opt/homebrew/Cellar/node/23.10.0_1/bin/node`, which `brew upgrade node` removes. When the cutover rewrites them, use `/opt/homebrew/opt/node/bin/node`, or have the doctor check the pinned path.

- [x] **S3 status notes: UI and skill (Claude), core and CLI (Astra), API view (both).**
  - **Banner.** A working note shows on its own line under whose turn it is, in quotes and with its age. An approval note turns the banner amber: "Claude is waiting for your approval in the Claude app", or "Astra … in ChatGPT" with an _Open chat_ link where a native link is available. The composer hint changes to match.
  - **Sidebar and notifications.** The sidebar says "… needs your approval" with an amber dot. With _Notify me_ on, an unfocused window notifies once per approval note.
  - **Room API.** It gets a read-only `statusNote` projection in `server.mjs`, on summaries and detail. It is shown only while its exact turn and speaker are pending and awaiting a reply, with a known kind and non-empty text, and before `expiresAt`. Text is capped at 280 characters. Browsers get no write route. A server test covers stale turns, the wrong speaker, expiry, unknown kinds, blank text, truncation and take.
  - **Harness.** Checked with seeded working and approval notes for both AIs at desktop and phone widths, with no horizontal overflow.
  - **Skill.** It documents `semaphore note <room> --turn <id> [--approval] "<text>"` and `--clear`. The README describes notes. 142 tests pass.
  - **Core and CLI.** `note` authenticates the native binding, stick ownership and exact received turn; stale, foreign or unreceived writes and clears are rejected. Notes replace one another, normalize whitespace to one line, and cap text at 280 Unicode code points. Working notes expire after 30 minutes; approval notes use `expiresAt: null`. They clear on accepted reply, take, recovery and seat replacement, without consuming a reply or causing delivery. A review-required reply keeps its note. Events record note kind and timing without copying the text.
  - **Shared projection.** The API and `status` use `lib/status-note.mjs`; both additionally require the pending speaker still to own the stick, a received turn, a valid timestamp and a future expiry for working notes. Full envelopes include the exact optional note command for chats whose installed skill has not reloaded.
  - **Release conditions.** `docs/releases.md` now explicitly excludes the Codex wake engine from cutover, retains every release referenced by old commands, and uses the stable Homebrew Node path when rewriting the app service and wrapper. No live activation occurred in this batch.

**Batch 3 validation (Astra):** all 146 automated tests pass, including four new checks for native binding and turn receipt, unchanged budgets/transcripts/delivery, Unicode truncation, expiry, incoming human messages and review retries, reply/take cleanup, and stale-seat cleanup on rebind. CLI and API share the same note filter. Claude's earlier visual checks used seeded notes; a final CLI-to-UI harness check and Claude's review precede the Batches 1–3 cutover. This does not claim a real native approval dialog has been exercised.

**Batch 3 final review (Claude):** approved. An end-to-end check used the real CLI in a throwaway harness room: a note before receipt is refused, and whitespace is normalized. A working note, then an approval note (amber banner, sidebar badge and composer hint) reached the app. `--clear` and an accepted reply each removed the note. Events record kinds without text.

**Cutover preparation (Claude):**
- **Read-only folder in invitations.** With the app running from a release, new Claude invitations would have opened in the read-only release folder, because `workspace` defaulted to the code folder. `buildInvite` now defaults to the room's shared folder, and the server passes a folder only when configured. `/api/session` also reported a hard-coded 0.2.0 and now reports the running version. There is a server test for the folder, and the README says Claude suggests the conversation's shared folder.
- **Cutover script.** `dev/cutover.mjs` covers steps 2–4 of `docs/releases.md`. It is a dry run unless `--apply`. It verifies the staged release and the stable Node path, and only touches Semaphore's own service, command and skill links. Before switching, it backs up the plist, the command, the link targets and all room journals. It restarts only `local.semaphore.app`, waits for the new build on `/health`, and confirms the wake engine's pid is unchanged. `--rollback <backup>` restores everything without depending on the release.
- **Rehearsal.** A release was staged to a scratch folder (0.3.0, build fbc475f869bf) and dry-run against the live install; every check passed. Its server ran from the read-only snapshot on a spare port with a scratch data folder: `/health` reported the release, and the app and its assets loaded. 146 tests pass.

**Cutover review (Astra):** the invitation fix is approved, including preservation of an explicitly selected project folder; session version now follows the captured runtime. The cutover helper received two corrections before approval: a locked per-room journal backup uses SQLite's snapshot operation instead of copying potentially active WAL files, and rollback preflights the entire installation with saved paths/hashes before replacing anything. It excludes workspace artifacts and ephemeral locks from the journal backup, refuses busy rooms or active deliveries before activation, checks Node's supported major version and kickstart failures, matches health to the actual service PID/build, and fails verification if the wake-engine PID changes. Isolated tests exercise read-only rehearsal, apply/rollback with saved turns and WAL input, refusal of foreign or later-edited targets, and recovery after registration failure with the candidate release unavailable. No live restart was performed during review.

**Review validation:** all 151 tests pass. A fresh scratch snapshot (0.3.0, build `8bf0d3534206`) installed locked dependencies successfully, and the updated helper passed its dry run against the real install paths. App service PID 7825 and wake-engine PID 99804 remained unchanged. The snapshot precedes only this validation note; the production cutover must stage the final committed tree again.

**Batches 1–3 live cutover: done (Claude), 24 September 2026.**
- **Release.** `600fb16` was staged fresh as `~/.semaphore/releases/0.3.0-c09070e7b07604c0` (build c09070e7b076). The dry run passed, then `dev/cutover.mjs --apply` ran. Backup: `~/.semaphore/backups/cutover-2026-09-24T20-19-57-579Z`, including consistent room snapshots.
- **Before switching.** Only this room had a turn pending, and it was mine and already received. No delivery was in flight.
- **After switching.** `local.semaphore.app` went from pid 7825 to 41926 and now runs the release with `/opt/homebrew/opt/node/bin/node`. `/health` reports release 0.3.0, build c09070e7b076. The installed command and both skill links point at the release. The wake engine (pid 99804) and ChatGPT (pid 8770) were untouched, and instant wake still reports on.
- **Transition check.** Turn `a4451cec…` was received by the old, unstamped CLI. The release CLI then received it compactly at revision 41, printing the runtime-change notice. A working note from the release CLI showed in the live app, and this same turn was then replied to once through the release CLI.
- **Left running.** The old checkout stays in place for the wake engine. A Claude listener for room `fb01b0fe…` (pid 81751) is still on the old CLI; it is protocol-compatible and adopts the release when that chat next rejoins.
- **Found live, fixed for the next release.** Since instant wake shipped, the connection guide said "Astra isn't listening" for a seat Semaphore wakes automatically. `web/app.js` now leaves automatically woken seats out, checked against the live room's API data and reviewed by Astra. It ships with Batch 4.
- **Astra's native-seat check.** Turn `b1a9edcb…` automatically woke the same native task on the new release. A full receive, rejoin through the installed command, and a working note succeeded. The live API reported the same turn as received, the note, automatic wake, and server PID 41926/build c09070e7b076. No listener or second native runtime was started.
