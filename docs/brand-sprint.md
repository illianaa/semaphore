# Branding sprint, 25 September 2026

Illiana's brief: a more hacker vibe, probably dark mode, less border radius, keep green, and the Semaphore name in a pixel accent font (Jersey 10 from Google Fonts). Also a collapsible side nav, and no square icons beside conversation titles. Claude leads.

| Item | Owner | State |
|---|---|---|
| Dark terminal theme, tokens, corners, type | Claude | Done; reviewed by Astra |
| Logo and in-app mark | Claude | Done; reviewed by Astra |
| No room icons in the sidebar | Claude | Done |
| Jersey 10 wordmark | Claude | Bundled; local serving and render reviewed by Astra |
| Collapsible side nav | Astra | Done; reviewed by Claude |
| Preview viewer in the dark theme | Astra | Done; reviewed by Claude from source |
| Cross-check in Chrome | Astra | Complete for this pass; fixes included |

## Design tokens

- **Surfaces.** Near-black green: `--paper` #0a0f0c, `--sidebar` #0d1310, `--surface` #0f1612, `--surface-2` #141d18, `--surface-3` #1a261f.
- **Lines.** `--line` #1d2923, `--line-strong` #2a3b31.
- **Text.** `--text` #d8e4d9, `--text-2` #a8b8ac, `--text-3` #75877a.
- **Accents.** `--green` #5fd38d is the phosphor accent, with `--accent-ink` #04100a for text on it. Claude is #e39a72, Astra #7fc49b, and approval and attention use amber #e2b35e.
- **Corners.** `--radius` 4px and `--radius-sm` 3px replace the 14–20 px cards and 999 px pills. The avatars are square-ish, and the signal mark is 6 px with 1 px bars.
- **Type.**
  - `--mono` is used for metadata: eyebrows, timestamps, sidebar details, labels, paths, chips and the limit menu.
  - `--pixel` ("Jersey 10", falling back to mono) is the wordmark.
  - Headings are Inter 650 instead of the old serif.
  - Status notes and the composer caption stay in regular type for reading, and notes clamp to two lines with the full text in a tooltip.
- **Mark.** The logo and inline signal are a dark square with a green outline and green bars; they take Claude's or Astra's colours while that AI works. The arrival sweep is a faint green glow.
- **Page.** `color-scheme` and `theme-color` follow the active palette so native controls and the browser frame match.

The theme is one layer at the end of `web/styles.css`, overriding the light defaults. Since 27 September these values are the dark palette; the light one is under [Light and dark](#light-and-dark-27-september).

## Jersey 10

The app's CSP is `font-src 'self'`, and Semaphore stays local-first, so the plan is to bundle the font rather than load it from Google on every app load.

Illiana already named Jersey 10 in the request. Claude initially asked for separate download confirmation; Astra did not identify an additional permission requirement for this ordinary font-bundling step. However, Astra's web tool refused access to the official Google Fonts repository (`ofl/jersey10`) as a restricted URL. No font or licence was downloaded, no alternate route was attempted, and Astra has not independently verified the licence. This is an access limitation, not a new approval requirement.

Before handoff, room revision 66 recorded Illiana’s direct reply to Claude: “YES! You have my approval entirely claude”. The requested font download is explicitly approved; Astra’s tool restriction still applies to Astra and was not bypassed.

**Bundled (Claude, 25 September).** With Illiana's approval to Claude, Claude downloaded exactly the two files from `raw.githubusercontent.com/google/fonts/main/ofl/jersey10/` with Claude's own tools. This was Claude's own access, not a route around Astra's restriction.
- **The files.** `web/fonts/Jersey10-Regular.ttf` is 77,732 bytes, TrueType, © 2023 The Soft Type Project Authors (github.com/scfried/soft-type-jersey), SHA-256 `db9cbd09…3e82`. `web/fonts/Jersey10-OFL.txt` is 4,395 bytes, SIL Open Font License 1.1. Both sizes match the headers checked before asking.
- **Serving.** The server serves `/fonts/jersey-10.ttf` as `font/ttf`. The static handler now reads assets as bytes, so the font isn't corrupted; only `index.html` is edited as text.
- **CSS.** `@font-face` uses `font-display: block` to briefly hide the fallback while the bundled local font loads. Slow or failed font loading can still show the fallback.
- **Size.** The wordmark is 30 px, on Jersey 10's 10 px grid, and replaces the temporary sizes set for the fallback. It is 122 px wide and fits the sidebar at every checked width.
- **Other.** The README credits the font and licence, and a new server test checks the font is served byte for byte.

## Navigation behavior

- The top bar always exposes a split-panel sidebar toggle and a new-conversation button.
- Desktop collapse persists across reloads and synchronizes between tabs. The shortcut is **Cmd+\ / Ctrl+\**. **Cmd+K / Ctrl+K** still starts a conversation.
- Narrow windows and Companion use a temporary drawer independently of the saved desktop preference. This remains true for a Companion window wider than the mobile breakpoint.
- Hidden navigation is inert and marked `aria-hidden`; the toggle announces its expanded state. Opening a drawer focuses search. Escape, outside click, or room selection closes it; focus returns to the toggle when the focused sidebar content becomes hidden.
- The drawer sits above floating status and offline notices. Reduced-motion preference disables the transition.

## Astra's cross-check and fixes

Chrome checks used disposable rooms, stub wake/diagnostics providers, and no native delivery. Main-window widths were 1280 and 1050; Companion was checked at 420×720 and at width 900; phone drawer navigation was checked at width 375, and the guided-start layout at 320×720.

- Desktop collapse/reload, both keyboard shortcut modifiers, focus restoration, and new conversation while collapsed passed. Companion drawer opening, Escape, room-selection close, and independence from the saved desktop preference passed. No horizontal page overflow in the checked layouts.
- Guided-start seat cards, section headings, and dividers retained light defaults. They now use dark tokens and readable text. The setup footer divider and diagnostic icons also use theme tokens.
- The setup dialog and synthetic wake-on card render in the dark palette. Synthetic approval, failed-action toast, offline banner, and recovered connection were checked; the drawer stays above them. This does not replace the outstanding real native approval exercise.
- At phone width the composer hint and limit control competed for one row, leaving the hint nearly one word wide. They now stack below 520 px; the corrected 320 px layout was checked.
- The preview wrapper uses dark surfaces, square corners, green selection, and monospace metadata. A new disposable HTML palette sample rendered in Chrome, retaining its own white canvas; Desktop and Phone controls worked, with Phone setting the frame to 390 px. CSP, sandbox, capability grants, routes, and artifact bytes are unchanged.
- **Automated checks:** all 169 tests passed (32.15 seconds). JavaScript syntax and `git diff --check` passed. Subsequent changes were CSS, HTML indentation, and this documentation.

Temporary QA servers were stopped, the owned browser tabs closed, and the viewport override reset after the checks. No release was built or deployed in Astra's pass. Claude's final design review and the font decision remain.

## Claude's initial checks

- **Main window at 1280×800.** The welcome screen, a 60-message conversation, the floating status, the Deliverables popover, and the members and setup dialogs.
- **Companion at 420×720.** An Astra-working state with a long note: the card is 114 px with the note clamped, the rail is visible, and there's no overflow.
- **Tests.** 169 pass.

## Claude's review of Astra's pass, 25 September

- **Approved.**
  - **Collapsible sidebar.** It collapses to 0 px and becomes inert. The collapsed state persisted across a reload, with the toggle reading "Show sidebar". ⌘\ and Ctrl+\ both work, and the collapsed layout gives the conversation the full width, with the toggle and "+" in the top bar.
  - **Guided-start and setup fixes, and the composer footer at 320 px.** Good.
  - **Preview viewer.** Reviewed from source only: Claude's host blocks framed previews, and no preview was reopened.
- **Claude's follow-up fix.** At medium widths (about 800 px), three buttons squeezed "Your turn · …" into a five-line column. The floating status now keeps at least about 260 px for its text and wraps its buttons below: 83 px tall at 800×500.
- **Tests.** 170 pass, including the new font test.

## Astra’s final review, 25 September

The static route serves the local TTF as bytes and keeps HTML token substitution working, with the existing CSP and origin checks unchanged. The bundled font is 77,732 bytes with SHA-256 `db9cbd091617048a145d249daa2b815fe7083be6ab66ac26626e21a4e01c3e82`; the adjacent OFL text and README attribution are included in the release file list. Astra inspected these local files, without another external fetch.

Chrome rendered the pixel wordmark in the 220 px sidebar at 800×500. The status text uses a readable row with buttons below (83 px card), and the page has no horizontal overflow. The final review approves Claude’s font-serving change and medium-width layout fix.

Astra reran the complete suite: **170 passed**, zero failed (31.37 seconds). Final review fixtures were stopped, the browser tab closed, and its viewport override reset. Version 0.7.0 is prepared for the app-only cutover; its outcome is recorded separately in `docs/releases.md`.

## Tweaks after 0.7.0 (Illiana, 25 September)

Requests: one focus ring on the composer, Outfit as the main font, richer markdown in agent messages (links don't work), "Stop after" instead of "Check in after", and a centred + in the top bar.

| Item | Owner | State |
|---|---|---|
| Single composer focus ring | Claude | Done |
| "Stop after" wording | Claude | Done |
| Centred top-bar + | Claude | Done |
| Outfit as the main font | Claude | Pending font implementation |
| Richer markdown with safe links | Astra | Implemented and checked; awaiting Claude review |

- **Focus.** The composer keeps its green border and 3 px glow; its textarea now draws no outline of its own.
- **Stop after.** The caption reads "Stop after [4 replies ▾]". The no-limit option reads "Never", so it scans as "Stop after: Never". The help says they stop after N AI replies in a row and hand the stick back, or have no automatic reply limit while still allowing either AI to return the stick. The README matches.
- **Top bar.** The + was a full-width text glyph ("＋") beside an SVG toggle. It is now an SVG in the same 19 px box and stroke, and the toggle, the + and the title all centre at y=37 at 800×500.
- **Outfit.** `Outfit[wght].ttf` (110,884 bytes, a variable font) and `OFL.txt` (4,389 bytes) from github.com/google/fonts, `ofl/outfit`. Illiana explicitly requested Outfit. Claude asked a separate download question; the implementation remains with Claude under Claude's normal tool rules.
- **Tests.** 170 pass.

## Astra’s Markdown and UI review

Implemented in `web/render.mjs`, with no added dependency. The renderer parses a bounded Markdown subset and escapes every text or attribute value before emitting HTML; generated markup is not reparsed.

- Inline links, angle links, and bare HTTP(S) URLs work; explicit `mailto:` links are supported. Only absolute HTTP(S) and mailto targets become anchors, with `target="_blank" rel="noopener noreferrer"`. Unsafe schemes, file paths, and relative paths stay text. Bare URLs exclude trailing prose punctuation and preserve balanced parentheses. Nested labels and optional link titles work. Image syntax produces a link, with “Image” for empty alt text, never a remote image.
- Code spans (including multiple backticks) and fenced blocks remain literal. Backtick and tilde fences are supported; an unclosed fence preserves the remaining text as code. No links or emphasis are parsed inside code.
- Paragraphs can flow directly into headings, unordered/ordered lists, quotes, and tables without blank separators. Lists support bounded nesting and ordered starts. Headings #–### become h3–h5. Emphasis, bold, combined emphasis, strikethrough, escaped punctuation, and existing mentions are supported; underscores inside identifiers remain literal.
- Simple pipe tables support alignment, escaped pipes and code in cells, with a focusable horizontal scroll region. New dark styles cover links, headings, quotes, rules, nested lists, strike, and tables. Table headings stay on one line.
- Work budgets and bounded recursion keep pathological unmatched/nested syntax from monopolizing rendering. Reference links, raw HTML, embedded media, and full CommonMark/GFM compatibility are not claimed.

**Checks.** All 178 tests passed in 31.08 seconds, including eight added renderer cases for hostile link/HTML input, literal code, nested labels, punctuation, mixed blocks, tables and large malformed input. A final empty-image-label fallback was followed by another passing 9-test renderer run. Syntax and diff checks passed.

Chrome used a disposable room with no native delivery. At 1280×900 the message’s links, nested lists, emphasis and headings rendered correctly. A local link opened the expected room in a separate tab; every anchor had the intended target/rel, code had zero links, and hostile examples created no script, image or event-handler element. At 420×720 and 320×720 Companion stayed within the viewport while the table scrolled internally; ArrowRight moved its horizontal scroll by 40 px. Both message and home composers had no inner outline and retained the outer green glow. The sidebar icon, plus icon and title shared the same vertical center (25.5 px in Companion). “Stop after” and “Never” rendered correctly; the no-limit tooltip was clarified to avoid implying an AI cannot voluntarily return the stick.

The scratch server and browser tabs were closed, and the viewport override reset. Claude’s first three tweaks pass Astra’s review. Outfit and Claude’s final Markdown/design review remain before the proposed 0.8.0 release; nothing from this pass is deployed yet.

Before handoff, revision 73 recorded Illiana’s “yes!” to Claude’s Outfit download question. The requested download is explicitly approved; no further confirmation is pending.

## Outfit and Markdown review (Claude), 25 September

- **Outfit bundled.** Illiana approved the download, and Claude fetched exactly the two files from `google/fonts`, `ofl/outfit`.
  - `web/fonts/Outfit-Variable.ttf`: 110,884 bytes, a TrueType variable font (weights 100–900), © 2021 The Outfit Project Authors, SHA-256 `fc728727…aeade`.
  - `web/fonts/Outfit-OFL.txt`: 4,389 bytes, SIL OFL 1.1. Jersey's licence is now `web/fonts/Jersey10-OFL.txt`.
  - It is served at `/fonts/outfit.ttf`, and `@font-face` declares the full weight range with `font-display: swap`.
  - Outfit is the root typeface and the heading face. Mono stays for details and Jersey 10 for the wordmark. The README credits both fonts, and the font test now checks both files byte for byte.
- **Emphasis.** Outfit has no italic and `font-synthesis: none` was set, so `em` looked upright. `em` now allows a synthesized slant.
- **Markdown: approved.** Astra's sample, run in a disposable harness at 1280×900:
  - **Links.** Five links rendered, all http(s) with `target=_blank rel="noopener noreferrer"`. No script, img or iframe elements and no `on*` attributes. `javascript:` and raw `<img>` stay text, and code spans and blocks stay literal.
  - **Blocks.** Headings, strikethrough, snake_case, one nested list level and an ordered list starting at 3 all render. The aligned table scrolls inside its own box in Companion at 420×720, with no page overflow.
- **0.8.0.** The version is bumped for the release. 178 tests pass.

## GPT naming, colours and connection alerts, 26 September

Illiana requested GPT as Astra's display name, white for GPT, bright green for human rail marks, and accurate alerts with automatic wake.

Claude implemented the display changes: web labels now say GPT; the seat ID, commands, transports and native envelopes still use Astra/`astra`. Both `@GPT` and `@Astra` select that seat. GPT's avatar, selected reply chip, working mark and status tint use black and white. Rail colors are human `#5fd38d`, GPT `#f2f2f2` and Claude `#e39a72`.

A real missed handoff exposed why simply hiding the listener warning was insufficient. Claude observed a verified chat absent from the loaded list, although the old API called that state `reconnect`. Astra replaced that ambiguous classification with separate `automatic`, `unloaded`, `reconnect`, `off`, `checking`, `unavailable` and `listening` states. A complete, recent engine inspection is required before claiming automatic wake or diagnosing unloading/reconnection. The UI uses the ordinary room poll; no separate cached global switch decides its advice.

The member badge, pending-turn banner and Manage members explanation agree. An unloaded chat offers Open chat. Stale verification explains reconnecting inside the existing chat. Disabled or unavailable wake offers Check setup. A received turn reads working in ChatGPT and suppresses listener/reconnect warnings; paused queues and uncertain sends retain their own recovery advice. Setup also acknowledges that a chat put to sleep by ChatGPT may need opening.

Astra's review: 181 tests pass. In a disposable browser fixture at 1280×800, the requested colors and GPT labels rendered correctly, the misleading listener alert was absent, and polling changed unloaded to automatic without reloading. Open chat targeted the existing bound chat; Check setup opened the setup dialog. Manage members showed the correct automatic, unloaded, reconnect and working descriptions. At 420×720 Companion, the reconnect banner and actions fit without horizontal overflow. Native Send advice retained priority, then cleared on receipt. The Off state offered Check setup without a listener warning, and typing `@GPT` selected GPT while the human composer remained usable during its turn. No real delivery, native resume or engine changes were used for these UI tests.

The wake-client allowlist and queue behavior are unchanged. Opening the existing native chat is still the supported recovery for an unloaded chat. See [instant wake](instant-wake.md#unloaded-chat-and-accurate-connection-states-26-september-2026) for evidence and limitations. Review is ready for Claude; 0.9 has not been released by Astra.

**Claude's review of 354e966, 26 September.**
- **Approved.** The server-derived wake states are the right model. `off`, `checking` and `unavailable` never pose as `unloaded` or `reconnect`, `automatic` needs a fresh, complete inspection, and a received turn takes precedence.
- **One copy change.** The idle `unloaded` member badge read "open chat to wake", a call to action with nothing waiting. It now reads "asleep in ChatGPT". The pending detail, "open it to continue", and the _Open chat_ action still appear when a GPT turn is actually waiting.
- **0.9.0.** The version is bumped for the release.

## Light and dark, 27 September

Illiana asked for three changes: light and dark modes that follow the system by default, with a top-right toggle cycling System → Light → Dark; no "Workspace /" before the chat title, because a user wondered which workspace they were in; and _Stop after_ on the new-chat screen too.

**Themes (Claude).**
- **Palettes.** Every colour in the brand layer is now a token, with a dark and a light palette. The dark values are exactly the old ones: the refactor checked each replaced colour against its dark token, and rules that later rules had fully replaced were removed.
- **Light palette.** The same brand on paper: `--paper` #fafbf9, `--surface` #ffffff, `--text` #0e1812. Buttons keep a bright green fill (#34c472) with dark ink. Green used for text, links, focus and your rail marks is deeper (`--green-text` #13773d, 5.4:1 on the page). Claude's text is #b0552c and amber #8a5a00, both at least 4.5:1. GPT turns black (#111) with white on its avatar. Toasts invert. The logo and working marks keep their dark tiles in both themes, like the app icon.
- **Before the first paint.** `web/theme.js` is a small classic script in `<head>`, served same-origin like the other assets, so the strict CSP still allows no inline script. It resolves the saved choice (`semaphore:theme`: light or dark; none means System) against `prefers-color-scheme` and sets `data-theme` and `data-theme-preference` on `<html>`. It follows system changes while on System, and other Semaphore windows through the `storage` event. The button's icon comes from CSS, so the right one shows before the app script runs. During a switch, transitions are paused for two frames so the page changes all at once.
- **Toggle.** The last item in the top bar, in Companion too: a monitor, sun or moon for the current choice, with a label such as "Theme: System (dark). Switch to Light".

**Title.** The top bar shows only the conversation's name ("New conversation" on the start screen). Companion hides the large heading, so the top bar keeps the name there.

**Start screen limit (Claude, including the small server part for Astra to review).**
- The start box now has the conversation composer's caption: the Enter hint on the left and _Stop after_ on the right. Companion hides the hint but keeps the menu.
- The choice travels in the start request as `maxTurns`: an integer from 1 to 20, `null` for Never, or omitted for the default of 4. It is part of the request identity, so a retry must repeat it, and the room's first exchange uses it. The menu resets to 4 after each start, and until then it is kept with the draft.

**Fixed along the way.** A closed sidebar drawer (Companion and narrow windows) cast its shadow into the window's left edge. That shadow was invisible on the dark theme and grey on light. The drawer now casts it only while open.

**Checks.** 182 tests pass, with a new server test for the start limit (Never, 10, default, retry conflict, invalid values, and the first exchange). In a disposable harness, a colour audit of every visible element on the home screen, all five fixture rooms and Setup found only the intended dark marks in light mode and only the intended bright fills in dark mode. The layouts were checked at 1280×820, in Companion at 420×720 and at phone width (375 px), with no horizontal overflow. The toggle cycled and was remembered, and a Companion window followed the main window. Starting a chat with _Never_ created it with no limit, and the start menu went back to 4.

## False “Claude isn’t listening”, 27 September

Illiana saw “Claude isn’t listening” while Claude was listening. It cleared by itself about 90 seconds later, when Claude acknowledged her message. The live room's timing confirmed the cause: her turn was queued at 19:41:34.096Z. Claude's listener handed it to the chat at 19:41:34.578Z and exited, as a listener does once it delivers. The chat acknowledged it at 19:43:06.466Z; it was compacting its context. The app read “no listener process” as “not listening” for the whole gap.

- **The fix (web only).** A seat isn't flagged when its listener has already handed it the current turn (`pending.timing.listenerObservedAt`, recorded by the listener). The status then reads “starting in the Claude app” instead of “waiting in Claude's inbox until its chat listens again”. A seat also isn't flagged for 90 seconds after its own last reply, which is the time a chat takes to restart its listener. That pause is part of the render signature, so the alert returns on the next poll if no listener starts.
- **Checks.** In the harness:
  - A queued Claude turn with no listener and no handoff still shows the alert.
  - With the handoff recorded, the alert goes away and the status reads “starting in the Claude app”.
  - A reply 20 seconds old with no listener shows no alert; the same room after 90 seconds shows it again.
- GPT's seats keep their own wake states.

### Astra's 0.10 review, 27 September

The title simplification, start-screen limit and theme implementation pass review. Server-side request identity preserves omitted limits for older clients. One upgrade edge case needed a fix in the browser: a persisted pre-0.10 start request would otherwise get a new ID when its fingerprint gained `maxTurns`, potentially creating a duplicate after a lost response. `web/start-request.mjs` now preserves the old ID and omitted field when retrying that unchanged default-limit draft; changing the selected limit creates a new request. Two regression tests cover legacy and current retries.

All 184 tests pass. Disposable Chrome checks independently verified the light home screen, creating a chat with Never, theme synchronization across two windows, the System → Light → Dark cycle, and Companion at 375×720 without overflow. A queued Claude turn without a listener raised the expected warning; recording listener pickup cleared it and showed “starting in the Claude app” before receipt. Native approvals and delivery acknowledgment remain separate from this advisory observation.

The requested release preserves the existing explicit Reply next semantics. Claude's proposed reinterpretation of selecting the current holder is a separate product decision, not part of the title/theme/limit/alert changes.
