/**
 * Headless half of the runtime-slots demo.
 *
 * Two things live here. The first is a rule worth knowing: a plugin is
 * runnable only when it declares `main`, `renderer`, or a plugin page.
 * `contributes.agentExtensions` is a contribution, not an entry, so a manifest
 * that declares only an agent extension is refused at install (spec
 * 07-plugins/02 §7 rule 19; host-core says `one of
 * main/renderer/panel/view/destination required`). The second is the command
 * below, which is this plugin's visible presence in the app: it registers in
 * the command palette and says what the agent-side half does.
 *
 * The behaviour itself lives in `agent/extension.js`, because only the agent
 * sidecar sees a running turn.
 */

/** Command id, declared in `contributes.commands`. */
const COMMAND_ID = "acme.runtime-slots-demo.about";

async function onLoad() {
  await pi.commands.register({
    id: COMMAND_ID,
    title: "Runtime Slots Demo: What this plugin adds",
    keywords: ["runtime", "slots", "tool gate", "abort", "demo"],
    run: async () => {
      await pi.ui.showToast(
        "Runtime Slots Demo: its agent extension refuses dangerous shell commands and asks the host to stop a turn that keeps trying.",
      );
    },
  });
}

async function onUnload() {
  await pi.commands.unregister(COMMAND_ID);
}

module.exports = {
  onLoad,
  onUnload,
};
