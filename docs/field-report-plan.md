# Plan: room FB01B0 field report

Source: `~/.semaphore/rooms/room-fb01b0fe007f54ed5e0efdcd/workspace/semaphore-field-report.md`, written by Claude and Astra on 24 September 2026. Illiana asked Claude to plan it and both of us to build it.

Work happens in the `semaphore-field` worktree (branch `field-report`), away from the live runtime the report warns about (S4). Reviewed cutovers merge it and restart the background service at the batch boundaries below. `node_modules` there is a local symlink to the main checkout's install; it is excluded locally and must not be committed.

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
