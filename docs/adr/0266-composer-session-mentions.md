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

Restoring parent-to-parent A2A (ADR 0165) is still rejected. This change is
only a composer mention: pick a session from the existing `@` menu, serialize
a stable id, and let the model use tools it already has.

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
5. No host-core, IPC, schema, or `Task*` change. Sessions are not inlined
   into the prompt. The mention is an address, not a transcript import.

## Consequences

- Users can `@` another conversation the same way they `@` a file.
- The model sees `@session:<uuid>` and can pass that id to SessionTask when
  the plugin is installed.
- File completion, paste chips, and transcript file chips stay unchanged.

## Alternatives considered

- **A second trigger (`@@` or `#`)**: rejected. The request is to reuse `@`.
- **Inline the other transcript**: rejected. That is a context-injection
  feature with token and privacy cost, not a mention.
- **Core A2A messaging**: rejected; ADR 0165 still stands.
