/**
 * The `composerControl` slot's mounts (spec 07-plugins/16 §2A.5).
 *
 * Three mounts, one per composer position:
 *
 * - `left` / `right` — the composer's two control rows. The host's own controls
 *   are already in the row when a plugin control is mounted, so plugin controls
 *   follow them and the rows' contract is unchanged (D8).
 * - `beforeSend` — the region immediately left of the send/stop control. The
 *   host hands this position over whole: the three pieces it built for the
 *   region (its model picker, its context display, its prompt-enhancement
 *   control) and the data behind them go to the one registration that claimed
 *   the position, and the same nodes are the outlet's fallback — so a user with
 *   nobody holding the position sees exactly the host's own toolbar, and a
 *   component that crashes gives the region back to it (D10).
 *
 * A registration is asked only for the positions it declared; one that declared
 * none keeps the two rows it has always been asked for.
 */
import { useMemo, type ReactNode } from "react";
import {
  PLUGIN_RENDERER_COMPOSER_DEFAULT_POSITIONS,
  type PiRendererComposerContextUsage,
  type PiRendererComposerControlPosition,
  type PiRendererComposerEnhancement,
  type PiRendererComposerModelSelection,
} from "@pi-desktop/plugin-sdk";
import { useAppStore } from "../../../stores/app-store";
import {
  PluginSlot,
  useSlotRegistrations,
} from "../../../plugins/renderer-slots/SlotOutlet";
import { useRendererCandidates } from "../../../plugins/renderer-slots/use-renderer-candidates";

/**
 * The region's pieces as the host hands them over: the nodes themselves (never
 * copies) and the values they display, so a plugin can draw its own version of
 * any of them. `beforeSend` only.
 */
export type ComposerControlHandoff = {
  modelControl: ReactNode;
  modelSelection: PiRendererComposerModelSelection;
  /** `null` when the host has no measured turn to draw a context display from. */
  contextControl: ReactNode;
  contextUsage: PiRendererComposerContextUsage | null;
  enhanceControl: ReactNode;
  enhancement: PiRendererComposerEnhancement;
};

export function ComposerControlSlot({
  position,
  draft,
  handoff,
  children,
}: {
  position: PiRendererComposerControlPosition;
  /** The draft the composer already holds; no new state is read for the slot. */
  draft: string;
  /** The region's own pieces, handed over at `beforeSend` only. */
  handoff?: ComposerControlHandoff;
  /** The host's own drawing of the region; the outlet's fallback. */
  children?: ReactNode;
}) {
  const candidates = useRendererCandidates();
  const sessionId = useAppStore((s) => s.activeSessionId);
  const registered = useSlotRegistrations("composerControl");
  // A registration that declared no positions keeps exactly the two rows it was
  // always asked for, so a component written before `beforeSend` existed is
  // never handed a region it never asked for.
  const shown = useMemo(
    () =>
      registered.filter((registration) =>
        (registration.positions ?? PLUGIN_RENDERER_COMPOSER_DEFAULT_POSITIONS).includes(
          position,
        ),
      ),
    [registered, position],
  );
  // A draft with no session reports no id at all, rather than an empty one a
  // plugin could mistake for a real session. The handoff keys exist at
  // `beforeSend` and nowhere else: the two rows' contract is unchanged.
  const slotProps = useMemo(
    () => ({
      position,
      draft,
      ...(sessionId ? { sessionId } : {}),
      ...(position === "beforeSend" && handoff
        ? {
            modelControl: handoff.modelControl,
            modelSelection: handoff.modelSelection,
            contextControl: handoff.contextControl,
            contextUsage: handoff.contextUsage,
            enhanceControl: handoff.enhanceControl,
            enhancement: handoff.enhancement,
          }
        : {}),
    }),
    [position, draft, sessionId, handoff],
  );
  return (
    <PluginSlot
      slot="composerControl"
      slotProps={slotProps}
      candidates={candidates}
      registrations={shown}
      containerProps={{ "data-pi-control-position": position }}
    >
      {children ?? null}
    </PluginSlot>
  );
}
