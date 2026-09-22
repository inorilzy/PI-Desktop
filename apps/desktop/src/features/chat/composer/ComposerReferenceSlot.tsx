/**
 * The `composerReference` position: a plugin's chip beside the composer's own
 * reference chips.
 *
 * The host paints its chips inside the contenteditable (the editor module owns
 * that DOM), so this mount sits in the same input surface directly after the
 * editor: a plugin chip follows every host chip, and no host chip is moved,
 * rewritten, or removed (D8). The plugin is handed the host's chips as data —
 * path, name, and kind, never the sentinel token a chip is painted from — plus
 * the draft, and contributes itself. Nothing is rendered for a user who has no
 * such plugin, so the input surface is unchanged.
 */
import { useMemo } from "react";
import type { PiRendererComposerReference } from "@pi-desktop/plugin-sdk";
import { useAppStore } from "../../../stores/app-store";
import { PluginSlot } from "../../../plugins/renderer-slots/SlotOutlet";
import { useRendererCandidates } from "../../../plugins/renderer-slots/use-renderer-candidates";
import type { ComposerFileReference } from "./model";

export function ComposerReferenceSlot({
  fileReferences,
  draft,
}: {
  /** The draft's live reference chips, as the editor holds them. */
  fileReferences: readonly ComposerFileReference[];
  /** The draft text the composer already holds. */
  draft: string;
}) {
  const candidates = useRendererCandidates();
  const sessionId = useAppStore((s) => s.activeSessionId);
  const slotProps = useMemo(() => {
    const references: PiRendererComposerReference[] = fileReferences.map(
      (reference) => ({
        path: reference.path,
        name: reference.name,
        kind: reference.kind,
      }),
    );
    return { references, draft, ...(sessionId ? { sessionId } : {}) };
  }, [draft, fileReferences, sessionId]);
  return (
    <PluginSlot
      slot="composerReference"
      slotProps={slotProps}
      candidates={candidates}
      containerProps={{ "data-pi-reference-count": fileReferences.length }}
    />
  );
}
