/**
 * Renderer half of the slots demo (ADR 0291, spec 07-plugins/16 §2A).
 *
 * The host fetches this file from
 * `plugin-renderer://acme.slots-demo/renderer/index.mjs` and evaluates it inside
 * the app's own window, lazily: the first time one of its slots actually
 * renders. It is a plain ES module with no build step — the host serves `mjs`
 * from the plugin package and needs no bundler to read it.
 *
 * A slot component is handed exactly two things: the slot's host data as props,
 * and `dispatch(action, payload)` — the plugin's one way to ask the host to do
 * something (ADR 0294). `dispatch` acts for `acme.slots-demo`, and it accepts
 * only the actions this manifest lists in `rendererActions`: an action the
 * plugin did not declare is refused with a structured error
 * (`PLUGIN_ACTION_UNDECLARED`) instead of being silently ignored.
 *
 * The two actions it declares are the two classes the host relays: `ui.toast`
 * is performed by the host itself, and `plugin.call` is forwarded to this
 * plugin's own headless entry (`main.js`), which answers. The badge's second
 * button is that round trip, and the value it shows came out of the plugin's
 * own process — the window could not have produced it.
 *
 * `react` is a bare specifier on purpose. The host installs an import map that
 * points `react`, `react-dom`, and `react-dom/client` at its own copies, and
 * every plugin shares that one instance. A plugin that ships its own React is
 * refused at load, because two copies break hooks and context.
 */
import { createElement, useState } from "react";

const PLUGIN_ID = "acme.slots-demo";

/**
 * Injected through `pi.ui.injectStyle`. The host auto-scopes every selector
 * under `data-pi-plugin="acme.slots-demo"` before the sheet is served, so
 * these class names stay inside this plugin's containers.
 *
 * Public design tokens are the host-owned `--pi-slot-*` aliases on
 * `.pi-plugin-slot`. Host-internal `--ds-*` names are not part of the plugin
 * contract. `currentColor` / inherit remain valid fallbacks when a token is
 * unavailable. Buttons and chips reuse the host's slot primitives
 * (`.pi-slot-btn`, `.pi-slot-chip`) where they fit.
 */
const STYLES = `
.acme-slots-demo__badge {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  margin-top: 0.25rem;
  color: var(--pi-slot-text-muted, inherit);
  font-size: var(--pi-slot-text-xs, 0.75rem);
  line-height: 1.6;
}

.acme-slots-demo__card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-width: 24rem;
  padding: 1rem;
  border: 1px solid var(--pi-slot-border, currentColor);
  border-radius: var(--pi-slot-radius-md, 0.75rem);
  background: var(--pi-slot-bg-elevated, transparent);
  color: var(--pi-slot-text, inherit);
  font-family: var(--pi-slot-font, inherit);
  font-size: var(--pi-slot-text-sm, 0.875rem);
  line-height: 1.5;
}

.acme-slots-demo__button {
  /* Prefer the host primitive; the custom rules keep a fallback if tokens are missing. */
  align-self: flex-start;
  padding: 0.25rem 0.75rem;
  border: 1px solid var(--pi-slot-border, currentColor);
  border-radius: var(--pi-slot-radius-sm, 0.5rem);
  background: var(--pi-slot-bg-elevated, none);
  color: var(--pi-slot-text, inherit);
  font: inherit;
  cursor: pointer;
}

/*
 * The entry's answer is printed verbatim, so it can be long: it stays inside
 * the badge instead of stretching the row.
 */
.acme-slots-demo__call-result {
  max-width: 24rem;
  overflow-wrap: anywhere;
  color: var(--pi-slot-text-muted, inherit);
  opacity: 0.9;
}
`;

/**
 * `entryExtra`: one extra block below a transcript entry.
 *
 * Everything this component gets arrives as a prop. The slot's data comes in as
 * `entry` — the `{ id, role }` of the row the badge sits under — and the
 * plugin's one way out to the host comes in as `dispatch(action, payload)`
 * (ADR 0294). Nothing is ambient and nothing is guaranteed: the host may mount
 * a slot before the data a plugin declared is ready, so this reads `entry?.id`
 * and falls back, the way any React component tolerates a missing prop.
 */
function EntryExtraBadge({ entry, dispatch }) {
  const [status, setStatus] = useState(null);
  const [forwarded, setForwarded] = useState(null);

  /**
   * `ui.toast` is one of the actions this manifest declares in
   * `rendererActions`, so the host runs it and answers. A dispatch is a promise:
   * it resolves once the host is done, and it rejects with a structured error
   * when the action is not declared (`error.code` is `PLUGIN_ACTION_UNDECLARED`)
   * — a refusal, never a silent no-op. The rejection is shown right here,
   * because swallowing it would make that refusal look like a broken button.
   */
  const notifyHost = () => {
    setStatus("asking...");
    dispatch("ui.toast", {
      message: `${PLUGIN_ID} · entry ${entry?.id ?? "unknown"}`,
    })
      .then(() => setStatus("toast sent"))
      .catch((error) => setStatus(error?.code ?? String(error)));
  };

  /**
   * `plugin.call` is the other class of action: the host forwards
   * `{ method, args }` to this plugin's own headless entry — the same child
   * channel a panel call uses — and this promise resolves with whatever that
   * entry returned. `demo.echo` answers with the arguments it was handed plus a
   * counter that lives in that process, so what the button shows is a value the
   * window could not have produced by itself.
   *
   * Every refusal arrives the same way, as `error.code`: an action the manifest
   * does not declare (`PLUGIN_ACTION_UNDECLARED`), a plugin with no headless
   * entry (`PLUGIN_CALL_NO_ENTRY`), an entry that implements no renderer methods
   * (`PLUGIN_CALL_NO_HANDLER`), or a call that never answered
   * (`PLUGIN_CALL_TIMEOUT`). Showing that code instead of a tick is what makes
   * this example honest about which half ran.
   */
  const askHeadless = () => {
    setForwarded("asking...");
    dispatch("plugin.call", { method: "demo.echo", args: { from: "badge" } })
      .then((answer) =>
        setForwarded(
          `entry ${answer?.entry} answered call #${answer?.calls}: ${JSON.stringify(answer)}`,
        ),
      )
      .catch((error) => setForwarded(error?.code ?? String(error)));
  };

  return createElement("span", { className: "acme-slots-demo__badge pi-slot-chip" }, [
    `${PLUGIN_ID} · renderer slot`,
    createElement(
      "button",
      {
        key: "notify",
        type: "button",
        className: "acme-slots-demo__button pi-slot-btn",
        onClick: notifyHost,
      },
      "Notify the host",
    ),
    createElement(
      "button",
      {
        key: "headless",
        type: "button",
        className: "acme-slots-demo__button pi-slot-btn acme-slots-demo__call",
        onClick: askHeadless,
      },
      "Ask the entry",
    ),
    status ? createElement("span", { key: "status" }, status) : null,
    forwarded
      ? createElement(
          "span",
          { key: "forwarded", className: "acme-slots-demo__call-result" },
          forwarded,
        )
      : null,
  ]);
}

/**
 * `modal`: a blocking, app-level dialog. The counter is the point of the
 * example — `useState` comes from the host's React, so a hook used here behaves
 * exactly as it does in host UI, and nothing is duplicated to make that work.
 *
 * Registration *is* the layer (spec 07-plugins/16 2A.5): the host mounts this
 * position as soon as the plugin registers it, which is why the card carries a
 * close button that withdraws that registration. Escape is still the host's own
 * dismissal, and it leaves the registration — and so this card's own state —
 * alone.
 */
function SlotsDemoModal({ onClose }) {
  const [renders, setRenders] = useState(0);

  return createElement("div", { className: "acme-slots-demo__card" }, [
    createElement(
      "p",
      { key: "title" },
      `${PLUGIN_ID} is running inside the host renderer`,
    ),
    createElement(
      "p",
      { key: "state" },
      `Re-renders through the host's React: ${renders}.`,
    ),
    createElement(
      "button",
      {
        key: "button",
        type: "button",
        className: "acme-slots-demo__button pi-slot-btn",
        onClick: () => setRenders((value) => value + 1),
      },
      "Re-render",
    ),
    createElement(
      "button",
      {
        key: "close",
        type: "button",
        className: "acme-slots-demo__button pi-slot-btn acme-slots-demo__close",
        "data-slots-demo-close": "modal",
        onClick: onClose,
      },
      "Close the modal",
    ),
  ]);
}

/**
 * Required by the host. There is no `onUnload` here on purpose: the host removes
 * every registration and the injected sheet when the plugin is unloaded,
 * disabled, or uninstalled, so a plugin that only registers slots has nothing
 * to clean up (D10).
 *
 * The modal's card closes by removing the handle this registration returned, so
 * a plugin that registers a layer at load still gives the user a way out that
 * is not the host's Escape key.
 */
export function onLoad(pi) {
  pi.ui.injectStyle(STYLES);
  pi.slots.register("entryExtra", EntryExtraBadge);
  const modal = pi.slots.register("modal", (props) =>
    createElement(SlotsDemoModal, { ...props, onClose: () => modal.remove() }),
  );
}
