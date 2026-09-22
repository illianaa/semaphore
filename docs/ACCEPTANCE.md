# Desktop release acceptance — 2026-09-22

## Actual native exchange

The development room connected an existing Codex desktop task and an existing Claude desktop Code chat. Neither session was resumed by a second model process.

An earlier `codex queue` test required the person to press Send. It did **not** establish automatic delivery. The release uses durable inboxes by default instead.

The no-click exchange used a fresh marker sent only through the room:

| Event | UTC |
| --- | --- |
| Claude submitted the marker to Astra's inbox | 23:08:32.43 |
| Astra received it in its foreground listener's tool output and acknowledged it | 23:08:41.38 |
| Astra submitted the same marker back to Claude | 23:08:56.65 |
| Claude's background listener woke its chat; Claude acknowledged it | 23:09:14.70 |

Claude subsequently sent its confirmation and implementation handoff through the room. That second Claude reply also arrived directly in Astra's foreground listener. No queue Send action, bootstrap relay, or journal read substituted for receiving either message. Before the exchange, two real five-minute listener waits expired and were restarted without changing the binding or Claude's pending turn.

This proves automatic delivery **while the native listeners are running**. It does not prove wakeup of a closed app, an idle unconnected Codex task, or delivery through the manual queue route.

## Automated verification

The suite covers journal durability, turn ownership, unseen messages, bounded exchanges across processes, exact native identity, duplicate replies and human submissions, interrupted delivery, stale acknowledgments, listener timeout and reconnect gaps, cancellation, transport migration, and replacement-session isolation.

Server checks cover Host, Origin, tokens, JSON/body limits, escaping, stale lock recovery and committed replies whose next delivery fails. Installation checks cover preflight, owned-file removal, custom data homes, asynchronous launchd unload, bounded diagnostics and real macOS launcher compilation. Provider calls in automated tests are simulated; the native exchange above is separate evidence.

## Installed application and distribution

On the development Mac, the real LaunchAgent serves the app, with matching service and health-process IDs. Both native apps loaded the shared skill. The browser view renders the real exchange with attribution and distinguishes acknowledgment from queue acceptance.

A packed release was unpacked into an isolated directory and installed twice against a clean temporary HOME. Its actual AppleScript launcher compiled, its installed command created and read a room, and uninstall removed its owned setup while retaining that room. This test did not register a second real LaunchAgent or install the model providers into a fresh Mac.

The GitHub workflow runs the test suite on fresh macOS and Linux runners with Node 22 and 24, and checks package contents. Runtime conversations and native session IDs are excluded from the repository and package.

## Compatibility limits

Validated locally with Node 23.10, Codex 0.154.0-alpha.6.2 in the ChatGPT desktop app, and Claude Code 2.1.280 in Claude desktop. Live integration is currently macOS-only and depends on native shell/background-task behavior.

The new-chat deep links have been checked against installed app code and their generated prompts have automated coverage. The browser tool refused the Claude custom-protocol link during click-through verification; no alternate execution bypass was attempted. The Copy invitation button was verified to put the standalone invitation on the clipboard. Pasting that invitation into a native chat is the supported alternative connection path. Browser controls cannot inspect the Codex app itself; no visual native-Codex verification is claimed.

See [the historical headless experiment](HEADLESS-ACCEPTANCE.md) for the earlier prototype; it is not evidence for desktop wakeup.
