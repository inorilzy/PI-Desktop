# Plugin Showcase

A PI-Desktop example plugin that ships **both plugin interfaces in one
package**, so a plugin author can read one directory and see how the pieces fit
together:

- the **renderer UI slots** — React components inside the app window, one for
  every one of the ten declared slots, registered through `manifest.renderer`
  (spec `07-plugins/16-trusted-extensions.md` §2A, ADR 0291, ADR 0294); and
- the **agent runtime slots** — hooks inside the agent sidecar, registered
  through `contributes.agentExtensions` (spec `07-plugins/16` §6, ADR 0295).

Neither half calls the other. They are two different plugin hosts with two
different permission tiers, and they meet in the host: the renderer draws what
the host hands it, the agent half is consulted while a turn runs.

## What this demonstrates

| What | Which permission | What it should show |
|---|---|---|
| A component for each of the ten declared UI slots | `renderer.extension` | the slot tour below: a whole-message card, a tool card, a fenced-block renderer, a badge under every transcript row, the two composer control rows plus the handover region left of the send button, completion rows, a composer chip, and the inline-confirm, modal and overlay layers |
| `pi.functions.register` — pure, synchronous functions the host may call *while it renders* | `renderer.extension` | the badge prints `fn entry-facts() → assistant`, the block prints `fn kv-rows() → N row(s)`: both values come out of the registered functions. No host position calls one yet |
| Buttons that dispatch `ui.toast` | `renderer.extension`, plus `rendererActions: ["ui.toast"]` | the toast names the entry or the tool card it came from, and the button then prints `toast sent` — or the refusal code, never a silent nothing |
| Composer draft round trip from a mounted slot | `renderer.extension`, plus `rendererActions: ["composer.readDraft", "composer.replaceDraft"]` | the left composer row reads the live draft (`{ sessionId, generation, text, fileReferences }`), writes the same text back through `composer.replaceDraft` with the generation it just read, and then drives the documented refusal: the same write with an out-of-date `expectedGeneration` answers `DRAFT_CONFLICT` and changes nothing |
| One declared action the host has no handler for | `renderer.extension`, plus `rendererActions: ["composer.insertText"]` | `composer.insertText` is in the vocabulary and unrouted, so the control's `Showcase: declared but unrouted` button answers `PLUGIN_ACTION_UNROUTED` — the same code the plugin row's Renderer diagnostics records, printed in the window *and* sent to the plugin process as a receipt |
| One agent tool of its own, `showcase_note` | `agent.tool.register` | the model can call `plugin_acme_plugin_showcase_showcase_note`; that row's card body is the `toolCard` component, and the host offers that position only to the tool's owner |
| An agent-side module | `agent.extension` | the module's hooks are consulted inside the agent sidecar; without the grant the manifest is refused at install |
| Tool gate: refuse a dangerous shell command with a readable reason | `runtime.tool.gate` | the `Bash` call is refused before it runs: the transcript carries the reason and the plugin also raises a warning toast |
| Turn watch: observe the running turn | `runtime.turn.watch` | a status chip at the bottom-right of the window counts what the plugin saw: `Plugin Showcase · turn 2 · 3 tool call(s) seen (1 failed)` |
| Turn facts: read the host's own numbers for the turn | `runtime.turn.facts` | one notification when the run ends: status, duration, tokens, tool calls with outcomes, files touched and plugin-tool spend — and the plugin's own count next to the host's |
| Session lifecycle notice | `runtime.session.lifecycle` | a notification when the desktop creates or deletes a session |
| Turn abort: ask the host to stop the turn | `runtime.turn.abort` | the third blocked call in one turn asks the host to stop it, and the block reason ends in `accepted` or `refused` |

`rendererData` and `rendererActions` are **declarations, not permissions** (ADR
0294 decision 3): they grant nothing and are not in the permission enum. The
declaration is what the plugin's own code and the review see. One half of it is
enforced (`dispatch` refuses an action the manifest did not declare, with
`PLUGIN_ACTION_UNDECLARED`) and the other is not (a slot's props arrive whether
or not the plugin declared them), so the honest reading is: declare what you
use, and treat the list as the thing a reviewer compares against the code.

## The ten UI slots, one by one

`renderer/index.mjs` registers a component for every slot the host declares
(`PLUGIN_RENDERER_SLOTS` in `packages/plugin-sdk`). Seven are registered when
the module loads; the three layer positions are registered on demand by the
plugin's own composer controls, because a modal registered at load would block
the window the moment the module was evaluated and an inline-confirm
registration would replace the user's approval UI (registration *is* the layer:
removal, unload, disable and uninstall all take it away — spec §2A.5, D10).
The module itself is evaluated lazily, the first time one of its slots really
renders; the badge under the transcript rows is enough for that.

Each component is handed the slot's host data as props plus
`dispatch(action, payload)` (ADR 0294 decision 1). Those props are the whole
input. Where a position hands over more than this example reads, the extra keys
are named in the row so a reader knows the contract without having to open the
SDK.

| Slot | To see it | What appears | What it needs | Its honest limit |
|---|---|---|---|---|
| `entry` | Open any session with a message: the registration takes every message row the transcript draws itself (a user message, a system notice; an assistant *turn* is drawn by the turn renderer and keeps its own Markdown). | The row's content, re-drawn by the plugin: the role/id/timestamp/session facts, then **the message text itself** (a multi-line text keeps its line breaks), any attachments as chips, the host actions the position stands in for (`copy`, `edit`, `delete`, `revisions` — printed as facts, because a plugin cannot trigger them), and the card's own controls beside that text: **Send a toast from the entry slot** and **Release this claim**. Props read: `entry` (`{ id, role, pluginId? }`), `message` (`{ text, attachments, createdAt?, command?, streaming, actions }`), `sessionId`, `dispatch`. | `renderer.extension`, the module's `rendererData` covers `entry` and `session`, and `rendererActions` declares `ui.toast` for the button and `plugin.call` for the report button. | It replaces the host's own rendering of that row (bubble and actions alike), so it has to re-draw what it was handed — that is the rule below. Pressing **Release this claim** withdraws the registration and the host draws its own row again. The text arrives as text: a plugin that wanted the host's Markdown would have to render it itself, because the position owns the whole row. While a row is being edited the host keeps its own message form and skips this position for that row, plugin or not. |
| `toolCard` | Ask the model to call the plugin's own tool — *"use the showcase_note tool to format the note hello"*. The row opens itself while this plugin's card is drawn. | The tool row's card body, re-drawn by the plugin: the owner line, the tool name with its status and duration, **the call's arguments and its result as JSON**, the session, and the card's own **Send a toast from the tool card** / **Release this claim** controls. Props read: `entry` (`{ id, role, pluginId }`), `tool` (`{ name, args, result?, status?, durationMs? }`), `sessionId`, `dispatch`. | A tool of its own: `contributes.agentTools` + `agent.tool.register`, registered from `main.js`. The forced name `plugin_acme_plugin_showcase_showcase_note` is the attribution — the host offers the position only to the plugin whose own prefix the row starts with, never to a host tool or a neighbour's tool. | Only the plugin's own tool row is offered. The mount sits inside the row's own detail body, so a tool row the host decides has no details has no position at all; the component checks `entry.pluginId` against its own id anyway, because a contract is worth making visible. The arguments and result are printed raw (`JSON.stringify`, capped at 600 characters), not through the host's own detail blocks. |
| `codeBlock` | Ask for (or write) a fenced block in the language this plugin claimed: a fence whose info string is `acme.plugin-showcase:kv`, with a `covered = 42` line and a `disk! = 91% used` line. | Rows instead of source text: `covered = 42`, `disk = 91% used` with the `disk` row underlined, under a head line `acme.plugin-showcase draws fenced acme.plugin-showcase:kv · fn kv-rows() → 2 row(s)`. Props read: `language`, `code` (the host also passes `isIncomplete` and `theme`). | The module's `rendererData` covers `code`, and the registration carries the option `{ language: "acme.plugin-showcase:kv" }`. A language has exactly one renderer and must be namespaced with the registering plugin's own id, so a plugin cannot claim `json`, `ts` or `mermaid`. | A component sees only a closed, in-limit block: an open fence and an oversized block stay the host's own source rendering, and `isIncomplete` is therefore always `false` in a component that runs. It draws what it was given and cannot decorate the host's other blocks. |
| `entryExtra` | Open any session: one badge is appended below every transcript message row. | `acme.plugin-showcase · entryExtra · assistant · <entry id>`, then `fn entry-facts() → assistant`, and the **Notify the host** button. Props read: `entry` (`{ id, role, pluginId? }`), `dispatch`. | `renderer.extension`, the module's `rendererData` covers `entry` and `session`, and `rendererActions` declares `ui.toast` for the button. | An additive position, not a replace one: it is handed the entry's *identity* only — no text, no attachments — because it adds to a row the host still draws. `pluginId` is set only when the host attributes a row to a producer, which the transcript does not report today, which is why the badge prints the role and id alone. |
| `composerControl` | Open a session: the controls are at the end of the composer's own left and right control rows, and in the region immediately left of the send button. | Left row: **Showcase: inline card**, then the draft controls — **Showcase: read the draft**, **Showcase: write it back**, **Showcase: stale write (DRAFT_CONFLICT)** and **Showcase: declared but unrouted**. The last read/write answer is printed on the group (`data-pi-showcase-draft-outcome`, `-generation`, `-text`). Right row: **Showcase: modal** and **Showcase: overlay**. The region left of Send: the host's own model picker, context display and prompt-enhancement control, in this plugin's order (`data-pi-showcase-region-order`, one `data-pi-showcase-region-piece` per piece), with **Showcase: cycle region order** and this plugin's own **Showcase: modal** / **Showcase: overlay** / report controls beside them. Every layer title carries the live draft length and the session, and each label flips to "close …" while the layer is up. Props read: `position`, `draft`, `sessionId`, and at `beforeSend` the handover — `modelControl`, `modelSelection`, `contextControl`, `contextUsage`, `enhanceControl`, `enhancement`. | The module's `rendererData` covers `draft` and `session`, and `rendererActions` declares `composer.readDraft`, `composer.replaceDraft` and the unrouted `composer.insertText`. | One registration declares all three positions (`{ positions: ["left", "right", "beforeSend"] }`) and the component decides what it draws in each (`null` for the others leaves no hole). In the two rows the host's own controls are already in place, so a plugin control can only follow them, and the `draft` prop is read-only: changing the draft goes through `composer.replaceDraft`, which the host applies to the mounted composer and answers with `{ ok, generation, previous }`; a write against a generation that has moved on is refused with `DRAFT_CONFLICT`. At `beforeSend` the host hands the region over whole, so the order is the plugin's and the host draws no second copy of a piece the plugin renders — see the composer-region rule below. |
| `completionSource` | Type `/showcase` in the composer (slash trigger), or `@acme` (file trigger). | Rows inside the completion popover, below the host's own: `/showcase-inline — demo row: it cannot insert a command into the draft yet`, or `@acme — demo row: it cannot add a reference to the draft yet`. Props read: `mode`, `query`. | `renderer.extension` only. | It is a candidate source, not a filter: the host's rows keep their own order, and the keyboard highlight and `Enter`/`Tab` acceptance stay host-owned. Nothing in this release inserts a candidate into the draft, so these rows say so and carry `aria-disabled` rather than pretending to be selectable. |
| `inlineConfirm` | Click **Showcase: inline card** (left composer row), then make the host ask for a permission — for example, ask the model to run a command that needs approval. | The plugin's card where the host's permission card would be drawn, below the transcript, re-drawing **the request the host's card would have shown**: the tool, its argument preview, the risk, the host's own reason and how many requests wait behind it — plus the card's own **Send a toast from the inline card** and **Close this card** controls. Props read: `sessionId`, `confirm` (`{ requestId, toolName, args, risk, reason, queued, agentName? }`), `dispatch`. | `renderer.extension` only. | The position exists only while a permission request is pending, so the registration can be up with nothing on screen — that is why it is opened from a control instead of at load. Approving or denying stays host-owned: the slot has no action for a decision, and closing the card (or unloading the plugin) brings the host's own card back. |
| `modal` | Click **Showcase: modal** (right composer row). | A blocking dialog over the window: `acme.plugin-showcase · modal`, a line naming **the host surface it occupies** (the app-level modal layer, with the host's own scrim, blocking and Escape dismissal), the session id, and a **Close the modal** button. Props read: `sessionId`. | `renderer.extension` only. | Registration is appearance, removal is disappearance: there is no "hide" state, and unloading, disabling or uninstalling the plugin reclaims the layer. A layer is the one replace position with no host content of its own: the plugin's registration *is* the layer, so the card states the surface instead of re-drawing one. Escape is the host's own dismissal — it hides the layer without touching the plugin's own state, while the button withdraws the registration for good. |
| `overlay` | Click **Showcase: overlay** (right composer row). | A non-blocking box in the window: `acme.plugin-showcase · overlay`, and a line saying that only this box takes the pointer. The rest of the window stays usable. Props read: `sessionId`. | `renderer.extension` only. | Same lifecycle as the modal, and the difference is the host's decision, not the plugin's: the host adds no scrim here, and the plugin cannot draw one, reach behind the window, or open an overlay without a registration. Escape dismisses it like the modal. |
| `composerReference` | Attach a file in the composer, or accept an `@` reference: the chip follows the host's own chips, after the editor. | A chip reading `acme.plugin-showcase chip · 2 ref · 9 ch`, plus the first three host chip names. Props read: `references[i].name` and the list length, `draft`, `sessionId` (the host also passes each chip's `path` and `kind`). | The module's `rendererData` covers `draft` and `session`. | The chip is a React element beside the editor, not an atomic editor token: it cannot add a reference to the draft, remove a host chip, or change what the draft sends. The host's reference list is read-only, and a component with nothing to draw for the current draft renders nothing. |

### The replace-slot rule this example follows

`entry`, `toolCard`, `inlineConfirm` and `modal` are **replace positions**: at
most one plugin holds each of them (`PLUGIN_RENDERER_REPLACE_SLOTS`). A
registration takes the place of a host surface, so the host hands the component
**the data that surface was going to display** — a message's text, attachments
and timestamp; a tool row's name, arguments and result; the pending
confirmation's request. The whole point of taking the position over is to
**re-render that same data in the plugin's own form**, with the plugin's own
controls *beside* it:

```text
host surface ──(position + its data)──▶ plugin component ──▶ same content, plugin's presentation
                                                    └──────▶ plugin's own controls, beside it
```

A card that announces "I replaced the host's row" and draws nothing of what the
host handed it is hiding the content it was given, which is the one thing a
replace position must not do. Every replace component in this example re-draws
its data, and each one carries a control that hands the position back
(**Release this claim**, or the layer's own close button) so the host's own
rendering can be seen again.

### The composer-region rule this example follows

The region immediately left of the send button is a **handover** position
(`composerControl` at `beforeSend`). The host hands over what it would draw
there — its own model picker, context display, and prompt-enhancement control —
as **the host's own elements** (`modelControl`, `contextControl`,
`enhanceControl`) together with the data behind them (`modelSelection`,
`contextUsage`, `enhancement`), and the plugin decides what the region looks
like:

```text
host region ──(nodes + data)──▶ plugin component ──▶ the same three pieces, the plugin's order
                                                └──▶ the plugin's own controls, beside them
```

Two rules follow, and this example follows both:

- **Keep every piece you were handed.** `ComposerRegion` renders all three,
  marks a piece the host could not hand over
  (`data-pi-showcase-region-data="none"` — the context display before any turn
  has been measured), and only ever changes their *sequence*: **Showcase: cycle
  region order** rotates it, and `data-pi-showcase-region-order` publishes what
  is on screen.
- **Never draw a piece twice.** The region renders the host's nodes, never
  copies it made itself, so the host's own drawing of the region is gone the
  moment the registration is up — nothing on screen appears twice.

Adding controls is allowed, and that is the point: the cycle button and the
layer toggles are this plugin's own, beside the host's pieces. Omitting a piece
is allowed *by contract* — a component that renders two of the three pieces has
removed the third, and the host will not put it back — which is exactly why this
example reports its order instead of trusting a comment: the window shows which
pieces survived. With nobody holding the position, the host draws its own three
pieces in its own order and no plugin is involved at all.

The two host-callable functions are registered next to these components:
`entry-facts` (used by the badge) and `kv-rows` (used by the block). Both are
pure, synchronous and defensive — a host position may call one on every render
with whatever input it has, and the host discards an answer that takes longer
than one frame (16 ms) and trips a per-function breaker after three failures.

## The self-check console (docked panel and work-panel view)

`views/console.html` is the plugin's own page, and the manifest declares it
twice on purpose:

* as `ui: { panel: "views/console.html" }` — the **docked panel** surface, for a
  plugin that wants a panel window (`ui.panel`);
* as `contributes.views: [{ id: "console", title: { en: "Showcase Console", … },
  entry: … }]` — a **work-panel view** beside the app's own destinations
  (`ui.view`). The host reads views from `contributes.views`, which is where the
  work-panel launcher's own menu comes from: the entry has to sit there, and a
  top-level `views` array is never listed.

Both point at one file, so opening the view and opening the panel show the same
page. It exists to answer the question the rest of this example cannot: *what
does the plugin's own process think is going on?* The renderer half and the
agent half cannot read each other, and the console page cannot read the window
(`showcase.console.status`, `…log`, `…session`, `…ai`, `…models`, `…panel`,
`…runtime`) and the renderer half pushes its live state to the process with
`plugin.call` (`renderer.report` / `renderer.slot`, and `renderer.refusal` for a
coded refusal it caught). The first report is sent when a position really
mounts — `ComposerControl` reports on mount — so the console's "slot-side
reports" tile is non-zero on a window nobody has clicked in; the cards'
**Report to the plugin process** button re-reports on demand and prints the
process's own answer (`ok`, or the code a manifest mistake produced).

The page is deliberately in the plugin's own copy and layout: a plugin page is
the plugin's HTML, and the host's i18n strings are not available inside it. Its
inventory shows the slots the module reported holding (which is how a card's
**Release this claim** becomes visible: the slot leaves the list), the function
call counts the module measured itself, the manifest's permissions, and the log
lines the plugin wrote — including the **runtime receipts** the plugin process
really holds about the agent half (one per host-pushed `session:turnEnded`, one
per execution of this plugin's own agent tool), which its runtime group reads
with `showcase.console.runtime`. The tool gate's own verdict (block or allow) is
written by the agent sidecar into the window (the extension's warning toast and
the modified tool result) and into the plugin row's diagnostics; the sidecar has
no channel to the plugin process or to this page, so the console lists the
receipts it really has and says that instead of inventing a hit count.

Permission-wise the console needs `ui.panel` (the docked panel) and `ui.view`
(the work-panel view); the renderer-reported numbers need `renderer.extension`
and `plugin.call`, which the renderer table above explains.

## Files

| File | Role |
|---|---|
| `manifest.json` | Declares `main`, `renderer`, `rendererData: ["entry", "session", "code", "draft"]`, `rendererActions: ["ui.toast", "plugin.call", "composer.readDraft", "composer.replaceDraft", "composer.insertText"]`, `contributes.agentExtensions`, `ui.panel` + `contributes.views[]` for the console page, one command, one agent tool, and the eleven permissions the four entries actually use |
| `main.js` | Plugin-process entry: registers the declared command and the plugin's own `showcase_note` tool, whose card body the renderer half draws; answers the console's own channels; and keeps the runtime receipts it really holds (host turn pushes, its own tool executions, the renderer's refusal reports). A manifest needs one of `main`, `renderer`, or a plugin page — `contributes.agentExtensions` alone is not an entry |
| `renderer/index.mjs` | Renderer entry: `onLoad(pi)` injects one namespaced stylesheet, registers two host-callable functions and a component for each of the ten slots — the three layer positions on demand. The composer control is one registration declared for all three composer positions: it reports on mount, its draft buttons drive `composer.readDraft` / `composer.replaceDraft` (including the `DRAFT_CONFLICT` and unrouted paths), and its region left of Send reorders the host's own three pieces and adds its own controls |
| `agent/extension.js` | Agent-side entry: the tool gate, the turn watcher, the turn-facts summary, the session lifecycle notice and the abort request |
| `views/console.html` | The plugin's own self-check console, served both as the docked `ui.panel` and as the `views[]` work-panel destination: it reads the plugin process's own state (including the runtime receipts `showcase.console.runtime` answers) and prints what the renderer half reported holding |

## Install (development folder)

There is no CLI install step for a plugin folder — the app loads it:

1. Open PI-Desktop and go to the **Extensions** destination in the sidebar
   (`Plugins` in older docs and in `docs/spec/`).
2. Open the header **⋯ (More actions)** menu and choose **Load local plugin**.
   The same button is offered in the empty state. Older documentation calls this
   action "Load development plugin".
3. Select the `examples/plugins/plugin-showcase` directory.
4. Accept the permission review. The full tour needs all eleven grants:
   `renderer.extension`, `agent.extension`, `agent.tool.register`,
   `agent.model.complete` (the console's own `pi.ai.complete` controls),
   `ui.view`, `ui.panel`, `runtime.tool.gate`, `runtime.turn.watch`,
   `runtime.turn.facts`, `runtime.session.lifecycle`, `runtime.turn.abort`. Without
   `renderer.extension` the renderer module is never served, without
   `agent.extension` the manifest is refused, without `ui.view` / `ui.panel` the
   console has no surface, and without a slot grant the behaviour behind that
   slot is skipped and reported as a `permission_denied` diagnostic on the
   plugin row. Loading the folder as a **development plugin** grants what the
   manifest asks for, which is how the e2e suites load it.

Use **Load local plugin** for this example — **Import pi extension** is for pi CLI
extension packages and is a different flow.

## Try it

**The renderer half** needs nothing but a chat. Open a session with at least one
message, then walk the table above in this order:

1. The badge appears under every transcript row, and the whole-message card
   (`entry`) takes over the row itself — it draws the message the host handed
   it, with its own two controls beside the text. That is the one slot that
   replaces host UI: **Release this claim** (or unloading the plugin) hands the
   row back to the host's own rendering.
2. Click **Notify the host** in the badge: a toast appears with the entry's role
   and id, and the badge prints `toast sent`. If the action were not declared,
   the badge would print `PLUGIN_ACTION_UNDECLARED` instead — the same is true
   of the buttons in the `entry` card and the tool card.
3. Ask the model (or write yourself) a fenced block in the plugin's own
   language:

   ````text
   ```acme.plugin-showcase:kv
   # a language only this plugin draws
   covered = 42
   disk! = 91% used
   ```
   ````

   It renders as rows, with the `disk` row emphasised: the language's trailing
   `!` is the plugin's own convention, showing that the component really owns the
   block.
4. Ask the model to use `showcase_note`, then look at the tool row: the
   `toolCard` card body replaces the host's detail blocks, and the row is open
   because the plugin draws it.
5. Use the composer controls. The left row's **Showcase: inline card** takes the
   host's inline-confirmation position (it needs a pending permission request to
   be visible), the right row's **Showcase: modal** and **Showcase: overlay**
   are the two layer positions, and each closes from its own button. The left
   row also carries the draft controls: type something, press **Showcase: read
   the draft** (the group prints the snapshot and its generation), press
   **Showcase: write it back** (the host writes it, the generation moves on),
   then press **Showcase: stale write (DRAFT_CONFLICT)**: the host refuses that
   one and the composer keeps its text. **Showcase: declared but unrouted**
   answers `PLUGIN_ACTION_UNROUTED`, and the same code shows up on the plugin
   row's Renderer diagnostics when the Extensions page is open.
6. While the completion popover is open, type `/showcase` or `@acme` to see the
   plugin's candidate rows, and attach a file to see the composer chip.

**The agent half** needs a turn:

1. Ask: *"Run `git reset --hard HEAD~1` with Bash."* The call is refused before
   anything runs; you get a warning toast and the transcript shows
   `Plugin Showcase refused this command: a hard reset that discards uncommitted
   work. Ask the user how to proceed instead of retrying.`
2. While the turn runs, a status chip at the bottom-right of the window counts what
   the plugin saw: `Plugin Showcase · turn 1 · 1 tool call(s) seen`.
3. Let the model retry twice more. On the **third** blocked call of the same turn
   the plugin also asks the host to stop the turn, and the reason says so:
   `… and asked the host to stop the turn after 3 blocked calls in it: accepted.`
   (If the grant were missing, the same sentence would end in `refused.`.)
4. When the run ends, one notification reports the host's numbers for the turn:

   `Plugin Showcase · turn summary — completed, 12.3s, 1500 tokens, 5 tool call(s) (4 ok / 1 failed) per host vs 3 seen here, 1 file(s) touched, no plugin-tool spend.`

   The two tool-call numbers are printed side by side on purpose:
   `runtime.turn.watch` is best-effort delivery, `runtime.turn.facts` is the
   host's own table.
5. Create or delete a session in the sidebar: the plugin is told
   (`the host created session …` / `the host deleted session …`) and can veto
   nothing.
6. Run **"Plugin Showcase: What this plugin adds"** from global search
   (`Cmd/Ctrl+K` or `Cmd/Ctrl+Shift+P`) to see the plugin's own summary toast,
   printed from the plugin process rather than the agent.

The gate patterns are shallow on purpose (`git reset --hard`, `rm -rf /` or
`rm -rf ~`, `curl … | bash`). They demonstrate the slot, not a policy: a real
guard belongs in the host's approval rules.

## How the two halves talk to each other

They do not, and that is the first thing to understand about this plugin model:

```text
renderer/index.mjs        main.js                agent/extension.js
(app window)              (plugin process)       (agent sidecar)
      │                        │                        │
      └── dispatch(action) ────┴── (host relay)          │
      │                        │                        │
      └── props from the host ─┴─ host render tree      │
                               │                        │
                               └── host tables ─────────┘
```

- The renderer half is a component: the host hands it props and a `dispatch`,
  and the host calls it. It has no channel to the agent half.
- The agent half is a hook: the host calls it while a turn runs. It has no
  channel to the window either — it talks to the user through `ctx.ui`, which the
  host renders.
- The **headless half** (`main.js`) is a third process. It registers the command
  and the plugin's own agent tool, which is what the `toolCard` slot needs. The
  only way the renderer reaches it is the forwarded action `plugin.call` — a
  mounted control reports on mount and the cards' **Report to the plugin
  process** buttons re-report on demand — and the answer they print is this
  process's own reply, so the console's inventory is a report rather than a
  claim made up in the window. The same channel carries the renderer's
  `renderer.refusal` reports, which is why the unrouted `composer.insertText`
  refusal appears in the console log as well as on the plugin row.

The runtime receipts the console shows are what this process really holds about
the agent half: the host's `session:turnEnded` push (this process subscribes
with `pi.events.on`) and one entry per execution of the plugin's own agent tool
(whose `execute` runs here, with the host's own session/turn in its context).
The agent half's own verdicts stay in the sidecar and reach the window, not this
process — see the console section above.

So the two halves communicate *through the host*: the renderer draws what the
host read from its own state, and the agent half changes what the host does next
(a blocked call, a stopped turn). If your plugin needs one half to affect the
other, that has to go through host state — a permission, a contribution, or a
transcript row the host owns.

## What this does not do yet

Honest gaps, all of them observed while writing this example:

- **No shipped host position calls a registered function yet.** `pi.functions.register`
  is real (`apps/desktop/src/plugins/renderer-host/host-functions.ts`): the host
  validates the name, measures the call, discards an answer past 16 ms and trips a
  breaker after three failures. All ten positions read their data as ordinary
  props today, so the only callers of a registered function are tests. The badge
  and the block call their own registered functions to show the shape; the value
  the host would use is the same value.
- **The entry position re-draws text, not the host's Markdown.** The `message`
  a replace component is handed is the message's *content* (text, attachments,
  timestamp, slash form, streaming state), so the host's Markdown rendering,
  its fenced-code handling and its link chips are the host's own and are not
  drawn while a plugin holds the row. The plugin's card has to render whatever
  form it wants; this example draws readable plain text.
- **A card cannot trigger the host's own row actions.** `message.actions` names
  them (`copy`, `edit`, `delete`, `revisions`) so a card can say what it stands
  in for, and the vocabulary has no action to invoke one: an `entry` claim
  really does take those controls away until the claim is released.
- **No action reaches the agent half.** The whole `rendererActions` vocabulary is
  host-performed (`ui.toast`, `composer.*`) or forwarded to the plugin's own
  entry (`plugin.call`). There is no "ask my agent extension" action, and none of
  the slot permissions can be requested from the window. `composer.insertText`
  and `composer.attachPath` are declared but unrouted: this example declares
  `composer.insertText` on purpose so the control can show the
  `PLUGIN_ACTION_UNROUTED` refusal, which is a real host answer rather than a
  missing button.
- **The console cannot read the agent sidecar.** The tool gate's verdict, the
  turn-facts summary and the status-line counts are written by
  `agent/extension.js` inside the sidecar, and the only channels it has are the
  host's own (`ctx.ui.notify` / `setStatus`), which the window renders. The
  sidecar has no channel to the plugin process or to the console page, so the
  console shows the runtime receipts the plugin process really holds (host turn
  pushes, its own agent-tool executions) and names that gap instead of printing
  a gate hit count nobody can read back.
- **A plugin cannot modify a tool call's arguments.** A `tool_call` handler may
  block a call and give a reason, and that is all; argument rewriting is
  permanently excluded (ADR 0295 rule 4), so nothing should be built on it.
- **`runtime.approval.before` (slot 12) does not exist.** Neither the kernel nor
  the harness has the hook, so a before-an-approval-card slot is not built and
  nothing here asks for it.
- **A candidate row cannot insert.** `completionSource` is a source of rows, not
  a way to accept them, and a `composerReference` chip cannot change the draft.
  Both positions say so instead of looking selectable.
- **Nothing from the runtime slots this example skips.** Before Send (1), Turn
  Closing (7), Turn Recap (8), Turn Continue (10) and Tool Extend (5) are not
  used here; Before Request (6) was withdrawn (`runtime.request.before` is not
  offered), and `examples/plugins/runtime-slots-demo` covers the gate and abort
  questions from the other direction.
- **Not a security control.** The three gate patterns are shell-text-level and
  easy to evade (quoting, variables, another language).

## How this example was checked

Run while writing it, and repeatable:

- `node packages/plugin-devkit/dist/cli.js check examples/plugins/plugin-showcase`
  — passes with one warning, the same `permission.high-risk` class the other
  examples produce: `renderer.extension, agent.extension, agent.tool.register,
  runtime.tool.gate, runtime.session.lifecycle, runtime.turn.abort` each need an
  explicit grant.
- The manifest through the SDK path the app uses (`validateManifest` from
  `packages/plugin-sdk/dist`): accepted, `id` matches `PLUGIN_ID_PATTERN`, the
  entry rule is satisfied, all eleven permissions exist in `PLUGIN_PERMISSIONS`,
  the console's destination is declared under `contributes.views` (where the
  host reads it), and `main.js`, `renderer/index.mjs`, `agent/extension.js` and
  `views/console.html` all exist.
- The replace positions are pinned at the mount, not only in prose:
  `apps/desktop/test/plugin-renderer-slots.test.mjs` mounts a component for
  `entry`, `toolCard` and `inlineConfirm` through `PluginSlot` and asserts the
  display data each one is handed (the message text/attachments/timestamp, the
  tool call, the pending confirmation). A host that stopped passing that data
  fails there.
  `pnpm test:e2e:plugin-showcase` walks the ten positions in a real window —
  including a user message whose own text has to stay readable inside the
  plugin's `entry` card, with the card's own controls beside it — opens the
  docked console view through the work-panel launcher and reads the inventory
  the page publishes (ten slots, ten actions, eight data keys, eleven runtime
  slots), drives the AI controls' receipts and the runtime group's own
  receipts, and answers a real tool permission through the run's own
  `e2e-auto-consent` marker instead of a native dialog. `pnpm
  test:e2e:plugin-slots` covers the renderer scheme, the import map and the
  action channel.
- The renderer module with the app's own React: `react` resolved to the app's
  copy, `onLoad` run against a recording `pi`, and all ten components
  server-rendered with the props their mount position passes — the mount points
  under `apps/desktop/src` are `features/chat/transcript/MessageRow.tsx` for
  `entry` and `entryExtra`, `features/chat/transcript/ToolRow.tsx` for
  `toolCard`, `components/Markdown.tsx` for `codeBlock`,
  `features/chat/composer/ComposerToolbar.tsx` for `composerControl`,
  `components/ComposerAutocomplete.tsx` for `completionSource`,
  `features/chat/composer/ComposerInput.tsx` for `composerReference`,
  `features/chat/transcript/ChatTranscript.tsx` for `inlineConfirm`, and
  `plugins/renderer-slots/PluginLayerHost.tsx` for `modal` and `overlay`. The
  three layer positions
  were opened and closed through the composer controls' own handlers — which is
  what the plugin does — with `useState`/`useEffect` stubbed, because the server
  renderer has no state updates; every registration was checked to disappear
  again. Both registered functions were exercised, including a 2000-row input
  well inside the 16 ms budget, and the toast button's dispatch path was driven
  with a resolved and a refusing `dispatch`.
- **Not run here:** `verify:ui:*`. The two e2e suites above cover the plugin in
  the running app; `verify:ui:*` is the host's own UI suite and is not run for
  an example plugin.
- The agent half was checked when it was written (through the sidecar's own
  loader, with a stubbed `pi` and `ctx`); it is unchanged in this pass and was
  **not re-run** here.

## Reference

- Spec: `docs/spec/07-plugins/16-trusted-extensions.md` §2A (renderer), §6 (agent)
- Decisions: `docs/adr/0291-trusted-renderer-execution-host.md`,
  `docs/adr/0294-renderer-plugin-interface-and-host-relay.md`,
  `docs/adr/0295-runtime-slots-and-their-permissions.md`
- Permissions: `docs/spec/07-plugins/13-plugin-permissions-matrix.md` §2
- Other examples: `examples/plugins/slots-demo` (renderer only),
  `examples/plugins/runtime-slots-demo` (agent only),
  `examples/plugins/README.md`
