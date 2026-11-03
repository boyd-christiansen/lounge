# Design review

Reviewed 2026-11-02 against Benji Taylor’s [Stageshow](https://benji.org/stageshow).

Stageshow concerns product illustrations and demos. Its applicable principles are intentional framing, restrained detail, clear visual hierarchy, and motion tied to a visible cause. Its advice to replace secondary demo text with placeholder lines does not apply to a working app: decisions, approvals and alternatives must remain complete and readable. Demo chrome and scripted cursors also have no place in the actual room.

## Audit

| Area | Finding | Decision |
| --- | --- | --- |
| Room | The landscape and single scene provide a quiet, recognizable identity. | Keep the full-window composition and native window chrome. |
| Entrance | Space previously chose a task before the user expressed an intention. | Open a brief spoken greeting, with the next step expressed through voice or chat. No written question or workflow buttons compete with the conversation. |
| Hierarchy | Long first-visit context could compete with the immediate decision. | Keep return visits short. Keep actual alternatives outside the summary budget. |
| Queue | Controls and source metadata can become crowded. | Retain a vertical drawer, expose management on demand, keep task title strongest. |
| Settings | Many capabilities compete for space. | Keep progressive disclosure; preserve the four existing groups. No dashboard or second navigation system. |
| Motion | Re-rendering can look like unrelated movement. | Keep scene arrival brief; use transitions for explicit navigation. New results wait in the queue; they cannot replace the entry screen. Respect reduced motion. |
| Identity | A generic browser symbol did not identify the desktop app. | Use a two-color chair mark in the Dock and browser favicon. |

## Verification standard

Check the actual sequence: welcome → Space → greeting → capture or queue → result/decision → next task. Check drafts, overflow, keyboard focus, narrow windows and reduced motion as well as settled screenshots. Use synthetic task text for public images. Keep source ownership, approval meaning and exact alternatives visible when they affect the next action.

## Follow-ups

Improve plain-language bridge question detection beyond a final question mark; continue to send unsupported approvals to their source app. Longer menus and settings should be checked against larger accessibility text sizes. Neither change justifies adding permanent panels to the room.
