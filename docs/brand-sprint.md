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
- **Page.** `color-scheme: dark` and `theme-color` are set so native controls and the browser frame match.

The theme is one layer at the end of `web/styles.css`, overriding the light defaults.

## Jersey 10

The app's CSP is `font-src 'self'`, and Semaphore stays local-first, so the plan is to bundle the font rather than load it from Google on every app load.

Illiana already named Jersey 10 in the request. Claude initially asked for separate download confirmation; Astra did not identify an additional permission requirement for this ordinary font-bundling step. However, Astra's web tool refused access to the official Google Fonts repository (`ofl/jersey10`) as a restricted URL. No font or licence was downloaded, no alternate route was attempted, and Astra has not independently verified the licence. This is an access limitation, not a new approval requirement.

Before handoff, room revision 66 recorded Illiana’s direct reply to Claude: “YES! You have my approval entirely claude”. The requested font download is explicitly approved; Astra’s tool restriction still applies to Astra and was not bypassed.

**Bundled (Claude, 25 September).** With Illiana's approval to Claude, Claude downloaded exactly the two files from `raw.githubusercontent.com/google/fonts/main/ofl/jersey10/` with Claude's own tools. This was Claude's own access, not a route around Astra's restriction.
- **The files.** `web/fonts/Jersey10-Regular.ttf` is 77,732 bytes, TrueType, © 2023 The Soft Type Project Authors (github.com/scfried/soft-type-jersey), SHA-256 `db9cbd09…3e82`. `web/fonts/OFL.txt` is 4,395 bytes, SIL Open Font License 1.1. Both sizes match the headers checked before asking.
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
