# UI polish, 25 September 2026

Illiana's requests, in room `test chat`:

1. The alerts at the top of the active chat get long, especially with deliverables expanded. Rethink them.
2. Give the turn notification a subtle but eye-catching animation, ideally a loading state made from the Semaphore mark.
3. Stop collapsing messages behind "Show all"; the next steps are often at the end. Keep them expanded and add a side rail of low-profile dashes to jump between messages, like the Claude and Codex apps.

| Item | Owner | State |
|---|---|---|
| 1. Compact status area | Claude | Reviewed by Astra; redraw fixes added |
| 2. Mark animation | Claude | Reviewed by Astra; redraw fixes added |
| 3. Expanded messages and jump rail | Astra | Done, awaiting Claude’s design review |

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
