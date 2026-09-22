/**
 * Which installed plugins may fill a component slot (ADR 0291).
 *
 * The capability is derived by the host from the manifest, so the renderer never
 * has to read one: a plugin shows up here exactly when it declared `renderer`
 * *and* is loaded with the `renderer.extension` grant. Both halves are the main
 * process's answer, and this module only re-shapes it for the mount points.
 */
import type { PluginSummary } from "@pi-desktop/shared";
import type { RendererCandidate } from "./SlotOutlet";

export function rendererCandidates(plugins: readonly PluginSummary[]): RendererCandidate[] {
  const out: RendererCandidate[] = [];
  for (const plugin of plugins) {
    if (!(plugin.capabilities ?? []).includes("renderer")) continue;
    out.push({
      id: plugin.id,
      version: plugin.version,
      declared: true,
      // The manifest's declaration rides along unchanged, so a mount point
      // already knows what this plugin said it would read and call. Empty means
      // it declared neither, which is also how a plugin that predates the
      // fields reads.
      rendererData: plugin.rendererData ?? [],
      rendererActions: plugin.rendererActions ?? [],
    });
  }
  return out;
}
