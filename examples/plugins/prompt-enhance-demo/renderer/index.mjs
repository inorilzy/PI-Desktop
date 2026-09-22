/**
 * Renderer slot UI only: paint buttons, move draft data, call plugin process.
 * No AI in this file (architecture rule: renderer = render + data transfer).
 */
const PLUGIN_ID = "example.prompt-enhance-demo";

let before = null;

function dispatch(action, payload) {
  return globalThis.piDesktop
    ? globalThis.piDesktop.invoke("plugin.dispatchRendererAction", {
        pluginId: PLUGIN_ID,
        action,
        payload,
      })
    : Promise.resolve({ ok: false, code: "NO_BRIDGE" });
}

export default function onLoad(pi) {
  pi.slots.register("composer.control", function PromptEnhanceSlot(props) {
    // In real host rendering this is a React component; example documents flow.
    return {
      enhance: async () => {
        const snap = await pi.dispatch
          ? pi.dispatch("composer.readDraft", {})
          : await dispatch("composer.readDraft", {});
        if (!snap?.ok && snap?.sessionId === undefined) return;
        const draft = snap?.ok === false ? null : snap;
        if (!draft) return;
        before = draft;
        const enhanced = pi.dispatch
          ? await pi.dispatch("plugin.call", {
              method: "enhanceDraft",
              args: { text: draft.text, generation: draft.generation },
            })
          : await dispatch("plugin.call", {
              method: "enhanceDraft",
              args: { text: draft.text, generation: draft.generation },
            });
        if (!enhanced?.ok) {
          if (pi.dispatch) await pi.dispatch("ui.toast", { message: enhanced?.detail || enhance?.code || "enhance failed" });
          return;
        }
        const write = pi.dispatch
          ? await pi.dispatch("composer.replaceDraft", {
              text: enhanced.text,
              expectedGeneration: draft.generation,
              fileReferences: "preserve",
            })
          : await dispatch("composer.replaceDraft", {
              text: enhanced.text,
              expectedGeneration: draft.generation,
              fileReferences: "preserve",
            });
        if (!write?.ok && write?.ok !== undefined) {
          if (pi.dispatch) {
            await pi.dispatch("ui.toast", {
              message: write.code === "DRAFT_CONFLICT" ? "输入框已变化，请重试" : write.code,
            });
          }
        }
      },
      undo: async () => {
        if (!before) return;
        const restore = { text: before.text, fileReferences: before.fileReferences || [] };
        if (pi.dispatch) await pi.dispatch("composer.replaceDraft", restore);
        else await dispatch("composer.replaceDraft", restore);
        before = null;
      },
    };
  });
}
