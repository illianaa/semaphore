# Shared deliverables: records and preview boundary

Batch 4 starts with an explicit list of selected deliverables. It does not scan or expose the workspace. Recording a file, its review or its publication claim never sends a conversation message, wakes a native task, or consumes a reply. Writes require the bound participant to own and have received the exact pending turn. Reading the list is independent of the stick.

## Commands

Here `semaphore` means the installed command, with the room's explicit root retained as usual. These commands become available at the Batch 4 cutover; development uses the CLI in `semaphore-field`.

```sh
semaphore artifact <room> add --turn <turn> --file /absolute/path/index.html --title "The result" --asset style.css --asset images/diagram.png
semaphore artifact <room> list
semaphore artifact <room> review --turn <turn> --id <artifact> --revision 1 --sha256 <hash> --kind source
semaphore artifact <room> review --turn <turn> --id <artifact> --revision 1 --sha256 <hash> --kind visual --via "Permitted browser at desktop and phone widths"
semaphore artifact <room> add --turn <turn> --id <artifact> --ready
semaphore artifact <room> add --turn <turn> --id <artifact> --url https://example.com/result --access "account-private"
```

Registration returns JSON containing the ID, revision, hash and derived access/review state. Registering the same canonical path reuses its ID; an explicit `--id` can move that record to another source path, or retain its path when `--file` is omitted. Identical retries are harmless. Omitted assets keep the previous explicit selection. A supplied `--asset` list replaces it; `--no-assets` selects only the entry file. `--draft` removes readiness and `--url ""` clears a publication link.

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

Room detail includes `artifacts` plus `deliverables: {total, ready}`. Summaries include only the counts, inspecting only declared-ready files for drift. They do not transfer manifests or review histories. Each projected artifact in room detail retains the stored fields and adds:

| Field | UI behavior |
|---|---|
| `availability` | `current`, `changed`, `missing`, or `unavailable` |
| `currentReviews` | Only reviews of this revision/hash, and empty when files are no longer current |
| `declaredReady` | Stored readiness; projected `ready` becomes false if the files changed or cannot be read |
| `publishedCurrent` | True only if the reported publication matches this current revision/hash |
| `preview` | `{available, reason}`; available only for current HTML entries, without implying native host permission |

The panel should show the filename/title, revision, ready/draft state, current review types and reviewers, source path, and any reported publication link with its access description and version. Show stale/missing files plainly. Escape all text; permit only the validated http/https publication links, opened without opener/referrer access. Do not create `file://` previews or imply an unavailable render was checked. Completion remains visible in Semaphore while the other participant is idle; native tasks still receive work only with the stick. Full turn envelopes identify registered revisions and print the list command to check for subsequent file changes.

## Isolated preview service

`POST /api/rooms/<room>/artifacts/<id>/preview` accepts an empty JSON object and requires the app's control token and same-origin checks. It returns `{url, revision, sha256, expiresAt}`. Selection comes only from that room's registered artifact; the caller cannot supply a path or manifest. Polling never creates preview links. The CLI's list output directs callers to the app to request one.

The service starts on a separate, random loopback port and receives no control token or arbitrary filesystem route. An unguessable 256-bit capability names one room/artifact/revision/hash snapshot. Every issue rechecks all selected bytes, including when reusing an existing link. A snapshot is immutable for its 30-minute lifetime: later edits are never served under an old revision. The old labeled snapshot remains accessible until expiry; reopening changed sources is refused until they are registered again. Links disappear on app restart. The in-memory cache is bounded to 64 snapshots and 100 MiB, with the record's existing 50 MiB limit.

The viewer labels the saved revision/hash and expiry and offers desktop and phone widths. HTML runs in an iframe with `sandbox="allow-scripts"`; the response repeats the sandbox in CSP. There is no same-origin, top-navigation, popup, form or download privilege. Selected local scripts, styles, images, fonts and data can work; external resources, workers, nested frames, other capabilities and control endpoints are excluded. Native app access rules still apply. See the [HTML iframe sandbox specification](https://html.spec.whatwg.org/multipage/iframe-embed-object.html) and [Content Security Policy specification](https://www.w3.org/TR/CSP/).

The preview server only serves supported entries from the verified in-memory manifest. It rejects forged hosts, writes, traversal, malformed encoded paths, unsupported types, missing selections and expired capabilities. It sets `no-store`, `no-referrer` and `nosniff`. Sandboxed documents have opaque origins; CORS allows `Origin: null` for selected modules/fonts/data without credentials, while CSP restricts their URLs to this capability's prefix. The trusted wrapper contains no room controls or token. Unsupported document formats remain source-only.

## Native verification

Before claiming shared visual access, both hosts must independently allow and open the same new, harmless test artifact through the supported feature, at desktop and phone widths. The earlier denied `tell-all.html` preview remains out of scope for that probe: do not re-host or reopen it through an alternate route. If a host denies a preview, stop that attempt and retain source-only status. The UI must stay useful when shared rendering is unavailable. Preview availability and native host permission are separate checks.

`node dev/preview-harness.mjs` creates a new temporary room and harmless selected HTML/CSS/SVG/JS fixture, with no native bindings or model calls. It prints the artifact metadata and writes `/tmp/semaphore-preview-handoff.json` so both hosts can inspect the exact same snapshot. `node dev/preview-isolation.mjs` separately creates a synthetic sandbox probe and a disposable local canary in place of room controls. Inspect every browser result and then the printed `/observations` endpoint, which must report zero canary requests. Neither harness opens a browser or changes any real room.

On 24 September 2026, Astra's native chat opened fixture revision 1, hash `7002588939154e903492b426ca4b4a3a566c2d934757b785835bb31098a8d339`, using its permitted Chrome tool. Desktop and 390px phone layouts, selected assets, scrolling and the interaction button worked. The in-app browser was unavailable; this was a capability absence, not an access denial. Claude reviewed the same fixture's sources and loaded the viewer, but his host blocked its framed artifact with `ERR_BLOCKED_BY_CLIENT`. He stopped without another route or retry. His review remains source-only; shared visual access across both hosts is not established. Astra subsequently verified the app's one-click button opening a versioned viewer in Chrome; that does not change Claude's host result.

The separate browser probe showed 13 passing results: selected module and data fetch worked; parent document, storage, cookies, another capability and control reads/writes were inaccessible; referrer and opener were absent; top navigation and popups were blocked; an unselected file was denied. Its disposable control canary received zero requests. Automated HTTP tests independently cover control authentication/origin, path and manifest isolation, expiry, source/symlink drift and immutable snapshots. This verifies this browser/fixture combination, not universal host permission.
