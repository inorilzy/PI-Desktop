# Runtime Slots Demo

A PI-Desktop example plugin for the **agent-side runtime slots**: the points
inside a running turn where a plugin is consulted and may change what the agent
does. It ships one small, honest behaviour — a shell guard that refuses unsafe
commands and, if the model keeps trying, asks the host to stop the turn — and it
declares exactly the slot permissions it uses, one per slot. It is the copy-me
shape for `contributes.agentExtensions` plus `runtime.*` grants (spec
`07-plugins/16-trusted-extensions.md` §6, ADR 0295).

## What it demonstrates

- **Two entries, two different worlds.** `main.js` is the plugin's own process:
  it registers the palette command, and it exists because a manifest must
  declare at least one entry (`main`, `renderer`, or a plugin page) —
  `contributes.agentExtensions` alone does not make a plugin runnable (spec
  `07-plugins/02` §7 rule 19). `agent/extension.js` is the agent-side module:
  it runs in the agent sidecar, which is the only plugin host that sees a
  running turn.
- **`runtime.tool.gate` (slot 4), the headline.** `pi.on("tool_call", handler)`
  is consulted before a tool runs. Returning `{ block: true, reason }` refuses
  the call, and the reason is what the user and the model are shown — so the
  demo writes readable prose instead of a code. It judges only the `Bash` tool
  and only three command patterns.
- **`runtime.turn.abort` (slot 3).** Three refusals in a session's window and
  the plugin calls `pi.requestTurnAbort()`, which asks the host to stop the
  running turn — the same path the Stop button takes. The call **returns**
  whether the request was accepted (`false` when the plugin does not hold the
  grant, plus a `permission_denied` diagnostic), so the block reason can say
  which answer it got. The plugin's own long-running work would learn about the
  stop through the turn's cancellation signal (`ctx.signal` in a handler,
  `signal` in a plugin tool's execution context); this demo has no long-running
  work to cancel, which is why it never reads that signal.
- **One permission per slot, declared explicitly.** `agent.extension` says where
  the module runs; it grants neither slot (ADR 0295 rule 2). A manifest that
  lists `agentExtensions` without `agent.extension` is refused at install, and a
  slot the plugin does not hold is not a silent no-op: the handler is skipped and
  the plugin row reports a `permission_denied` diagnostic naming the permission.
- **A refusal the user can see.** The block reason travels with the tool call in
  the transcript, and the handler also raises `ctx.ui.notify`, so a refusal is
  never a mystery the user has to attribute themselves.

## Files

| File | Role |
|---|---|
| `manifest.json` | Declares `main`, `contributes.agentExtensions`, one command, and the three permissions: `agent.extension`, `runtime.tool.gate`, `runtime.turn.abort` |
| `main.js` | Plugin-process entry: registers the declared command, which explains the demo in a toast |
| `agent/extension.js` | Agent-side entry: the `tool_call` gate and the abort request |

## Install (development folder)

There is no CLI install step for a plugin folder — the app loads it:

1. Open PI-Desktop and go to the **Extensions** destination in the sidebar
   (`Plugins` in older docs and in `docs/spec/`).
2. Open the header **⋯ (More actions)** menu and choose **Load local plugin**.
   The same button is offered in the empty state. Older documentation calls this
   action "Load development plugin".
3. Select the `examples/plugins/runtime-slots-demo` directory.
4. Accept the permission review. All three grants are high risk and all three are
   needed: `agent.extension`, `runtime.tool.gate`, `runtime.turn.abort`. Without
   `agent.extension` the manifest is refused; without a slot grant the behaviour
   behind that slot is skipped and reported as a diagnostic.

Use **Load local plugin** for this example — **Import pi extension** is for pi CLI
extension packages and is a different flow.

## Try it

The guard only acts inside a turn, so ask the agent to do the thing:

1. In a chat, ask: *"Run `rm -rf /` with Bash."* The model's tool call is
   refused before anything runs. You get a toast that names the plugin, and the
   transcript shows the block reason: `Runtime Slots Demo refused this command: a
   recursive force-delete of the filesystem root. Ask the user how to proceed
   instead of retrying.`
2. Ask again, or let the model retry. On the **third** refusal in the same
   session the plugin also asks the host to stop the turn, and the reason says
   so — `… and asked the host to stop the turn after 3 refusals: accepted.` If
   the grant were missing the same sentence would end in `refused.`
3. Run **"Runtime Slots Demo: What this plugin adds"** from global search
   (`Cmd/Ctrl+K` or `Cmd/Ctrl+Shift+P`) to see the plugin's own summary toast,
   printed from the plugin process rather than the agent.

`git push --force-with-lease` is deliberately **not** refused by this demo: the
patterns match literal `--force`, and the lease variant is the safe form. A
`git push --force`, `mkfs.*`, and a recursive `rm -rf /` are.

## What this does not do yet

- **No turn-facts summary.** The turn-facts slot (9) has its host-side answer —
  host-core serves `turn.facts` from its own tables on schema v21
  (`docs/spec/03-runtime/06-host-rpc-protocol.md`,
  `docs/spec/03-runtime/04-data-storage.md` §4.16) — but **no plugin-facing
  reader for it exists yet**: there is no `pi.*` call that returns those facts.
  This demo therefore does not request `runtime.turn.facts`; a permission with
  nothing to call would only be another line in the user's consent dialog.
- **No event-assembled summary either.** A plugin can observe the raw turn event
  stream with `runtime.turn.watch` and count what it saw, but that count is the
  plugin's own view of what it happened to receive (best-effort delivery, no
  receipt, no redelivery) — not the host's numbers. That difference is exactly
  why slot 9 exists, so this example does not fake it.
- **No tool extension.** Slot 5 (`runtime.tool.extend`) lets a tool result
  introduce a tool, report its own spend, and ask for early termination. It needs
  a tool of its own, and this demo registers none; the fields are documented in
  spec 16 §7.6.
- **No argument rewriting.** A `tool_call` handler may block a call and give a
  reason — nothing else. Rewriting the call's arguments is permanently excluded
  (ADR 0295 rule 4), so no plugin should build on it.
- **Not a security control.** The three patterns are shallow and easy to evade
  (quoting, variables, another language). They demonstrate the slot, not a
  policy. A real guard belongs in the host's approval rules.
- **Nothing from the other slots.** Before Send (1), Turn Closing (7), Turn
  Recap (8), Turn Continue (10), Session Lifecycle (11) and Approval Before (12)
  are not used here; Before Request (6) was withdrawn — `runtime.request.before`
  is not offered and a handler for it is never consulted — and Approval Before
  (12) is not built.

## Reference

- Spec: `docs/spec/07-plugins/16-trusted-extensions.md` §6, §6.1, §7.6
- Permissions: `docs/spec/07-plugins/13-plugin-permissions-matrix.md` §2, §2C
- Decision: `docs/adr/0295-runtime-slots-and-their-permissions.md`
- Other examples: `examples/plugins/README.md`
