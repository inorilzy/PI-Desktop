# Slots Demo

A PI-Desktop example plugin for the trusted renderer host: it registers React
components into host-owned slots and injects one host-scoped stylesheet. It is the
copy-me shape for `manifest.renderer` (spec `07-plugins/16-trusted-extensions.md`
§2A, ADR 0291).

## What it demonstrates

- **Two entries, one plugin.** `main.js` is the headless half (the plugin's own
  process, the host-injected `pi` global). `renderer/index.mjs` is the trusted
  renderer half, which runs **inside the app window**. The tiers are orthogonal:
  declaring one grants nothing in the other.
- **`renderer.extension`.** `manifest.renderer` plus that grant is what lets the
  host serve and evaluate the module. Declaring `renderer` without the permission
  fails manifest validation; a manifest that asks for it but was never granted it
  loads with the entry skipped and audited.
- **Component slots.** `entryExtra` (a component-only slot, one extra block below
  a transcript entry) and `modal` (a blocking, app-level dialog). The modal
  registration *is* the layer, so its card carries a **Close the modal** button
  that withdraws the registration; Escape is the host's own dismissal and leaves
  the registration — and the card's `useState` counter — in place.
- **Data in, actions out.** A slot component is handed two things: the slot's
  host data as props, and `dispatch(action, payload)`, which acts for the plugin
  that registered the component (ADR 0294). `rendererData` and
  `rendererActions` in the manifest name what the module reads and calls, and
  the vocabulary belongs to the host — this example reads `entry`, dispatches
  `ui.toast` from the badge's first button, and `plugin.call` from its second.
  An action the manifest does not declare is refused with a structured
  `PLUGIN_ACTION_UNDECLARED` error rather than ignored, so a button that does
  nothing is a bug you can see.
- **Two classes of action, both relayed.** `ui.toast` is a *host-performed*
  action: the window's own host runs it and answers. `plugin.call` is
  *forwarded*: the host sends `{ method, args }` to the calling plugin's own
  headless entry — `main.js` here, over the same child channel panel calls use —
  and the promise resolves with whatever that entry returned. `main.js`
  implements `onRendererCall`, answers `demo.echo` with the arguments it was
  handed plus a counter kept **in that process**, and refuses any other method
  by name. The badge prints the entry's answer, so what you see is a value the
  window could not have produced on its own.
- **The host's React, not the plugin's.** `react` is imported as a bare
  specifier; the host maps it to its own instance through an import map. The
  modal's counter uses `useState` from that shared instance — a plugin that
  shipped its own React copy would be refused at load.
- **Lazy loading.** Nothing is fetched until one of the plugin's slots actually
  renders, and an unrendered slot costs nothing at startup.
- **Injected, host-scoped styles.** `pi.ui.injectStyle(css)` is the only way to
  style plugin UI. Every selector here is `.acme-slots-demo__*`, but scoping does
  not depend on that naming: the host auto-scopes every selector under the
  plugin's `[data-pi-plugin="<id>"]` container and rewrites `:root` to that
  container. A sheet whose top-level selector is `html`, `body`, or `*`, or that
  uses `@import`, is refused whole instead of being silently narrowed, and the
  host reports `PLUGIN_STYLE_SCOPED` when it rewrote the source. The host removes
  the sheet on unload, so the module exports no `onUnload`.

## Files

| File | Role |
|---|---|
| `manifest.json` | Declares `main`, `renderer`, the `rendererData` list, the `rendererActions` list (`ui.toast`, `plugin.call`), the `renderer.extension` permission, and one command |
| `main.js` | Headless entry: registers the declared command, and implements `onRendererCall` — the method the badge's `plugin.call` dispatch runs in the plugin's own process |
| `renderer/index.mjs` | Renderer entry: `onLoad(pi)` injects the stylesheet and registers two slots; the badge's first button dispatches `ui.toast`, its second one `plugin.call` |

## Install (development folder)

There is no CLI install step for a plugin folder — the app loads it:

1. Open PI-Desktop and go to the **Extensions** destination in the sidebar
   (`Plugins` in older docs and in `docs/spec/`).
2. Open the header **⋯ (More actions)** menu and choose **Load local plugin**.
   The same button is offered in the empty state. Older documentation calls this
   action "Load development plugin".
3. Select the `examples/plugins/slots-demo` directory.
4. Accept the permission review. It must include `renderer.extension`; without
   that grant the manifest is refused, or the entry is skipped and audited.

Use **Load local plugin** for this example — **Import pi extension** is for pi CLI
extension packages and is a different flow.

## What you should see

The plugin row shows a `renderer` capability chip once the entry is served. The
slots draw wherever the host's current surfaces mount them: the badge below a
transcript entry, the dialog as an app-level modal. The dialog is up as soon as
the entry runs — a registration is the layer — so **Close the modal** takes it
away, and pressing Escape hides it the host's way (the registration stays, so the
next render of that position brings the dialog back with its counter intact).

The badge carries both classes of action, and each one reports what really came
back rather than a tick:

- **Notify the host** (`ui.toast`) asks the host to show a notification and then
  prints `toast sent`, or the code of the refusal.
- **Ask the entry** (`plugin.call`, method `demo.echo`) sends
  `{ from: "badge" }` to this plugin's own headless entry and prints the answer
  it returned — the method, the arguments, `entry: "main.js"` and the entry's
  own call counter. Click it twice: the counter goes 1, 2, because it lives in
  that process. If the round trip is unavailable, the button shows the code
  instead (`PLUGIN_ACTION_UNDECLARED` when the manifest does not declare
  `plugin.call`, `PLUGIN_CALL_NO_ENTRY` for a plugin with no headless entry,
  `PLUGIN_CALL_NO_HANDLER` for one whose entry implements no renderer methods,
  `PLUGIN_CALL_TIMEOUT` when the call never answered).

A slot no visible surface renders simply leaves the module unloaded — that is
the design, not a failure. If a component throws, only its own slot collapses to
the host's default rendering and the crash is reported as a diagnostic.

## Reference

- Spec: `docs/spec/07-plugins/16-trusted-extensions.md` §2A
- Decision: `docs/adr/0291-trusted-renderer-execution-host.md`
- Other examples: `examples/plugins/README.md`
