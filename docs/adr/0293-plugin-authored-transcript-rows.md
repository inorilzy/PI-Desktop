# ADR 0293: Plugin-authored transcript rows

- Status: Accepted for implementation
- Date: 2026-09-18
- Related: issue #528 (sub-issue #561 item 7) ·
  [ADR 0291](0291-trusted-renderer-execution-host.md) ·
  [ADR 0292](0292-runtime-hooks-for-plugin-host-processes.md) ·
  [ADR 0239](0239-session-collaboration-messages.md) ·
  [13-plugin-permissions-matrix](../spec/07-plugins/13-plugin-permissions-matrix.md) ·
  [16-trusted-extensions](../spec/07-plugins/16-trusted-extensions.md)

## Context

`turn_closing` (runtime slot 7,
[16-trusted-extensions](../spec/07-plugins/16-trusted-extensions.md) §6) is
implemented. A trusted extension may answer `{ continue: true, message? }`, and
that message is queued on the steering queue so the kernel's loop has something
to consume. It reaches the model and is deliberately **not persisted**: writing
plugin-authored text into a user-role transcript row is a product decision the
implementation did not take, and putting words in the user's mouth is a claim
about who said what.

The product decision of 2026-09-18 is to take it: the continuation must appear
as a visible user message row.

The repo already has the mechanism for "a row in this transcript that the local
user did not write": cross-session collaboration messages
([ADR 0239](0239-session-collaboration-messages.md)). They are user-role rows
that carry provenance and are drawn with an origin strip
(`MessageRow.tsx` renders `SessionMessageOrigin` above the row). Their delivery
to the model is wrapped by `formatSessionMessage` with an explicit disclaimer
that the content is task data, grants no new authorization, and does not change
permissions.

## Decision

1. **A `turn_closing` continuation is persisted as a user-role row.** It is not
   a transient injection. It appears in the transcript, in export, and to
   compaction like any other user row.

2. **The row carries provenance, and the transcript draws the same origin strip
   the collaboration messages use.** The strip names the plugin ("from plugin
   X"), so a reader can tell an authored row from a row they typed. The stored
   provenance is a snapshot — the plugin id plus the display name as of the
   write — for the same reason `SessionCollaborationMessage` snapshots
   `sourceTitle`: a row must remain readable after the plugin is uninstalled.

3. **The model receives the content without a wrapper.** It is presented as an
   ordinary user message. This is a deliberate divergence from the
   collaboration path, which keeps its `formatSessionMessage` disclaimer.

4. **The consequence of 3 is an accepted risk, recorded as such:** the model
   cannot distinguish plugin-authored text from user-authored text, so a plugin
   can instruct the model through the user's channel. The compensating facts are
   that every runtime slot is a high-risk permission, explicitly confirmed at
   install; that the row is visibly attributed in the UI; and that the plugin id
   is on the row. This divergence is intentional and is not a defect to be
   repaired by re-adding a wrapper without a new decision.

## Consequences

- The continuation becomes auditable: what the agent was told is in the
  transcript instead of appearing only as spent tokens.
- A producer is now required: the plugin identity has to travel from the hook
  call to the persistence path. This is the missing producer #545's D14 field
  needs, and it makes the `pluginId` on a transcript entry real rather than
  structurally always-empty.
- The AI trust boundary is weaker on this one path, on purpose. The transcript
  and the audit log are what remain between a plugin and the model.
- Compaction, export, and session-title derivation now see plugin-authored text
  as user text. That is the same treatment the user asked for, and it is
  recorded here so a later surprise is not diagnosed as a bug.

## Alternatives considered

- **Keep the continuation unpersisted (the previous implementation).** Rejected
  by the product decision: the user cannot see what the agent was told, and the
  row disappears from the transcript while still costing tokens.
- **Persist it as a system row instead.** Rejected: the product decision names a
  user message row, and user and system rows carry different transcript
  semantics.
- **Wrap it for the model like a collaboration message.** Rejected by the
  product decision. The cost is recorded under Decision 4 rather than argued
  away; the collaboration path is unchanged.
