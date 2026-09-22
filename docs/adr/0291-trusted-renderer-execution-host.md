# ADR 0291: Trusted renderer execution host

- Status: Accepted for implementation
- Date: 2026-09-18
- Related: issue #528 (sub-issues #545 / #561) ·
  [ADR 0215](0215-agent-extensions-as-plugin-contribution.md) (D387 / D388) ·
  [ADR 0214](0214-trusted-extensions.md) · [ADR 0008](0008-plugin-runtime-isolation-target.md) ·
  [02-plugin-manifest-schema](../spec/07-plugins/02-plugin-manifest-schema.md) ·
  [04-plugin-security](../spec/07-plugins/04-plugin-security.md) ·
  [12-plugin-ipc-and-host-services](../spec/07-plugins/12-plugin-ipc-and-host-services.md) ·
  [13-plugin-permissions-matrix](../spec/07-plugins/13-plugin-permissions-matrix.md) ·
  [14-plugin-roadmap](../spec/07-plugins/14-plugin-roadmap.md) ·
  [16-trusted-extensions](../spec/07-plugins/16-trusted-extensions.md) ·
  [08-meta/decisions-log](../spec/08-meta/decisions-log.md) (D218)

## Context

PI-Desktop already has three plugin execution hosts.

- `main` (`manifest.main`): one Electron `utilityProcess` per plugin, behind the
  permission gateway and the audit log ([ADR 0008](0008-plugin-runtime-isolation-target.md)).
- `views` (`contributes.views[].entry`, `ui.panel`,
  `settingsDestinations[].entry`): the plugin's own page in its own
  `webContents`, loaded from `file://`, per-plugin partition, `net.domains`
  egress.
- `agent` (`contributes.agentExtensions`): plugin code in the agent sidecar,
  shipped and documented in [ADR 0215](0215-agent-extensions-as-plugin-contribution.md)
  and [16-trusted-extensions](../spec/07-plugins/16-trusted-extensions.md).

Work on #528 adds a fourth surface, `renderer`: a new optional manifest entry
whose module runs **inside the host renderer process, in the same JavaScript
realm as the host UI**, and registers React components into host-defined slots.
That is a different trust position from all three existing hosts, and it is the
first surface where plugin code shares a realm, a DOM, a module graph, and a
React tree with the host. This record fixes the host contract, the trust tier,
and — most importantly — the defences that are given up by accepting it.

The UI slots themselves are defined by the UI-slot contract (#545); this ADR
governs the host that loads slot implementations and the rules they are held to.

## Decision

1. **`manifest.renderer` is a new optional entry field.** It is a
   plugin-relative path to an ESM module. `manifest.main` is relaxed from
   required to optional, with one new validation rule: at least one entry must
   exist across `main`, `renderer`, and the `views` / `ui.panel` /
   `settingsDestinations` entry contributions. Existing plugins are unaffected
   — every manifest that validates today still validates, and every manifest
   without `renderer` keeps its current behavior byte for byte.

2. **Trust is per entry, and the tiers are orthogonal, not a ladder.**

   | Entry | Where the code runs | Permission | Component slots |
   |---|---|---|---|
   | `main` / `views` | plugin process / plugin `webContents` | existing manifest permissions | none |
   | `renderer` | the host renderer, same realm | `renderer.extension` (high) | allowed |
   | `agentExtensions` | agent sidecar | `agent.extension` (high) | none |

   The base tier (`main` / `views` only) can register no slots. The trusted UI
   tier (declares `renderer`) can register component slots. The trusted agent
   tier (declares `agentExtensions`) runs in the agent sidecar. A plugin may
   declare any combination; declaring one tier grants nothing in another.

3. **One permission name covers the trusted UI tier: `renderer.extension`,
   risk tier `high`.** A single name authorizes every component slot; slots are
   not individually authorized, following the UI-slot contract decision D1 —
   *by tier, not by slot* (#545). The existing model is reused unchanged:
   declaration is the application, the install review is the authorization
   ceiling, and a runtime `assertPermission` check gates the load. A plugin that
   declares `renderer` without the grant loads with its module skipped and
   audited, exactly like `agentExtensions`.

4. **There is no entry-level distribution gate.** A plugin that declares
   `renderer` is a normal plugin and is distributed normally: local import,
   development plugin, and marketplace listing are the same paths the other
   tiers already use.

5. **`renderer` entries load lazily.** The module is fetched and evaluated only
   when one of its slots is first really rendered. Nothing is reserved or shown
   while loading, so a plugin that declares slots the current surface never
   renders costs nothing at startup.

6. **Same realm is accepted, deliberately.** No `iframe`, no worker, no second
   sandbox: the module shares the host's global object and React tree. One
   mitigation ships with it: the plugin module's import map resolves only
   `react`, `react-dom` and `react-dom/client`, all three to the host's own
   copies; nothing else is mapped, so a bare specifier a plugin invents fails at
   import rather than resolving to a host module. The bridge global is *not*
   mitigated. An earlier version of this decision claimed the app deletes
   `window.piDesktop` after capturing the bridge, and a real Electron run
   measured that claim to be false: `contextBridge.exposeInMainWorld` defines the
   property non-configurable, so `delete window.piDesktop` is a silent no-op —
   `typeof window.piDesktop === "object"`, `"piDesktop" in window === true`, and
   `piDesktop.invoke` reaches all 243 whitelisted channels (220 invoke + 23
   event) with no per-caller check. The host API is not a specifier at all: it
   arrives as the `pi` argument of `onLoad`, which is what keeps it per-plugin —
   an import-map entry would have had to be the same URL for every plugin in the
   document.

7. **Plugin code is fetched over a new custom scheme, `plugin-renderer`.** The
   existing `plugin-asset` scheme is not widened: its MIME allowlist is
   deliberately images and fonts only. The new scheme serves `js` / `mjs` /
   `css` / `json` / `map`, is restricted to paths inside the plugin package, and
   only answers for plugins that are loaded **and** declare `renderer`. Because
   the host renderer is a `file://` origin in production, the production CSP
   must allow the scheme for scripts and connections, and the build-time CSP
   tightening `tightenCsp()` in `apps/desktop/electron.vite.config.ts` (it
   rewrites `connect-src` to `'self'`) must be updated in the same change —
   otherwise the feature works in dev and breaks only in packaged builds.

8. **React is a singleton, as a hard requirement.** The host injects its own
   React through the import map. A plugin that ships its own React is refused at
   load with a diagnostic; two React copies break hooks and context, and a
   silent second copy would fail in ways users cannot explain.

9. **Style isolation is host auto-scope plus a public token surface, not Shadow
   DOM.** Every slot is wrapped in a `data-pi-plugin="<plugin-id>"` container;
   plugin styles must go through the host API `pi.ui.injectStyle(css)`, and the
   host removes them on unload. The host **rewrites** selectors under that
   container before serving (observable as `PLUGIN_STYLE_SCOPED`); `:root` is
   rewritten to the container; top-level `html`, `body`, `*`, and `@import` are
   refused (`PLUGIN_STYLE_REFUSED`). Public design tokens are the `--pi-slot-*`
   aliases on `.pi-plugin-slot` (`PLUGIN_SLOT_DESIGN_TOKENS`); host-internal
   `--ds-*` names are not a plugin contract. Replace-type slots take one claim
   (`PLUGIN_SLOT_DUPLICATE` for a later registration). Shadow DOM was rejected
   because the renderer's `createPortal` call sites would escape a shadow root.
   Rewrite is intentional contract, not silent mutation: authors preview with
   SDK `scopePluginStyle`.

10. **Crash containment is per-slot React error boundaries plus crash reporting
    — nothing more.** A slot that throws collapses to nothing and does not
    affect neighboring entries. Where the host has its own default rendering for
    that position, it falls back to the default.

11. **Registering a slot without declaring `renderer` is skipped and produces a
    visible diagnostic.** The plugin is never silently served: the slot is not
    mounted, and the user or developer sees that it was refused and why.

## Relation to D218

D218 ("Host-owned cross-platform plugin panel chrome") states, in its rationale
column:

> Default Electron frames made plugin tools look detached from PI-Desktop and
> varied by platform. Preload-owned chrome provides parity without moving
> untrusted plugin HTML into the host renderer or exposing general Electron
> window authority (ADR 0081).

The clause is scoped to *untrusted plugin HTML*, and that is exactly what stays
out: panel and view contributions still load their own page in their own
`webContents`, and the sandboxed plugin preload still draws its own chrome. This
ADR moves *trusted plugin code* — an ESM module the user explicitly granted
`renderer.extension` to — into the host renderer.

**Verdict: D218 is not contradicted and does not need an amendment.** Its
statement remains literally true after this change. What changes is the boundary
D218 was protecting by implication: "no plugin content in the host renderer" is
no longer the host's rule, only "no *untrusted* plugin content in the host
renderer". That shift is the reason the defended-and-abandoned lines below are
recorded here rather than left implicit.

Two documents elsewhere in the tree do carry clauses that this decision
relaxes for the trusted UI tier, and the same change updates them:
[04-plugin-security](../spec/07-plugins/04-plugin-security.md) §3 "Must" item 1
("Plugin UI is isolated from the host UI DOM") no longer holds for component
slots, and [ADR 0008](0008-plugin-runtime-isolation-target.md)'s separate-process
target now has one documented exception, the trusted UI tier.

## Differences from the issue text

The plan moved after the issues were written. Each difference and the reason:

1. **Authorization.** #528 §3 item 0.2 and §8.1 item 2 say the `renderer` entry
   is trusted by declaration and "needs no separate authorization". This ADR
   adds the `renderer.extension` permission instead (the later user decision),
   so the grant flows through the existing install-review surface the user
   already sees for `agent.extension`, `fs.write`, and the rest.
2. **Load timing.** #528 §3 item 0.6 says the renderer entry loads at application
   startup. This ADR mandates lazy load on first real slot use (the later user
   decision), which also removes startup cost for plugins whose slots the
   current surface does not render.
3. **Permission granularity.** #561 D1 worded permission granularity as one
   permission per slot. For component slots this ADR follows #545 D1 instead:
   one permission per tier, not per slot. #561's per-slot wording remains the
   model for the RUNTIME slots, which are out of scope here.

## Consequences

### Defence lines deliberately abandoned

These are given up on purpose. They are listed here so that no later reading of
the code, the spec, or this ADR can mistake their absence for an oversight.

- **No publishing review gate.** Any plugin can be installed and the marketplace
  sets no trust limit, so nothing upstream of the user inspects what a
  `renderer` entry does.
- **The preload IPC surface is reachable from plugin code.** Same realm means
  `window.piDesktop` is an ordinary own property of the window — measured as
  `typeof window.piDesktop === "object"` and `"piDesktop" in window === true` —
  and `contextBridge` defines it non-configurable, so the app cannot delete it.
  A plugin module can call all 243 whitelisted channels (220 invoke + 23 event)
  with no per-caller check. Plugins are trusted and broadly permissioned on
  purpose: the boundary is marketplace review plus install-time consent, not
  isolation, and nothing here should be read as a sandbox.
- **Plugin code sits in the app's own window.** Declaring `renderer` puts plugin
  code in the host renderer: same realm, no process isolation, no second
  sandbox. A misbehaving module is in the same process as the UI it renders
  into.
- **Plugins can read and rewrite the user's draft (UI slot 8).** The host
  provides no diff view, no undo entry point, and no global kill switch for it.
  The user's only recourse is per-plugin disable or uninstall after the fact.
- **The copy in a blocking confirmation dialog is no longer host-controlled (UI
  slot 10).** It is a contract requirement on the plugin, and the host does not
  verify it. A plugin can present a host-styled confirmation whose text does not
  describe what the plugin actually does.
- **A code-block renderer slot receives model-produced, untrusted content (UI
  slot 3).** The content is untrusted input crossing into trusted plugin code;
  the host does not mediate it.
- **Crash radius.** For the `renderer` host, an infinite loop, a memory leak, or
  global pollution is not contained. Per-slot error boundaries catch React
  render errors only; unloading is not guaranteed to roll back global mutations
  a plugin performed.
- **Style pollution can only be discouraged.** The namespace container, the
  `pi.ui.injectStyle` path, and the top-level-selector check are convention plus
  mechanical checks. A hostile plugin can defeat them.

### Defence still standing

Sandboxed plugins remain fully restricted: `ui.panel` / `ui.view` plus headless
capabilities, no realm access, no slots. A user who never installs a plugin that
declares `renderer` is not exposed to any of the above, and a user who installs
one has seen `renderer.extension` at `high` risk on the install review.

### Not logged as a risk

UI slot 5 (the Composer control slot) renders whatever the plugin wants with no
host-imposed limit. That is an explicit product decision, not a risk: the slot
exists to let a trusted plugin place a control in the composer, and constraining
it would make it useless. It is recorded here so it is not re-litigated as a
defect.

## Alternatives considered

- **An `iframe`, a worker, or a second sandbox for `renderer`.** Rejected in
  Decision 6: component slots must render React inside the host tree and host
  context, which is only possible in the same realm. The cost is recorded above.
- **Shadow DOM for style isolation.** Rejected in Decision 9: the renderer's 41
  `createPortal` call sites (18 files) would escape the shadow root, and the
  repo's only shadow roots isolate the host from a plugin page, not a plugin
  from the host.
- **One permission per slot.** Rejected in Decision 3 and Difference 3: it turns
  the tier decision into an install-review list the user cannot evaluate, and
  #545 D1 already settled the component-slot tier.
- **Widening `plugin-asset` to serve scripts.** Rejected in Decision 7: its MIME
  allowlist is images and fonts on purpose, and widening it would also widen
  every existing consumer of that scheme.
- **Gating distribution of `renderer` plugins.** Rejected in Decision 4: an
  entry-level distribution gate would create a second, undocumented trust
  boundary the marketplace does not enforce, and #528 establishes that a
  `renderer` plugin is a normal plugin.

## Out of scope

Runtime slots governed by #561 D1 (including their per-slot permission wording),
per-slot authorization of component slots, and any migration of `views` /
`ui.panel` / `settingsDestinations` content into the renderer host.
