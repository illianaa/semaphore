# UI polish, 25 September 2026

Illiana's requests, in room `test chat`:

1. The alerts at the top of the active chat get long, especially with deliverables expanded. Rethink them.
2. Give the turn notification a subtle but eye-catching animation, ideally a loading state made from the Semaphore mark.
3. Stop collapsing messages behind "Show all"; the next steps are often at the end. Keep them expanded and add a side rail of low-profile dashes to jump between messages, like the Claude and Codex apps.

| Item | Owner | State |
|---|---|---|
| 1. Compact status area | Claude | Reviewed by both; live in 0.5.0 |
| 2. Mark animation | Claude | Reviewed by both; live in 0.5.0 |
| 3. Expanded messages and jump rail | Astra | Reviewed by Claude; live in 0.5.0 |

## 1 and 2: compact status area and mark animation (Claude)

- **Rows.** People and the reply limit share one row. The limit's one-line explanation moved to a tooltip and a screen-reader description. The connection notice is a single slim line.
- **Status bar.** It is one compact bar, with a note on a second line only when one exists. A **Deliverables** pill ("Deliverables · 1 ready") replaces the panel.
  - The pill opens a popover over the conversation, anchored under the bar, right-aligned on desktop and full-width on narrow windows.
  - Opening moves focus to its close button. Escape, the close button, an outside click or a room switch close it, and Escape and × return focus to the pill.
  - New ready work adds a small dot to the pill instead of opening anything.
  - Outside clicks are detected through `event.composedPath()`, because the pill redraws the bar during its own click.
- **The mark as the turn signal.**
  - While an AI holds the stick, the inline Semaphore mark takes that AI's colour, and its three bars wave in sequence.
  - When the stick comes back to the person, the mark pops, pings three times, and a single soft sweep crosses the bar. This plays once per handoff; later redraws stay still. A DOM observer confirmed the "working", then "arrived and ping" sequence.
  - During an approval wait, the mark is still, on the amber bar.
  - With reduced motion, every animation is off.
- **Harness checks.** 1280×800, 375×812 and the 420×720 Companion view. At 1280×800 the messages now start at 333 px, with the popover closed. On narrow windows the bar's buttons wrap, all inside the bar, and the popover goes full width. No horizontal overflow anywhere. 169 tests pass.

## 3: expanded messages and jump rail (Astra; Claude reviews the design)

- **Expanded messages.** Render every message in full. Remove `messageText` folding, `state.expanded`, the Show all/less handling and their styles.
- **Placement.** A slim `nav` rail (`aria-label="Jump to a message"`) overlays the right gutter of the message area, just left of the scrollbar, outside the scrolling content. It is vertically centred and at most about 60% of the area's height.
- **Dashes.** One per message, in order, 2 px tall. The person's messages are about 16 px wide and the AIs' about 10 px. The resting colour is a quiet `#cfd7c6`. On hover, and for messages currently in view, a dash takes its speaker's colour: `#293e35` for the person, `#a5694d` for Claude, `#476958` for Astra. The gap is clamped between about 2 and 8 px to fit the rail.
- **Preview.** Hover or focus shows a small card to the dash's left: speaker, time, and about the first 80 characters, as escaped plain text.
- **Jump.** Click or Enter scrolls the message to the top of the area and briefly tints it. Use `behavior: "auto"` under reduced motion.
- **Accessibility.** Each dash is a `button` labelled "Claude, 4:09 PM: first words…". Up and Down move between dashes.
- **Tracking.** An `IntersectionObserver` on `#message-scroll` marks the dashes of messages in view. Rebuild and re-observe after every message render, and keep the rail stable during polling.
- **When to hide it.** With fewer than about 4 messages, when the message area is shorter than about 200 px, and at 760 px wide or less, including the Companion view.

## Astra implementation and review, 25 September

- **Messages stay expanded.** Removed all folding state, fade masks and Show all/less controls. Message markup is kept intact during status-only updates, preserving the reading position and text selection; a forced title/status redraw no longer sends the reader back to the bottom. Opening a room follows its final paragraph after the composer finishes sizing (verified within one pixel of the bottom).
- **Rail implemented.** It sits outside the scrolling conversation with 2 px dashes, wider human marks and speaker colours for visible messages. Hover/focus previews use plain text, not HTML. Click/Enter jumps with a brief tint; Up/Down and Home/End navigate a single tab stop, Escape moves focus into that message. Reduced motion uses an immediate jump and no transition.
- **Visibility and long conversations.** The rail hides below four messages, below 200 px of message height, at phone widths, in Companion, and when the message column is narrower than 400 px. At large message counts it scrolls internally, retains every message and follows the current reading position unless the user is interacting with it. It rebuilds only when rendered messages change; IntersectionObserver tracks visibility and ResizeObserver tracks available space.
- **Status review and fixes.** Claude's compact area and animation are approved with redraw fixes. An unchanged status or deliverables render keeps its DOM. A continuing logo animation retains its element through note/pill updates; the arrival stays for its finite animation instead of ending on the next redraw, and does not leak into another room. Focused status controls survive redraws. Updated deliverable cards preserve expanded file details, scroll position and the relevant focus; Escape/× return to the pill and outside clicks retain focus on the clicked control. Home and room navigation close the popover.
- **Native browser checks.** In a disposable root with no wake pump or native delivery: 60 fully expanded messages, exact jump alignment, current-message tracking, pointer and keyboard activation, Home/End through 300 messages, literal `<script>` in a plain-text preview, and preserved rail focus through a synthetic working → human transition. A changed artifact retained its open disclosure and focused summary. Opening deliverables left message height unchanged (337 px at 1280×800). Escape and outside-click dismissal passed. The working mark used `signal-wave`, then changed to `signal-ping` on arrival and kept that state through a pill redraw. Reduced-motion behavior was checked in source, not by changing the person's OS settings.
- **Responsive checks.** 375×812 kept 218 px for messages and the composer visible; 420×720 Companion kept 261 px. Neither had horizontal overflow, and both hid the rail. A 137 px desktop message area hid it; a two-message conversation hid it too. The three room fixtures also confirmed independent room navigation.
- **Validation.** All 169 automated tests pass; `node --check web/app.js` and `git diff --check` pass. Browser QA uses `/tmp/semaphore-polish-ui.mjs` and `/tmp/semaphore-polish-change.mjs`; the harness is disposable and does not touch real rooms. The temporary server and browser tab were closed, and viewport overrides reset. Claude's final design review and 0.5.0 staging/cutover follow. The live app remains 0.4.0 during review.
- **Long idle accepted.** This legitimate handoff woke Astra after 21+ hours idle, once, without a listener or manual Send. Exact stages and remaining native acceptance boundaries are recorded in `docs/instant-wake.md`.

## Claude design review, 25 September

- **Approved.** The rail matches the spec: quiet dashes, wider ones for Illiana's messages, speaker colours in view and on hover, a plain-text preview card, and a single tab stop.
- **Checked in the disposable harness at 1280×800.**
  - 60 expanded messages open at the final paragraph.
  - The preview card for message 29 read "Claude · 1:15 PM" with its opening words.
  - A click jump placed message 29 exactly at the top of the message area, after a long smooth scroll of about 14,000 px, and tinted it.
  - 300 messages give a 4 px step and a rail that scrolls internally. A 2-message conversation hides the rail.
- **Redraw fixes approved.** Markup diffing leaves unchanged status and cards alone, the animating mark keeps its element, focus is restored, and the arrival plays once per handoff without leaking across rooms.
- **0.5.0.** The version is bumped for the release; the release is staged from `59df114` plus this bump and this note.

**Release complete.** 0.5.0 is live and the final same-chat wake and live UI checks passed. See [the cutover record](releases.md) for release identity, backup and verification.

## Round 2: Companion first (Illiana, 25 September)

Illiana's requests:
- Bring the polish to Companion, now her primary window.
- Move "Check in after" to where the Enter/Shift+Enter hint was, smaller, and drop the hint.
- Let the chat run to the top, with the alerts hovering over the messages instead of taking their own space.

| Item | Owner | State |
|---|---|---|
| Floating alerts and chat to the top | Claude | Reviewed by Astra; jump/visibility fixes added |
| Reply limit in the composer caption | Claude | Reviewed by Astra; save/focus fixes added |
| Companion spacing | Claude | Approved by Astra |
| Rail in Companion | Astra | Done, awaiting Claude’s design review |

- **Floating alerts (Claude).** The connection notice and status bar now sit in `#room-alerts` inside `#message-area`: absolutely positioned, translucent, blurred, with a soft shadow. The conversation runs up to the header. A ResizeObserver writes the overlay's height to `--alerts-height`, and the messages pad their top by it, so the first message starts just below the alerts. The Deliverables popover still anchors under the bar. The rail centres in the space below the alerts (`sizeMessageRail` subtracts their height).
- **Reply limit (Claude).** A small "Check in after [4 replies ▾]" select replaces the keyboard hint in the composer caption. It redraws only when its value or room changes, so polling never closes it, and a failed save restores the saved value. The explanation stays as a tooltip and a screen-reader description.
- **Companion (Claude).** The empty controls row is hidden and the top padding is 6 px. On narrow windows the floating card uses small buttons and drops the your-turn help text, which the buttons make redundant. At 420×720, messages went from 261 px to 463 px and the card from 125 px to 78 px.
- **Harness checks.**
  - At 1280×800: messages 389 px (from 337); the popover opens over the conversation; the limit saved 10, then 4, through the server; scrolled to the top, the first message starts at 282 px, below the alerts at 274 px.
  - No horizontal overflow; 169 tests pass.
- **Rail in Companion (Astra, next).** Enable the rail in Companion, perhaps slimmer, since Companion is Illiana's main window. Today it's hidden by the `companion` flag and the 400 px and 760 px checks. Keep phones without it.


### Round 2 implementation and review (Astra)

- **Companion rail.** Companion now gets the same message navigation with a 20 px hit strip, 8 px AI dashes, 12 px human dashes and 28 px message gutter. The 210 px plain-text preview sits above or below the selected dash, clamped into the unobscured message area. Ordinary narrow/touch layouts outside Companion still hide the rail. Companion hides it below 240 px of message width or 200 px of unobscured message height, and all modes hide it below four messages.
- **Overlay review: approved with corrections.** DOM order puts the status and deliverables before messages; existing status announcements, native buttons and popover focus/dismissal behavior remain. Jumps and scroll padding now account for the floating alert height, placing the target 8 px below the card. IntersectionObserver excludes that covered region and refreshes its root margin when the card changes size, so hidden text isn't marked visible. A near-zero threshold also clears a previous message that only touches the viewport edge. The deliverables popover is capped to the remaining message height so the composer remains accessible in the tested sizes.
- **Limit review: approved with corrections.** The labelled native select remains mounted through polling, saves and room switches. The description remains attached with `aria-describedby`. Only one save per room can be in flight; the control is disabled while saving to prevent out-of-order writes, then restores focus only if the person hasn't moved elsewhere. A failed save restores the saved value. Responses for a room left behind cannot change the new room's selector or steal focus.
- **Browser checks.** A disposable app with synthetic rooms and no native delivery exercised Companion at 420×720 and 320×720. The rail stayed visible, previews stayed within the message area, and there was no horizontal overflow. At 420×720 the message area was 463 px with a 78 px card. Jumps landed at y=152 below the card's y=144 bottom; after a long working note increased the overlay to 190 px, jumps adjusted to y=264 below y=256. A 300-message Companion conversation supported Home/End and Enter through its internally scrolling rail. A two-message room hid it. Desktop 1280×800 retained a 389 px message area and placed jumps 8 px below the card. Ordinary 375×812 mode hid the rail and had no horizontal overflow.
- **Save checks.** A successful change to 10 survived polling; a deliberately rejected change to 20 restored 10, re-enabled the control, displayed the refusal and restored keyboard focus. A deliberately delayed save to 20 followed by navigation to a second room left that room at 4; returning to the first showed its saved 20. The popover remained within the message area after a long note, and its close button retained the existing focus behavior.
- **Validation and handoff.** All 169 automated tests pass; syntax and whitespace checks pass. Harnesses: `/tmp/semaphore-companion-ui.mjs` and `/tmp/semaphore-companion-change.mjs`; the response-mode file supports normal/fail/delay for the disposable limit route. The temporary server and tab were closed and browser sizing reset. Changes remain in the worktree until Claude's final review and a reviewed 0.6.0 cutover; live remains 0.5.0.
