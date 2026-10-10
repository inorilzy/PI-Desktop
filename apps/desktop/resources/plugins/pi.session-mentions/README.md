# Session Mentions (`pi.session-mentions`)

A bundled first-party plugin: it ships with the app and is on by default
(**Extensions** lists it as bundled; it can be disabled there but not
uninstalled). Type `@` in the composer to reference another local session.
The plugin owns the `@` composer trigger (`composerTrigger`,
`docs/plugin-plan/ui/composer/`) with `placement: "first"`: its **Session
Mentions** group leads the list, its first session is highlighted (Enter picks
it), and the host's file rows follow under their own heading. Picking a
session puts a mark chip labelled with the session title into the draft. When
the message is sent, the chip is replaced by a `<referenced-chat>` block
holding that session's most recent complete Q&A.

Like `pi.browser`, it is plain ES modules with no build step: `manifest.json`,
`main.js` (headless entry), `service.js`, `renderer.js` (renderer entry) and
`lib/` (the pure logic carried over from PR #447). Its tests live in
`apps/desktop/test/plugin-session-mentions*.test.mjs`.

## What a reference contains

- Up to the **10 most recent complete Q&A turns** of the referenced session,
  each a parent user question and every eligible parent answer row after it,
  in chronological order.
- Whole turns are selected newest-first until the block would exceed the
  host's **32 KB** mark limit (`PLUGIN_MARK_SEND_MAX_BYTES`), or the current
  session's remaining context (see below) if that is smaller. If even the
  newest turn alone is larger than 32 KB, it is clipped and the block says so.
- Thinking, tool calls and results, delegated (subagent) rows, streaming,
  error and aborted answers, and attachment contents are never included.
- Referenced chats inside the referenced session (including #447 envelopes)
  become a one-line placeholder, so references do not nest.
- The block opens with a note that it is reference material, not a new
  instruction or tool authorization, and says how many turns were included
  or omitted and whether older history was not read.

## When the current context is nearly full

The host tells a composer trigger the draft's session and its context use
(`PluginTriggerQuery.sessionId` / `.context`, the figures the composer's
context ring shows). When the remaining space minus an 8192-token reply
reserve (at #447's UTF-8/3 estimate) is below 32 KB, snapshots are budgeted
against it. When not even the newest complete turn fits, the row is **not**
given a clipped snapshot: it shows as `⚠ <title>` with the hint
"上下文快满了，先 /compact 压缩再引用" / "Context is nearly full: run /compact
first, then reference this session again", and picking it anyway only sends a
one-line note that the session was not attached. The plugin never compacts;
the user runs `/compact`. Before the session's first answered turn the host
reports no usage, and the 32 KB mark limit is the only budget.

## The list

At most 8 sessions (the host's per-draft mark limit), most recently updated
first, filtered by the text typed after `@` against title and id. Only local
desktop sessions are offered; scheduled-task runs and other session
namespaces are not. The session being typed in is left out, and so are
sessions without a single complete Q&A turn (nothing to reference).

Each row's label is the session title (also the chip's label). When several
listed sessions share a title (e.g. a few "new task"), their labels get the
short local update time, `new task · 10-09 21:17`, plus the first four
characters of the id if that still collides. Labels stay within 64
characters. The second line reads `<update time> · “<first question>” ·
<coverage>`: a relative time (`5 min ago`, `3 小时前`), the first words the
user typed in that session (referenced chats stripped, cut to 40 characters),
and how many turns the reference holds.

## How it works

- `renderer.js` registers the `@` trigger. A trigger row must carry its mark
  text when the list is drawn, so the renderer asks the headless entry for the
  list together with the rows' snapshots through `plugin.call`
  (`sessions.items`, then `sessions.snapshots` for any still pending), and
  caches them by `id@updatedAt`. Only rows whose snapshot is ready are listed.
  The cache is warmed once at load.
- `service.js` (headless) reads through the reviewed desktop-control read
  operations `session/list` and `session/get` (`pi.desktop.invoke`, permission
  `desktop.control`), paging 400 physical rows at a time (at most 4 pages).
  Snapshots are built ahead of the pick, cached, and sent in answers kept
  under the host's 64 KB `plugin.call` limit and 2 s budget.

## Boundaries and differences from #447

- The referenced Q&A becomes part of the user's message as sent, so it is
  visible in the transcript. #447 rewrote only the model's copy in a Before
  Send hook, which main does not have.
- The snapshot is taken when the list is shown, not at send time. A session
  that changes after the pick is referenced as it was then.
- Clicking a chip does not open the referenced session; marks are host chips.
- `desktop.control` is broader than this plugin needs (it also allows desktop
  write operations); the plugin only calls `session/list` and `session/get`.
  As a bundled plugin it holds its manifest permissions without a consent
  prompt. A read-only cross-session API (`session.read` scoped to listing and
  reading other sessions) would let it drop `desktop.control`.
