/**
 * Plugin process: business logic for draft enhance.
 * Renderer only calls in via plugin.call; AI runs here with pi.ai.complete.
 */
module.exports = {
  onLoad() {},
  async onRendererCall(method, args) {
    if (method !== "enhanceDraft") {
      return { ok: false, code: "PLUGIN_CALL_NO_HANDLER" };
    }
    const text = String(args?.text ?? "");
    const generation = Number(args?.generation ?? 0);
    try {
      const result = await pi.ai.complete({
        purpose: "prompt-enhance",
        // system is exactly what we pass — host does not merge session system.
        system:
          "Rewrite the user draft to be clearer and more specific. Keep facts. Reply with the rewritten draft only.",
        messages: [{ role: "user", content: text }],
        maxTokens: 800,
      });
      return {
        ok: true,
        generation,
        text: result?.text ?? text,
        modelKey: result?.modelKey ?? null,
      };
    } catch (error) {
      return {
        ok: false,
        code: error?.code || "PROVIDER_ERROR",
        detail: String(error?.message ?? error),
      };
    }
  },
};
