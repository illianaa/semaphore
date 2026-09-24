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
