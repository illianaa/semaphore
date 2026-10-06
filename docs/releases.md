# Release identity and reviewed cutovers

This is the S4 approach for the field-report work, recorded before its implementation. Development stays in `semaphore-field`. The first cutover follows Batch 3 review; the second follows Batches 4–5. Neither requires every connected room to become empty.

## Identity

Each process captures the package version, protocol version and a fingerprint of its release sources at module initialization. The fingerprint covers the CLI, server, libraries, web assets, skill, bundled documentation, package metadata and dependency lock. It is not a fresh Git lookup at message time. A development checkout is labeled a development snapshot. A staged release has a manifest whose fingerprint must match its files before it starts.

Every envelope identifies its producer. A foreground/background listener separately identifies its own runtime when it prints a saved envelope: those two processes may have different versions. A receive command identifies the current CLI and reports a change from the seat's last received build (or its join build). Build history is diagnostic; it never changes turn identity, receipts, message ordering or authorization. Missing stamps on older seats and turns are reported as unknown rather than guessed.

## Staging

`dev/stage-release.mjs` copies the package's release files into a new temporary directory under the release root, installs locked production dependencies without lifecycle scripts, verifies the source fingerprint, writes a release manifest, and makes the snapshot read-only before renaming it to `<version>-<fingerprint>`. It rejects source symlinks and never edits an existing release. A failed staging operation removes only its own temporary directory. It does not change installed commands, skills, login items, rooms or running processes.

## Cutover checklist

1. Both engineers review the batch and tests. Tell Illiana which service will restart and that turns remain saved. Stage the exact reviewed files; do not edit the live checkout.
2. Save the active install paths and back up the room journals. Inventory active deliveries, received turns and listener process versions. Finish or explicitly pause an in-flight delivery before stopping its producing service; a durable pending turn may remain.
3. Point the service, installed CLI and skill links at the new release in one reviewed installation step, preserving the old release for rollback. The first migration must explicitly recognize the existing Semaphore-owned links and legacy command paths into the old checkout. Keep that checkout intact for the separately running Codex wake engine; do not silently merge over it. Never remove unrelated links. When rewriting the service and CLI wrapper, use the stable Homebrew Node path (`/opt/homebrew/opt/node/bin/node`) after checking that it resolves, rather than pinning a removable Cellar version. This installation step is performed at the cutover, not by staging.
4. Restart only Semaphore's app service (`local.semaphore.app`), verify its health/build identity, and reconnect affected native listeners after their current turn. **Do not restart or repoint `local.semaphore.codex-wake`**: its unchanged runner remains in the old checkout, and restarting it disconnects the native chats until ChatGPT restarts. Moving that engine is a separate, coordinated migration while Astra is idle. Existing envelopes can still name an old CLI. Keep every release referenced by saved envelopes or bindings, as well as the old checkout; there is no automatic pruning. Its durable receipt/reply protocol remains compatible; it must not be redelivered merely to refresh its commands. Each participant should rejoin through the stable installed command before its next exchange to adopt the new release. Do not resume a native chat from another process.
5. Verify one already-pending turn across the transition: the same turn ID is received and replied to once. Record the builds used by the old listener, new CLI and restarted server. Confirm bindings and human input remain intact, then document the cutover.

The build stamp is not a claim that a native chat has reloaded its skill. Envelopes remain self-contained. A protocol-incompatible release needs an explicit drain/migration plan; this batch adds metadata with protocol 1 and does not change the journal format's meaning. To roll back, restore the saved install paths and restart the service on the preserved release, retaining room data and reviewing any uncertain delivery rather than resending it.

## Cutover helper

`node dev/cutover.mjs --release <staged folder>` checks the current install without changing it. Add `--apply` after the review and room inventory above. It verifies the release and Node executable, saves the owned wrapper/plist/skill targets, then switches those paths and restarts the app service. The health check must match the new build and service PID; the wake-engine PID must stay the same.

The backup holds room journals, transcripts, drafts and inbox state, excluding shared workspace files and transient locks/listener markers. Each room is locked while it is copied; SQLite input is saved with `VACUUM INTO`, including committed input still in the write-ahead log. A busy writer or a delivery in progress stops the operation before activation. This is a per-room snapshot, not a global pause: the human may continue sending messages, and the live journals remain authoritative.

The printed `--rollback <backup>` command restores the installation, never the room data. It checks the recorded installation paths, backup hashes, and every current destination before writing anything. Files or links changed by a later install are left alone. Rollback also works when the candidate release is unavailable. Keep the reviewed worktree containing this helper and the previous runtime until the transition is verified.

## 0.5.0 cutover, 25 September 2026 (Claude)

- **Candidate.** `59df114` plus the 0.5.0 version bump and Claude's design-review note in `docs/ui-polish-plan.md`, staged fresh as `~/.semaphore/releases/0.5.0-68b75350a3e0f021` (build 68b75350a3e0). Runtime commit `edd8d74` contains exactly those files; Astra exported that commit and verified its full source fingerprint equals `68b75350a3e0f02137dc13742d3a0e744e7f6845a9f6db27ae013724ea88ed02`. This record was written after staging and belongs in a separate documentation commit.
- **Heads-up.** Illiana got a status note in the room ("restarting … to switch to 0.5.0 … reload this page if it asks") and a message in Claude's chat before the restart.
- **Before switching.** The candidate booted from its read-only snapshot on port 4332 with a scratch data folder: `/health` reported release 0.5.0, and the app and its assets loaded. The inventory showed only this room's received Claude turn pending, and no delivery in flight. Two other Claude chats' 0.4.0 listeners were left running, since 0.4.0 is retained. The dry run was clean.
- **Apply.** Backup: `~/.semaphore/backups/cutover-2026-09-25T18-50-11-064Z`. The app went from pid 69677 to 72226, release 0.5.0. The command and both skill links now point at 0.5.0. The wake engine stayed at pid 99804 and ChatGPT at pid 8770; wake is still on. Releases 0.3.0 and 0.4.0 and the old checkout are kept.
- **Transition.** Turn `5ddd79e7…` was received on 0.4.0. The 0.5.0 CLI then received it compactly at revision 56 with the runtime-change notice, and the rejoin kept the binding. A status note showed in the live app, and this turn's reply is its one commit.
- **Live app, looked at only.** At 1280×800: the compact bar with Claude's waving mark and note; fully expanded messages; a 56-dash rail with in-view tracking; Astra's seat reads "wakes automatically", with no stale connection guide.

### Final native and live verification (Astra)

Claude's single reply became message 57 and automatically woke the same Astra native task. Turn `4826a58d-ece5-4b4e-8f1c-b244844bd65c` was received on 0.5.0 at revision 57, with the 0.4.0 → 0.5.0 runtime notice. No listener or second native runtime was used. Queued `2026-09-25T18:51:16.043Z`, native queue `18:51:17.661Z`, host-start observed `18:51:19.461Z`, acknowledged `18:51:22.186Z`: 6.143 seconds from queue to receipt in this handoff, with exact host delivery still unknown.

Live `/health` independently reported PID 72226 and the full expected 0.5.0 fingerprint. Chrome showed `test chat`, all 57 messages expanded, 57 rail dashes, Astra's working mark and status, and no stale connection guide or horizontal overflow. The check changed no room messages or names, and its temporary browser tab was closed. Both engineers approve the UI and release; 169 automated tests passed before cutover. The final report returns the stick to the human.

## 0.6.0 cutover, 25 September 2026 (Claude)

- **Candidate.** `7b39e67` plus the 0.6.0 version bump and Claude's round-2 design-review note in `docs/ui-polish-plan.md`, staged fresh as `~/.semaphore/releases/0.6.0-0af4cbb6efe8f953` (build 0af4cbb6efe8). Runtime commit `03360a2` contains exactly those files. Astra exported that commit and verified its source fingerprint matches the full release build `0af4cbb6efe8f953c9d87111da43aaa45384bd7ed61c510cc5509ce02dda4b44`; this record belongs in a later documentation commit.
- **Heads-up.** Illiana got a status note in the room and a message in Claude's chat before the restart.
- **Before switching.** The candidate booted read-only on port 4332 with a scratch data folder; `/health` reported 0.6.0 and the page carried `#room-alerts`. The inventory showed only this room's received Claude turn pending. Two other Claude chats' 0.4.0 listeners were left running, since 0.4.0 is retained. The dry run was clean.
- **Apply.** Backup: `~/.semaphore/backups/cutover-2026-09-25T19-13-22-617Z`. The app went from pid 72226 to 84052, release 0.6.0. The command and both skill links now point at 0.6.0. The wake service stayed at 99804, its Codex engine at 99808 and ChatGPT at 8770; wake is still on. Releases 0.3.0 to 0.5.0 and the old checkout are kept.
- **Transition.** Turn `113c5ef4…` was received on 0.5.0. The 0.6.0 CLI then received it compactly at revision 61 with the runtime notice, and the rejoin kept the binding. A status note showed live, and this turn's reply is its one commit.
- **Live Companion at 420×720, looked at only.** The floating card showed Claude's working mark and note, messages had 424 px, the slim rail had 61 dashes, the caption showed the room's "No limit" setting, and there was no horizontal overflow.


### Final native and live Companion verification (Astra)

Claude's reply became message 62 and automatically woke the same native task `01a0cffb-3b55-7013-9ab8-a3e8890f4d36`. Astra received turn `bbae3acf-78f5-4d92-9049-d41781966c47` on 0.6.0 at revision 62, with the 0.5.0 → 0.6.0 runtime notice. No listener, manual Send or second native runtime was used. Queued `2026-09-25T19:14:06.740Z`, native queue `19:14:08.174Z`, host-start observed `19:14:10.091Z`, received `19:14:13.989Z`: 7.249 seconds from queue to acknowledgment in this handoff. Exact host delivery remains unknown.

Live `/health` independently reported PID 84052 and the expected full 0.6.0 fingerprint. A read-only Chrome check of live Companion at 420×720 showed `test chat`, 62 expanded messages, 62 dashes in a visible 20 px rail, a 78 px floating card, Astra's working mark, a 443 px message area, and the existing `No limit` setting in the composer caption. No stale connection guide or horizontal overflow appeared. The check changed no message, name or reply limit. The temporary tab was closed and browser sizing reset. Both engineers approve the design and release; the 169-test suite passed during implementation. The final report returns the stick to the human.

## 0.7.0 cutover, 25 September 2026 (Astra)

- **Reviewed candidate.** Runtime commit `9a47afe` includes both engineers’ branding work, Jersey 10 and its OFL text, the binary-safe static asset route, and the 0.7.0 package/lock version. All 170 tests passed (31.37 seconds). The staged release is `/Users/illiana/.semaphore/releases/0.7.0-7dea1b45dd7390f3`, full build `7dea1b45dd7390f3ceda9f2c1991d03f50bcb292cf20f2e28c4e4cc1217bbfb4`. Source and staged fingerprints matched before any post-release documentation edits.
- **Candidate checks.** The frozen release booted on an ephemeral port with a scratch room root and native delivery disabled. Health identified release 0.7.0; HTML token substitution, JS/CSS/icon routes, the bundled font’s byte-for-byte response, and inclusion of its licence passed. The candidate server was closed.
- **Heads-up and inventory.** A native commentary and a room status note explained the brief app restart and saved turns. All ten rooms were inventoried: only this room’s received Astra turn `03d905ab-d6ee-4998-a0da-6098ce6e15e1` was pending (`awaiting-reply`); no delivery was in progress. Existing Claude listeners on 0.4.0 and 0.6.0 were retained. The dry run passed.
- **Apply.** Backup: `/Users/illiana/.semaphore/backups/cutover-2026-09-25T20-17-49-412Z`. App PID **84052 → 24378**, launched with `/opt/homebrew/opt/node/bin/node`. The installed command and both skill links now target 0.7.0. Wake service PID **99804**, its engine **99808**, and ChatGPT **8770** were unchanged. Old releases and the original checkout remain.
- **Saved-turn transition.** Astra rejoined through the stable installed command in the same native task and received the same turn at revision 68 using 0.7.0. The CLI reported the 0.6.0 → 0.7.0 runtime change and explicitly retained the turn ID and receipt. Automatic wake remains verified. All ten rooms’ participant IDs and existing message-sequence prefixes matched the pre-cutover inventory.
- **Live verification.** Health returned PID 24378 and the full expected fingerprint. The live font matched the bundled bytes. A read-only Chrome check at 1280×800 showed `test chat`, 68 expanded messages, the pixel wordmark, dark surfaces, zero sidebar room glyphs, the sidebar toggle, Astra’s working note and automatic-wake seat, and the unchanged `No limit` setting. No horizontal overflow. The tab was closed and viewport reset.
- **Final exchange.** This turn’s reply will cross from the new 0.7.0 CLI to Claude’s existing 0.6.0 listener. Claude should adopt the stable installed command and confirm its receipt, then return the stick to Illiana. No replay or second native runtime is needed.

This cutover record is a documentation-only follow-up after staging and does not alter the frozen release. The broader real native approval and interrupted-queue exercises remain unverified; this branding release does not claim them.

## 0.8.0 cutover, 25 September 2026 (Claude)

- **Candidate.** `1b8b474` plus Claude's Outfit bundle (font, licence, route, CSS, font test), the Jersey licence renamed to `Jersey10-OFL.txt`, the README credits, the synthesized-italic fix, the brand-sprint notes and the 0.8.0 bump. Staged fresh as `~/.semaphore/releases/0.8.0-b4b1b2da4124e9ee` (build b4b1b2da4124). Runtime commit `2e891cf` contains exactly those files; Astra exported the commit and verified its full source fingerprint equals `b4b1b2da4124e9ee118beca9492a25a95c6dfd70bc2ba004532c807d1adbec13`. This record was written after staging and belongs in a later documentation commit.
- **Heads-up.** Illiana got a status note in the room and a message in Claude's chat before the restart.
- **Before switching.** The candidate booted read-only on port 4332 with a scratch data folder. `/health` reported 0.8.0, and `/fonts/outfit.ttf` (110,884 B), `/fonts/jersey-10.ttf` (77,732 B) and the assets were all served. The inventory showed only this room's received Claude turn pending. Three other chats' listeners on retained 0.4.0 and 0.6.0 were left running. The dry run was clean.
- **Apply.** Backup: `~/.semaphore/backups/cutover-2026-09-25T21-14-45-558Z`. The app went from pid 24378 to 53614, release 0.8.0, and the live Outfit route serves 110,884 B. The command and both skill links now point at 0.8.0. The wake service stayed at 99804, its Codex engine at 99808 and ChatGPT at 8770; wake is still on. Releases 0.3.0 to 0.7.0 and the old checkout are kept.
- **Transition.** Turn `9baf08f9…` was received on 0.7.0. The 0.8.0 CLI then received it compactly at revision 74 with the runtime notice, and the rejoin kept the binding. A status note showed live, and this turn's reply is its one commit.
- **Live app at 1280×800, looked at only.** Outfit and Jersey 10 are loaded, and the caption reads "Stop after: Never" for this room's no-limit setting. 14 links rendered in real messages, all http(s) or mailto. No horizontal overflow.

### Final native and live verification (Astra)

Claude’s single reply became message 75 and automatically woke the same native task `01a0cffb-3b55-7013-9ab8-a3e8890f4d36`. Astra received turn `78a408b9-5ebf-4638-831c-158073a8d8ae` on 0.8.0 at revision 75, with the 0.7.0 → 0.8.0 notice. No listener, manual Send or second native runtime was used. Queued `2026-09-25T21:15:37.121Z`, native queue `21:15:38.760Z`, host-start observed `21:15:40.700Z`, acknowledged `21:15:44.298Z`: 7.177 seconds from queue to acknowledgment. Exact host delivery remains unknown. Rejoining through the installed command retained the existing binding.

The exported runtime commit matches the frozen release’s full build, and live health independently reports that same build and PID 53614. Both live font responses match their bundled bytes; the updated font-serving test passes. Outfit’s upstream licence was preserved byte for byte, including its existing trailing space on line 21 (the sole whitespace warning when committing the runtime). Claude reported all 178 tests passing before cutover.

A read-only live Companion check at 420×720 showed Outfit text, the Jersey 10 wordmark styling, synthesized italic emphasis, 75 expanded messages and 14 links with permitted schemes and the intended target/rel. “Stop after: Never” preserved the room’s existing unlimited reply setting. The textarea had no inner outline, while the outer composer retained the green focus glow. Both navigation icons and the title shared center y=25.5; no horizontal overflow appeared. The temporary tab was closed and viewport reset. Wake service PID 99804, its engine 99808, and ChatGPT 8770 were unchanged. Both engineers’ review is complete; the final report returns the stick to Illiana.

## 0.9.0 cutover, 26 September 2026 (Claude)

- **Candidate.** `354e966` plus Claude's "asleep in ChatGPT" badge copy, the review note in `docs/brand-sprint.md` and the 0.9.0 bump. Staged fresh as `~/.semaphore/releases/0.9.0-73de9c184a5f6b4b` (build 73de9c184a5f). This record belongs in a later documentation commit.
- **Heads-up.** Illiana got a status note and a message in Claude's chat before the restart.
- **Before switching.** The candidate booted read-only on port 4332: `/health` reported 0.9.0, it served both fonts at their exact sizes, and `render.mjs` carried the GPT label. The inventory showed only this room's received Claude turn pending. The dry run was clean.
- **Apply.** Backup: `~/.semaphore/backups/cutover-2026-09-26T19-41-37-916Z`. The app went from pid 53614 to 51311, release 0.9.0. The command and skills point at 0.9.0. The wake service stayed at 99804, its Codex engine at 99808 and ChatGPT at 8770; wake is still on. Releases 0.3.0 to 0.8.0 and the old checkout are kept.
- **Transition.** Turn `75cc5eaa…` was received on 0.8.0. The 0.9.0 CLI then received it compactly at revision 82 with the runtime notice, and the rejoin kept the binding.
- **Live wake states from the new server.** test chat: automatic; Wetware Manual: automatic; field-report room: automatic; illiana.me blog setup: unloaded; Semaphore release workshop: reconnect.
- **This room.** It shows "GPT wakes automatically" with no connection guide, GPT's avatar is #f2f2f2, and there's no overflow.


### Final native verification (Astra)

Runtime commit `8cde37e88a6fdc6e86e9a4df0d63a02ab7242c2d` exports to exactly the frozen release build `73de9c184a5f6b4bcf344edb18460cafaf2c66f52deb116d285724120c7be57e`. The immutable release validates against its manifest, and live `/health` independently reports that full build, version 0.9.0 and app PID 51311. The release runtime and post-cutover documentation are separate commits.

Claude's message 83 automatically woke this same native task `01a0cffb-3b55-7013-9ab8-a3e8890f4d36`. Astra received turn `80ff9bde-77c2-4ebb-a02f-7ba15913b192` at revision 83 through the installed 0.9.0 command. Timing records show room queue at `2026-09-26T19:42:30.221Z`, native queue at `19:42:31.070Z`, native turn start observed at `19:42:33.108Z`, and explicit acknowledgment at `19:42:36.197Z`: 5.976 seconds from room queue to acknowledgment. No listener, manual Send, second runtime or native resume was used to receive this turn. This verifies ordinary wake for a loaded chat; recovery of an unloaded chat still requires opening it in ChatGPT.

Process inspection confirms wake service PID 99804, its engine 99808 and ChatGPT 8770 remained unchanged, and the wake switch remains on. The 181-test review and disposable browser checks cover the implementation; Claude's final change was the idle badge text and version bump. Both engineers' review and the same-chat wake check are complete. The final report returns the stick to Illiana.

## 0.10.0 cutover, 27 September 2026 (Astra)

Runtime commit `8c24fba` contains the reviewed title cleanup, start-screen reply limit, system/light/dark themes and Claude listener-pickup/grace fix. It also preserves pre-0.10 browser request identities after a lost create response. All 184 tests passed; independent disposable-browser checks covered creating Never-limit chats, resetting the next draft to 4, cross-window theme changes, narrow Companion layout, listener pickup before receipt and warning reappearance after the 90-second reply grace expired. Test windows/server were closed and the viewport reset.

The frozen release is `~/.semaphore/releases/0.10.0-6e5d68c7bd2916d8`, full build `6e5d68c7bd2916d8262de31c5925e9645eff3538aefc61354ee43639d67de27a`. The committed runtime's source fingerprint matches it. Its isolated smoke server served the shell, theme and start-request scripts and both font files. Only this room's acknowledged Astra turn was pending at inventory; no delivery was in flight. Existing listeners and older releases were retained.

Astra gave a native heads-up and room status note, ran the clean dry run, then applied the app-only cutover. Backup: `~/.semaphore/backups/cutover-2026-09-27T20-11-19-009Z`. The app changed from PID 51311 to 72743; live `/health` reports the full release build above. Wake service PID 99804, its bundled Codex engine 99808 and ChatGPT 8770 were unchanged. The stable command and both skill links now target 0.10.0.

The already-pending turn `db3a8af2-1aad-4460-b82b-48ae0d5a7471` was first received on 0.9.0 at revision 88. Rejoin through 0.10.0 preserved its native binding and turn ID. A compact transition receipt correctly refused because new human input had arrived; Astra read the full envelope and acknowledged revision 89 without redelivery. A live read-only UI check showed just `test chat` in the title, the System theme toggle, “working in ChatGPT”, no false connection guide and no horizontal overflow.

Illiana explicitly requested committing and merging the work online. GitHub main was confirmed as the ancestor `78a677e`; the reviewed branch can fast-forward it without changing the old local checkout, which remains at `d4d0bde2b8b327e9f2bc3acdadcb8c4c030d0005` for the running wake service. The publication is a normal fast-forward, with no force push.

Revision 89 adds a new request: human messages during active work should immediately guide the current holder. That is subsequent delivery work; 0.10 retains durable interjections and the before-reply review barrier, and does not claim immediate native interruption.

## 0.11.0 cutover, 27 September 2026 (Claude)

- **Candidate.** Runtime commit `4261a19`: live guidance while an AI works (Claude's listener route and Astra's GPT steering), guidance-not-routing for mid-turn input, and Claude's review fix to the pump's steering snapshot. All 200 tests passed. Staged fresh from the clean commit as `~/.semaphore/releases/0.11.0-ca075e66992cf84f`, full build `ca075e66992cf84fed9cecfd6330d8de27ef831953a107b48a0631137da81642`.
- **Before switching.** The frozen candidate booted on port 4332 with a scratch data folder. `/health` reported 0.11.0 and that build. The shell, theme, start-request, app, render, style and icon routes answered, and both fonts were served at their exact sizes. The app script carried the new composer and delivery code. A scan of the committed probe report found no secrets or personal paths.
- **Inventory and dry run.** Only this room's received Claude turn was pending, and no delivery was in flight. Four other Claude chats' listeners on retained releases 0.4.0, 0.6.0 and 0.9.0 were left running. The dry run was clean.
- **Heads-up.** A room status note and a message in Claude's chat, before the restart.
- **Apply.** Backup: `~/.semaphore/backups/cutover-2026-09-27T20-45-28-843Z`. The app went from pid 72743 to 88137. Live `/health` reports the full build above, and every asset matches the candidate. The command and both skill links point at 0.11.0. The wake runner stayed at 99804, its engine at 99808 and ChatGPT at 8770, and wake stays on. Older releases and the old checkout (`d4d0bde`, which hosts the runner) are kept.
- **Transition.** Turn `640f7fdd…` was received on 0.10.0 at revision 92. The 0.11.0 command then acknowledged it compactly with the runtime notice.
- **Claude's new route, live.** Claude then started its listener under 0.11.0, in the middle of its own turn. The live room reports Claude listening while it holds a received turn, with no reply routing set.
- **Live states from the new server.** GPT: test chat, Blog blurb and Naming Camel automatic; Wetware Manual, illiana.me blog setup and the Codex collaboration room unloaded; Semaphore release workshop reconnect. No GPT turn was working, so steering was correctly not offered anywhere.
- **Still to verify.** Astra checks GPT's released binding and steering in its own native chat, then publishes the commits to GitHub as a fast-forward.

### Released GPT verification and publication (Astra)

Astra received room turn `4324c4ed-a194-442c-9060-a87a20741a50` at revision 93 through the released 0.11.0 command. Its saved `pending.nativeWork` matches both the wake-observed native turn `01a0e49e-97e4-7300-919e-27f3e8c29b88` and the original chat binding, with shared engine PID 99808 and its unchanged start time. The live room API reports `wake: automatic`, `steering: true` and `progress: received` while Astra works; Claude's listener remains active. Live health independently matches the full release fingerprint and app PID 88137. Wake runner 99804, engine 99808 and ChatGPT 8770 remain unchanged. No human interjection arrived during this check, so actual same-turn desktop message receipt remains an acceptance step, not a claimed result.

The reviewed 0.11.0 commits were published with a normal fast-forward `8d739f5..087d5be`. GitHub main was then verified as `087d5bed5b232210639a4aa52560f3341ede46e6`. The old runner checkout remains at `d4d0bde2b8b327e9f2bc3acdadcb8c4c030d0005`. A separately tested follow-up bounds the age of steering availability retained across a room lock; it awaits Claude's review and a subsequent release.

## 0.11.1 cutover, 27 September 2026 (Claude)

- **Candidate.** Astra's `b4c679e` (a room held behind a long lock stops advertising GPT steering after 10 seconds) and the version commit `e0f51fa`. Claude reviewed it: the per-room inspection time can't be renewed by a lock, and the new test covers both a short lock and a long one. All 201 tests passed. Staged fresh from the clean commit as `~/.semaphore/releases/0.11.1-62a0e22f1760b653`, full build `62a0e22f1760b65323807d49dac031cdfd1e11bd55e1bdefb854243858b4d787`.
- **Before switching.** The candidate booted on port 4332 with a scratch data folder, reported 0.11.1 and that build, and served every asset at the same sizes as 0.11.0. Only this room's received Claude turn was pending. The dry run was clean.
- **Apply.** Heads-up in the room and in Claude's chat, then `--apply`; backup `~/.semaphore/backups/cutover-2026-09-27T20-50-59-639Z`. The app went from pid 88137 to 91184, and live `/health` matches the build. The command and both skill links point at 0.11.1. Wake runner 99804, engine 99808 and ChatGPT 8770 are unchanged. 0.11.0 and earlier releases are kept; Claude's listener started under 0.11.0 keeps running.
- **Transition.** The 0.11.1 command acknowledged turn `28c1936e…` compactly at revision 94 with the runtime notice. The live room shows Claude listening while it works. GPT's wake states are the same as under 0.11.0, with no steering offered while no GPT turn is working.
- **Publication.** A fast-forward of GitHub main from `087d5be`; the old checkout stays at `d4d0bde`.

## 0.12.0 cutover and Claude hook install, 27–28 September 2026 (Claude)

- **Candidate.** Runtime commit `0f60eed`: Claude chats woken through Claude Code hooks, with no listener. Claude built it, and Astra reviewed and hardened it (durable claims, one outstanding revision, WAL watching, and uninstall revoking registrations). All 214 tests passed. Staged fresh as `~/.semaphore/releases/0.12.0-99a97bdd1dea4d49`, full build `99a97bdd1dea4d491adb2cdd2b4705e01e4c38ef8094002bdd43fb2935a0f12a`.
- **Before switching.** The candidate on port 4332 with a scratch folder reported 0.12.0 and that build, and served every asset. `hook register` exits 0 quietly on invalid input. Only this room's received Claude turn was pending, and no listener ran for this room. The dry run was clean.
- **Apply.** Heads-up in the room and in Claude's chat, then `--apply`; backup `~/.semaphore/backups/cutover-2026-09-28T00-02-46-333Z`. The app went from pid 91184 to 49939. The command and both skill links point at 0.12.0. Wake runner 99804, engine 99808 and ChatGPT 8770 are unchanged.
- **Hooks installed with Illiana's explicit approval** ("yes, INSTALL THE HOOKS!"). `semaphore hooks install` added exactly three entries to `~/.claude/settings.json`, through the stable command:
  - SessionStart and CwdChanged run `hook register` (timeout 10).
  - FileChanged runs `hook wake` (`asyncRewake: true`, timeout 10).

  Every unrelated setting compared equal, the file keeps its 0600 mode, and a backup is in `~/.semaphore/backups/claude-settings-2026-09-28T00-02-54-…json`.
- **Registration.** Claude's running chat registered itself through a real CwdChanged hook about 48 seconds after the install. The live room then reported Claude as `wake: "automatic"`, and the 0.12.0 envelope for the turn in hand said "no listener is needed". Before handing off, the chat had no background task and no listener for this room.
- **Production proof, 28 September.** Claude handed turn 111 to Astra at 00:04:17 and ended its native turn with no background task and no listener. Astra received the turn through 0.12.0 and passed it back:

  | UTC | Event |
  | --- | --- |
  | 00:04:31.666 | The turn was queued for Claude |
  | 00:04:32.056 | The app's ClaudeSignalPump wrote Claude's signal (reason `…:turn`) |
  | 00:04:32.799 | The FileChanged hook claimed the notice under the room lock |
  | 00:04:32.829 | The hook recorded the observation |
  | 00:04:37.151 | Claude acknowledged |

  That is 5.5 seconds from queue to acknowledgment. The chat woke with the notice "Semaphore: a saved room message for this chat", which the host labels as a hook error. It still had no child task and no listener after waking. **Listener-free Claude delivery passed in production.**
- **Publication.** A fast-forward of GitHub main to this record. The old runner checkout stays at `d4d0bde`.

## 0.13.0 cutover, 6 October 2026 (GPT)

Runtime commit `035cb2a` contains Wake Claude, GPT naming, remembered reply limits, the Needs you request tray and End/Reopen, including companion controls. Review fixes cover answer routing, stale request choices, retry payloads, dismissal receipts, text submission and the companion notice layout. All 240 tests passed; the release/cutover checks passed separately (8 tests). Disposable browser checks covered the companion at 420×760, including a registered-Claude fixture and text-only request answers.

The frozen release is `~/.semaphore/releases/0.13.0-81c696f5a477fdcc`, full build `81c696f5a477fdccdef67bc38dbb59843f4b63b31742d7b318d935c0075071d4`. Its source matches the runtime commit. The isolated smoke server and installation dry run passed. This record is written after staging and belongs in a separate documentation commit; the frozen release is unchanged.

The person approved installation in room message 7 and subsequently handed the task to GPT. After a room status note and native heads-up, GPT applied the app-only cutover. Backup: `~/.semaphore/backups/cutover-2026-10-06T21-21-38-527Z`. App PID changed from 49939 to 97109. Live health reports the exact full build above, and eight served assets match the frozen release byte for byte, including both fonts. The command and both skill links target 0.13.0. Wake runner 99804, shared engine 99808 and ChatGPT 1885 stayed running; previous releases remain available.

Before the switch, three saved turns were pending and no deliveries were in flight. The before/after inventory preserves all 23 rooms' participant bindings and previous messages. The three pending turns remain available. Current turn `0ac2ea57-25fe-45de-8618-c34f0236c8f3` was received on 0.12.0 and acknowledged through the installed 0.13.0 command at revision 11 after rejoining the same native chat. Both seats report automatic wake, and GPT reports live steering. No listener or second native runtime was used.

A read-only live companion check showed the End button, the preserved Never reply limit and the first real Needs you request (`c4ce021f-b1a3-4daf-b4e2-c3659f1e4434`). That request asks whether to build the separately proposed blocked-agent safeguards. Those safeguards are not part of 0.13.0. No remote publication was performed.
