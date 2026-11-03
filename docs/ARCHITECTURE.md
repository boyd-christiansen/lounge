# Architecture and implementation boundaries

The product owns attention. Agent runtimes own execution.

```text
Wispr / text / browser dictation
            ↓ finished dictation / Enter for typing
Full-screen room — one brief, hidden queue, stable per-task draft
            ↓ same-origin HTTP + CSRF capability
Node server — SQLite queue, command receipts, event journal, SSE
            ↓
Conductor — replaceable provider/model + typed queue tools
            ↓ authorized dispatch
Provider registry — normalized sessions, questions, results, cancellation
            ↓
Workers — subscription-backed Codex / Claude Code sessions in project workspaces
            ↑ progress / question / approval / result
```

## Work state and attention

`queued → running → waiting → running → review → done`

`paused` and `error` retain recovery context. `snoozed` retains its previous attention state. `review` is deliberately distinct from `done`. No inferred legal or business deadline is stored. A fixed priority band dominates bounded age, pin, and due-date bonuses.

Every task has a stable ID and revision. Updates reject conflicting revisions. Capture/update commands have durable receipt IDs. Dispatch reserves a task before asynchronous I/O, imposes parallel limits and workspace ownership, and requires explicit recovery after a disconnect. A runtime disconnect invalidates that provider's pending request handles. Session ownership is keyed by both provider and session ID. A provider change does not resume another provider's session ID. Saved user/assistant exchanges and current context give a new coordinator a bounded handoff.

## Codex integration

Protocol checked against the installed CLI `0.163.0-alpha.11` using `codex app-server generate-ts --experimental`. The adapter initializes a stdio child process, enables experimental APIs, and handles:

- `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`
- `item/agentMessage/delta`, `item/completed`, `turn/completed`
- `item/tool/call` for `lounge_ask` and conductor queue tools
- `item/tool/requestUserInput`, command/file approval requests, and request resolution
- read-only thread discovery and paginated saved-turn reads

The conductor can read the queue, capture work, set priorities, and dispatch. Workers get `lounge_ask`. Queue tools are executed by application code. Provider output and source content are treated as evidence, never permission. Model choice initially inherits the installed runtime configuration. Explicit model and effort settings apply to the next turn. The runtime's account catalog provides available model IDs and supported efforts; unsupported choices fail without fallback. Codex sessions signed in with an API key are refused before inference in this subscription-first configuration. Newly created persistent sessions receive descriptive titles; existing source titles are preserved.

`lib/codex.mjs` owns Codex stdio transport; `lib/adapters/codex.mjs` translates the wire protocol into normalized sessions, events and requests. `lib/engine.mjs` owns reservations, tool execution, question binding and durable state transitions. It does not construct provider RPC payloads. A compatibility input shim remains for existing test callers.

Official references:

- https://developers.openai.com/blog/codex-as-a-platform
- https://learn.chatgpt.com/docs/app-server

## Existing application leverage

The app-server can read persisted Codex history. A separate process cannot claim to own the desktop's live sessions or its approvals. Source imports therefore keep their original ownership and offer a linked handoff. A native desktop plugin/bridge is the next integration step for direct messaging and live questions in already-running desktop chats. App plugins such as Slack must be available in the executing runtime; no credential or connector access is copied from this conversation.

## Provider and session contract

`public/applications.js` defines task application identity and honest per-task capabilities. Application identity is distinct from coordinator inference: a Claude coordinator can dispatch Codex work, and a Cowork task is not a Claude Code task. Source-app-only types never acquire an execution adapter by model substitution. New tasks inherit the default worker application unless the user explicitly chooses one; existing source sessions keep their application and execution ownership. Legacy tasks infer their application from known source/provider fields without changing original titles.

`lib/providers.mjs` registers adapters and resolves `provider/model` strings, splitting only on the first slash. For example, `local/organization/model` keeps the model ID `organization/model`. The coordinator and default worker each have a separate durable `{model, effort}` selection; a Lounge-owned task can override its worker selection. `codex/default` inherits Codex's runtime preference. Existing worker sessions retain runtime ownership. Selection is never permission to duplicate or interrupt an active turn.

Each adapter declares `id`, `name`, `roles`, `billing`, `ready`, and optional `configured`. It implements `connect`, `listModels`, `openSession`, `startTurn`, `interrupt`, `respond`, `reject`, `release`, and `close`. The session contract accepts instructions, tools, a model, bounded handoff history and an ephemeral/read-only role. The engine records admission before awaiting a provider. Adapters emit normalized `text.delta`, `message`, `request.resolved`, and `turn.ended` events with provider/session identity, and tool/question/approval requests. Only the adapter translates native permissions and responses. Runtime capabilities are explicit: a coordinator-only adapter cannot execute worker tasks.

`lib/adapters/local.mjs` implements a coordinator-only tool loop using an existing local OpenAI-compatible `/models` and `/chat/completions` API. It requires function tools and JSON-schema output. Calls go only to HTTP loopback addresses with redirects refused, no credentials, no model download/start and no hosted fallback. Tool rounds execute sequentially; `lounge_ask` waits for explicit user submission without a silence timer. The local loop has no shell or filesystem tools. Conversation state remains in memory during a session; restart reconstructs bounded visible exchanges from SQLite and supplies the current project/task frontier. It does not promise to transfer hidden model reasoning or a provider's full internal transcript. Local model quality and compatibility must be qualified on the actual chosen model.

Hermes and paid API inference adapters remain unconnected. Claude Code is implemented below. Implement them against this contract and test their own approvals, recovery, billing and source ownership. Do not mark an adapter connected based on the binary being installed. An API adapter must add explicit credentials and spending policy; it cannot inherit an automatic fallback from these adapters.

## Claude Code adapter

`lib/adapters/claude-code.mjs` uses the official Anthropic Agent SDK, pinned in the lockfile, with the installed Claude Code executable. `claude auth status --json` supplies safe subscription metadata. `claude.ai` / first-party sign-in is required, and inherited API/auth-token/alternate-backend environment variables are filtered. Native SDK account metadata is checked before submitting a prompt. API-key or alternate-provider selection fails closed. The SDK/CLI owns authentication; the app never opens authentication files, displays tokens, or returns credential values in state.

Sessions use client-chosen UUIDs and one active turn per owned session. Each turn starts a streaming SDK query, reusing the durable native session with `resume` for later turns. A UUID allocated before a failed startup is retried as a new native session; after restart, official session metadata distinguishes missing sessions from saved ones. Recovery of a missing owned session carries bounded visible exchanges, without claiming to restore native tool history. Provider admission stays reserved synchronously before process or SDK awaits. Model changes recheck current ownership after asynchronous catalog lookup. Ephemeral briefings and verification coordinators do not persist. Persistent sessions get readable names through the official SDK session API. `result` is the completion signal; non-success/error results never become completed work. Async input, provider callbacks and the native query close on cancellation; expired question handles cannot be replayed after restart.

Lounge tools are registered through an in-process SDK MCP server with Zod schemas generated from the shared tool definitions. Only the application can register this server. Native `AskUserQuestion` callbacks map to stable per-request IDs and return complete answers through native updated inputs. Native tool approvals are distinct requests and return allow/deny for that call only, without persistent permission updates. Native shell sandboxing is enabled with unsandboxed commands refused, and application hooks reject direct writes outside the reserved project (including symlink escapes), sandbox-disabling calls and explicitly detached commands. The coordinator has no native filesystem/shell tools. Workspace ownership applies across Codex and Claude Code workers, not merely within a provider.

Strict MCP configuration loads only the explicitly registered Lounge server, without silently inheriting project/user/plugin MCP servers. The native SDK's warning about preapproved Lounge tools is expected: these are the in-process application tools, and their handlers enforce ownership, exact answer binding, import confirmation and task authorization. Native worker actions remain subject to their own permissions.

Source discovery uses SDK session metadata in registered workspaces. A source is read only after selection/confirmation, with its original title and workspace retained. Source histories are normalized into bounded visible exchanges. Saved Claude transcripts have unknown live status; they are snapshots, not a terminal result or a live event bridge. Imported sources are never resumed by this adapter. ChatGPT/Codex desktop source messaging remains a handoff. Claude chat/Cowork uses the separate original-app adapter described below; this SDK never resumes those consumer sources.

## Portable context and local operation

User preferences and explicit memories remain in the profile. Project notes are independently keyed by project identity, with update timestamps. `lib/context.mjs` builds a compact current-task frontier and bounded recent coordinator exchanges; prior prompt envelopes are flattened so the context does not recursively repeat itself. Detailed saved source history stays with its provider and the local snapshot. The `lounge_context` tool reads context or saves a note only on explicit user instruction. `lounge_models` discovers capabilities; `lounge_model` changes next-turn preferences. These are application tools, not prose commands.

Settings exposes coordinator/worker models inside Connections, project notes inside Memory, and a private JSON export inside Flow. `lib/portable.mjs` exports an allowlisted configuration plus task records without credentials or live question handles. This is an inspectable snapshot, not automatic restoration of provider sessions. For full relocation, stop the app, copy the private SQLite database, map project paths, and sign in with the providers on the destination. Provider source histories and browser drafts have separate stores.

No hosting is required. The Node process, queue and UI run on the Mac; Codex inference still uses the signed-in service and ElevenLabs speech uses its configured API. Optional local inference uses an already-running local server. The Mac must remain awake with the app process running to observe updates and coordinate work. Remote machine runners, remote access authentication and launch-at-login remain future work. The Mac bundle now includes the local runtime and Claude bridge.

## Scope of this iteration

The full-screen room and actual Codex orchestration are implemented. A short, structured, read-only briefing describes the selected task. Completed dictation auto-submits; ordinary typing waits for Enter. The hidden queue supports explicit persistent ordering, and its settings store memory/personality/voice preferences locally. User instructions may pass through or receive a light contextual edit under the policy in `lib/prompting.mjs`.

OS launch-at-login, native OS-wide microphone/shortcut integration, authenticated remote access and additional worker providers remain future work. The existing Wispr shortcut inserts into the focused room. Arbitrary local artifact canvases still need a safe file-serving design. This revision deliberately supports a bounded chat-preview card: escaped title/description, project folder, and a validated source link. The server persists the candidate batch, refuses same-exchange imports, and only accepts IDs from that batch after a later confirmation. No generated HTML or JavaScript executes. The expanded context reader supports escaped Markdown paragraphs, lists, quotes, code, and links.

## Context and routing, version 3

Queue hover descriptions are two separate synthesized fields: the overall thread goal and the latest turn’s status/next step. They combine the original context and the last four saved turns; raw last replies are never used as hover descriptions. Read-only ephemeral summaries run serially in the background, cache by task content, and discard stale output. They do not alter source threads or execution state.

Every completed thought now enters the conductor even while a worker is awaiting input. A turn stores the viewed task and question ID as routing context. The answer tool is limited to that displayed question, rejects approvals, and requires the exact original text. A new task can be captured without answering an unrelated worker. Approval controls remain explicit.

`lib/speech.mjs` is a server-side speech adapter. Its credential is separate from the queue/profile and never enters state events. The server loads ignored `.env.local` at startup or uses a session-only key supplied through Settings. It uses the official JavaScript API client directly; the CLI is never a runtime transport. The credential is excluded from Codex child-process environments. Speech POSTs require the same CSRF capability as queue mutations. The renderer receives audio bytes from localhost and owns cancellation and playback. The Mac application uses AppKit/WKWebView around this same local renderer; no Electron runtime is required.

## Rotation and snooze controls

`public/rotation.js` is shared by the server and renderer. Project identity uses an explicit source project label, a matched registered project, or an actual source workspace. Unrelated Inbox items have separate identities. A persistent category map assigns personal/work at project scope; an explicit task-level boolean can override inheritance. The default category is work. The conductor v4 adds classification, rotation and early-wake tools, while the queue tool exposes hidden tasks only when requested.

Rotation has three durable modes: all, work, and personal. The drawer, next-task selector and default conductor queue use the same eligibility rules. Snoozed and done tasks never enter rotation. Filtering does not transfer ownership, dispatch work, delete tasks, or stop agents. Dragging within a filtered queue keeps hidden tasks in their saved ordering slots. Mode/category changes preserve bound drafts; newly included work becomes eligible to surface again.

Snoozing stores the prior attention state and a future wake time. Re-snoozing changes the wake time without replacing that prior state with “snoozed”. On expiry or explicit wake, the task restores its prior state and receives a resurfacing marker included in its fingerprint, so a previously reviewed result can return. Existing source polling and state snapshots handle expiry, including after app restart. No external scheduled automation is created.

## Bundled Mac shell and original-app adapter

`native/LoungeApp.swift` hosts the room in WKWebView and starts the bundled Node binary. `native/DesktopBridge.swift` is compiled into that same application executable. A private parent/child JSONL pipe carries allowlisted bridge requests; AX handles never become model-facing tools. The renderer has only a validated fullscreen message handler and same-origin CSRF-protected application APIs. External user-activated links open through the OS. App closure stops its backend; the queue is protected by a process lock. The build uses an explicit source allowlist and excludes data, environment files and provider credentials.

`lib/adapters/desktop.mjs` is an existing-source-only adapter (`newWork=false`). Provider selection refuses it for new worker/coordinator sessions. New conversations use Codex app-server or Claude Code SDK. Existing consumer sources retain their thread IDs, titles and links; local monitoring sessions have separate runtime IDs. Single-source reservations happen before asynchronous UI work. Disconnect/restart invalidates pending questions and requires explicit recovery; a paused monitor is not silently attached again.

`lib/desktop/claude.mjs` serializes short UI operations while app-owned tasks run independently. It verifies the exact source, excludes nested artifact frames, preserves drafts, refuses writes while Claude is in the foreground, guards inserted text and binds replies/approvals to source fingerprints. Uncertain delivery is never replayed. One-time native approval controls are supported only when their labels are unambiguous. Plain-language question detection is currently heuristic, not an SDK event. Source artifacts are escaped metadata and source links, not executable canvases. Live qualification remains required after the OS Accessibility grant.

The native allowlist is Claude only. The computer-use environment refuses access to the Codex app; this bridge must not be used to bypass that restriction. Codex desktop-owned sources remain observation/handoff until a supported owner-runtime control path is available.

## Existing-source recovery and controls

The v8 conductor can find visible pinned/recent Claude app sources, preview the current source, watch an existing source without sending, and select its exposed model/effort. Import still requires a later confirmation. Sidebar navigation verifies the destination URL; search fallback accepts only a matching source link, not opaque command-palette text. Older sources can require manual opening once.

Source settings reserve synchronously across every queue record with the same canonical source. New turns cannot overlap a source model change. Unseen questions block delivery; source message fingerprints include ordinals so identical consecutive replies remain separate turns. Recovery uses observation rather than resending an old brief. An unavailable app view pauses monitoring, leaving the original backend work intact. The bridge needs an unlocked Mac; native SDK execution is independent.

Only unambiguous one-time permissions can be answered in Lounge. Other native approval choices become source-only requests; their controls open Claude for the user to decide. A source-side decision expires the old queue request without treating it as a Lounge approval.

The shipped shell loads its bundled server only. It does not honor a development-code override and removes Node/dynamic-loader injection variables from the backend environment. Model menu handling supports native cancel/show-menu actions and a narrowly guarded, app-directed Right-arrow to an exact model submenu. It never posts text, Return or an OS-wide key event. Local ad-hoc signing can require refreshing Accessibility after a rebuild.
