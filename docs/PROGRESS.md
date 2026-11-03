# Progress

## Public baseline — 2026-11-02

Lounge is a local desktop attention queue for parallel agents. The public baseline contains the application, tests, build scripts and generic documentation. Private pre-publication development history remains local. Queue contents, source snapshots, source identifiers, credentials and browser drafts are excluded from this repository.

Implemented: durable SQLite state; priority and manual ordering; task-level and project-level work/personal classification; snooze and resurfacing; explicit remove/undo; draft and displayed-question binding; Codex app-server and Claude Code SDK execution; optional local coordination; scoped existing-Claude bridge; one-conversation import preview/confirmation; native source handoff; grounded decision briefs with exact alternatives; repeat-visit summaries; system and ElevenLabs read-aloud; completed-dictation submission; bundled Mac application.

The entry flow opens a personalized spoken greeting and a composer. The user can say to start the queue, add a task or find a conversation. Source briefings and narration prefetch independently. Background updates cannot enter the queue until the user chooses it. The room remains one scene with its queue/settings in the left drawer.

Design review: see [DESIGN.md](DESIGN.md). Public release checks and final verification are recorded below when completed.


Verification before publication: 127 automated tests, syntax checks, whitespace checks, native compilation and strict bundle signature verification pass. Isolated browser checks confirmed Space → greeting, a state event preserving that greeting, typed queue navigation waiting for Enter, prepared alternatives visible after selection, and a complete pasted new thought reaching the conductor with no prior task bound. The README image uses a synthetic profile and no real task data. New entry thoughts cannot answer an unseen coordinator question; the UI offers an explicit Hear waiting question action.

The Mac package includes the tan/burnt-orange chair mark at standard icon resolutions and the browser uses its favicon. Existing saved preferences remain local; a fresh installation has no hardcoded user name. No hosting was added.


Entry refinement: removed the three workflow buttons and the written opening question. Space alone starts the spoken greeting and reveals input. Short navigation requests remain available through voice/chat; a full new instruction goes directly to the coordinator. Rephrased the greeting as one continuous question, “Hello [name], what’s on your mind?”, synthesized in one utterance. No independent clip or artificial pause is inserted between the greeting and question.
