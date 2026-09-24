# Shared deliverables: records and preview boundary

Batch 4 starts with an explicit list of selected deliverables. It does not scan or expose the workspace. Recording a file, its review or its publication claim never sends a conversation message, wakes a native task, or consumes a reply. Writes require the bound participant to own and have received the exact pending turn. Reading the list is independent of the stick.

## Commands

Here `semaphore` means the installed command, with the room's explicit root retained as usual. These commands become available at the Batch 4 cutover; development uses the CLI in `semaphore-field`.

```sh
semaphore artifact <room> add --turn <turn> --file /absolute/path/index.html --title "The result" --asset style.css --asset images/diagram.png
semaphore artifact <room> list
semaphore artifact <room> review --turn <turn> --id <artifact> --revision 1 --sha256 <hash> --kind source
semaphore artifact <room> review --turn <turn> --id <artifact> --revision 1 --sha256 <hash> --kind visual --via "Permitted browser at desktop and phone widths"
semaphore artifact <room> add --turn <turn> --id <artifact> --file /absolute/path/index.html --ready
semaphore artifact <room> add --turn <turn> --id <artifact> --file /absolute/path/index.html --url https://example.com/result --access "account-private"
```

Registration returns JSON containing the ID, revision, hash and derived access/review state. Registering the same canonical path reuses its ID; an explicit `--id` can move that record to another source path. Identical retries are harmless. Omitted assets keep the previous explicit selection. A supplied `--asset` list replaces it; `--no-assets` selects only the entry file. `--draft` removes readiness and `--url ""` clears a publication link.

An artifact can live in the room's shared folder or an existing project. The canonical source path resolves symlinks at registration. Adjacent assets are individually selected relative to that file's directory and cannot traverse out or use symlinks. No recursive directory publication occurs. There are at most 256 selected files and 50 MiB total per record, and 50 selected records per room. Byte changes during a read are rejected. Polling caches hashes only while the canonical file identity, size and nanosecond modification/change timestamps match; reviews always recheck the bytes.

## Stored record

`room.artifacts` is an optional array, empty for older rooms. Each record has:

| Field | Meaning |
|---|---|
| `id`, `title`, `path`, `entry` | Stable room-local ID, display name, canonical absolute entry path and its filename |
| `revision`, `sha256`, `bytes` | Monotonic registered revision, SHA-256 of the selected file manifest, total size |
| `files` | Sorted `{name, path, sha256, bytes, mediaType}` entries; names are relative to the entry directory |
| `ready` | The participant marked this registered version ready; it does not imply a visual review or native approval |
| `published` | Optional `{url, access, revision, sha256, by, at, verification: "reported-by-publisher"}` |
| `reviews` | `{speaker, kind: "source" or "visual", revision, sha256, via, at}` records, including previous versions |
| `createdAt`, `createdBy`, `updatedAt`, `updatedBy` | Attribution and timestamps |

The manifest hash covers sorted `[name, file SHA-256, size]` tuples. Thus editing CSS or an image advances the revision even if the HTML is unchanged. Moving the canonical source also advances the revision. Title or readiness changes do not. A new content revision defaults to draft unless explicitly marked ready.

The publishing participant must record which version they actually published and describe who can open the link. Semaphore does not fetch, upload, verify remote contents, or establish approval by storing it. The UI should identify this as a reported link, not independent publication verification. A later file revision leaves the old link attributed to its earlier revision. Native authorization requirements still apply to the actual publishing action.

A review requires the exact registered revision/hash and unchanged selected files. Visual review also requires `--via` describing the permitted render inspected. A source review never counts as a visual review; a visual review is the named participant's report, not an automated certificate. The same participant/kind/version can update its review location; identical repeats are idempotent. Inspect the current files and respect host policy before recording either kind.

## Read-only API for the Deliverables panel

Both room detail and summaries include `artifacts` plus `deliverables: {total, ready}`. Each projected artifact retains the stored fields and adds:

| Field | UI behavior |
|---|---|
| `availability` | `current`, `changed`, `missing`, or `unavailable` |
| `currentReviews` | Only reviews of this revision/hash, and empty when files are no longer current |
| `declaredReady` | Stored readiness; projected `ready` becomes false if the files changed or cannot be read |
| `publishedCurrent` | True only if the reported publication matches this current revision/hash |
| `preview` | Currently `{available: false, reason: "Shared preview is not configured."}` |

The panel should show the filename/title, revision, ready/draft state, current review types and reviewers, source path, and any reported publication link with its access description and version. Show stale/missing files plainly. Escape all text; permit only the validated http/https publication links, opened without opener/referrer access. Do not create `file://` previews or imply an unavailable render was checked. Completion remains visible in Semaphore while the other participant is idle; native tasks still receive work only with the stick. Full turn envelopes identify registered revisions and print the list command to check for subsequent file changes.

## Next: preview implementation and host verification

The record/API portion does not serve artifact bytes. The proposed preview must use a separate loopback origin, an artifact-and-revision-scoped unguessable capability, a sandbox without same-origin or top-navigation privileges, and no Semaphore control token. It may expose only the explicit entry/assets manifest. Requests must reject traversal and symlink escapes and verify the registered bytes, including adjacent assets; no arbitrary filesystem or room routes. Control API isolation needs a hostile sample test.

Before claiming shared visual access, both hosts must independently allow and open the same new, harmless test artifact through the supported feature, at desktop and phone widths. The earlier denied `tell-all.html` preview remains out of scope for that probe: do not re-host or reopen it through an alternate route. If a host denies a preview, stop that attempt and retain source-only status. The UI must stay useful when shared rendering is unavailable. Preview availability and native host permission are separate checks.
