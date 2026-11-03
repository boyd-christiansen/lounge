# Design review

Reviewed 2026-11-02 against Benji Taylor’s [Stageshow](https://benji.org/stageshow) and its more specific [craft reference](https://github.com/benjitaylor/skills/blob/main/stageshow/references/craft.md).

The first review described intent without measuring the controls or checking enough interaction states. That missed the mismatched glyphs, faint small text, shifting hover previews, and settings alignment. This revision records the actual components, changes and checks.

Stageshow is a guide to product demonstrations. Its useful lessons here are a clear reading hierarchy, deliberate spacing, consistent icons, restrained surfaces and inspection between states. Demo placeholders, scripted cursors and imitation window chrome do not belong in the working application. Real questions, choices and approvals retain their full meaning.

## Room and controls

The full-window landscape, spoken entrance and left drawer remain the main composition. Space starts the greeting and composer; opening questions and workflow choices are expressed through conversation. The drawer overlays the room and never turns it into a dashboard.

| Finding | Change | Check |
| --- | --- | --- |
| Read-aloud and fullscreen used unrelated text glyphs with different baselines. | Pinned Heroicons outline assets, a shared 24px source grid and 1.5px source stroke. Main controls render at 18px inside 32px targets. | At 1280×720, both header targets and icons have center Y=44px. |
| Microphone and Send used different visual conventions. | Matching target dimensions and the same outline family. Recording remains an explicit state; it never stops on silence. | Both composer targets share their centerline; the input still distinguishes typing from completed dictation. |
| The room could be displaced by a new result. | Keep source changes in the attention queue and preserve the displayed question/draft. | Entry, update, selection and draft-preservation sequences exercised. |

## Project queue

The old flat order treated each chat as an independent priority. The outer queue is now project priority, with chat order inside each project. P1/P2 labels show positions in the current rotation. Named project headings are disclosure bars; unrelated unassigned tasks remain individual entries rather than becoming one artificial project.

| Finding | Change | Check |
| --- | --- | --- |
| Project names repeated under every chat. | Show the project once in its heading. Chat rows contain title, application and current state. | Project and chat titles share a reading edge; project headings use stronger weight and their own quiet surface. |
| A nearby chat could displace a more important project. | Persist project rank independently of chat order. Automatic project order uses the most urgent visible chat. | Tests cover multiple chats, running work, new results, reset and restarts. |
| Reordering had only one level. | Project handles move whole groups; child handles reorder only within their project. Both support Alt+Up/Down. | Actual pointer drags and keyboard moves exercised at both levels; cross-project chat moves are rejected. |
| Hover summaries expanded rows and moved nearby targets. | A separate context tooltip floats beside the drawer and also works on keyboard focus. | The two visible rows retained top positions 171px and 238.34px, and heights 64.34px, before/after the tooltip appeared. |
| Background refreshes rebuilt identical rows. | Skip replacing unchanged queue markup. | Focus and disclosure state survive unrelated updates. |
| Collapse could be confused with deferral. | Persist disclosure state locally without changing task eligibility. | Focus top still selects a task inside a collapsed P1 project. |
| Reorder could interrupt a response. | Apply priority immediately, but change the room’s focused task only when it has no draft, recording or pending exchange. | An unsent response remained attached to its original chat during a project reorder. |

Filtered and snoozed projects retain their order slots. Hidden chats retain their positions during visible-chat reordering. Queue order tools and the renderer use the same grouping rules. Collapse changes presentation; snooze and rotation filters change eligibility.

## Settings

The initial view presents four sections: Voice, Memory, Connections and Flow. One section opens at a time. Connection/billing details, model configuration and workspace paths are secondary disclosures. Quiet styling keeps text legible rather than making every item faint.

| Finding | Change | Check |
| --- | --- | --- |
| The panel used many tiny labels, offsets and unrelated gaps. | Shared 24px gutters, 13px field text, 12px labels and 11px metadata; restrained neutral inks. | Fields and section headings use the same left edge. |
| Pace, Delivery and Listen competed along an uneven baseline. | Equal-width Pace/Delivery fields with matching heights. Preview is a separate, aligned action. | Both select boxes are 36px high and share top and bottom edges. |
| Connected status, disconnect and eligibility copy crowded the main voice choice. | Place them under ElevenLabs connection. Missing configuration/errors reveal that disclosure. | Connected and expanded-detail states inspected. |
| Save disappeared below long settings. | A stable footer keeps Save visible while the form scrolls. | Save stays in place in Voice, Memory and Connections. |
| Save looked actionable when nothing changed. | Disable it until a preference changes. Retain unsaved edits when the drawer closes. | Changed pace, reopened the drawer, saved and restored the synthetic preference. |
| Multiple expanded sections created a long inventory. | Native accordion grouping opens one primary section at a time. | Voice, Memory and Connections opening/closing checked. |

## Dimensions and evidence

At the checked desktop viewport, the drawer is about 461px wide. Main control targets are 32×32px, icons 18×18px and settings controls 36px high. Project headings are 14px, chat titles 13px and chat metadata 11px. Controls have visible keyboard focus; disabled and expanded states remain distinguishable. Reduced-motion preferences disable animation and transitions.

Public screenshots use synthetic projects and a demo profile:

- [Project queue](images/project-queue.png)
- [Voice settings](images/voice-settings.png)
- [Room](images/room.png)

The native minimum-window check and final installed verification are recorded in [PROGRESS.md](PROGRESS.md). The fixed Save area and scrolling form are designed to keep controls reachable at that size.

## Remaining limits

The Claude bridge still detects some plain-language questions heuristically; unsupported approvals stay in the source app. Artifacts remain escaped text and source links. Those limitations must not be hidden by a polished presentation. A full screen-reader and alternate display-scaling audit remains separate from the geometry and keyboard checks recorded here.
