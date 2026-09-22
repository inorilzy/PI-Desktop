/**
 * Headless half of the slots demo.
 *
 * A plugin may declare both entries: this module runs in the plugin's own
 * process with the host-injected `pi` global, and `renderer/index.mjs` runs
 * inside the app window (spec 07-plugins/16 §2A.1 — the tiers are orthogonal).
 * The command below is registered here, and so is the method the badge's button
 * forwards to (`onRendererCall`, ADR 0294 decision 4) — the one thing the
 * window cannot answer for itself, because only this process runs it.
 */

/** Command id, declared in `contributes.commands`. */
const COMMAND_ID = "acme.slots-demo.about";

/** Method the renderer's forwarded call asks this entry to run. */
const ECHO_METHOD = "demo.echo";

/**
 * How many forwarded renderer calls this process has answered. Module state, so
 * it belongs to this entry alone: the window can ask again but cannot move this
 * number, and a second click can only show `2` if the call really came back
 * here.
 */
let rendererCalls = 0;

async function onLoad() {
  await pi.commands.register({
    id: COMMAND_ID,
    title: "Slots Demo: What this plugin adds",
    keywords: ["slots", "renderer", "demo"],
    run: async () => {
      // `renderer` unread by the host is a diagnostic, not a crash, so this
      // toast is the only way to tell "loaded" from "loaded but never drawn".
      await pi.ui.showToast(
        "Slots Demo registered an entryExtra badge, a modal, and one stylesheet.",
      );
    },
  });
}

async function onUnload() {
  await pi.commands.unregister(COMMAND_ID);
}

/**
 * The method the badge's `plugin.call` dispatch runs.
 *
 * `dispatch("plugin.call", { method, args })` is relayed to this plugin's own
 * entry and the renderer's promise resolves with whatever this returns. Only
 * JSON-serializable values travel — they cross `postMessage`, Electron IPC and
 * the result envelope — and an answer the transport cannot carry is refused
 * with `PLUGIN_CALL_UNSERIALIZABLE` instead of arriving truncated. An absent
 * answer arrives as `null`.
 *
 * A method this hook does not implement is refused here, by the plugin: the
 * host answers a *missing hook* with `PLUGIN_CALL_NO_HANDLER`, but which method
 * names exist is the plugin's own decision, so it has to say so itself.
 */
async function onRendererCall(method, args) {
  if (method !== ECHO_METHOD) {
    const error = new Error(`the slots demo has no renderer method: ${method}`);
    error.code = "SLOTS_DEMO_NO_SUCH_METHOD";
    throw error;
  }
  rendererCalls += 1;
  return {
    method,
    args,
    // The evidence that this ran here: a counter only this process has, and the
    // name of the file that answered.
    calls: rendererCalls,
    entry: "main.js",
  };
}

module.exports = {
  onLoad,
  onUnload,
  onRendererCall,
};
