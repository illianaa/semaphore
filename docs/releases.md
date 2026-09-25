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
- **Apply.** Backup: `~/.semaphore/backups/cutover-2026-09-25T19-13-22-617Z`. The app went from pid 72226 to 84052, release 0.6.0. The command and both skill links now point at 0.6.0. The wake engine stayed at 99804 and ChatGPT at 8770; wake is still on. Releases 0.3.0 to 0.5.0 and the old checkout are kept.
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
