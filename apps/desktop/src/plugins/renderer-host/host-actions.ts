/**
 * The host's implementations of the renderer actions this release performs
 * (ADR 0294). The relay (`./relay`) owns the declaration check and the routing;
 * this module is what it routes to, and it is installed once at app start from
 * `src/main.tsx` next to the other renderer-side installs.
 *
 * Eight of the ten vocabulary names are implemented here:
 *
 * - `plugin.call { method, args? }` forwards to the plugin's own headless entry
 *   through `api.pluginRendererCall`, which re-checks the manifest in the main
 *   process and relays to that plugin's process.
 * - `ui.toast { message, variant? }` raises the shell's existing toast.
 * - `composer.readDraft {}` answers a snapshot of the active session's draft.
 * - `composer.replaceDraft { text, expectedGeneration?, fileReferences? }`
 *   writes the draft through the one external path a mounted composer consumes,
 *   and answers with the previous snapshot and the new generation.
 * - `ui.openModal` / `ui.closeModal` / `ui.openOverlay` / `ui.closeOverlay`
 *   withdraw or restore the calling plugin's own layer position. A layer's
 *   appearance is its registration, so these four act on the layer the plugin
 *   already registered; a call with no such registration is a coded refusal.
 *
 * The remaining two (`composer.insertText`, `composer.attachPath`) have no
 * handler, so the relay refuses them as `PLUGIN_ACTION_UNROUTED` instead of
 * resolving `undefined`.
 *
 * Every failure is a coded error and exactly one diagnostic on the plugin's
 * row. A payload refused here is reported here; a rejection that came back from
 * the main process or from the plugin's own entry is reported here too, and
 * rethrown unchanged — the relay must not report a handler rejection, so no
 * failure lands on the row twice. It is a contract for plugins that behave, not
 * a security boundary.
 */
import { api } from "../../lib/api";
import type { ComposerDraftFileReference } from "../../lib/composer-smart-stop";
import { useAppStore } from "../../stores/app-store";
import { pluginSlots, type PluginLayerSlot, type PluginSlotDiagnostic } from "../renderer-slots/registry";
import {
  refuseRendererAction,
  registerHostRendererAction,
  type RendererHostActionHandler,
} from "./relay";

/**
 * How long a `composer.replaceDraft` write waits for a mounted composer to
 * consume it. A composer consumes the prefill on its next commit, so this is
 * only ever spent when there is no composer — a frame is not a deadline.
 */
export const DRAFT_PREFILL_DEADLINE_MS = 500;

const TOAST_VARIANTS = ["info", "success", "error"] as const;
type ToastVariant = (typeof TOAST_VARIANTS)[number];

function isToastVariant(value: unknown): value is ToastVariant {
  return typeof value === "string" && (TOAST_VARIANTS as readonly string[]).includes(value);
}

/** Payloads are plugin input: an object, or nothing this host can read. */
function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

/**
 * `plugin.call`: runs `method` inside the calling plugin's own entry and answers
 * with its value. A missing method is refused here, before anything crosses IPC.
 *
 * A rejection that comes back from `api.pluginRendererCall` was produced by the
 * main process or by the plugin's own headless entry, and this is where it
 * becomes visible: the same refusal is recorded once on the plugin's row, and
 * the error is rethrown unchanged so the component still reads its code and
 * message. Reporting it here rather than in the wrapper keeps the generic
 * preload module free of plugin-row concerns.
 */
async function forwardRendererCall(payload: unknown, pluginId: string): Promise<unknown> {
  const record = payloadRecord(payload);
  const method = record?.method;
  if (typeof method !== "string" || !method.trim()) {
    throw refuseRendererAction(
      pluginId,
      "plugin.call",
      "PLUGIN_ACTION_INVALID_PAYLOAD",
      'plugin.call needs a non-empty "method" string',
    );
  }
  try {
    return await api.pluginRendererCall(pluginId, method, record?.args);
  } catch (error) {
    reportForwardedCallFailure(pluginId, method, error);
    throw error;
  }
}

/**
 * One forwarded call's failure on the plugin's row, under exactly the code the
 * caller has to branch on: a refusal from the main process (`PLUGIN_CALL_*`), a
 * code the plugin's own entry threw with, or the blanket class when it named
 * none. The detail names the method that failed, because a row that only says
 * "a call was refused" is not something a plugin author can act on.
 */
function reportForwardedCallFailure(pluginId: string, method: string, error: unknown): void {
  const raw = (error as { code?: unknown } | null)?.code;
  const code = typeof raw === "string" && raw ? raw : "PLUGIN_CALL_FAILED";
  pluginSlots.report({
    pluginId,
    code: code as PluginSlotDiagnostic["code"],
    detail: `${method}: ${error instanceof Error ? error.message : String(error)}`,
  });
}

/** `ui.toast`: the shell's existing toast, with the store's own default variant. */
async function showHostToast(payload: unknown, pluginId: string): Promise<void> {
  const record = payloadRecord(payload);
  const message = record?.message;
  if (typeof message !== "string" || !message.trim()) {
    throw refuseRendererAction(
      pluginId,
      "ui.toast",
      "PLUGIN_ACTION_INVALID_PAYLOAD",
      'ui.toast needs a non-empty "message" string',
    );
  }
  const variant = record?.variant;
  if (variant !== undefined && !isToastVariant(variant)) {
    throw refuseRendererAction(
      pluginId,
      "ui.toast",
      "PLUGIN_ACTION_INVALID_PAYLOAD",
      `ui.toast "variant" must be one of ${TOAST_VARIANTS.join(", ")}`,
    );
  }
  useAppStore.getState().showToast(message, variant === undefined ? undefined : { variant });
}

/**
 * `ui.openModal` / `ui.closeModal` / `ui.openOverlay` / `ui.closeOverlay`:
 * withdraws or restores the calling plugin's own layer position.
 *
 * A layer's appearance *is* its registration (`PluginLayerHost`), so none of
 * these can create one: `open` restores the layer this plugin already
 * registered, `close` withdraws it, and the plugin's own component stays
 * registered either way. The payload is ignored — what a layer shows is the
 * component the plugin registered, and the host has nothing else to put in it.
 *
 * The plugin id comes from the dispatch, never from the payload, so a plugin
 * can only ever reach its own layer. A call with no registration of its own
 * behind it is refused with `PLUGIN_ACTION_LAYER_NOT_REGISTERED` rather than
 * quietly doing nothing: the relay's contract is that a plugin learns why
 * nothing happened. Asking for the state a layer already has is a success.
 */
function setLayerWithdrawnForCaller(
  action: "ui.openModal" | "ui.closeModal" | "ui.openOverlay" | "ui.closeOverlay",
  slot: PluginLayerSlot,
  withdrawn: boolean,
): RendererHostActionHandler {
  return (_payload, pluginId) => {
    if (!pluginSlots.setLayerWithdrawn(pluginId, slot, withdrawn)) {
      throw refuseRendererAction(
        pluginId,
        action,
        "PLUGIN_ACTION_LAYER_NOT_REGISTERED",
        `${action} found no "${slot}" layer registered by this plugin`,
      );
    }
    return { ok: true, slot, visible: !withdrawn };
  };
}

/** Draft snapshot for renderer plugins (data transfer only — not AI). */
export type ComposerDraftSnapshot = {
  sessionId: string;
  generation: number;
  text: string;
  fileReferences: ComposerDraftFileReference[];
};

type ReplaceDraftOk = {
  ok: true;
  generation: number;
  previous: ComposerDraftSnapshot;
};

/** Per-session draft generation + last known text for undo/conflict (module-local). */
const draftMemory = new Map<
  string,
  { generation: number; text: string; fileReferences: ComposerDraftSnapshot["fileReferences"] }
>();

/**
 * `composer.readDraft`: snapshot of the active session draft for the calling
 * plugin. Data-transfer only; business logic stays in the plugin process.
 */
async function readComposerDraft(_payload: unknown, pluginId: string): Promise<ComposerDraftSnapshot> {
  const state = useAppStore.getState();
  const sessionId = state.activeSessionId;
  if (!sessionId) {
    throw refuseRendererAction(
      pluginId,
      "composer.readDraft",
      "NO_SESSION",
      "composer.readDraft found no active session",
    );
  }
  const mem = draftMemory.get(sessionId);
  const prefill = state.composerPrefill?.sessionId === sessionId ? state.composerPrefill : null;
  return {
    sessionId,
    generation: mem?.generation ?? 0,
    text: mem?.text ?? prefill?.text ?? "",
    fileReferences: mem?.fileReferences ?? prefill?.fileReferences ?? [],
  };
}

/**
 * `composer.replaceDraft`: replaces the active session's draft text.
 *
 * Returns the previous snapshot plus the new generation so the plugin can
 * implement undo itself (host does not own enhance/undo business UI).
 * `expectedGeneration` is an optimistic lock: mismatch → DRAFT_CONFLICT.
 * `fileReferences: "preserve"` keeps existing refs; `[]` clears them.
 */
async function replaceComposerDraft(
  payload: unknown,
  pluginId: string,
): Promise<ReplaceDraftOk> {
  const record = payloadRecord(payload);
  const text = record?.text;
  if (typeof text !== "string") {
    throw refuseRendererAction(
      pluginId,
      "composer.replaceDraft",
      "PLUGIN_ACTION_INVALID_PAYLOAD",
      'composer.replaceDraft needs a "text" string',
    );
  }
  const sessionId = useAppStore.getState().activeSessionId;
  if (!sessionId) {
    throw refuseRendererAction(
      pluginId,
      "composer.replaceDraft",
      "PLUGIN_ACTION_DRAFT_UNCONSUMED",
      "composer.replaceDraft found no active session to write into",
    );
  }
  const mem = draftMemory.get(sessionId);
  const generation = mem?.generation ?? 0;
  const previous: ComposerDraftSnapshot = {
    sessionId,
    generation,
    text: mem?.text ?? "",
    fileReferences: mem?.fileReferences ?? [],
  };
  const expected = record?.expectedGeneration;
  if (expected !== undefined && Number(expected) !== generation) {
    throw refuseRendererAction(
      pluginId,
      "composer.replaceDraft",
      "DRAFT_CONFLICT",
      "composer.replaceDraft expectedGeneration does not match the live draft",
    );
  }
  const refsInput = record?.fileReferences;
  // The snapshot carries the composer's own chip entries (`path` + `name`), so
  // a plugin can hand an earlier snapshot straight back and keep its chips.
  const fileReferences: ComposerDraftFileReference[] =
    refsInput === "preserve"
      ? [...previous.fileReferences]
      : Array.isArray(refsInput)
        ? refsInput.filter(
            (item): item is ComposerDraftFileReference =>
              Boolean(
                item &&
                  typeof item === "object" &&
                  typeof (item as { path?: unknown }).path === "string" &&
                  typeof (item as { name?: unknown }).name === "string",
              ),
          )
        : [];
  const nextGeneration = generation + 1;
  draftMemory.set(sessionId, { generation: nextGeneration, text, fileReferences });
  useAppStore.setState({ composerPrefill: { sessionId, text, fileReferences } });
  if (await prefillConsumed(DRAFT_PREFILL_DEADLINE_MS)) {
    return { ok: true, generation: nextGeneration, previous };
  }
  useAppStore.getState().clearComposerPrefill();
  throw refuseRendererAction(
    pluginId,
    "composer.replaceDraft",
    "PLUGIN_ACTION_DRAFT_UNCONSUMED",
    `composer.replaceDraft was not consumed within ${DRAFT_PREFILL_DEADLINE_MS} ms`,
  );
}

/** True once the store's prefill is gone, which is how the composer consumes it. */
function prefillConsumed(deadlineMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (consumed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(consumed);
    };
    unsubscribe = useAppStore.subscribe(() => {
      if (useAppStore.getState().composerPrefill === null) finish(true);
    });
    if (useAppStore.getState().composerPrefill === null) finish(true);
    else timer = setTimeout(() => finish(false), deadlineMs);
  });
}

/**
 * Registers the eight implemented actions (`plugin.call`, `ui.toast`,
 * `composer.readDraft`, `composer.replaceDraft`, and the four layer actions).
 * Called once from the app entry; calling it again registers the same
 * functions, so the relay is never left half wired.
 */
export function installRendererHostActions(): void {
  registerHostRendererAction("plugin.call", forwardRendererCall);
  registerHostRendererAction("ui.toast", showHostToast);
  registerHostRendererAction("composer.readDraft", readComposerDraft);
  registerHostRendererAction("composer.replaceDraft", replaceComposerDraft);
  registerHostRendererAction(
    "ui.openModal",
    setLayerWithdrawnForCaller("ui.openModal", "modal", false),
  );
  registerHostRendererAction(
    "ui.closeModal",
    setLayerWithdrawnForCaller("ui.closeModal", "modal", true),
  );
  registerHostRendererAction(
    "ui.openOverlay",
    setLayerWithdrawnForCaller("ui.openOverlay", "overlay", false),
  );
  registerHostRendererAction(
    "ui.closeOverlay",
    setLayerWithdrawnForCaller("ui.closeOverlay", "overlay", true),
  );
}
