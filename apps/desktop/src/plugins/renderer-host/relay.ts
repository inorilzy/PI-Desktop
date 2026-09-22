/**
 * The host relay for renderer slot actions (ADR 0294).
 *
 * A slot component acts through exactly one method, `dispatch(action, payload)`,
 * which the outlet hands it as a prop and which is bound to the plugin the
 * component belongs to. This module is the renderer side of that method: it
 * refuses an action the plugin's manifest never declared, runs a
 * host-performed action through the handler the host registered for it, and
 * refuses a declared action with no handler yet as an explicit
 * `PLUGIN_ACTION_UNROUTED` error — "not implemented yet" must not look like a
 * plugin bug returning `undefined`.
 *
 * The vocabulary is host-owned, so a plugin states intent instead of inventing
 * verbs, and the declaration is what a review reads. This is a contract for
 * plugins that behave, not a security boundary: the module shares the host's
 * realm and can reach the preload bridge directly (ADR 0291 decision 6).
 */
import {
  PLUGIN_RENDERER_ACTIONS,
  type PiRendererDispatch,
  type PluginRendererActionName,
} from "@pi-desktop/plugin-sdk";
import { pluginSlots } from "../renderer-slots/registry";
import { declaredRendererActions } from "./loader";

/**
 * What a host-performed action does. It receives the payload unchanged and the
 * id of the plugin that dispatched — never another plugin's — and its value is
 * what the dispatching `dispatch` promise resolves to. A throw or rejection
 * propagates to the caller rather than resolving to a value nobody chose.
 */
export type RendererHostActionHandler = (payload: unknown, pluginId: string) => unknown;

/** Host-performed implementations. Empty in this release: the seam is the point. */
const hostActions = new Map<PluginRendererActionName, RendererHostActionHandler>();

/**
 * One dispatch per plugin id. The identity is per plugin, not per component or
 * per render: a plugin's components may list `dispatch` in a `useEffect`
 * dependency without thrashing, and two components of one plugin act under the
 * same declaration.
 */
const dispatches = new Map<string, PiRendererDispatch>();

/**
 * Registers the host's implementation of one host-performed action. Returns a
 * remover; removing an action another registration has since replaced leaves
 * the newer handler in place. A name outside `PLUGIN_RENDERER_ACTIONS` is
 * refused here, because a manifest can never declare it and the handler would
 * be silently unreachable.
 */
export function registerHostRendererAction(
  action: PluginRendererActionName,
  handler: RendererHostActionHandler,
): () => void {
  if (!(PLUGIN_RENDERER_ACTIONS as readonly string[]).includes(action)) {
    throw Object.assign(new Error("PLUGIN_ACTION_UNKNOWN"), {
      code: "PLUGIN_ACTION_UNKNOWN",
      action,
    });
  }
  hostActions.set(action, handler);
  return () => {
    if (hostActions.get(action) === handler) hostActions.delete(action);
  };
}

/**
 * The stable `dispatch` prop for one plugin's slot components. The function
 * object is cached, so re-rendering the slot hands the component the same
 * reference; what it enforces is read from the loader on every call, so a
 * reloaded declaration is honoured without rebuilding it.
 */
export function slotDispatchFor(pluginId: string): PiRendererDispatch {
  const cached = dispatches.get(pluginId);
  if (cached) return cached;
  const dispatch: PiRendererDispatch = (action, payload) =>
    dispatchFromPlugin(pluginId, action, payload);
  dispatches.set(pluginId, dispatch);
  return dispatch;
}

/**
 * The method behind a component's `dispatch` prop. `pluginId` is the plugin the
 * component was rendered for, never one the caller chooses, which is what makes
 * the declaration check meaningful.
 */
export async function dispatchFromPlugin(
  pluginId: string,
  action: PluginRendererActionName,
  payload?: unknown,
): Promise<unknown> {
  // Checked before anything else happens: an action the plugin did not declare
  // is refused whether or not the host could have performed it.
  if (!declaredRendererActions(pluginId).has(action)) {
    throw refuseRendererAction(
      pluginId,
      action,
      "PLUGIN_ACTION_UNDECLARED",
      `the plugin did not declare "${action}" in rendererActions`,
    );
  }
  const handler = hostActions.get(action);
  if (!handler) {
    throw refuseRendererAction(
      pluginId,
      action,
      "PLUGIN_ACTION_UNROUTED",
      `the host has no handler for "${action}" yet`,
    );
  }
  return handler(payload, pluginId);
}

/** Every refusal the relay or its handler wiring can leave on a plugin's row. */
export type RendererActionRefusalCode =
  | "PLUGIN_ACTION_UNDECLARED"
  | "PLUGIN_ACTION_UNROUTED"
  | "PLUGIN_ACTION_INVALID_PAYLOAD"
  | "PLUGIN_ACTION_DRAFT_UNCONSUMED"
  // A handler may need something the live UI holds. `ui.openModal` /
  // `ui.closeModal` / `ui.openOverlay` / `ui.closeOverlay` refuse
  // `PLUGIN_ACTION_LAYER_NOT_REGISTERED` when the calling plugin holds no
  // registration for that layer position — a layer's appearance is its
  // registration, so there is nothing for them to open or close.
  | "PLUGIN_ACTION_LAYER_NOT_REGISTERED"
  // `composer.readDraft` refuses `NO_SESSION` when no session is active, and
  // `composer.replaceDraft` refuses `DRAFT_CONFLICT` when the caller's
  // `expectedGeneration` is stale.
  | "NO_SESSION"
  | "DRAFT_CONFLICT";

/**
 * Builds the coded error and records the same refusal as a diagnostic. The
 * error reaches the plugin that dispatched; the diagnostic is what stays
 * visible on the plugin row after the caller has caught it.
 *
 * This is for the refusals the relay itself decides — an undeclared action, an
 * unrouted one, a payload a handler refuses before doing any work. Every failure
 * is reported exactly once: a handler that forwards work reports its own
 * rejection (the `plugin.call` handler does) and the relay adds nothing to it,
 * so a rejected handler must never be routed through here.
 */
export function refuseRendererAction(
  pluginId: string,
  action: PluginRendererActionName,
  code: RendererActionRefusalCode,
  detail: string,
): Error {
  pluginSlots.report({ pluginId, code, detail });
  return Object.assign(new Error(code), { code, pluginId, action, detail });
}

/** Test seam: forget every host handler and every cached dispatch. */
export function resetRendererRelay(): void {
  hostActions.clear();
  dispatches.clear();
}
