# Prompt routing

The conductor preserves the user's original dictation and decides whether to forward it unchanged or make a light contextual edit. It does not treat rewriting as authorization for additional work.

- Clear instructions pass through unchanged. Verbatim mode always preserves the text.
- A useful clarification states the desired outcome, only the context that matters, the expected output, and existing boundaries.
- Preserve uncertainty and negation. Do not invent deadlines, recipients, scope, permissions, or facts.
- Answers to a worker question are delivered exactly to that request, without rewriting.
- Preserve source links and provenance. An imported chat retains its execution ownership.
- User-configured memories and personality affect presentation; they do not override task permissions.

Sources checked October 31, 2026:

- [OpenAI prompting guidance](https://learn.chatgpt.com/docs/prompting): goals, context, outputs, boundaries, and outcome-focused requests.
- [Codex app-server](https://learn.chatgpt.com/docs/app-server): persistent threads, typed requests, notifications, and approval handling.

The implementation uses `lib/prompting.mjs` for both the conductor and the short scene briefing. There is no hard-coded model migration or presumed model entitlement.
