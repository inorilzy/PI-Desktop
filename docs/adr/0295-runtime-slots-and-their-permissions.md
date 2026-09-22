# ADR 0295: Runtime slots, their permissions, and the rules that hold across them

- Status: Accepted for implementation
- Date: 2026-09-18
- Amendment: slot 6 (`runtime.request.before`) was withdrawn by product
  decision before shipping; see §1.
- Related: issue #528 (sub-issue #561) ·
  [ADR 0291](0291-trusted-renderer-execution-host.md) ·
  [ADR 0292](0292-runtime-hooks-for-plugin-host-processes.md) ·
  [ADR 0293](0293-plugin-authored-transcript-rows.md) ·
  [ADR 0294](0294-renderer-plugin-interface-and-host-relay.md) ·
  [13-plugin-permissions-matrix](../spec/07-plugins/13-plugin-permissions-matrix.md) ·
  [16-trusted-extensions](../spec/07-plugins/16-trusted-extensions.md)

## Context

Issue #561 names twelve *runtime slots*: points inside a running turn where a
plugin is consulted and may change what happens — before a message is sent, while
a turn runs, before a tool call is gated, before a request is assembled, before a
turn closes, after it ends, and around session lifecycle changes. They are the
counterpart of the fourteen UI slots (#545): the UI slots decide what the user
sees, the runtime slots decide what the agent does.

Each slot was specified with concrete examples, an inventory of the kernel
extension points behind it (`@earendil-works/pi-agent-core@0.85.1`,
`pi-coding-agent`), and a "current state" line. That inventory showed two
different problems mixed together:

- six slots where the kernel already has the entry point and the desktop never
  wired it (`⚙️`),
- three slots that only reach high-trust plugins today (`🔶`),
- three that need host work (`❌`),
- and one capability — **modifying a tool call's arguments** — that exists in
  neither layer the desktop uses.

The other fork in the road was the separate *harness* layer of
`pi-agent-core`, which has eleven hooks of its own. It was rejected (see
Alternatives), so everything below is a kernel-layer decision.

This record fixes what each slot is, which permission it needs, what is
deliberately not built, and the rules that hold across all of them. It does not
order the work (see Phasing) and it does not restate the per-slot examples
already in #561; §1 records that slot 6 was decided there and then withdrawn
before shipping.

## Decision

### 1. Naming and the slot set

Slot permissions use the three-segment form of D11: `runtime.<domain>.<item>`.
They never reuse `agent.*` (already taken by `agent.extension`,
`agent.tool.register`, `agent.prompt.inject`, `agent.complete`) or `ui.*` (taken
by the fourteen UI slots). Ten slots are offered; slot 6 was withdrawn by
product decision before shipping, and slot 12 was never built:

| # | Permission | What it does | Slot shape decided here |
|---|---|---|---|
| 1 | `runtime.send.before` | Called after send, before queueing: read the outgoing message (attachments included), block it, or **rewrite** what the model receives | Rewrites are always visible to the user (rule 5) |
| 2 | `runtime.turn.watch` | Live observation of the running turn (eleven kernel events), open to ordinary plugins | Best-effort delivery; no receipt, no redelivery |
| 3 | `runtime.turn.abort` | The plugin asks to stop the turn, and the plugin's own long-running work receives the cancellation signal | Both halves ship together: abort without a signal leaves plugin work running after the user stopped |
| 4 | `runtime.tool.gate` | Block a tool call with a reason, replace a tool's *result*, request early termination of a batch | **Modifying arguments is permanently excluded** (rule 4). Asking the user is the plugin's job (rule 6) |
| 5 | `runtime.tool.extend` | Plugin tools as first-class: introduce a tool at runtime, report their own spend, request early termination | A runtime-introduced tool is labelled as such in the UI |
| 6 | `runtime.request.before` — **withdrawn before shipping** (see the note below) | Rewrite what is sent to the model: system prompt, model and thinking level, request payload, **message list** (delete / replace / reorder history) | Decided here, then withdrawn by product decision: silent rewrites of what the model reads are not offered. Its six events are never consulted and the permission is registered nowhere |
| 7 | `runtime.turn.closing` | Before a turn closes: let it close, or ask for another turn with an instruction | The continuation is persisted as a real, visible user row with plugin provenance (ADR 0293) |
| 8 | `runtime.turn.recap` | A plugin reads session content | Whole-session reads need `runtime.session.read` as well (rule 7) |
| 9 | `runtime.turn.facts` | Structured facts about a turn: tool calls and outcomes, tokens, spend, duration, files touched | The `artifacts` model is extended so "this turn" is answerable (rule 8) |
| 10 | `runtime.turn.continue` | The plugin starts a new continuation after a turn ends | **No quota** (rule 9) |
| 11 | `runtime.session.lifecycle` | Called on create / switch / delete / fork / before compaction | Informed-only on destructive actions; cancellation of compaction; and the segment about to be compacted is handed over (rule 7) |
| 12 | `runtime.approval.before` | Called before an approval card appears | **Not built in this cycle.** Neither the kernel nor the harness has this hook; it needs a new extension point in host-core |

**Slot 6 was withdrawn before shipping.** This record decided
`runtime.request.before` and the six kernel events behind it, and the same
implementation cycle then dropped the slot by product decision: a capability
that silently changes what the model reads is not offered. `runtime.request.before`
is absent from `PLUGIN_PERMISSIONS`, from `TRUSTED_EXTENSION_EVENT_PERMISSIONS`
and `REGISTERED_SLOT_PERMISSIONS`, and from the runner's consultation; a handler
that still registers one of the six events (`before_agent_start`, `context`,
`before_provider_request`, `before_provider_headers`, `model_select`,
`thinking_level_select`) is accepted silently and never runs. The UI-visible
route for plugin AI on user-configured models is the plugin-level completion
`pi.ai.complete` under `agent.model.complete`: the user reviews it at install,
and it never rewrites the request.

### 2. Slot permissions are separate from tier permissions

A tier permission says **where plugin code runs** (`agent.extension` in the agent
sidecar, `renderer.extension` in the host renderer). A slot permission says
**what that code may do to a running turn**. The two are orthogonal: a plugin
that holds `agent.extension` still needs `runtime.turn.closing` for the closing
slot, and an installation shows each slot it is asking for.

This is not what the code does today: the closing hook fires for any extension
loaded under `agent.extension` and no code consults `runtime.turn.closing`. That
is a defect to fix while wiring the slots, not a design choice. It follows from
D1 (one slot, one permission; the install page lists each) that a tier grant must
not silently imply a slot grant for every slot the record offers.

### 3. Ordinary plugins, not high-trust-only

Slots reach ordinary plugins through their own permissions. The `🔶` state in
#561 (block / result rewrite / prompt rewrite available only to high-trust
plugins) was a wiring accident, not a security model: those abilities are exactly
what the corresponding slot permissions are for.

### 4. Modifying tool arguments is permanently excluded

The kernel's `BeforeToolCallResult` has no field for arguments — a `beforeToolCall`
handler can block and explain, and nothing else. Only the harness layer's
`before_tool` supports `{ args }`. With the harness rejected, this capability is
dropped: not deferred, not "for later", **not built**. The same applies to the
workaround of wrapping the host's own tool objects before the kernel sees them,
which was considered and rejected:

- the approval card is raised *inside* tool execution, so a wrapper that rewrote
  arguments first would change what the user approves without the user seeing the
  original — the opposite of rule 5;
- the model reasons from the arguments it emitted; silently replacing them makes
  a later explanation impossible;
- it is host code pretending to be a kernel capability, and #561's own example
  ("tool proxy") was written against the harness semantics.

The documentation and the plugin-facing contracts must therefore say that
argument rewriting does not exist, so no plugin author builds on it.

### 5. Rewrites are visible, and audited at diff level

Every rewrite a slot performs — the outgoing message (#1) is the only reachable
producer today; the system-prompt, message-list and request-payload rewrites
decided for slot 6 were withdrawn with it — is recorded at **diff level**: which
characters, which messages, which payload fields changed. In the product:

- a rewritten outgoing message is marked on its row ("rewritten by plugin X"),
  expandable to the original;
- the kinds slot 6 would have written keep their shape — message-list and
  system-prompt rewrites inspectable from the plugin row / audit view, a request
  payload recorded as a summary plus an expandable body — and `plugin_rewrites`
  defines every one of them, with no writer.

The reason is blunt: this class of capability changes what the model sees without
the user seeing it change. Without a diff-level record, a wrong answer has no
explanation.

### 6. Asking the user is the plugin's job

Nothing in the host adds a "confirmation flow" for plugins. An extension handler
already receives a UI object with `confirm`, `select`, `input`, `notify` and
`setStatus` (`backend: TrustedExtensionRunner.createUi` → `bridge.requestUi`), so
a plugin that wants to ask before allowing a call can do so itself, and draws
richer UI in its own panel page today or in a UI slot once `modal` /
`inlineConfirm` are mounted (#545).

One constraint shapes the patterns: handlers for result-bearing events have a
**30-second budget** (`TRUSTED_EXTENSION_HANDLER_TIMEOUT_MS`), and a handler that
overruns is treated as having no opinion and reported as `handler_timeout`. So:

- a decision made within 30 seconds can be awaited in the handler and the call
  allowed or blocked in place;
- a slower decision uses the two-phase pattern: the handler blocks with a reason,
  the plugin asks the user, and after approval the plugin asks for another turn
  with `runtime.turn.continue` — a slot this record already builds, so the
  two-phase pattern needs no new host mechanism.

While a handler is holding a result event, the interface must show that the turn
is waiting for a plugin, rather than appearing frozen.

### 7. Reading conversation content

Reading what the user and the agent said is a permission of its own.

- `runtime.session.read` covers reading a session's content (and whole-session
  reads from slot #8 need it). It is **not** logged per read: a per-read trail
  would drown the session in records while adding no protection. What informs the
  user instead is the install review and the plugin row stating that the plugin
  can read conversations.
- `runtime.session.lifecycle` carries its own right to the segment about to be
  compacted. That content exists only for that moment and exists for exactly this
  purpose (rescuing context before compaction), so stacking a second permission on
  it would add a click without adding a constraint.

### 8. Structured turn facts, and the artifact model behind them

"Which files did this turn change?" must be answerable from host-owned data, not
reconstructed by each plugin. The `artifacts` table therefore stops being a
per-`(session, file)` deduplicated list: `op` grows beyond `write` / `edit` to
cover **create**, **download/generated** and **delete**, and `turn_id` becomes
part of the exposed shape together with a per-turn query. This is what makes
"this turn" mean one thing instead of several.

### 9. Continuations are visible and unbounded

A plugin-triggered continuation (#10) is persisted as a real row with plugin
provenance (ADR 0293), so the user can see that a plugin asked for another round.
There is no numeric quota: the host's own continuation loops have none (ADR 0253
removed `maxTurns`), and inventing a limit for plugins only would make the same
capability behave differently depending on who asked. What replaces a quota is
visibility (rule 5 for rewrites, this rule for continuations) plus the audit
trail.

### 10. Best-effort observation

Slot #2 delivers events on a best-effort basis: no receipt, no redelivery, and a
plugin that is loading or crashed simply misses them. #561's "confirmable
delivery" tier is not built, because it is a different piece of engineering
(buffering, persistence, replay) and no plugin in this cycle needs it.

### 11. Destructive actions are informed-only

Plugin notifications about session switch, delete, fork and compaction are
informed-only: a plugin is told, and cannot veto — except for cancelling a
compaction, which the high-trust path already allows. These moments must stay
cheap: a plugin that does not answer within the handler budget is skipped, and a
session switch or delete never waits on a plugin.

## Consequences

- #561's twelve slots become ten offered capabilities, one withdrawn capability
  (slot 6) and one excluded capability (slot 12), each with rules that hold
  across the set and a permission where it ships.
- Ordinary plugins get the runtime abilities that only high-trust plugins reached
  before. The install review becomes the consent surface for all of them, which
  is consistent with the plugin-center review model, and inconsistent with the
  current code silently implying twelve grants from one tier permission.
- Permission names are **reserved here and registered as each slot ships**; slot
  6's name is deliberately absent from the SDK, the desktop risk table, the
  devkit mirror, the locales and the permission matrix. Registering a name early
  would ship a name that does nothing and grow the existing gap of names without
  display copy.
- Argument rewriting is gone for good, and the docs must stop implying it exists.
- Three pieces of work are now prerequisites rather than side quests: fixing the
  `artifacts` model, persisting continuations as visible rows (ADR 0293), and
  gating the closing hook with its own permission.
- The audit surface grows: diff-level records for rewrites are new storage and a
  new inspection UI.

## Alternatives

- **Use the harness layer's eleven hooks.** Rejected: that layer carries its own
  persistence model, which collides with host-core owning persistence; and the
  only capability it would add over the kernel is argument rewriting, which rule 4
  rejects on its own merits. Rejecting the harness costs the product nothing else,
  because the kernel has an equivalent for every other hook the twelve slots need
  (`before_run_end` ↔ `shouldStopAfterTurn` + follow-ups, `transform_context` ↔
  `transformContext`, `before_payload` ↔ `onPayload`, `after_response` ↔
  `onResponse`, `before_compaction` ↔ `session_before_compact`).
- **Wrap the host's tool objects to rewrite arguments.** Rejected in rule 4: it
  would change what the user approves, break the model's own reasoning about the
  arguments it emitted, and reimplement a capability the kernel deliberately does
  not have.
- **Give high-trust plugins the slots for free.** Rejected in rule 2: D1 says one
  slot, one permission, listed on the install page; a tier permission answers a
  different question.
- **Log every session read.** Rejected in rule 7: volume without protection.
- **Quota plugin continuations.** Rejected in rule 9: the host has no such limit
  for its own loops, and visibility is the honest control.
- **Ship all twelve permissions now, wire the slots later.** Rejected: names that
  grant nothing mislead authors and reviewers, and the permission registry is
  mechanically synced across six places.

## Phasing

Recommended order once implementation starts (each step is independently
shippable):

1. **Low-risk, high-value, self-contained**: #3 abort (+ cancellation signal),
   #5 tool capabilities, #9 turn facts (with the `artifacts` extension).
2. **Events and lifecycle**: #1 before send, #11 session lifecycle — both need
   the `pi-coding-agent` emit surface widened (blacklist / never-emitted events),
   so one change unlocks two slots.
3. **Withdrawn before shipping**: #6 before request was dropped by product
   decision (see §1). Rule 5's diff-level audit still shipped with slot #1, its
   first producer.
4. **Closing the loop**: #7 turn closing — wire the permission (rule 2) and
   complete ADR 0293's persistence, which the hook currently does not do.
5. **Last, and only when the audit surface exists**: #4 tool gate (informed by
   the confirmation patterns of rule 6).
6. **Not this cycle**: #12 approval before.
