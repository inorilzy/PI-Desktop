# 14. Plugin Roadmap

## 1. Guiding principle

```text
Local plugins usable → developer-friendly → marketplace distribution → signing and auto-update
```

## 2. Roadmap

### R1 — Foundation (with M4) ✅
- manifest v1
- Local directory loading
- enable/disable/uninstall
- command palette integration
- hello example plugin
- permission declaration display

### R2 — Agent Extension (partial ✅)
- Full agentTools pipeline ✅
- Official `pi.session-orchestrator` worker-session plugin ✅ — real durable
  sessions, host-owned bidirectional delivery, turn-bound results,
  at-most-once completion callbacks, bounded status projections, and
  parent-scoped persistence; it composes the reviewed `desktop.control`
  operations while the durable ledger remains in host-core (ADR 0237 / ADR
  0239)
- Skills contribution is activated: declared skills reach the model as a `# Skills`
  catalog in the system prompt when `agent.prompt.inject` is granted, and the model
  loads a body on demand through the `Skill` tool ✅ (ADR 0039, D174)
- Unified namespace and audit ✅
- Per-plugin settings API and generated settings UI are implemented. The UI
  supports string/number/boolean/select/json fields and plugin-local command
  shortcuts; OS-global plugin shortcuts remain out of scope.
- Plugin log panel remains planned; runtime audit logs exist without a dedicated
  plugin-log surface

### R3 — DX & Packaging ✅
- plugin-sdk ✅
- Template generation ✅ (`panel-basic`, `agent-tool-basic`, `skill-pack`,
  `full-demo`, from the plugins page, the agent, or `pi-plugin init`)
- `pi-plugin check/pack` ✅ (`@pi-desktop/plugin-devkit`, also exposed as the
  `PluginCheck` / `PluginScaffold` / `PluginPack` agent tools)
- `.piplug` install ✅
- dev hot reload ✅ (watch + debounce, and a reload can never widen permissions)

### R4 — Marketplace Read-only ✅
- market provider abstraction (official remote GitHub catalog provider)
- Official-source browse/search from `vastsa/pi-desktop-plugins`
- Download + checksum install
- updates list (manual update)

### R5 — Trust & Auto Update (partial ✅)
- Publisher verification (verified flag in catalog)
- Signature verification (still planned; checksum enforced now)
- Permission-diff upgrade ✅
- Auto-update policy ✅
- Malicious-version yank response (still planned)

### R6 — Advanced Ecosystem (partial ✅)
- MCP plugin type ✅ — `contributes.mcpServers` over stdio and remote HTTP (D176)
- Background service plugins ✅ — `contributes.services` with supervised
  restarts (D177)
- Inter-plugin message bus ✅ — declared topics, `pi.bus.*` (D178)
- Theme plugins ✅ — plugins ship CSS files (D175)
- Enterprise private sources (still planned)
- Marketplace reviews / quality score (optional, still planned)

### R7 — Agent extensions (v1.1 ✅, D387 / D388)
- v1: ExtensionAPI adapter in the Agent sidecar; tools, commands, lifecycle and
  provider hooks, basic UI prompts
- v1.1: modules are a plugin contribution (`contributes.agentExtensions`, permission
  `agent.extension`); "Import pi extension" turns a pi CLI extension into a
  development plugin; no separate registry or settings tab
- v2: custom session entries, `sessionManager` read shim, editor read/write,
  shortcuts, markdown transformers; marketplace distribution once signing lands
- v3: pi CLI `settings.json` hints, unified skill/prompt discovery, remote-control
  prompt routing
- Spec: [16-trusted-extensions.md](16-trusted-extensions.md); ADR 0214, ADR 0215

### R8 — Trusted renderer host (issue #528, batch 0 ✅)
- `manifest.renderer`: a plugin-relative ES module that runs inside the host
  renderer and registers React components into host-owned slots ✅
- `manifest.main` became optional, with one new rule: at least one entry across
  `main`, `renderer`, `ui.panel`, `views[].entry`, and
  `settingsDestinations[].entry` ✅
- `renderer.extension` (high) is the single permission for the trusted UI tier;
  component slots are authorized by tier, never one by one ✅
- Component-slot ids: `entry`, `toolCard`, `codeBlock`, `entryExtra`,
  `composerControl`, `completionSource`, `inlineConfirm`, `modal`, `overlay`,
  `composerReference` ✅
- Lazy fetch and evaluation over the `plugin-renderer` scheme, namespace style
  isolation, the React singleton rule, per-slot error boundaries, and a
  `renderer` capability chip on the plugin row ✅
- Spec: [16-trusted-extensions.md](16-trusted-extensions.md) §2A; ADR 0291

### R9 — Runtime slots (issue #561)
- The slot-permission model is shipped: every `runtime.*` name ADR 0295 builds is
  registered, and the sidecar resolves a wired event's slot permission before a
  handler runs, so a plugin that holds only `agent.extension` is refused with a
  `permission_denied` diagnostic (spec 13 §2C, ADR 0295 rule 2). That retires
  the D1 deviation this section used to describe.
- Batch A of ADR 0295's phasing is shipped: Abort Turn (3) has its entry point
  (`requestTurnAbort`) plus the turn's cancellation signal that plugin work
  observes; Tool Extend (5) reaches the tool-result fold; and Turn Facts (9) is
  answered by host-core through the `turn.facts` RPC on schema v21
  (04-data-storage §4.16). A plugin-facing reader for those facts is not built
  yet, so the slot's grant has nothing a plugin can call.
- Turn Closing (7) still reaches the kernel through `shouldStopAfterTurn`, and
  the hooks that were already wired — Turn Watch (2) and Tool Gate (4) — keep
  the behaviour they had; spec 13 §2C states per event which hook points the
  desktop emits today.
- Shipped: Before Send (1) — the runtime's `input` hook fires after Electron main
  persisted the user's message and before it is queued, honours all three kernel
  actions, and every rewrite a plugin performs is stored at diff level through
  the `plugin.rewrites.record` RPC (04-data-storage §4.15) and marked on the
  message row (ADR 0295 rule 5) — and Session Lifecycle (11) — create, switch,
  delete and fork are announced informed-only, with the compaction handover
  keeping its cancel.
- Not shipped: Turn Recap (8) and Turn Continue (10) — a registered name with no
  hook or call behind it; Approval Before (12) — not built.
- Before Request (6) was withdrawn before shipping: its six events are never
  consulted and its permission is registered nowhere; the slot set, the
  per-slot permissions and the order of work are all fixed in
  [ADR 0295](../../adr/0295-runtime-slots-and-their-permissions.md).

## 3. Mapping to product milestones

| Product milestone | Plugin goal |
|---|---|
| M1 Skeleton | Reserve the plugins directory and interface stubs |
| M2 Chat Runtime | Non-blocking; can be designed in parallel |
| M3 Tools | ToolHost reserves contribution hooks |
| M4 Plugin Foundation | R1 complete |
| M5 Hardening | Plugin isolation and stability |
| Post-MVP | Complete R2 and progress R3–R6 in phases |

## 4. Success metrics (ecosystem)

1. Users can extend their workflow via plugins even without a new official release
2. Third parties can independently develop and locally install plugins
3. A plugin failure does not break the main app's availability
4. Permissions are visible and refusable before installing any plugin

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Building the marketplace too early destabilizes the core | Defer the marketplace; R1 does local first |
| Plugin security incident | Deny by default + audit + mandatory signing later |
| Frequent API breakage | apiVersion / schemaVersion |
| High developer barrier | Templates + hello example + SDK |
