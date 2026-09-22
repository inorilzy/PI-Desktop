# ADR 0292: Runtime hooks for plugin-host processes

- Status: Accepted for implementation
- Date: 2026-09-18
- Related: issue #528 (sub-issue #561) ·
  [ADR 0215](0215-agent-extensions-as-plugin-contribution.md) ·
  [ADR 0214](0214-trusted-extensions.md) ·
  [ADR 0291](0291-trusted-renderer-execution-host.md) ·
  [02-plugin-manifest-schema](../spec/07-plugins/02-plugin-manifest-schema.md) ·
  [13-plugin-permissions-matrix](../spec/07-plugins/13-plugin-permissions-matrix.md) ·
  [16-trusted-extensions](../spec/07-plugins/16-trusted-extensions.md)

**Implementation status: partial.** This record fixes the accepted design of the
broker channel, and that channel is not built: there is no registration IPC, no
registration table, no 2 s deadline, and no circuit breaker. What is built is
the slot model around it ([ADR 0295](0295-runtime-slots-and-their-permissions.md)):
the twelve `runtime.*` names are registered (plugin SDK, desktop risk table,
devkit mirror, eight locales), the agent sidecar resolves a wired event's slot
permission before a handler runs and reports a skip as a `permission_denied`
diagnostic, and nine slots have a wired entry point — Before Send (1), Turn
Watch (2), Turn Abort (3), Tool Gate (4), Tool Extend (5), the request hooks of
Before Request (6), Turn Closing (7), Turn Facts (9) and Session Lifecycle (11).
The remaining slots carry a registered name without a plugin-facing path yet,
and #12 (Approval Before) is not built at all. This record remains the accepted
shape of the broker channel.

## Context
Issue #561 names twelve runtime slots: points inside a running turn where a
plugin is consulted and may change what happens. Today a plugin can only be
consulted if it is an **agent extension** (`contributes.agentExtensions`),
which runs in the agent sidecar and carries the high-risk `agent.extension`
grant ([ADR 0215](0215-agent-extensions-as-plugin-contribution.md),
[16-trusted-extensions](../spec/07-plugins/16-trusted-extensions.md) §6).

The other two plugin hosts have no registration path at all:

- `main` (`manifest.main`): one Electron `utilityProcess` per plugin
  ([ADR 0008](0008-plugin-runtime-isolation-target.md)).
- `views` / `ui.panel` / `settingsDestinations[].entry`: the plugin's own page
  in its own `webContents`.

Nothing in the host can call into those processes from inside a turn, so every
runtime slot was reachable only through the sidecar gate. The product decision
of 2026-09-18 is to open a controlled channel instead of leaving the twelve
slots as a high-trust-only surface. This ADR fixes the shape of that channel,
its failure policy, and its ordering rule.

## Decision

1. **Electron main is the only broker.** A plugin-host process never reaches the
   agent runtime directly. It registers over the existing plugin-host IPC to
   Electron main, and main owns the registration table, the permission check,
   the audit record, the deadline, and the circuit breaker. The agent runtime
   sees one broker, not N plugins.

2. **All twelve slots are open, including the ones that can stop or rewrite.**
   There is no notify-only subset: a plugin that may be told a message is about
   to be sent may also stop it. The gate is the install-time review. The
   per-slot permission names in
   [13-plugin-permissions-matrix](../spec/07-plugins/13-plugin-permissions-matrix.md)
   §2 are what the user explicitly confirms, and they are the same names the
   sidecar path uses — one name per slot, no second naming scheme for the new
   channel.

3. **A hook call races a 2 s deadline.** On timeout the answer is "no opinion":
   the turn proceeds with the unmodified value and records a diagnostic. A
   handler that throws is also "no opinion", logged the same way. The existing
   30 s allowance in
   [16-trusted-extensions](../spec/07-plugins/16-trusted-extensions.md) §6 is
   for a handler in the same process tree as the runtime; a cross-process
   round trip on the turn path cannot inherit it.

4. **Three strikes per run.** Three timeouts or throws for one plugin and one
   slot in the same run circuit-break that pair for the rest of the run:
   later hook points skip it without waiting, and the skip is a diagnostic, not
   a silent drop. The breaker resets with the next run, like the `turn_closing`
   continuation budget.

5. **Registration order decides the order of consultation.** The first plugin
   to register a slot is consulted first and cannot be displaced by a later
   registration. Derived from that, and recorded here so it is not assumed
   silently: a slot whose answer can end the matter — stop the message, end the
   turn — stops consulting the remaining handlers once one of them answers
   affirmatively; a slot that rewrites a value passes the rewritten value down
   the chain.

6. **The cost is paid on the turn path, on purpose.** A registered slot costs
   one cross-process round trip per registered plugin per hook point. The three
   bounds above (only registered slots, 2 s, three strikes) are what keeps that
   cost from being unbounded.

## Consequences

- Once this broker ships, batch A and the remaining batch E₂ slots are unblocked
  for all three plugin hosts: this was the hard prerequisite the plan called G14.
- The threat surface grows in a way that must not be softened later: a plugin
  that could previously only draw a page can now influence a running turn, up
  to stopping a message or ending a turn. What stands between that and the user
  is the high-risk permission name, the install-time review, the audit log, and
  the breaker. There is no sandbox between a plugin's decision and the turn.
- A turn now depends on another process being responsive. The deadline bounds
  the damage; an honest but slow plugin is skipped at 2 s, which its author
  cannot detect other than through diagnostics.
- Every refusal is observable: unregistered slot, missing permission, timeout,
  circuit-broken, and broker unavailable are each a diagnostic. A refusal is
  never a silent no-op.

## Alternatives considered

- **Keep the sidecar as the only path (the option recommended first).**
  Rejected by the product decision: the twelve slots are a product surface
  specified for plugins in general, not a high-trust-only feature. The cost is
  recorded above rather than argued away.
- **Open only the notify-only slots.** Rejected: it doubles the contract (two
  shapes per slot, two permission semantics) to avoid a confirmation the
  install review already carries.
- **Wait without a deadline.** Rejected: a wedged plugin process would hang a
  turn with no user-visible cause and no recovery point.
- **Remove the plugin's hooks on the first failure.** Rejected as too blunt: one
  transient IPC hiccup would silently disable a plugin for the whole session,
  and silent degradation is harder to diagnose than a bounded skip.
