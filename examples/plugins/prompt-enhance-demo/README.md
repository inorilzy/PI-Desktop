# Prompt Enhance Demo

Illustrates the architecture rule after withdrawing `runtime.request.before`:

- **Renderer** (`renderer/index.mjs`): slot UI + draft data transfer only (`composer.readDraft` / `composer.replaceDraft` / `plugin.call`).
- **Plugin process** (`main.js`): business logic; AI via `pi.ai.complete` (permission `agent.model.complete`, or legacy `agent.complete`).
- **Host**: resolves the user-configured model, holds credentials, audits spend.

`system` passed to `pi.ai.complete` is **not** auto-merged with the session system prompt.

Undo is **plugin-owned**: the renderer keeps the `previous` snapshot returned by `composer.replaceDraft` and writes it back.
