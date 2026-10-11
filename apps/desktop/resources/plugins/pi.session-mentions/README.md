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
holding that session's first and most recent complete Q&A, inside a fence
tagged `pi.session-mentions:chat`. In the transcript the block is drawn as a
one-line card that opens on click (see below).

Plain ES modules, no build step: `main.js` + `service.js` (headless),
`renderer.js` + `card.js` (renderer), `lib/` (pure logic from PR #447).
Tests: `apps/desktop/test/plugin-session-mentions*.test.mjs`.

## What a reference contains

- The referenced session's **first complete Q&A turn**, always, then its
  **most recent** complete turns, at most **max turns** in all (below; the
  first turn counts, so 3 is the first + the 2 most recent). Each turn is a
  parent user question and every eligible parent answer row after it; the
  block keeps them in chronological order.
- Recent turns are selected newest-first, whole, until the next one would
  exceed the reference budget (below). A marker line stands where turns were
  left out between the first turn and the recent ones: `[… 7 turns omitted
  here]`, or `… were not read` when the reader did not reach them.
- The reader pages backwards from the newest rows (400 at a time, at most 4
  pages) and stops once it has 21 turns (enough for any turn limit); for a longer session the first turn
  comes from one read of its first 48 rows. A first turn not closed by a later
  question within those rows (a very long first run of tool rows) is not
  used; the block then holds the most recent turns and says older history was
  not read.
- If the first turn alone does not fit the 32 KB mark limit, it is clipped
  (question capped first, then the answer) and the block says so.
- Thinking, tool calls and results, delegated (subagent) rows, streaming,
  error and aborted answers, and attachment contents are never included.
- Referenced chats inside the referenced session (fenced, bare, or #447
  envelopes) become a one-line placeholder, so references do not nest.
- The block opens with a note that it is reference material, not a new
  instruction or tool authorization, and says what it covers. Its opening
  tag carries the same: `turns`, `first-turn`, `omitted` (turns left out that
  were read) and `unread` (some were not read).

## Settings › AI › Session references

The plugin has no settings of its own. The host's **Settings › AI › Session
references** group (会话引用) holds both choices and hands them to the trigger
with each query as `sessionReferences: { budgetPercent, maxTurns }`:

- **Reference budget**: 10%, **25%** (default), 50% or 100% of the current
  chat's remaining context.
- **Max turns per reference**: 3, 5, **10** (default) or 20.

A host without the field (or a value outside the choices) gets 25% and 10.
A budget once saved under the plugin's former Extensions setting is ignored.
One reference may use

    min(32 KB, pct × (contextWindow − usedTokens − 8192) × 3 bytes)

where `usedTokens` / `contextWindow` are the trigger query's `context` (what
the composer's context ring shows), 8192 tokens are held back for the reply,
and 3 bytes per token is #447's UTF-8 estimate (not a tokenizer). The budget
is rounded down to 512 bytes. Before the chat's first answered turn the host
reports no usage, and the 32 KB mark limit is the budget. A change applies
to the next `@`.

When the context share is the tighter limit and not even the first turn fits
it, the row is **not** given a clipped snapshot: it shows as `⚠ <title>` with
the hint "上下文剩余不足：先 /compact 压缩，或在 设置 › AI 里调高引用预算" / "Not
enough context left: run /compact, or raise the reference budget in Settings
› AI" (at 100%: "上下文快满了，先 /compact 压缩再引用"), and
picking it anyway only sends a one-line note that the session was not
attached. The plugin never compacts; the user runs `/compact`.

## In the transcript

The mark sends the block inside a fence tagged `pi.session-mentions:chat`
(longer than any backtick run in the block). The plugin's `blockRenderer`
claims that tag, so the sent message shows a closed card: the session title
and, e.g., `first + 9 recent turns · 4 between omitted · ~12.3 KB`. Clicking
it shows the block's full text; clicking again closes it. The message itself
is unchanged: the model reads the same text, and Copy, edit and the context
menu's copy use the full message. With the plugin disabled the fence is shown
as the text it is.

In user messages the host draws only claimed fences (`UserMessageText`);
other fences stay text.

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
and what the reference holds (`first + 9 most recent turns · 4 between
omitted`, or `3 Q&A turns` for a session referenced whole).

## How it works

- `renderer.js` registers the `@` trigger. A trigger row must carry its mark
  text when the list is drawn, so the renderer asks the headless entry for the
  list together with the rows' snapshots through `plugin.call`
  (`sessions.items`, then `sessions.snapshots` for any still pending), passing
  the query's `context` and `sessionReferences` on, and caches them by
  `id@updatedAt#bytes/maxTurns`, so a snapshot is reused exactly while the
  session, the budget and the turn limit are unchanged. Only rows whose snapshot is ready are
  listed. The cache is warmed once at load. It also registers the
  `blockRenderer` for the reference fence and injects the card's styles.
- `service.js` (headless) reads through the reviewed desktop-control read
  operations `session/list` and `session/get` (`pi.desktop.invoke`, permission
  `desktop.control`), paging 400 physical rows at a time (at most 4 pages).
  Snapshots are built ahead of the pick, cached, and sent in answers kept
  under the host's 64 KB `plugin.call` limit and 2 s budget.

## Boundaries and differences from #447

- The referenced Q&A becomes part of the user's message as sent; the
  transcript shows it as a closed card. #447 rewrote only the model's copy in
  a Before Send hook, which main does not have.
- The snapshot is taken when the list is shown, not at send time. A session
  that changes after the pick is referenced as it was then.
- Clicking a chip does not open the referenced session; marks are host chips.
- `desktop.control` is broader than this plugin needs (it also allows desktop
  write operations); the plugin only calls `session/list` and `session/get`.
  As a bundled plugin it holds its manifest permissions without a consent
  prompt. A read-only cross-session API (`session.read` scoped to listing and
  reading other sessions) would let it drop `desktop.control`.
