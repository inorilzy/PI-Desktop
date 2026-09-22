# 13. Plugin Permissions Matrix

## 1. Goals

Provide a permission–capability–risk–default-policy reference table for reuse by UI copy and validation.

## 2. Matrix

| Permission | Risk | Allowed API / capability | Default policy | Notes |
|---|---|---|---|---|
| `ui.panel` | low | Open the plugin panel | Granted at install | Needed by almost all UI plugins |
| `ui.view` | low | `contributes.views` are listed in the work panel and may be opened | Granted at install | Same isolation as a panel window: sandboxed page, per-plugin partition, `net.domains` egress. Filtered by activation scope |
| `ui.theme` | low | `contributes.themes` CSS is loaded and offered in Settings; runtime `pi.themes.upsert` / `remove` / `list` and `pi.app.setTheme` (ADR 0260) | Granted at install | CSS is sanitized by the host; it cannot script. Declared `assets` are served over the host's read-only `plugin-asset:` scheme. `setTheme` may only select a built-in preference or a currently registered plugin theme. There is no per-plugin theme count cap |
| `ui.window.appearance` | low | `contributes.windowAppearance` sets the native window background while one of the plugin's themes is selected | Granted at install | `#rrggbb` / `#rrggbbaa` only; applied per resolved palette and back to the host default once the theme is gone. macOS keeps vibrancy |
| `clipboard.read` | medium | `clipboard.readText`, `clipboard.getHistory` | Confirm on first use | May read sensitive information and retained clipboard history |
| `clipboard.write` | medium | `clipboard.writeText` | Confirm on first use | Prevents clipboard pollution |
| `notify` | low | `ui.notify`, `ui.getNotificationPermission`, `ui.requestNotificationPermission`, `ui.showNativeNotification` | Can be granted by default | Native delivery is OS-controlled; avoid notification-spam abuse |
| `fs.read` | medium | `fs.readText` / `fs.stat` / `fs.readRange` / `fs.readPreview` / `fs.openDefault` / `fs.reveal` / `fs.glob` / `fs.list` / `fs.requestDirectory` / dropped-file grant | Granted at install, bounded by `manifest.fs.read` | `fs.stat` and `fs.readRange` share the read gate; a dropped-file grant is one-file, read-only, memory-only, and gesture-bound; all file calls remain root- and deny-list-checked |
| `fs.write` | high | `fs.writeText` | Granted at install, bounded by `manifest.fs.write` | Scope is required; a whole-tree pattern fails validation. Out of scope asks the user |
| `fs.delete` | high | `fs.remove` | Granted at install, bounded by `manifest.fs.delete` | Two tiers (`own` / `scope`), always via the OS trash, non-recursive, rate-braked (§2B) |
| `fs.read.workspace` | medium | — | Downgraded on load to `fs.read` with a whole-tree scope | Legacy name; predates scopes |
| `fs.write.workspace` | high | — | Downgraded on load to `fs.write` with **no** scope | Legacy name; every write asks the user until the manifest declares scope |
| `fs.delete.workspace` | high | — | Downgraded on load to `fs.delete` with `own: true` | Legacy name; only the plugin's own output goes without asking |
| `agent.tool.register` | high | Register an agent tool | Confirm at install | Tool execution is audited separately |
| `agent.prompt.inject` | high | Inject a system prompt; activates `contributes.skills` | Deny by default / strong confirmation | Easily leads to behavior hijacking |
| `agent.extension` | high | Run `contributes.agentExtensions` modules inside the agent process | Explicit confirmation; local imports and development plugins only in v1.1 | Same access as the agent's own tools; the plugin sandbox does not apply (spec 16) |
| `provider.register` | high | `contributes.providers` become rows in the native provider list, owned by the plugin and refreshed from the manifest on load | Explicit confirmation; local imports and development plugins only in v1.1, matching `agent.extension` | The user path refuses the row (`PROVIDER_OWNED_BY_PLUGIN`); credentials stay in the Host secret store under the usual provider refs; `oauth` declarations are not enabled yet |
| `net.fetch` | high | `net.fetch` | Deny by default | Confined to `manifest.net.domains`; an empty or malformed list means no egress (§2A) |
| `net.websocket` | high | `pi.net.websocket.connect` / `send` / `close` (host-owned sockets; at most 4 per plugin, 1 MiB frames) | Deny by default | Confined to `manifest.net.domains` like `net.fetch`; a refused host never reaches the transport, and every socket is closed when the plugin unloads, is disabled, or crashes |
| `shell.openExternal` | medium | Open external link | Confirm on first use | Prevents phishing links |
| `mcp.server.local` | high | Spawn a `transport: "stdio"` MCP server declared in the manifest | Deny by default | Runs a local executable; its tools reach the agent |
| `mcp.server.remote` | high | Connect a `transport: "http"` MCP server | Deny by default | Sends tool arguments to a third-party endpoint; non-loopback HTTP is unencrypted |
| `background.service` | medium | Start `contributes.services` and keep the plugin process resident | Confirm at install | Supervised with backoff; visible on the Plugins page |
| `bus.publish` | medium | `bus.publish` to declared topics | Confirm at install | Other plugins can act on the message |
| `bus.subscribe` | medium | `bus.subscribe` to declared patterns | Confirm at install | Can observe another plugin's messages |
| `browser.cdp` | high | `pi.browser.*` against the host work-panel guest | Confirm at install | Guest bounds are clamped to the calling plugin view; CDP is allowlisted |
| `desktop.control` | high | `pi.desktop.listOperations`, `pi.desktop.invoke`, including the reviewed `session/collaboration/*` operations | Confirm at install | Shared with the local MCP control plane's reviewed operation catalog, except for operations marked plugin-only: the six `session/collaboration/*` operations reach the plugin gateway but are deliberately absent from the MCP-visible catalog and have no renderer mutation channel; collaboration `spawn`/`send` additionally require an active plugin Agent tool invocation, whose source Session/turn/invocation identity is injected by the host; panel cancellation is limited to that plugin's own deliveries; a `dangerous` operation needs `confirm: true` from the plugin **and** the user's answer to a host-owned native dialog that names the catalog operation; the MCP bearer token and Electron channel names are never exposed |
| `ui.microphone` | medium | `navigator.mediaDevices.getUserMedia({ audio: true })` inside the plugin's isolated panel | Confirm at install | Audio only; camera and every other device permission stay denied; no native handle or host secret reaches the plugin |
| `audio.capture.background` | high | `pi.audio.getInputDevices`, `openInput`, `closeInput`, `getCaptureState`, `onInputFrame` / `offInputFrame` (registered in the plugin API and gated by this permission; the two synchronous registration helpers throw the coded refusal) | Deny by default | Host owns the device; PCM16 frames only, no device handle or `MediaStream`. The host has no device backend yet, so an authorized call is refused with a coded `UNSUPPORTED` (audited); no device is opened |
| `audio.playback.background` | medium | `pi.audio.openOutput`, `writeOutput`, `stopOutput`, `closeOutput` (registered in the plugin API and gated by this permission) | Confirm at install | Host-owned playback queue, PCM16 only. The host has no device backend yet, so an authorized call is refused with a coded `UNSUPPORTED` (audited); no device is opened |
| `keyboard.globalShortcut` | medium | `pi.keyboard.registerGlobalShortcut`, `unregisterGlobalShortcut`, `listGlobalShortcuts`; `contributes.globalShortcuts` | Confirm at install | Host owns Electron `globalShortcut`; a shortcut only runs the plugin's own command; conflicts are refused (`SHORTCUT_CONFLICT` / `SHORTCUT_UNAVAILABLE` / `INVALID_ACCELERATOR` / `LIMIT_EXCEEDED`, max 8 per plugin); released on unload/disable/crash |
| `models.list` | medium | `pi.models.list` | Confirm at install | Ready provider/model rows only; no secrets |
| `project.create` | high | `pi.project.create` and explicit `projectId` on session import | Confirm at install | Creates or reuses a durable project row without activating the workspace; imported sessions remain unbound unless the id is supplied |
| `session.read` | high | `pi.session.getLlmContext` | Confirm at install | In-flight tool session only; compaction-aware projection (D019 / D336) |
| `session.import` | high | `pi.session.import`, `pi.session.importBatch` | Confirm at install | Imports only into the calling plugin's declared session sources; bounded and rate-limited |
| `session.read.own` | medium | `pi.session.list`, `pi.session.get`, `pi.session.listMessages` | Confirm at install | Reads only sessions imported by the calling plugin; no cross-plugin access |
| `session.update.own` | medium | `pi.session.rename` | Confirm at install | Renames only the calling plugin's active imported sessions |
| `session.delete.own` | high | `pi.session.delete` | Confirm at install | Trash/purge only the calling plugin's imported sessions; rate-limited |
| `usage.read` | medium | `pi.usage.listTurns` | Confirm at install | Read-only listing of completed-turn facts (per-turn token counters and identifiers, keyset-paginated); no message body and no write path |
| `agent.complete` | high | `pi.agent.complete` | Confirm at install | Host-owned one-shot; spends user quota; `includeSessionContext` also needs `session.read` |
| `speech.adapter.register` | high | `pi.speech.registerAdapter` / `unregisterAdapter` | Confirm at install | Registers a speech protocol. Handles stay in the guest; HTTP plans are executed by the host with the bound provider key and must stay on that origin. Built-in protocol ids are reserved |
| `renderer.extension` | high | Run `manifest.renderer` as an ES module inside the host renderer and register components into host-owned slots | Explicit confirmation; by tier, never per slot | The module runs inside the app window, in the host's own realm, with no process isolation. One permission covers every component slot (spec 16 §2A, ADR 0291) |
| `agent.model.complete` | high | Plugin AI on user-configured models | Confirm at install | One-shot plugin completion (`pi.ai.complete`); optional `model` limited to the user provider catalog; `system` is not auto-merged with the session prompt. Existing `agent.complete` remains accepted. |
| `runtime.request.before` | — | withdrawn | — | Slot 6 is not offered; silent request rewrites are not a plugin surface. |
| `runtime.send.before` | high | Runtime slot consult: Before Send | Confirm at install | Consulted after the user presses send and before the message is queued: read it (attachments included), block it, or rewrite what the model receives; a rewrite is marked on the message row. The slot rides the `input` event |
| `runtime.session.lifecycle` | high | Runtime slot consult: Session Lifecycle | Confirm at install | Told about create / switch / delete / fork and compaction. Informed-only on destructive actions; it may cancel a compaction and receives the segment about to be compacted, while a session switch or delete never waits on a plugin (ADR 0295 rule 11) |
| `runtime.session.read` | high | Runtime slot consult: Session Read | Confirm at install | Reading a session's content. Reads are not logged one by one; the install review and the plugin row are the consent surface (ADR 0295 rule 7) |
| `runtime.tool.extend` | high | Runtime slot consult: Tool Extend | Confirm at install | A plugin tool may introduce a tool at runtime, report its own spend, and request early termination of the batch; a runtime-introduced tool is labelled as such in the UI. Gated per tool result through `TRUSTED_EXTENSION_API_PERMISSIONS.toolResult` |
| `runtime.tool.gate` | high | Runtime slot consult: Tool Gate | Confirm at install | A `tool_call` handler may block a call with a reason; a `tool_result` handler may replace a tool's result. Changing the call's arguments is permanently excluded (ADR 0295 rule 4), and asking the user is the plugin's job (rule 6) |
| `runtime.turn.abort` | high | Runtime slot consult: Abort Turn | Confirm at install | Asks the host to stop the current turn; the plugin's own long-running work receives the same cancellation signal. Both halves ship together (ADR 0295 slot 3) |
| `runtime.turn.closing` | high | Runtime slot consult: Turn Closing | Confirm at install | Consulted while a turn is still running and may ask the agent to keep going, which spends more tokens with no new message from the user. The continuation is persisted as a visible row with plugin provenance (ADR 0293) |
| `runtime.turn.continue` | high | Runtime slot consult: Turn Continue | Confirm at install | Starts another continuation after a turn ends. No numeric quota: the host's own loops have none, so visibility and the audit trail are the control (ADR 0295 rule 9) |
| `runtime.turn.facts` | low | Runtime slot consult: Turn Facts | Confirm at install | Structured facts about a turn — tool calls and outcomes, tokens, spend, duration, files touched — with no conversation text. The per-turn query surface behind it is shipped: host-core answers `turn.facts` from its own tables on schema v21 (`artifacts` with `turn_id`; 04-data-storage §4.16). No plugin-facing reader exists yet, so a plugin that holds this grant has nothing to call |
| `runtime.turn.recap` | high | Runtime slot consult: Turn Recap | Confirm at install | Reads what a turn contained, including conversation text. A whole-session read also needs `runtime.session.read` (ADR 0295 rule 7) |
| `runtime.turn.watch` | medium | Runtime slot consult: Turn Watch | Confirm at install | Live observation of the running turn — the kernel's message, tool-execution, turn and agent events — delivered best-effort with no receipt and no redelivery. It can watch and nothing else (ADR 0295 slot 2) |

## 2A. A permission is the switch; the manifest carries the range

Two capabilities are too coarse to be answered by a name alone, so the name says
whether the plugin may act and a manifest field says how far. Both fields are
enforced by the host, shown to the user next to the permissions, and validated at
install time.

| Field | Bounds | Absent or empty means |
|---|---|---|
| `net.domains` | Every host-owned egress path: the panel session, `pi.net.fetch`, remote HTTP MCP endpoints | No egress at all, whatever `net.fetch` says |
| `fs.read` / `fs.write` / `fs.delete` | Which paths that file mode may touch | No standing reach; every access falls to a confirmation |

Failing closed on an absent field is what makes the two safe to omit: a
manifest that says nothing grants nothing. See
[04-plugin-security.md](04-plugin-security.md) §6 and §8.1, and ADR 0088.

The two are also linked. `fs.read` may declare the whole tree because a read
only becomes a leak when the bytes can leave, and `net.domains` closes that
half. `fs.write` and `fs.delete` are dangerous on their own, so a whole-tree
pattern (`**`, `**/*`, `*/**`, `./*`) fails manifest validation for those modes.

## 2B. Deletion

`fs.delete` is the one file mode whose damage is not undoable by re-running the
plugin, so it carries three bounds the other modes do not:

1. **Two tiers.** `own: true` lets a plugin remove files it wrote itself — the
   host keeps a write ledger in the plugin's data directory — with no scope and
   no prompt; a file the user has modified since drops out of the ledger.
   Deleting anything else needs a declared `scope`, and out-of-scope paths ask
   the user.
2. **The OS trash.** Removal goes through `shell.trashItem`, never `rm`, and
   never recursively: a non-empty directory is refused rather than emptied. The
   host keeps no copy of the user's data to provide this.
3. **A rate brake.** 50 deletes per rolling 60s per plugin. Past it the user is
   asked once with the reason given as rate rather than path, because
   `recursive: false` bounds one call and not a `glob` plus a loop.

## 2C. Trust tiers

Trust tier comes before slot here: this section maps entries to tiers, and the
rows in §2 are the permissions those entries may draw on. Trust is per entry,
and the tiers are orthogonal, not a ladder: declaring one tier grants nothing in
another, and a plugin may declare any combination.

| Entry | Where the code runs | Permission | Component slots |
|---|---|---|---|
| `main` / `ui.panel` / `views[].entry` / `settingsDestinations[].entry` | plugin `utilityProcess` / plugin `webContents` | the manifest's own permissions | none |
| `renderer` | the host renderer, same realm as the host UI | `renderer.extension` (high) | allowed, by tier |
| `contributes.agentExtensions` | the agent sidecar | `agent.extension` (high) | none |

Component slots are never authorized individually. `renderer.extension` is the
single grant for all of them (spec 16 §2A, ADR 0291); a plugin that does not
declare `renderer` cannot register one, and a registration attempt is skipped
and reported as a diagnostic rather than dropped silently. The runtime
permissions in §2 differ in shape — one name per slot, because each one changes
a different point of a running turn.

Every runtime slot ADR 0295 builds is registered and enforced. The agent sidecar
resolves a wired event's slot permission before a handler runs, skips the
handler when the plugin does not hold it, and reports the skip as a
`permission_denied` diagnostic on the plugin row. A tier permission says where
the code runs and never implies a slot grant (ADR 0295 rule 2), so a plugin that
holds only `agent.extension` has every slot-gated handler skipped — loudly, with
the permission named. The same holds for the non-event calls named in
`TRUSTED_EXTENSION_API_PERMISSIONS`: `requestTurnAbort` needs
`runtime.turn.abort`, and a plugin tool's extended result needs
`runtime.tool.extend`.

The gate's input is the registry, not a filter: the eleven `runtime.*` names
that ship are in `PLUGIN_PERMISSIONS` (ten slots plus `runtime.session.read`),
and `REGISTERED_SLOT_PERMISSIONS` in `@pi-desktop/shared` mirrors them, with the
desktop guard test failing when the two lists drift. Slot 6
(`runtime.request.before`) was withdrawn and is deliberately absent from both
lists; `runtime.approval.before` is the one slot the record leaves unbuilt, so
no event maps to it and no registry holds it either.
Modifying a tool call's arguments is not a slot and is
permanently excluded (ADR 0295 rule 4): a `tool_call` handler can block with a
reason, and nothing else.

Some mapped events ride hook points the desktop does not emit yet
(`project_trust`, `resources_discover`). Their permission is enforced on the
mapping, so the gate is already in place the moment the hook point is wired;
until then no handler runs, because no event fires. The six withdrawn slot-6
events (`before_agent_start`, `context`, `before_provider_request`,
`before_provider_headers`, `model_select`, `thinking_level_select`) are mapped
nowhere: a registered handler is accepted silently and never consulted.
The session lifecycle notices are the
opposite case: `session_before_switch`, `session_before_fork` and
`session_lifecycle` are emitted, and they are informed-only, so the result the
gate would allow is ignored by the caller (ADR 0295 rule 11).

Separate from the permission question, the trusted-extension sidecar's
result-bearing event set
(`packages/agent-runtime/src/extensions/runner.ts:116-130`) gives the 30 s
handler budget to events whose result is ignored: the informed-only lifecycle
notices by design (ADR 0295 rule 11), and `message_end`, which the desktop's
forwarding path discards. The budget is what keeps a stalled handler from
holding the notification loop; no permission or trust decision is involved.

## 3. Permission dependencies

- `ui.panel` is required to load a panel entry
- `ui.view` is required to contribute work panel views; it is independent of
  `ui.panel`, so a plugin may ship docked views without a detached window
- `agent.tool.register` is required to contribute agentTools
- When `fs.write` is present, it is recommended to also declare `fs.read`
- `manifest.fs.<mode>` requires the matching `fs.<mode>` permission; a scope
  nobody can use fails validation rather than being silently ignored
- `fs.requestDirectory` (the `userSelected` root) is gated on `fs.read`; writing
  or deleting inside the chosen directory still needs `fs.write` / `fs.delete`
- A contribution whose permission is missing fails manifest validation
  (`themes`, `mcpServers`, `services`, `bus`); `skills` is the exception and is
  skipped at load time instead (see
  [02-plugin-manifest-schema.md](02-plugin-manifest-schema.md) §7)
- Lifecycle and state events need no permission: `workspace:changed`,
  `session:modelChanged`, `session:turnEnded`, and `plugin:settingsChanged`
  arrive on the existing plugin event channel, and subscribing to an unknown
  event name does not error

## 3A. Plan operating-state rule

Every `agentTools` contribution is denied in Plan, regardless of this matrix's
risk or default policy. `agent.tool.register` authorizes registration for
Agent, not visibility in Plan. The host returns `PLUGIN_DISABLED_IN_PLAN` for a
direct Plan call and records the denial. Plugin tools become eligible only
after the same Agent is approved into Agent mode.

## 4. Permission display copy

English is the primary copy. The zh-CN column holds the localized example strings.
A file permission is never shown alone: the declared scope is rendered beside it,
so "Modify the files it lists" is followed by the list.

| Permission | English copy | zh-CN example |
|---|---|---|
| `fs.read` | Read the files it lists | 读取它列出的文件 |
| `clipboard.read` | Read the current clipboard and retained history | 读取当前剪贴板和保留的历史 |
| `fs.write` | Modify the files it lists | 修改它列出的文件 |
| `fs.delete` | Delete the files it lists, to the trash | 删除它列出的文件（进回收站） |
| `notify` | Show in-app and native notifications | 显示应用内和系统通知 |
| `agent.tool.register` | Provide executable tools to the AI Agent | 向 AI Agent 提供可执行工具 |
| `agent.prompt.inject` | Adjust agent instructions | 调整智能体指令 |
| `agent.extension` | Run code inside the agent | 在 agent 内运行代码 |
| `net.fetch` | Access the network | 访问网络 |
| `shell.openExternal` | Open external links | 打开外部链接 |
| `ui.theme` | Provide a theme | 提供主题 |
| `ui.settings` | Add a sandboxed Settings entry in Extensions | 在“扩展”中添加沙盒设置项 |
| `ui.window.appearance` | Set the window background | 设置窗口背景 |
| `mcp.server.local` | Run a local MCP server | 运行本地 MCP 服务 |
| `mcp.server.remote` | Reach a remote MCP server | 连接远端 MCP 服务 |
| `background.service` | Keep a background service running | 保持后台服务运行 |
| `bus.publish` | Send messages to other plugins | 向其他插件发送消息 |
| `bus.subscribe` | Receive messages from other plugins | 接收其他插件的消息 |
| `browser.cdp` | Control the work-panel browser | 控制工作面板浏览器 |
| `models.list` | List authenticated models | 列出已登录的模型 |
| `session.read` | Read the current conversation sent to the model | 读取当前发给模型的对话 |
| `session.import` | Import bounded session history into your declared sources | 导入受限的会话历史到已声明的数据源 |
| `session.read.own` | Read sessions imported by this plugin | 读取此插件导入的会话 |
| `session.update.own` | Rename sessions imported by this plugin | 重命名此插件导入的会话 |
| `session.delete.own` | Trash or purge sessions imported by this plugin | 将此插件导入的会话移入回收站或清除 |
| `usage.read` | Read usage statistics | 读取用量统计 |
| `agent.complete` | Run a one-shot completion with your models | 用你的模型发起一次补全 |
| `agent.model.complete` | Use your configured models for one-shot plugin AI | 使用你已配置的模型发起一次性插件 AI |
| `speech.adapter.register` | Register a speech adapter | 注册语音适配器 |
| `audio.capture.background` | Use the microphone in the background | 后台使用麦克风 |
| `audio.playback.background` | Play audio in the background | 后台播放声音 |
| `keyboard.globalShortcut` | Register system-wide shortcuts | 注册系统级快捷键 |
| `net.websocket` | Open real-time connections | 建立实时双向连接 |
| `renderer.extension` | Run plugin UI inside the app window | 在应用窗口内运行插件界面 |
| `runtime.send.before` | Inspect a message before it is sent | 在消息发送前检查 |
| `runtime.tool.extend` | Add tools while the agent runs | 在 agent 运行时添加工具 |
| `runtime.turn.abort` | Stop the running turn | 停止正在运行的轮次 |
| `runtime.turn.closing` | Act just before a turn ends | 在轮次结束前介入 |
| `runtime.turn.facts` | Read structured facts about a turn | 读取本轮的结构化事实 |
| `runtime.session.lifecycle` | Follow session and compaction events | 跟踪会话与压缩事件 |
| `runtime.session.read` | Read a session's content | 读取会话内容 |
| `runtime.tool.gate` | Block tool calls and replace tool results | 拦截工具调用并替换工具结果 |
| `runtime.turn.continue` | Start another turn after one ends | 在轮次结束后再发起一轮 |
| `runtime.turn.recap` | Read what a turn contained | 读取某一轮的内容 |
| `runtime.turn.watch` | Watch the running turn | 观察运行中的轮次 |

## 5. Adding permissions on upgrade

If new permissions appear on upgrade:

1. Compute the diff
2. Force user confirmation
3. If not confirmed, cancel the upgrade or disable the new capabilities (canceling the upgrade is recommended)

## 6. Runtime check pseudocode

```ts
assertPermission(pluginId, perm) {
 if (!granted(pluginId, perm)) throw ERROR_PERMISSION_DENIED
}
```

Every Host API entry point must assert first. A file entry point then passes
three more gates, in this order — a later gate can only refuse, never widen:

```ts
assertFsAccess(pluginId, mode, requestedPath, sessionId) {
 assertPermission(pluginId, `fs.${mode}`)              // declared AND granted
 full = realpathWithinRoot(root(pluginId, mode, sessionId), requestedPath)
 if (!full) throw NOT_FOUND | INVALID_ARGUMENT         // symlinks resolved first
 if (isDenied(full) || isHostReserved(full)) throw ERROR_PERMISSION_DENIED
 if (!inScope(full, declaredScope(pluginId, mode))) await confirmWithUser(...)
}
```
The `workspace` root is the invoking tool session's project, falling back to the
visible workspace for a panel call (ADR 0266).

## 7. Acceptance

1. Unauthorized API calls fail
2. Permission copy is visible in the install UI, and a file permission shows its
   declared scope alongside
3. Upgrades that add permissions prompt the user
4. A write or delete outside the declared scope prompts, and a denial is audited
   as `PERMISSION_DENIED`
5. `.env` and `.git/**` stay unreadable under a whole-tree read scope, and do not
   appear in `fs.glob` results either
6. A symlink inside the root pointing outside it does not carry an access out
7. A delete lands in the OS trash, refuses a non-empty directory, and is
   interrupted past 50 removals in a rolling minute
8. A plugin declaring only the legacy `fs.*.workspace` names loses write and
   delete reach, and the Plugins page says so
