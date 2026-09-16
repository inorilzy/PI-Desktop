# ADR 0266: Composer @ mentions other sessions

- Status: Accepted
- Date: 2026-09-16
- Decision: D430
- Amends: ADR 0024, ADR 0070, ADR 0163
- Related: ADR 0237, ADR 0239, ADR 0240, issue #446
## Context

Composer `@` only completed workspace files (ADR 0024). Users who want to point
the current Agent at another durable conversation had to paste a session id or
rely on Session Orchestrator's `SessionTask.list`. There is no `@session`
chip, and a bare title in the draft is not a reference.

Restoring parent-to-parent A2A (ADR 0165) is still rejected. The mention is a
composer address. At send time the desktop may expand that address into a
local Q&A snapshot so the current model can see the other conversation.

## Decision

1. The `@` autocomplete keeps its file grammar. The same menu adds a
   **Sessions** group above **Files**.
2. Session rows come from the renderer's live session list. The current
   session is excluded. An empty query shows the eight most recently updated
   sessions; a query fuzzy-matches title, then id.
3. Accepting a session inserts the same sentinel-backed inline chip as a file.
   The compact label is the session title. The canonical token is
   `@session:<uuid>`.
4. `@session:<uuid>` is not a filesystem path. It is never a structured
   attachment, never opened by `fs/open`, and survives a workspace switch.
   The transcript paints it as a chip; clicking opens that durable session.
5. No host-core, IPC, schema, or `Task*` change. At send time the desktop
   reads the referenced session through existing `session.get`, keeps the
   newest 10 completed user/assistant Q&A turns, and injects them as a frozen
   reference block. `thinking`, tools, nested delegates, and aborted rows are
   dropped. Nested `@session` tokens inside that material are not expanded.
   The UI still shows the compact chip; the model sees the snapshot plus the
   address.

## Consequences

- Users can `@` another conversation the same way they `@` a file.
- The current model receives recent Q&A from that session without A2A and
  without importing thinking or tool traces.
- File completion, paste chips, and transcript file chips stay unchanged.

## Alternatives considered

- **A second trigger (`@@` or `#`)**: rejected. The request is to reuse `@`.
- **Pointer only, no snapshot**: rejected for v1 of this expansion. An id
  without content does not give the model the other conversation.
- **Inline the full transcript, including thinking and tools**: rejected.
- **Core A2A messaging**: rejected; ADR 0165 still stands.
- **LLM summarization / RAG / view_chat tool**: deferred. First version is a
  deterministic last-N Q&A snapshot with a character budget.
