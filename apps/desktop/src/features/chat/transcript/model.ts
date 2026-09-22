import type { ThinkingLevel, UiMessage, UiMessageRole } from "@pi-desktop/shared";
import { THINKING_LEVELS } from "@pi-desktop/shared";
import type { SubagentRun } from "../../../lib/assistant-turns";
import type { PendingPermission } from "../../../lib/pending-permissions";
import { toolResultPayload } from "../../../lib/tool-presentation";
import type {
  PiRendererEntryAction,
  PiRendererEntryExtraProps,
  PiRendererEntryMessage,
  PiRendererEntryProps,
  PiRendererInlineConfirmProps,
  PiRendererToolCardProps,
} from "@pi-desktop/plugin-sdk";
import { pluginToolName } from "@pi-desktop/plugin-sdk";

export function delegateAgentName(
  message: UiMessage,
  delegate?: SubagentRun,
): string {
  if (delegate?.agentName) return delegate.agentName;
  const args = message.toolArgs;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const requested = (args as { agent?: unknown }).agent;
    if (typeof requested === "string") return requested;
  }
  return "";
}

/** Effective model resolved for this delegation, recorded by the Task result. */
export function delegateModelId(message: UiMessage): string {
  const payload = toolResultPayload(message);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }
  const modelId = (payload as { modelId?: unknown }).modelId;
  return typeof modelId === "string" ? modelId.trim() : "";
}

/** Effective thinking level resolved for this delegation, from the Task result.
 * `off` and `omit` deliberately have no visible suffix. */
export function delegateThinkingLevel(message: UiMessage): ThinkingLevel | undefined {
  const payload = toolResultPayload(message);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const value = (payload as { thinkingLevel?: unknown }).thinkingLevel;
  if (
    typeof value !== "string" ||
    value === "off" ||
    !THINKING_LEVELS.includes(value as ThinkingLevel)
  ) {
    return undefined;
  }
  return value as ThinkingLevel;
}

/**
 * Copies a run row's command from its head. The expanded body holds only the
 * output, so this is the one place the command can be taken from (D226).
 */

/**
 * What the host knows about one transcript entry's identity (D14).
 *
 * Every transcript position is handed this: enough to name the row a plugin is
 * attached to, and enough for that plugin to tell whether the entry is its own.
 * It is deliberately not the host's own `UiMessage` record — the replace
 * positions that stand in for a row are handed the row's display data
 * separately (`entrySlotProps` / `toolCardSlotProps`), in the shape the slot
 * contract documents rather than the host's internal one.
 */
export type TranscriptEntryIdentity = {
  id: string;
  /** The entry's own role, before the slot contract narrows it. */
  role: UiMessageRole;
  /**
   * The plugin the host attributes this entry to. It is set only when the host
   * knows the producer, and it exists so a plugin can decide whether an entry
   * is its own; it is never guessed from a tool name or from message text.
   *
   * This is not the cross-session origin (`UiMessage.sessionMessage`, drawn by
   * `SessionMessageOrigin`): that says which session sent a message and
   * carries no plugin identity.
   */
  pluginId?: string;
};

/**
 * The identity `entryExtra` receives for a transcript row.
 *
 * Nothing in the transcript pipeline reports which plugin produced an entry
 * today, so `pluginId` is deliberately left unset rather than inferred; the
 * host fills it only once a producer can report itself (D14).
 */
export function transcriptEntryIdentity(
  message: Pick<UiMessage, "id" | "role">,
): TranscriptEntryIdentity {
  return { id: message.id, role: message.role };
}

/**
 * The slot contract's role set. A tool row is neither user input nor a host
 * notice: the transcript already groups it under the assistant's own turn
 * (`data-row-role="assistant"`), so that is the role it reports.
 */
export function rendererEntryRole(
  role: UiMessageRole,
): PiRendererEntryExtraProps["entry"]["role"] {
  return role === "tool" ? "assistant" : role;
}

/**
 * Props for one `entryExtra` registration. `pluginId` is omitted rather than
 * blanked when the host knows no producer, so a plugin's own
 * `props.entry.pluginId === pi.plugin.id` check can never match an empty id.
 */
export function entryExtraSlotProps(
  entry: TranscriptEntryIdentity,
  sessionId: string,
): PiRendererEntryExtraProps {
  const pluginId = entry.pluginId?.trim();
  return {
    entry: {
      id: entry.id,
      role: rendererEntryRole(entry.role),
      ...(pluginId ? { pluginId } : {}),
    },
    sessionId,
  };
}

/**
 * The message one transcript entry carries, in the shape the `entry` replace
 * position is handed it.
 *
 * The claim a plugin makes on this position is a claim on the row the host
 * would have drawn, so the host hands over what that row was going to display:
 * the text, the attachments, the timestamp, the typed slash form, whether the
 * text is still arriving, and which of the host's own row actions the position
 * stands in for. `actions` is read from the same conditions the host's own
 * action bar uses, so there is one rule for both.
 */
export function transcriptEntryMessage(
  message: Pick<
    UiMessage,
    "content" | "attachments" | "createdAt" | "command" | "status"
  >,
  actions: readonly PiRendererEntryAction[],
): PiRendererEntryMessage {
  return {
    text: String(message.content || ""),
    // The host's own attachment record carries sidecar-only image bytes; the
    // slot contract hands over display fields only.
    attachments: (message.attachments ?? []).map((attachment) => ({
      ref: attachment.ref,
      name: attachment.name,
      kind: attachment.kind,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(typeof attachment.size === "number" ? { size: attachment.size } : {}),
    })),
    streaming: message.status === "streaming",
    ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    ...(message.command ? { command: message.command } : {}),
    actions: [...actions],
  };
}

/**
 * Props for one `entry` registration: the row's identity, the message the
 * host's own row would have drawn for it, and the session it belongs to.
 *
 * `entryExtra` (the additive position) keeps the identity-only shape, which is
 * what makes the two contracts distinguishable from inside a component.
 */
export function entrySlotProps(
  entry: TranscriptEntryIdentity,
  message: PiRendererEntryMessage,
  sessionId: string,
): PiRendererEntryProps {
  return {
    entry: entryExtraSlotProps(entry, sessionId).entry,
    message,
    sessionId,
  };
}

/**
 * Props for one `inlineConfirm` registration: the confirmation the host's own
 * card would have shown while a permission request is pending.
 *
 * The request is copied field by field into the slot's own shape rather than
 * handed over as the host's `PendingPermission` record, so the contract can
 * grow without the host's internal queue shape leaking into it.
 */
export function inlineConfirmSlotProps(
  permission: Pick<
    PendingPermission,
    | "sessionId"
    | "requestId"
    | "toolName"
    | "argsPreview"
    | "risk"
    | "reason"
    | "agentName"
  >,
  queued: number,
): PiRendererInlineConfirmProps {
  const agentName = permission.agentName?.trim();
  return {
    sessionId: permission.sessionId,
    confirm: {
      requestId: permission.requestId,
      toolName: permission.toolName,
      args: permission.argsPreview,
      risk: permission.risk === "low" || permission.risk === "medium" ? permission.risk : "high",
      reason: permission.reason,
      queued: Math.max(0, queued),
      ...(agentName ? { agentName } : {}),
    },
  };
}

/**
 * The plugin a tool row belongs to, or `undefined` when the host cannot say.
 *
 * Plugin tools are exposed under a forced prefix — `plugin_<pluginIdSafe>_<tool>`
 * (D015) — so that prefix *is* the attribution: the host never guesses an owner
 * from a tool name's shape, it asks which candidate plugin's own prefix the row
 * starts with. A host tool and another plugin's tool therefore never match, and
 * two ids that sanitize to the same prefix cancel out rather than one of them
 * silently taking the other's card.
 */
export function toolOwnerPluginId(
  toolName: string | undefined,
  candidates: readonly { id: string }[],
): string | undefined {
  if (!toolName) return undefined;
  let owner: string | undefined;
  for (const candidate of candidates) {
    if (!toolName.startsWith(pluginToolName(candidate.id, ""))) continue;
    if (owner !== undefined) return undefined;
    owner = candidate.id;
  }
  return owner;
}

/**
 * Props for one `toolCard` registration: the tool row whose card body the
 * component draws, the call that body stands in for, and the session it
 * belongs to.
 *
 * This is the one position where the host really knows the producing plugin, so
 * `entry.pluginId` is set from the tool's own namespace (D14): the mount offers
 * a plugin only its own rows, and the component can confirm that with
 * `props.entry.pluginId === pi.plugin.id` before drawing anything.
 *
 * The card body replaces the host's own detail blocks, so the host hands over
 * what those blocks are built from: the tool's name, the call's arguments, its
 * result and status, and the duration the host measured.
 */
export function toolCardSlotProps(
  message: Pick<
    UiMessage,
    "id" | "role" | "toolName" | "toolArgs" | "toolResult" | "toolStatus" | "toolDurationMs"
  >,
  sessionId: string,
  ownerPluginId: string,
): PiRendererToolCardProps {
  return {
    entry: entryExtraSlotProps(
      { ...transcriptEntryIdentity(message), pluginId: ownerPluginId },
      sessionId,
    ).entry,
    tool: {
      name: message.toolName ?? "",
      args: message.toolArgs,
      ...("toolResult" in message ? { result: message.toolResult } : {}),
      ...(message.toolStatus ? { status: message.toolStatus } : {}),
      ...(typeof message.toolDurationMs === "number"
        ? { durationMs: message.toolDurationMs }
        : {}),
    },
    sessionId,
  };
}
