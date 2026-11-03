# Existing Claude app control

Lounge owns attention; the original app owns an imported conversation. New work uses Codex app-server or the Claude Code SDK. The bridge never creates replacement consumer conversations or resumes imported sessions in another runtime.

## One Mac application

`npm run build:mac` produces `dist/Lounge.app`, containing the room, Node, dependencies and native bridge. AppKit/WKWebView hosts the scene. Private JSONL pipes connect the backend to the bridge compiled into the same executable. No separate helper installation, hosting or network bridge is required. The local build is ad-hoc signed, not notarized.

Production data belongs in `~/Library/Application Support/Command Lounge/`; the bundle excludes queue databases, environment files, Git and provider credentials. Native CLI sign-ins are used in place without copying auth files. A database instance lock prevents competing queue writers. The standalone helper build remains for development only.

## Control paths

| Target | Control path |
| --- | --- |
| New Lounge-owned Codex conversation | Installed Codex app-server |
| New Lounge-owned Claude Code conversation | Official Agent SDK with native subscription sign-in |
| Existing Claude chat/Cowork | Bundled Mac bridge, after Accessibility permission and connection |
| Imported Claude Code session | Saved-history observation and source handoff; never competing resume |
| Imported ChatGPT/Codex desktop conversation | Saved-history observation where available, plus source handoff |

The installed Claude app exposes combined **Chat and Cowork**, plus separate **Code**. Application intent stays explicit in task records; no artificial Cowork mode is invented. The SDK is not an API into consumer app conversations or their connectors/files.

The native allowlist contains Claude only. This environment refuses computer-use access to Codex, and the custom bridge must not bypass that restriction. No undocumented OpenAI IPC or account endpoints are used.

## Queue integration

`lib/adapters/desktop.mjs` attaches exact existing sources. `newWork=false` prevents choosing it as a new worker or coordinator. Source IDs/titles/URLs remain unchanged, with separate local monitor IDs. Reservations precede UI work. Duplicate source imports and active turns are rejected across chat/Cowork labels.

The conductor can preview the currently open Claude conversation, show a source card, and import only after confirmation in a later exchange. Discovery covers visible recent/pinned conversations, with preview and later import confirmation. Known sources use verified sidebar entries; search fallback accepts only an exact source URL link. Opaque older search results require opening the conversation manually once. Ambiguous titles stop. New consumer conversation creation is not a fallback.

Authorized follow-ups are inserted whole into an empty composer and submitted once. Results become **review**, not **done**. Replies bind to the current question fingerprint; native one-time approvals bind to the displayed permission context. If the user answers directly in Claude, the old Lounge request expires. Disconnect/restart clears live handles and pauses the task. Explicit pause is not silently reversed by polling. A queue source link can reveal its exact conversation in Claude when connected.

Model/effort tools read the app's exposed choices, apply an explicitly requested selection, and verify the observed label. They are separate from SDK selectors. Source controls reserve synchronously so neither the same task nor a duplicate-source record can dispatch while a model menu is in use. Recovery uses observation without a prompt; an old brief is never resent. Unseen questions stop delivery until presented. Message identities include their ordinal, preserving repeated identical replies.

## Guards and limits

- Only the allowlisted Claude app and exact supported conversation frame are inspected. Nested artifact frames cannot impersonate controls. Auth/password controls are excluded.
- Handles are unique per inspection and single-use. Source identity and guarded values are rechecked immediately before acting.
- App-scoped controls use no clipboard or OS-wide keystrokes. Model submenus can use a private-state Right-arrow directed only to Claude's PID, after the exact source/menu/focus is verified. No text, Return or arbitrary key is supported. Native menu cancellation is limited to the source model popup. Writes/navigation defer while Claude is foregrounded; drafts are preserved.
- Short UI operations serialize while underlying app tasks continue in parallel. Polling never changes Lounge's focused task or drafts.
- Uncertain delivery is never replayed. Crash recovery requires explicit reconciliation.
- Only unambiguous one-time approval controls can be pressed. Persistent/ambiguous grants become source-only requests with a Review in Claude action. Replies cannot apply those grants. The pending request expires when handled in the source app.
- Plain-language question detection currently uses the final question mark. This heuristic is not equivalent to an SDK structured question event.
- Artifacts are escaped metadata/source links. Arbitrary app HTML, local files and executable canvases are not embedded.

## Qualification status

The single bundle builds and passes strict ad-hoc signature verification. Its native window renders the room and exposes Connections; private parent/child status RPC works. Automated tests cover delivery guards, source identity, exact answers, stale questions, one-time decisions, disconnect/restart, duplicate imports, writer locking and host timeouts.

Accessibility was granted after replacing a stale entry. A user-selected existing conversation passed a real single-message send/result test and a separately approved question/full-reply exchange, with its original source identity intact. The question test used an isolated in-memory engine; its response included the verification marker plus a preface. Native model menus and recent-source navigation still require the final release checks. Native Cowork file/connector approvals are not live-qualified; unsupported prompts remain source-only.

The release removes the development-code override and starts only its bundled backend. A local ad-hoc update can require refreshing the macOS Accessibility entry. The Mac must be unlocked for UI bridge work; when its view becomes unavailable, monitoring pauses without stopping the original app's agents. Codex/Claude SDK execution remains independent of that UI requirement.
