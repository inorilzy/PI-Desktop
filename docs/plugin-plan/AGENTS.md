# docs/plugin-plan — Plugin Slot & Runtime API Catalog

This directory records, for each UI slot and each plugin-facing agent-runtime
method, what the host promises a plugin and what a plugin may do with it.

Parent policy is `/AGENTS.md`. Domain specifications under `docs/spec/` remain
the source of truth for real behavior; this catalog is review material and
working notes. When they disagree, verify the code and fix this catalog.

## Layout

```text
docs/plugin-plan/
  AGENTS.md            this file
  index.html           the only complete list; every existing folder is linked
  ui/<slot-id>/        one UI slot        e.g. ui/user-message
  runtime/<hook-id>/   one runtime hook   e.g. runtime/before-send
  api/<method-id>/     one core method that is not a slot, e.g. api/open-attachment
```

Folder id is lowercase-kebab and must match the name the SDK will use. Titles
inside the pages are Chinese; ids, field names, code, and commit messages stay
English.

## Required files per folder

Every folder carries its own `index.html` first. It lists the pages in that
folder, the status, and the issue the folder belongs to.

| file | answers |
|---|---|
| `index.html` | what this folder covers, and links to the pages below |
| `requirements.html` | what the user asked for: scope, default component, slot split, named scenarios, explicit non-goals |
| `demo.html` | what it looks like inside a real conversation |
| `data-flow.html` | how data moves, and where the feature sits in a plugin |

`data-flow.html` is required when the slot has host-side data plumbing (fixed
data formats, host components, callable operations). A slot where the host
hands raw content over once and the plugin owns everything else — e.g.
`ui/block-renderer` (language tag + raw source, renderer implements copy and
error display itself) — may omit the page; the omission is then recorded in
that folder's `index.html` and its `requirements.html` 拍板 section, and the
folder's navigation shows only the pages that exist.

## Top navigation

Every page carries the same navigation strip at the very top, above its own
header, so any page can reach any sibling:

- Left: the folder's parent chain, ending in the current folder (`插件插槽目录 / 用户消息卡`).
- Right: the sibling pages — `目录` · `需求` · `演示` · `数据流`.
- The current page is marked with `aria-current="page"` and stays visually
  distinct from its siblings.

Keep the markup and class name (`plan-nav`) identical across pages; a page
whose navigation drifts is a defect. `docs/plugin-plan/index.html` carries the
same strip, listing the folders that actually exist.

`data-flow.html` carries these sections, in this order, in plain language. A
missing section is a defect, not a style choice:

1. **接口约定** — what data the plugin gets, which host components it can use, which operations it can call, permission name
2. **数据怎么走** — who passes what, in which direction, over what lifetime
3. **出错怎么办** — thrown error, unload, edit mode
4. **不提供什么** — what this position deliberately does NOT provide
5. **相关条目** — neighbouring slots and core APIs, by folder path
6. **还没定的事** — unanswered questions, one screen maximum

## Status

`draft` · `decided` · `implemented`

- `draft` — agent proposal, user has not decided
- `decided` — user decided, not built
- `implemented` — shipped, on a named branch

Status appears in `index.html` and as an HTML comment on line 1 of each file.
Every folder names the issue it belongs to (`#545`, `#561`, …) and the branch
when one exists.

## Writing rules

- Separate **user decided** from **agent proposal**. Never blur them into one list.
- No empty folders. Items without a folder appear in `index.html` only.
- Self-contained pages: one file each, no build step, no external assets, opens
  by double-click.
- No narration in `demo.html`. The demo shows the interface, not the reasoning.
- Write in plain language. Pages are read by the user, not by the agent that
  wrote them. No internal shorthand: name what the reader sees, not the
  implementation's word for it.
  - Say `消息气泡整体`, not `气泡心`; say `这条消息的数据`, not `本行事实`.
  - Say `现成组件`, not `积木`; say `出错隔离`, not `error boundary`.
  - Say `能调用的操作`, not `action 闭包`.
  - Table headers and section titles are part of this rule, not just prose.
- Do not restate an ADR or a spec as if this catalog were authoritative.
- `docs/plugin-slots/*` is frozen history. Do not sync it, do not cite it as
  current, and do not add new material there. Each folder here is the live copy.
