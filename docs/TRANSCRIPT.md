# Local conversation view

`RoomStore.save()` first commits and syncs `room.json`, then atomically replaces `transcript.html` using `lib/transcript.mjs`. The HTML is a derived view and never drives delivery or ownership. Rendering errors are retained as `store.transcriptError` and reported as `SEMAPHORE_TRANSCRIPT` warnings; they do not fail an already committed save.

The page includes all shared messages, their speaker and nominated recipient, human relay provenance, participants, the current owner, and pending delivery status. It escapes all message content rather than interpreting it as HTML or Markdown. The output uses owner-only file permissions and has no external dependencies or requests.

Browser JavaScript refreshes the page every five seconds while visible. It preserves the scroll position (following the bottom when already there), pauses while text is selected, and remembers the Auto-refresh checkbox in session storage when available. With JavaScript disabled, manual reload still works. No server or coordinator process is required to keep the page available.

Validation includes ordered attribution and escaping, pending states, atomic view replacement, and a forced view-write failure that leaves the journal committed and recovers on the next save. The earlier live room's view was generated without changing its pending turn. Browser visual verification was blocked because the browser tool does not permit navigating to this local-file URL; it was not bypassed.
