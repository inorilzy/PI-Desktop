# ADR 0294: The renderer plugin interface and its host relay

- Status: Accepted for implementation
- Date: 2026-09-18
- Related: issue #528 (sub-issue #545) ·
  [ADR 0291](0291-trusted-renderer-execution-host.md) ·
  [ADR 0292](0292-runtime-hooks-for-plugin-host-processes.md) ·
  [02-plugin-manifest-schema](../spec/07-plugins/02-plugin-manifest-schema.md) ·
  [16-trusted-extensions](../spec/07-plugins/16-trusted-extensions.md)

## Context

ADR 0291 fixed how a trusted renderer module is loaded, how its styles are
namespaced, and what a crash costs. It did not fix what a slot component may
*do*. Today the answer is "nothing":

- The `pi` object handed to `onLoad` carries `plugin`, `slots.register` and
  `ui.injectStyle`, and nothing else
  (`apps/desktop/src/plugins/renderer-host/loader.ts:50-89`, as of `0726e0ff`).
- The two slots that are really mounted pass data-only props. `entryExtra` gets
  `{ entry, sessionId }` (`features/chat/transcript/model.ts:105-118`),
  `codeBlock` gets `{ language, code, isIncomplete, theme }`
  (`components/Markdown.tsx:534-543`). Neither receives a single callback.
- The other eight declared slots register successfully and render nowhere, so
  the gap has not shown up in practice yet.

Issue #545 already assumes callbacks exist: its general rendering contract says
the host hands a plugin component props *and callbacks*, that a plugin must not
touch document-level globals, and that the two sides share one React instance.
What is missing is the wire. Without a decision, each of the fourteen slots
would invent its own callback props — fourteen undocumented interfaces, each
with its own error behaviour, and no single place where a plugin states what it
uses and what it does.

Two facts from ADR 0291 bound what such a wire can be worth. The trusted
renderer module shares the host's realm, module graph and React tree, and it can
reach `window.piDesktop` and all 243 whitelisted preload channels with no
per-caller check (ADR 0291 decision 6, measured in a real Electron run). So this
interface is a contract for plugins that behave, not a wall around plugins that
do not.

## Decision

1. **Data comes in as props; actions go out through one method.** A slot
   component receives host data (`slotProps`) and a `dispatch(action, payload)`
   function. Both arrive as props on every render; nothing is ambient, and no
   other host handle is part of the interface.

2. **A plugin declares what it uses and what it does, in the manifest.**
   `rendererData: string[]` and `rendererActions: string[]`, both optional. Each
   is a subset of a host-owned vocabulary, so a plugin may only pick from names
   the host knows; it cannot invent one:

   - `rendererData`: `entry`, `session`, `code`, `theme`, `selection`, `draft`,
     `attachments`, `locale`.
   - `rendererActions`: `plugin.call` (forwarded to the plugin's own entry), and
     the host-performed actions `composer.replaceDraft`,
     `composer.insertText`, `composer.attachPath`, `ui.openOverlay`,
     `ui.closeOverlay`, `ui.openModal`, `ui.closeModal`, `ui.toast`.

3. **The two lists are declarations, not permissions.** They grant nothing, they
   are not in the permission enum, they do not change grants, and a manifest
   that declares them without `renderer` still validates. They exist to give the
   plugin and the host one stable contract, to give plugin-center review
   something mechanical to compare against the code, and to be visible wherever
   a review already holds the manifest it asks about — today the developer-folder
   load and reload review. They are not a security gate, and must not be
   documented as one: the defence against hostile plugin code is marketplace
   review plus install-time consent (product decision, this cycle).

4. **`dispatch` has two classes of recipient, and the host relays both.**

   - *Host-performed actions* are executed by the host renderer against its own
     state — composer draft, attachments, overlays, modals, toasts. No plugin
     process is involved.
   - *Forwarded actions* are `plugin.call { method, args }`: Electron main
     relays the call to the calling plugin's own entry — its `utilityProcess` or
     its page — over the same `sendToChild` path plugin panels already use, and
     brings the answer back to the caller.

   A dispatch returns a promise. A missing recipient, a thrown error, or a
   vocabulary entry that the host does not implement yet is reported as an
   error; nothing degrades to a silent no-op, because a silent no-op is
   indistinguishable from a plugin bug.

5. **Identity is the declared plugin id.** A slot component is rendered on
   behalf of exactly one plugin, and the host attaches that plugin's id to every
   dispatch. The renderer refuses an action the plugin did not declare before
   anything else happens; for a forwarded call, Electron main then looks the
   plugin up in its own registry and forwards only when that plugin is loaded
   and its manifest declares the action, which is what makes `plugin.call` reach
   the calling plugin's own entry rather than a neighbour's. This is a
   correctness measure for the normal case. It is not containment, and is not
   described as such: a module in the host realm can call IPC directly, so a
   plugin that intends to lie is not stopped by this check (ADR 0291 decision 6).

6. **Some positions need the host to call the plugin locally, and synchronously.**
   A slot that sits inside rendering — a per-message block whose height the
   transcript must know, a code-block decoration, a value read while a composer
   control is computed — cannot be served by an async round trip without the UI
   flickering or reflowing afterwards. The interface therefore also lets a
   plugin register host-callable pure functions, invoked in the renderer while
   the host renders, with the semantics a synchronous call actually admits: the
   call is measured, an answer that returns within the one-frame budget (16 ms)
   is used, an answer that arrives over budget is discarded, and a failure —
   missing, thrown, or over budget — is recorded as a diagnostic on the
   plugin's row. Three consecutive over-budget or throwing calls trip a
   per-function circuit breaker (a success resets the count), and the host then
   stops calling that function for the rest of the plugin's loaded lifetime.
   The deadline therefore limits what the host *uses*, not what it *waits for*:
   a synchronous call cannot be preempted, so the budget is enforced by
   discarding the answer and by the breaker, never by cancelling the call.
   These functions are renderer-local: they are not an IPC channel and must not
   perform I/O.

7. **Data is pushed; plugins do not poll — within a narrow ambient set.**
   Slot-contract props (draft, entry, references, mode, query, position, code,
   …) always arrive from the mount that owns that slot and are not gated by
   `rendererData`. Ambient keys the host injects at `SlotOutlet` when the
   plugin declared them are only `theme` and `locale`
   (`PLUGIN_RENDERER_AMBIENT_DATA`), and only when the host already holds the
   value. `selection` remains declarable for install review but is not served
   this cycle; the host reports `PLUGIN_DATA_UNSERVED` rather than silently
   ignoring the declaration. Data a plugin did not declare is never
   ambient-injected. This is a merge, not a live subscription engine.

8. **Within one slot, plugins render in registration order.** A later plugin
   cannot take a position away from an earlier one, matching the ordering rule
   ADR 0292 fixed for runtime hooks.

9. **A refused dispatch is visible.** A disallowed or unknown action returns a
   structured error, is audited, and leaves a diagnostic on the plugin's row,
   the same way ADR 0292 treats a refusing hook.

## Consequences

- All fourteen UI slots can be implemented against one interface. Mounting the
  remaining eight becomes ordinary UI work instead of eight protocol decisions.
- The vocabulary is the extension axis. Adding an action, or a data key, is a
  spec, validation and relay change in one place — the price is that a plugin
  cannot ship a genuinely new capability without the host knowing about it,
  which is the point.
- Compatibility is unchanged for existing plugins: two more optional fields, no
  migration, and hosts older than this change ignore the fields (manifest
  validation does not reject unknown keys), so a plugin that declares them still
  installs there. `engines.piDesktop` remains the way to require a host new
  enough to serve them.
- The declarations do not contain a hostile plugin, and the same-realm decision
  is untouched. Anyone reading the lists as a boundary would be reading them
  wrongly; the audit trail and the review dialog are what they are for.
- Two new surfaces now need upkeep: the action vocabulary (its unimplemented
  entries must keep returning explicit errors) and the main-process dispatch
  check (it must not grow into a place where trust is assumed).
- The eight unmounted slots stay unmounted in this cycle. The interface is
  designed for them; shipping them is separate work under #545.

## Alternatives

- **Per-slot callback props, decided slot by slot.** Rejected: fourteen
  undocumented interfaces, no shared error behaviour, and no place for a plugin
  to state what it uses.
- **One ambient dispatch handle on the document, e.g. `window.piPlugin`.** Rejected:
  it would be a single handle for every plugin in the window, with no natural
  way to attribute a call to a plugin — the same mistake ADR 0291 decision 6
  recorded about the preload bridge.
- **Isolation first: iframe, worker, or `MessagePort` behind a token.** Rejected,
  and the evidence is specific rather than theoretical: a comparable plugin host
  shipped a renderer token gate whose only importer disappeared, leaving it dead
  code, and deleted its isolated worker runtime in a later ADR. A token held in
  the same realm is not a boundary, and paying for partial isolation would
  degrade the real-time slots that need synchronous local calls.
- **A per-call capability token handed to the plugin module.** Rejected for the
  same reason: the same realm can read it, so it buys an audit line and nothing
  else, at the cost of pretending to be a boundary.
- **Making `rendererActions` a permission.** Rejected by product decision. The
  high privilege a renderer entry already carries is expected, the malicious-code
  defence lives in plugin-center review, and presenting the list as a permission
  would mislead both authors and reviewers about what it enforces.
