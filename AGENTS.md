# Command Lounge

Local, single-user command center for parallel agents. This project does not authorize unrelated infrastructure deployments or model downloads.

- Use the installed Codex app-server protocol. `lib/codex.mjs` owns transport; `lib/engine.mjs` owns execution and questions; `lib/store.mjs` owns durable state.
- Keep queue data, source snapshots, and user drafts out of Git. SQLite lives in ignored `data/`; browser drafts are local to that browser origin.
- Imported desktop threads remain owned by the desktop runtime. Do not resume them in a competing app-server process. Keep their original title and link.
- Reserve dispatch synchronously before awaiting a provider. Keep one writer per workspace, and do not duplicate active turns on retry or reconnect.
- Result completion means ready for review. Only a user's explicit acknowledgment clears a task.
- A notification must not change the focused task, destroy a draft, or reinterpret a reply against an unseen question.
- The main interface is one full-screen scene. The queue and settings live in a drawer revealed from the left edge. Do not reintroduce dashboard navigation, stats, or panels into the room.
- Completed Wispr/bulk dictation pasted outside the composer auto-submits by default. Composer pastes and ordinary typing wait for Enter; native microphone capture submits only after the user stops it. Never infer a pause in a thought from a silence timer.
- Inference uses the user's existing Codex sign-in. Never read, copy, or log auth tokens. Do not bypass provider approvals or sandboxing.
- Maintain `docs/PROGRESS.md` at meaningful handoff boundaries. Run `npm run check` and `npm test` after runtime changes. No dependencies are required.
- Keep the localhost interface private: bind to loopback, validate Host/Origin, and require the session CSRF capability on mutations. Remote access needs a separate authenticated design.

- The public GitHub branch has a clean release history. Keep private pre-publication history local; never merge or push it, and never push `--all` or `--mirror`. Run `npm run check:public` before publication.
