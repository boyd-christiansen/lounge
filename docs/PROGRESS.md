# Progress

## Public baseline — 2026-11-02

Lounge is a local desktop attention queue for parallel agents. The public baseline contains the application, tests, build scripts and generic documentation. Private pre-publication development history remains local. Queue contents, source snapshots, source identifiers, credentials and browser drafts are excluded from this repository.

Implemented: durable SQLite state; priority and manual ordering; task-level and project-level work/personal classification; snooze and resurfacing; explicit remove/undo; draft and displayed-question binding; Codex app-server and Claude Code SDK execution; optional local coordination; scoped existing-Claude bridge; one-conversation import preview/confirmation; native source handoff; grounded decision briefs with exact alternatives; repeat-visit summaries; system and ElevenLabs read-aloud; completed-dictation submission; bundled Mac application.

The entry flow opens a personalized spoken greeting and a composer. The user can say to start the queue, add a task or find a conversation. Source briefings and narration prefetch independently. Background updates cannot enter the queue until the user chooses it. The room remains one scene with its queue/settings in the left drawer.

Design review: see [DESIGN.md](DESIGN.md). Public release checks and final verification are recorded below when completed.


Verification before publication: 127 automated tests, syntax checks, whitespace checks, native compilation and strict bundle signature verification pass. Isolated browser checks confirmed Space → greeting, a state event preserving that greeting, typed queue navigation waiting for Enter, prepared alternatives visible after selection, and a complete pasted new thought reaching the conductor with no prior task bound. The README image uses a synthetic profile and no real task data. New entry thoughts cannot answer an unseen coordinator question; the UI offers an explicit Hear waiting question action.

The Mac package includes the tan/burnt-orange chair mark at standard icon resolutions and the browser uses its favicon. Existing saved preferences remain local; a fresh installation has no hardcoded user name. No hosting was added.


Entry refinement: removed the three workflow buttons and the written opening question. Space alone starts the spoken greeting and reveals input. Short navigation requests remain available through voice/chat; a full new instruction goes directly to the coordinator. Rephrased the greeting as one continuous question, “Hello [name], what’s on your mind?”, synthesized in one utterance. No independent clip or artificial pause is inserted between the greeting and question.


Final installed verification: the bundled app shows only the personalized hello and composer after Space, with no written opening question or workflow buttons. The revised greeting returns valid, decodable MP3 audio using the saved voice, Brisk pace and Brighter delivery. Voice/chat queue navigation was exercised with completed paste in the isolated room; ordinary typing still waits for Enter. The installed UI matches the committed source. Existing local queue and preferences are preserved. Refreshed the existing same-app Accessibility identity after the ad-hoc update and confirmed the Claude bridge is ready; no permission scope changed and no source prompt was sent. The public repository is https://github.com/boyd-christiansen/lounge, on main, with private pre-publication history excluded. The isolated verification server was stopped and the existing browser room refreshed only after confirming it had no draft. No hosting or user setup is needed for this release.


## 0.5.0 — project-first attention and measured drawer audit

Project ordering is now separate durable state, with its own optimistic revision. Legacy flat overrides seed project rank once, preserving the previous user ordering intent. Chats retain their order within the project. Current-rotation urgency determines automatic project order; explicit project rank wins. Running/seen work does not stall later eligible projects, and fresh results return to their project’s place. Filters and snoozes retain hidden project slots; child reordering retains hidden chat slots. Project/chat ordering are exposed as conductor tools, and idle conductors upgrade to tool contract 11. Exports include the new ordering metadata. Source titles, original links, execution ownership and drafts are unchanged.

The drawer uses collapsible project bars and separate project/chat drag handles, with keyboard equivalents. Source metadata no longer repeats each project name. Cached hover context floats without changing row geometry. Unchanged markup is retained across background state events. Primary controls now use a pinned, licensed outline icon family, shared 32px targets and 18px icons. Settings use consistent gutters, legible text, a single open primary section, secondary connection details, fixed Save and unsaved-edit preservation. The Mac bundle version now follows the package version.

Verification before installation: 134 tests and syntax checks pass. Isolated synthetic UI checks covered real project drag, real child drag, keyboard project ordering, persisted collapse, collapsed P1 still entering rotation, a draft surviving project reorder, and a settings edit surviving close/reopen before Save. Measured header centers match at Y=44px; composer target centers also match. Pace/Delivery dimensions match, and tooltip appearance left queue-row coordinates unchanged. The updated audit records component-level findings and evidence, rather than aesthetic intent alone. Native minimum-window and installed-state checks follow.
