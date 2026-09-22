/**
 * The host's own UI kit with `portalOverlay` flattened for a test process that
 * has no DOM.
 *
 * The layer positions' contract is the markup they render *and* that nothing is
 * placed in the overlay root while no plugin fills them. The legacy server
 * renderer refuses portals outright, so this stands in for the one boundary a
 * DOM-less process cannot cross: it records what the host asked to place, and
 * renders it inline. Everything else in `components/ui` is the real module.
 */
export * from "../../src/components/ui";

/** Every node the host asked the overlay root to hold, in order. */
export const portalCalls = [];

export function portalOverlay(node) {
  portalCalls.push(node);
  return node;
}
