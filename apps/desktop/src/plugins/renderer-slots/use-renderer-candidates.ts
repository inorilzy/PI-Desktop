/**
 * The plugin rows a mount point hands `PluginSlot`, read from the shell's own
 * plugin list.
 *
 * Every mount has to carry these: the outlet loads a plugin's renderer entry
 * from the rows it renders for, and records what that plugin declared, so a
 * position that forgets them renders a plugin's registrations only if some
 * other position on screen happened to load it first. One hook keeps the three
 * composer positions — and any later mount — reading the same list the same
 * way, instead of each restating the store selector and the memo.
 */
import { useMemo } from "react";
import { useAppStore } from "../../stores/app-store";
import { rendererCandidates } from "./candidates";
import type { RendererCandidate } from "./SlotOutlet";

export function useRendererCandidates(): RendererCandidate[] {
  const plugins = useAppStore((s) => s.plugins);
  // A fresh array every render would restart the outlet's load effect, which is
  // keyed on the set of plugin ids it was handed.
  return useMemo(() => rendererCandidates(plugins), [plugins]);
}
