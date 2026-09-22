/**
 * The host's app-level layer positions: `modal` and `overlay` (spec
 * 07-plugins/16 2A.5, ADR 0291).
 *
 * A layer has no place in the host's own tree, so the registration *is* the
 * layer: a plugin says its dialog or overlay is up by registering one, and says
 * it is gone by removing that registration (`handle.remove()`, or its own
 * component rendering nothing). Everything the shell already does on unload,
 * disable, or uninstall therefore reclaims the layer with it (D10), which is the
 * rule this file exists for: no orphan layer is left on screen, and any layer
 * that is on screen can be left with Escape.
 *
 * Appearance is not the same thing as registration, though: a layer can be
 * *withdrawn* while its registration stands. That one piece of state lives in
 * the slot registry (`pluginSlots.isLayerWithdrawn`), because the plugin's own
 * `ui.closeModal` / `ui.openModal` (`ui.closeOverlay` / `ui.openOverlay`) acts
 * on the same state Escape does. The component is never removed, so restoring
 * the layer shows the same registration again, and a call can only ever reach
 * the layer of the plugin that made it.
 *
 * The two positions differ in one thing only, and it is the host's decision
 * rather than the plugin's: a `modal` is blocking and takes the host's own
 * `.overlay` scrim, while an `overlay` is a transient layer that leaves the rest
 * of the window usable (only the plugin's own box takes the pointer). Neither is
 * portaled while no plugin fills it, so a window with no renderer plugin keeps
 * today's DOM exactly.
 */
import { useEffect, useMemo } from "react";
import { portalOverlay } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { PluginSlot, useSlotRegistrations } from "./SlotOutlet";
import { pluginSlots, type PluginLayerSlot } from "./registry";
import { useRendererCandidates } from "./use-renderer-candidates";

function PluginLayer({ slot, blocking }: { slot: PluginLayerSlot; blocking: boolean }) {
  const registrations = useSlotRegistrations(slot);
  const candidates = useRendererCandidates();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const slotProps = useMemo(
    () => (sessionId ? { sessionId } : {}),
    [sessionId],
  );

  // A registration the host withdrew is still a registration: the plugin's
  // component is not removed, and it comes back the moment the layer is
  // restored — by the plugin's own `ui.openModal` / `ui.openOverlay`, or by
  // registering the layer again.
  const shown = useMemo(
    () =>
      registrations.filter(
        (registration) => !pluginSlots.isLayerWithdrawn(registration.pluginId, slot),
      ),
    [registrations, slot],
  );

  useEffect(() => {
    if (!shown.length) return;
    // Escape is the host's close affordance for a plugin layer. The key is
    // neither captured nor prevented: the host's own dialogs keep handling it
    // exactly as before, and this only withdraws the layers this host drew.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      for (const registration of shown) {
        pluginSlots.setLayerWithdrawn(registration.pluginId, slot, true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shown, slot]);

  if (!shown.length) return null;

  return portalOverlay(
    <div
      className={blocking ? "overlay pi-plugin-layer is-modal" : "pi-plugin-layer is-overlay"}
      data-pi-plugin-layer={slot}
      role="presentation"
    >
      <PluginSlot
        slot={slot}
        slotProps={slotProps}
        candidates={candidates}
        registrations={shown}
      />
    </div>,
  );
}

/** Both layer positions, mounted once by the app shell beside its own dialog host. */
export function PluginLayerHost() {
  return (
    <>
      <PluginLayer slot="modal" blocking />
      <PluginLayer slot="overlay" blocking={false} />
    </>
  );
}
