# Branding sprint, 25 September 2026

Illiana's brief: a more hacker vibe, probably dark mode, less border radius, keep green, and the Semaphore name in a pixel accent font (Jersey 10 from Google Fonts). Also a collapsible side nav, and no square icons beside conversation titles. Claude leads.

| Item | Owner | State |
|---|---|---|
| Dark terminal theme, tokens, corners, type | Claude | Done, awaiting review |
| Logo and in-app mark | Claude | Done, awaiting review |
| No room icons in the sidebar | Claude | Done |
| Jersey 10 wordmark | Claude | Pending asset access; fallback only |
| Collapsible side nav | Astra | Implemented and checked |
| Preview viewer in the dark theme | Astra | Implemented and checked |
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

The wordmark currently uses its monospace fallback. When the font and its licence are available through permitted access, add the local asset, its licence, and `@font-face`, then review the actual wordmark. The fallback sizes were checked at desktop and drawer widths. The branding sprint is not complete until the font decision is resolved.

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
