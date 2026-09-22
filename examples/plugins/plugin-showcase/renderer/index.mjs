/**
 * Renderer half of the plugin showcase (ADR 0291, ADR 0294, spec
 * 07-plugins/16 §2A).
 *
 * The host fetches this file from
 * `plugin-renderer://acme.plugin-showcase/renderer/index.mjs` and evaluates it
 * inside the app's own window, lazily: the first time one of its slots actually
 * renders. It is a plain ES module with no build step.
 *
 * A slot component is handed exactly two things: the slot's host data as props,
 * and `dispatch(action, payload)` — the plugin's one way to ask the host to do
 * something (ADR 0294 decision 1). `dispatch` acts for `acme.plugin-showcase`
 * and accepts only the actions this manifest lists in `rendererActions`; an
 * action the plugin did not declare is refused with a structured error
 * (`PLUGIN_ACTION_UNDECLARED`) instead of being silently ignored.
 *
 * This example registers a component for every one of the ten declared slots:
 *
 *   `entry`            — the whole-message position. A registration replaces
 *     the row the host draws, so the host hands the component the message that
 *     row was going to display (`text`, `attachments`, `createdAt`, the typed
 *     slash form, `streaming`, and the host `actions` the position covers) and
 *     this component re-draws that message in its own form with its own
 *     controls beside it. That is the rule for every replace position here:
 *     the position comes with its data, and this example always re-renders it.
 *   `entryExtra`       — a block appended below a transcript entry. An additive
 *     position: it is handed the entry's identity only and adds to the row.
 *   `codeBlock`        — a component that owns one fenced language, namespaced
 *     with this plugin's id so it cannot shadow `json`, `ts` or `mermaid`.
 *   `toolCard`         — the card body of this plugin's own tool. The host
 *     offers this position only to the tool row's owner (the forced
 *     `plugin_<id>_<tool>` prefix), which is why this plugin contributes
 *     `showcase_note` from its headless half. The card re-draws the call it
 *     stands in for — its name, arguments and result — beside its own controls.
 *   `composerControl`  — one registration, asked for all three composer
 *     positions (the two control rows and the region immediately left of Send);
 *     it decides for itself what it draws in each (`position`), opens the layer
 *     positions, and drives the draft through the declared
 *     `composer.readDraft` / `composer.replaceDraft` actions (including one
 *     deliberate `DRAFT_CONFLICT` and one unrouted `composer.insertText`). At
 *     `beforeSend` the host hands the region over whole — its own model picker,
 *     context display, and prompt-enhancement control as nodes, plus the data
 *     behind them — and this module keeps all three pieces while reordering
 *     them and adding its own buttons beside them.
 *   `completionSource` — rows inside the completion popover, below the host's.
 *   `composerReference`— the plugin's own chip beside the composer's chips.
 *   `inlineConfirm`, `modal`, `overlay` — the three layer positions. They are
 *     not registered at load: a modal registered at load would block the window
 *     the moment the module is evaluated, and an inline-confirm registration
 *     replaces the host's permission card, so both are opened from this
 *     plugin's own composer controls and closed by removing the registration.
 *     That is the position's whole lifecycle: registration is appearance,
 *     removal is disappearance (spec 07-plugins/16 2A.5, D10). The inline card
 *     re-draws the pending permission request the host's own card would have
 *     shown; approving or denying stays host-owned.
 *
 * Nothing here touches `window` or `document`: the props are the whole input
 * and `dispatch` is the whole output (ADR 0294 decision 1). The module shares
 * the host's realm, so that is a contract, not a wall.
 *
 * The module also *reports* what it holds to the plugin's own process. Its only
 * channel is the same `dispatch` a component is handed, so the reports travel as
 * the forwarded action `plugin.call { method: "renderer.report" | "renderer.slot" }`
 * — a call this manifest declares in `rendererActions`. That is what makes the
 * plugin's sidebar console (`views/console.html`) show live slot state instead of
 * a copy of the manifest, and it never runs outside a mounted component: the
 * dispatcher only exists there.
 *
 * `react` is a bare specifier on purpose. The host installs an import map that
 * points `react`, `react-dom`, and `react-dom/client` at its own copies, and
 * every plugin shares that one instance. A plugin that ships its own React is
 * refused at load, because two copies break hooks and context.
 */
import { createElement, useEffect, useState } from "react";

const PLUGIN_ID = "acme.plugin-showcase";

/**
 * The one fenced language this plugin claims. A `codeBlock` language is the
 * slot's identity — one language has exactly one renderer — and it has to be
 * namespaced with the registering plugin's own id, which is what
 * `acme.plugin-showcase:kv` is.
 */
const CODE_LANGUAGE = `${PLUGIN_ID}:kv`;


/* -------------------------------------------------------------------------
 * Live state this module keeps about itself
 *
 * A plugin component cannot read the host's registry, and the console page in
 * the work panel cannot read this realm at all. So the two facts a self-check
 * console needs — which slots are held right now, and how many times the
 * registered functions were really called — are counted here, where both are
 * observable, and reported to the plugin process through `dispatch`.
 * ---------------------------------------------------------------------- */

/** Slots this module currently holds; registration is the whole lifecycle. */
const heldSlots = new Set();

/**
 * Calls this module made to its own registered functions, per function name.
 *
 * `served` is what this module counted. `overBudget` is a *self-measured*
 * count of calls that took longer than the host's one-frame budget — the host's
 * own discard and breaker counters live in the app window
 * (`renderer-host/host-functions.ts`) and are not readable from any plugin
 * realm, which is why the console labels that number as the plugin's own.
 */
const functionCalls = {
  "entry-facts": { served: 0, overBudget: 0 },
  "kv-rows": { served: 0, overBudget: 0 },
};

/** The host's published budget for one host-callable function. */
const FRAME_BUDGET_MS = 16;

function nowMs() {
  return typeof performance?.now === "function" ? performance.now() : Date.now();
}

/**
 * slot -> registration for every position this module holds outside the
 * on-demand layers. Held here so a replace-slot card can hand its own position
 * back to the host: this module registers `entry` and `toolCard` once, at load,
 * and without the handle a card could only *say* it was standing in for the
 * host's row.
 */
const heldRegistrations = new Map();

/** Registers one slot and remembers that this module holds it. */
function registerSlot(slot, component, options) {
  const handle = hostApi.slots.register(slot, component, options);
  heldSlots.add(slot);
  const registration = {
    remove: () => {
      heldSlots.delete(slot);
      heldRegistrations.delete(slot);
      handle.remove();
    },
  };
  heldRegistrations.set(slot, registration);
  return registration;
}

/**
 * Withdraw one position this module holds. Registration is appearance and
 * removal is disappearance (D10), so this is the only way a card can give a
 * position back; the host then draws its own rendering again. A layer's
 * registration is tracked by `openLayers` as well, so both stores are cleared.
 */
function releaseSlot(slot) {
  const registration = openLayers.get(slot) ?? heldRegistrations.get(slot);
  if (!registration) return false;
  openLayers.delete(slot);
  registration.remove();
  for (const listener of [...layerListeners]) listener();
  return true;
}

/** Every function count, plus their totals. */
function functionTotals() {
  const totals = { served: 0, overBudget: 0, by: {} };
  for (const [name, counts] of Object.entries(functionCalls)) {
    totals.served += counts.served;
    totals.overBudget += counts.overBudget;
    totals.by[name] = { ...counts };
  }
  return totals;
}

/** What this module holds right now, in the shape the plugin process stores. */
function selfReport() {
  return { slots: [...heldSlots], functions: functionTotals() };
}

/**
 * One report to the plugin's own process, through the only channel a component
 * has: `dispatch`. An answer is a structured receipt; a refusal is returned
 * rather than thrown so a caller can print its code.
 */
function reportToProcess(dispatch, method, args) {
  if (typeof dispatch !== "function") {
    return Promise.resolve({
      ok: false,
      code: "NO_DISPATCH",
      detail: "this mount was handed no dispatch",
    });
  }
  return dispatch("plugin.call", { method, args })
    .then((answer) =>
      answer && typeof answer === "object"
        ? answer
        : { ok: true, code: "ok", detail: "reported" },
    )
    .catch((error) => ({
      ok: false,
      code: error?.code ?? "PLUGIN_CALL_FAILED",
      detail: error?.message ?? String(error),
    }));
}
/**
 * The layer positions this plugin opens on demand instead of at load. The two
 * app-level layers and the inline-confirm card are the only positions where a
 * registration at load would change the window before the user asked for
 * anything, so they are opened by a control and closed by their own button.
 */
const LAYER_SLOTS = ["inlineConfirm", "modal", "overlay"];

/**
 * Injected through `pi.ui.injectStyle`. The host auto-scopes every selector
 * under this plugin's `data-pi-plugin` container. Public design tokens are the
 * host-owned `--pi-slot-*` aliases; host-internal `--ds-*` names are not a
 * plugin contract. Layer surfaces use `--pi-slot-bg-elevated` /
 * `--pi-slot-text` (Canvas fallbacks) so they stay opaque over the window.
 */
const STYLES = `
.acme-plugin-showcase__badge {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
  margin-top: 0.25rem;
  color: var(--pi-slot-text-muted, inherit);
  font-size: var(--pi-slot-text-xs, 0.75rem);
  line-height: 1.6;
  opacity: 0.85;
}

.acme-plugin-showcase__muted {
  color: var(--pi-slot-text-muted, inherit);
  opacity: 0.75;
}

.acme-plugin-showcase__button {
  padding: 0.125rem 0.625rem;
  border: 1px solid var(--pi-slot-border, currentColor);
  border-radius: var(--pi-slot-radius-sm, 0.5rem);
  background: var(--pi-slot-bg-elevated, none);
  color: var(--pi-slot-text, inherit);
  font: inherit;
  cursor: pointer;
}

.acme-plugin-showcase__action {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: var(--pi-slot-text-xs, 0.75rem);
}

.acme-plugin-showcase__card {
  display: block;
  margin: 0.25rem 0;
  padding: 0.5rem 0.625rem;
  border: 1px dashed var(--pi-slot-border, currentColor);
  border-radius: var(--pi-slot-radius-sm, 0.5rem);
  color: var(--pi-slot-text, inherit);
  font-family: var(--pi-slot-font, inherit);
  font-size: var(--pi-slot-text-sm, 0.8125rem);
  line-height: 1.6;
}

.acme-plugin-showcase__card-title {
  display: block;
  color: var(--pi-slot-text, inherit);
  font-weight: 600;
}

.acme-plugin-showcase__line {
  display: block;
}

.acme-plugin-showcase__layer-card {
  display: block;
  max-width: min(24rem, 90vw);
  padding: 0.75rem 0.875rem;
  border: 1px solid var(--pi-slot-border, currentColor);
  border-radius: var(--pi-slot-radius-md, 0.75rem);
  background: var(--pi-slot-bg-elevated, Canvas);
  color: var(--pi-slot-text, CanvasText);
  box-shadow: var(--pi-slot-shadow, 0 12px 32px rgba(0, 0, 0, 0.35));
  font-family: var(--pi-slot-font, inherit);
  font-size: var(--pi-slot-text-sm, 0.8125rem);
  line-height: 1.6;
}

.acme-plugin-showcase__layer-card.is-overlay {
  margin: 0.75rem;
  max-width: 19rem;
}

.acme-plugin-showcase__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
  font-size: var(--pi-slot-text-xs, 0.75rem);
}

.acme-plugin-showcase__chip {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  max-width: 100%;
  color: var(--pi-slot-text-muted, inherit);
  font-size: var(--pi-slot-text-xs, 0.75rem);
  line-height: 1.6;
}

.acme-plugin-showcase__completion {
  display: block;
  color: var(--pi-slot-text-muted, inherit);
  font-size: var(--pi-slot-text-xs, 0.75rem);
  line-height: 1.7;
}

.acme-plugin-showcase__kv {
  display: block;
  font-size: 0.8125rem;
  line-height: 1.7;
}

.acme-plugin-showcase__kv-head {
  display: block;
  opacity: 0.7;
}

.acme-plugin-showcase__kv-row {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
}

.acme-plugin-showcase__kv-key {
  min-width: 8rem;
  opacity: 0.85;
}

/* The message a replace position re-draws. pre-wrap keeps a multi-line
 * message readable: the card is presentation, not concealment. */
.acme-plugin-showcase__entry-text {
  display: block;
  margin: 0.25rem 0;
  white-space: pre-wrap;
  color: var(--pi-slot-text, inherit);
}

/* Tool arguments and results, printed as JSON. Bounded by the component, not
 * by CSS, so the card never grows without limit. */
.acme-plugin-showcase__args {
  display: block;
  margin-top: 0.125rem;
  padding: 0.25rem 0.375rem;
  border-radius: var(--pi-slot-radius-sm, 0.375rem);
  background: var(--pi-slot-bg, transparent);
  color: var(--pi-slot-text-muted, inherit);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--pi-slot-text-xs, 0.75rem);
  white-space: pre-wrap;
}

/* The card's own controls, beside the content it re-draws — never instead. */
.acme-plugin-showcase__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
  margin-top: 0.375rem;
}

/* A row the block marked with a trailing "!": the plugin's own emphasis. */
.acme-plugin-showcase__kv-flagged {
  text-decoration: underline;
}
`;

/**
 * One pure function the host may call while it renders (ADR 0294 decision 6),
 * registered below as `entry-facts`.
 *
 * The rules a host-callable function has to follow are the reason it is written
 * this way: no I/O, no network, no DOM, no state, and it must return inside the
 * host's one-frame budget (16 ms) or the answer is discarded. It is called with
 * whatever input the calling position passes, so it reads defensively.
 *
 * No host position calls it yet. It is registered so the shape is visible next
 * to the slot components that use the same value, and the smoke test calls it
 * the way a host position would.
 *
 * @param {unknown} input The transcript entry the host is rendering.
 * @returns {{ id: string, role: string, attributedTo: string | null }}
 */
function entryFacts(input) {
  const entry = input && typeof input === "object" ? input : {};
  return {
    id: typeof entry.id === "string" && entry.id ? entry.id : "unknown",
    role: typeof entry.role === "string" && entry.role ? entry.role : "unknown",
    // D14: the host sets this when it attributes the entry to a plugin. It is
    // absent for every entry the host itself produced, which is most of them.
    attributedTo:
      typeof entry.pluginId === "string" && entry.pluginId ? entry.pluginId : null,
  };
}

/**
 * The second host-callable function, registered below as `kv-rows`.
 *
 * It turns the fenced source into rows for `codeBlock`. Pure and synchronous
 * like the one above, and deliberately boring: a parser the host can call on
 * every render of the block it draws has no business touching anything else.
 *
 * Grammar: one `key = value` per line, `#` starts a comment line, and a key
 * ending in `!` marks the row as one the block wants to draw attention to.
 *
 * @param {unknown} input The fenced source the block was handed.
 * @returns {Array<{ key: string, value: string, flagged: boolean }>}
 */
function kvRows(input) {
  const source = typeof input === "string" ? input : "";
  const rows = [];
  for (const line of source.split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const separator = text.indexOf("=");
    if (separator <= 0) continue;
    const rawKey = text.slice(0, separator).trim();
    rows.push({
      key: rawKey.replace(/!$/, ""),
      value: text.slice(separator + 1).trim(),
      flagged: rawKey.endsWith("!"),
    });
  }
  return rows;
}

/**
 * One measured call, so this module can report what its own registered
 * functions really did. `entry-facts` and `kv-rows` are registered through
 * these wrappers, which is why every call a component makes is counted — and
 * why the number is the plugin's own count, not the host's.
 */
function measured(name, compute) {
  return (input) => {
    const startedAt = nowMs();
    const value = compute(input);
    const elapsedMs = nowMs() - startedAt;
    const counts = functionCalls[name];
    if (counts) {
      counts.served += 1;
      if (elapsedMs > FRAME_BUDGET_MS) counts.overBudget += 1;
    }
    return value;
  };
}

/* -------------------------------------------------------------------------
 * The on-demand layer positions
 *
 * `inlineConfirm`, `modal` and `overlay` are opened from this plugin's own
 * composer controls. The `pi` object `onLoad` was handed is kept here because
 * only that object may register a slot, and a control that is already on
 * screen can still call it later. `openLayers` is the truth about which layers
 * are up; `layerListeners` re-renders the controls and the cards when it
 * changes, whichever of them made the change.
 * ---------------------------------------------------------------------- */

/** The `pi` object `onLoad` was handed, or `null` before `onLoad` runs. */
let hostApi = null;

/** slot -> registration handle for every layer this plugin has open. */
const openLayers = new Map();

/** Components that re-read `openLayers` when a layer opens or closes. */
const layerListeners = new Set();

function layerComponent(slot) {
  if (slot === "inlineConfirm") return InlineConfirmCard;
  if (slot === "modal") return ModalCard;
  if (slot === "overlay") return OverlayCard;
  return null;
}

/**
 * Opens or closes one layer. Appearance is the registration and disappearance
 * is its removal, so nothing else has to be tracked: if this plugin is unloaded
 * while a layer is up, the host reclaims the registration and the layer with it
 * (D10).
 *
 * `dispatch` is the mounted control's own prop. The change is reported to the
 * plugin process through it, so the sidebar console shows the state this module
 * really holds after the user pressed the button — a report, never a claim made
 * on the console's behalf.
 */
function setLayerOpen(slot, open, dispatch) {
  if (open === openLayers.has(slot)) return open;
  if (open) {
    if (!hostApi) return false;
    openLayers.set(slot, registerSlot(slot, layerComponent(slot)));
    for (const listener of [...layerListeners]) listener();
  } else {
    // `releaseSlot` re-renders the controls and the cards itself, so the close
    // path notifies once and still reaches the report below.
    releaseSlot(slot);
  }
  // The layer positions are handed the pending confirmation (inlineConfirm) or a
  // session id and nothing else, so a close from a layer card's own button has
  // no dispatcher and cannot report its own change; the console then keeps the
  // previous state until the next control-driven toggle. That is stated on the
  // console page rather than papered over with a report this realm cannot send.
  if (typeof dispatch === "function") {
    void reportToProcess(dispatch, "renderer.slot", {
      slot,
      registered: open,
      slots: [...heldSlots],
    });
  }
  return open;
}

/** Re-render the calling component when any layer opens or closes. */
function useLayerState() {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((value) => value + 1);
    layerListeners.add(listener);
    return () => {
      layerListeners.delete(listener);
    };
  }, []);
}

/**
 * The plugin's one host interaction: a button that dispatches `ui.toast` and
 * prints the answer — `toast sent`, or the refusal code. It is shown instead of
 * swallowed, which is what keeps an undeclared or unrouted action legible
 * (ADR 0294 decision 2).
 */
function HostToastButton({ dispatch, message, label = "Notify the host" }) {
  const [status, setStatus] = useState(null);
  const notify = () => {
    if (typeof dispatch !== "function") {
      setStatus("no dispatch prop");
      return;
    }
    setStatus("asking...");
    dispatch("ui.toast", { message, variant: "info" })
      .then(() => setStatus("toast sent"))
      .catch((error) => setStatus(error?.code ?? String(error)));
  };
  return createElement("span", { className: "acme-plugin-showcase__action" }, [
    createElement(
      "button",
      {
        key: "button",
        type: "button",
        className: "acme-plugin-showcase__button pi-slot-btn",
        "data-pi-showcase-action": "ui.toast",
        onClick: notify,
      },
      label,
    ),
    status
      ? createElement(
          "span",
          { key: "status", className: "acme-plugin-showcase__muted" },
          status,
        )
      : null,
  ]);
}

/**
 * The in-slot control bar's report button: this plugin's own half of the
 * self-check console.
 *
 * The console page in the work panel cannot see this realm, and this module
 * cannot see the console, so the state travels one way only — through the
 * forwarded `plugin.call` action, which means it runs inside a mounted slot
 * component and nowhere else. The button prints the answer it got: `ok`, or the
 * code the relay refused the report with (a manifest that forgot to declare
 * `plugin.call` answers `PLUGIN_CALL_UNDECLARED`, which is exactly the kind of
 * fact this example exists to show).
 */
function ProcessReportButton({ dispatch, label = "Report to the plugin process" }) {
  const [status, setStatus] = useState("idle");
  const report = () => {
    setStatus("asking");
    void reportToProcess(dispatch, "renderer.report", selfReport()).then((answer) =>
      setStatus(String(answer?.code ?? "unknown")),
    );
  };
  return createElement("span", { className: "acme-plugin-showcase__action" }, [
    createElement(
      "button",
      {
        key: "button",
        type: "button",
        className: "acme-plugin-showcase__button pi-slot-btn",
        "data-pi-showcase-report": status,
        title:
          "Sends this module's live state (held slots, function call counts) to the " +
          "plugin's own process, where the sidebar console reads it.",
        onClick: report,
      },
      label,
    ),
    status !== "idle"
      ? createElement(
          "span",
          { key: "status", className: "acme-plugin-showcase__muted" },
          status,
        )
      : null,
  ]);
}

/**
 * The report a mounted position sends by itself.
 *
 * The console's live tile counts "slot-side reports", and a report that only
 * happens when a human presses a button reads zero on a window nobody has
 * touched. A mount is the one moment this module knows a position is live, so
 * the report goes out from here — once per mount, carrying the state this
 * module really holds at that moment. The button below stays: it re-reports on
 * demand and prints the host's own answer.
 */
function useMountReport(dispatch) {
  useEffect(() => {
    void reportToProcess(dispatch, "renderer.report", selfReport());
  }, []);
}

/**
 * The draft half of the composer control (spec 07-plugins/16 2A.7).
 *
 * Three real host actions and one deliberate refusal:
 *
 * - `composer.readDraft` answers the live snapshot
 *   `{ sessionId, generation, text, fileReferences }`, which the control shows
 *   and keeps for the next two buttons.
 * - `composer.replaceDraft` writes a whole draft back. `expectedGeneration` is
 *   the host's optimistic lock, so the control passes the generation it just
 *   read and the host answers `{ ok, generation, previous }` once a mounted
 *   composer consumed the write.
 * - the same action with a deliberately stale `expectedGeneration` is the
 *   refusal path: the host answers `DRAFT_CONFLICT` and writes nothing.
 * - `composer.insertText` is declared in the manifest and has no host handler
 *   at all, so dispatching it is refused with `PLUGIN_ACTION_UNROUTED` — the
 *   same code the plugin row's Renderer diagnostics records.
 *
 * Every outcome is printed on the control and reported to the plugin process,
 * because an action that only ever answers inside this realm is not evidence of
 * anything. The refusal report is what the console shows next to the row's own
 * diagnostic: one refusal, two places to read it.
 */
function ComposerDraftControls({ dispatch }) {
  const [outcome, setOutcome] = useState("idle");
  const [snapshot, setSnapshot] = useState(null);

  const run = (label, action, payload, onOk) => {
    if (typeof dispatch !== "function") {
      setOutcome(`${label}: no dispatch prop`);
      return Promise.resolve(null);
    }
    setOutcome(`${label}: asking`);
    return dispatch(action, payload)
      .then((answer) => {
        if (onOk) onOk(answer);
        setOutcome(`${label}: ok`);
        return answer;
      })
      .catch((error) => {
        const code = error?.code ?? String(error);
        setOutcome(`${label}: ${code}`);
        // Reported, never swallowed: the code the window shows is the code the
        // console shows, and the row keeps the host's own diagnostic as well.
        void reportToProcess(dispatch, "renderer.refusal", { action, code });
        return null;
      });
  };

  const generation = typeof snapshot?.generation === "number" ? snapshot.generation : null;
  const draftText = typeof snapshot?.text === "string" ? snapshot.text : null;
  return createElement(
    "span",
    {
      className: "acme-plugin-showcase__action",
      "data-pi-showcase-draft-outcome": outcome,
      "data-pi-showcase-draft-generation": generation === null ? "" : String(generation),
      "data-pi-showcase-draft-text": draftText === null ? "" : draftText,
      title:
        "composer.readDraft / composer.replaceDraft, driven from a mounted slot. " +
        "The stale write is the documented DRAFT_CONFLICT path; the insert is declared " +
        "and unrouted, so the host answers PLUGIN_ACTION_UNROUTED.",
    },
    [
      createElement(
        "button",
        {
          key: "read",
          type: "button",
          className: "acme-plugin-showcase__button pi-slot-btn",
          "data-pi-showcase-trigger": "readDraft",
          onClick: () =>
            run("readDraft", "composer.readDraft", {}, (answer) => setSnapshot(answer ?? null)),
        },
        "Showcase: read the draft",
      ),
      createElement(
        "button",
        {
          key: "write",
          type: "button",
          className: "acme-plugin-showcase__button pi-slot-btn",
          "data-pi-showcase-trigger": "replaceDraft",
          onClick: () =>
            run("replaceDraft", "composer.replaceDraft", {
              text: draftText ?? "",
              // The generation this control last read is the lock the write is
              // made against; without a read there is nothing to write back.
              ...(generation === null ? {} : { expectedGeneration: generation }),
            }),
        },
        "Showcase: write it back",
      ),
      createElement(
        "button",
        {
          key: "stale",
          type: "button",
          className: "acme-plugin-showcase__button pi-slot-btn",
          "data-pi-showcase-trigger": "staleDraft",
          onClick: () =>
            run("staleDraft", "composer.replaceDraft", {
              text: draftText ?? "a stale showcase write",
              // Deliberately out of date: the host must refuse this one.
              expectedGeneration: (generation ?? 0) + 99,
            }),
        },
        "Showcase: stale write (DRAFT_CONFLICT)",
      ),
      createElement(
        "button",
        {
          key: "unrouted",
          type: "button",
          className: "acme-plugin-showcase__button pi-slot-btn",
          "data-pi-showcase-trigger": "unroutedAction",
          onClick: () => run("insertText", "composer.insertText", { text: "showcase insert" }),
        },
        "Showcase: declared but unrouted",
      ),
      outcome === "idle"
        ? null
        : createElement(
            "span",
            { key: "outcome", className: "acme-plugin-showcase__muted" },
            outcome,
          ),
    ],
  );
}

/**
 * `entry`: the whole-message position.
 *
 * The host draws a registration *instead of* the message it would otherwise
 * render — bubble and actions alike — so it hands this component the message
 * that row was going to display: `message.text`, `message.attachments`, the
 * timestamp, the typed slash form, whether the text is still arriving, and the
 * host `actions` the position covers. This card re-draws exactly that message in
 * its own form and puts its own controls beside it. Stating "I took the row
 * over" while hiding the text would be concealing the data the position exists
 * to present, which is the one thing a replace slot must not do.
 *
 * Everything is read defensively: the host may mount a position before the data
 * is ready, and a component written against an older host is handed no
 * `message` at all.
 */
function EntryCard({ entry, message, sessionId, dispatch }) {
  const facts = entryFacts(entry);
  const text = message && typeof message.text === "string" ? message.text : "";
  const attachments = message && Array.isArray(message.attachments) ? message.attachments : [];
  const actions = message && Array.isArray(message.actions) ? message.actions : [];
  const meta = [
    `${facts.role} message`,
    facts.id,
    facts.attributedTo ? `added by ${facts.attributedTo}` : null,
    sessionId ? `session ${sessionId}` : "no session id in props",
    message && message.createdAt ? message.createdAt : null,
    message && message.command ? `typed as ${message.command}` : null,
    message && message.streaming ? "still streaming" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return createElement(
    "div",
    { className: "acme-plugin-showcase__card", "data-pi-showcase-slot": "entry" },
    [
      createElement(
        "span",
        { key: "title", className: "acme-plugin-showcase__card-title" },
        `${PLUGIN_ID} · entry`,
      ),
      createElement(
        "span",
        { key: "meta", className: "acme-plugin-showcase__line acme-plugin-showcase__muted" },
        meta,
      ),
      // The message itself, in the card's own form. `data-pi-showcase-entry-text`
      // is what the e2e read: a card that stopped drawing the text would fail
      // there rather than quietly showing its own chrome instead.
      createElement(
        "span",
        {
          key: "text",
          className: "acme-plugin-showcase__entry-text",
          "data-pi-showcase-entry-text": "1",
        },
        text || "(this entry has no text)",
      ),
      attachments.length
        ? createElement(
            "span",
            { key: "attachments", className: "acme-plugin-showcase__row" },
            attachments.map((attachment, index) =>
              createElement(
                "span",
                {
                  key: `attachment-${index}`,
                  className: "acme-plugin-showcase__chip pi-slot-chip",
                  "data-pi-showcase-entry-attachment": attachment?.name ?? "",
                },
                `${attachment?.name ?? "attachment"} (${attachment?.kind ?? "file"} · ${attachment?.ref ?? "no ref"})`,
              ),
            ),
          )
        : null,
      createElement(
        "span",
        { key: "actions", className: "acme-plugin-showcase__line acme-plugin-showcase__muted" },
        actions.length
          ? `the host's own row actions this card stands in for: ${actions.join(", ")} (this card cannot trigger them)`
          : "the host's own row actions would be none here",
      ),
      createElement(
        "span",
        { key: "session", className: "acme-plugin-showcase__line acme-plugin-showcase__muted" },
        sessionId ? `session ${sessionId}` : "no session id in props",
      ),
      createElement(
        "span",
        { key: "controls", className: "acme-plugin-showcase__controls" },
        [
          createElement(HostToastButton, {
            key: "notify",
            dispatch,
            message: `${PLUGIN_ID} · entry slot · message ${facts.id}`,
            label: "Send a toast from the entry slot",
          }),
          createElement(
            "button",
            {
              key: "release",
              type: "button",
              className: "acme-plugin-showcase__button pi-slot-btn",
              "data-pi-showcase-release": "entry",
              title:
                "Removes this module's registration for the whole-message position. " +
                "The host then draws its own row again — registration is the claim.",
              onClick: () => releaseSlot("entry"),
            },
            "Release this claim (give the row back to the host)",
          ),
        ],
      ),
    ],
  );
}

/**
 * `entryExtra`: one extra block below a transcript entry.
 *
 * Everything this component gets arrives as a prop: the slot's data as `entry`
 * (the `{ id, role }` of the row the badge sits under, plus `pluginId` when the
 * host attributed the row to a plugin), and `dispatch(action, payload)`. No
 * prop is guaranteed — the host may mount a slot before the data a plugin
 * declared is ready — so the badge reads through `entryFacts`, which tolerates a
 * missing entry exactly the way any React component tolerates a missing prop.
 */
function EntryExtraCard({ entry, dispatch }) {
  const facts = entryFacts(entry);
  return createElement("span", { className: "acme-plugin-showcase__badge pi-slot-chip" }, [
    `${PLUGIN_ID} · entryExtra`,
    createElement(
      "span",
      { key: "facts", className: "acme-plugin-showcase__muted" },
      facts.attributedTo
        ? `${facts.role} · ${facts.id} · added by ${facts.attributedTo}`
        : `${facts.role} · ${facts.id}`,
    ),
    // The value below is what the registered function returned. A host position
    // that needs a synchronous answer calls exactly this function, in this
    // realm, while it renders (ADR 0294 decision 6).
    createElement(
      "span",
      { key: "fn", className: "acme-plugin-showcase__muted" },
      `fn entry-facts() → ${facts.role}`,
    ),
    createElement(HostToastButton, {
      key: "notify",
      dispatch,
      message: `${PLUGIN_ID} · ${facts.role} entry ${facts.id}`,
    }),
  ]);
}

/** The JSON of a value the host handed over, bounded so a card stays readable. */
function preview(value, empty = "nothing to show", limit = 600) {
  if (value === undefined) return empty;
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch (error) {
    text = `unprintable value: ${error?.message ?? String(error)}`;
  }
  if (typeof text !== "string") text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}… (${text.length} characters)` : text;
}

/**
 * `toolCard`: the card body of this plugin's own tool.
 * The host asks a plugin to draw this position only for a tool row whose forced
 * prefix names that plugin (D015), and it hands over the row as
 * `{ entry, tool, sessionId }` with `entry.pluginId` set to the owner. The
 * component checks that attribution anyway, because "the host only offers me my
 * own rows" is a contract worth making visible rather than assuming.
 *
 * The card body replaces the host's own detail blocks, so the host hands over
 * what those blocks are built from: the tool's name, the call's arguments, its
 * result and status. This card re-draws all of it and adds its own controls;
 * a card that only announced "the host's blocks are hidden" would throw away
 * the call the user asked to see.
 */
function ToolCard({ entry, tool, sessionId, dispatch }) {
  const facts = entryFacts(entry);
  const owned = facts.attributedTo === PLUGIN_ID;
  const call = tool && typeof tool === "object" ? tool : {};
  const name = typeof call.name === "string" && call.name ? call.name : "no tool name in props";
  const status = typeof call.status === "string" && call.status ? call.status : "unknown status";
  const duration =
    typeof call.durationMs === "number" && call.durationMs > 0
      ? ` · ${(call.durationMs / 1000).toFixed(2)}s`
      : "";
  return createElement(
    "div",
    { className: "acme-plugin-showcase__card", "data-pi-showcase-slot": "toolCard" },
    [
      createElement(
        "span",
        { key: "title", className: "acme-plugin-showcase__card-title" },
        `${PLUGIN_ID} · toolCard`,
      ),
      createElement(
        "span",
        { key: "owner", className: "acme-plugin-showcase__line" },
        owned
          ? `this is the plugin's own tool row (${facts.id}), so the host offered it its card body instead of its detail blocks.`
          : `not this plugin's tool row (owner: ${facts.attributedTo ?? "unknown"}); the host does not offer the position for it.`,
      ),
      createElement(
        "span",
        { key: "tool", className: "acme-plugin-showcase__line", "data-pi-showcase-tool-name": name },
        `${name} · ${status}${duration}`,
      ),
      createElement(
        "span",
        { key: "args", className: "acme-plugin-showcase__args" },
        `arguments: ${preview(call.args)}`,
      ),
      createElement(
        "span",
        { key: "result", className: "acme-plugin-showcase__args" },
        `result: ${preview(call.result, "nothing yet (the call is still running)")}`,
      ),
      createElement(
        "span",
        { key: "session", className: "acme-plugin-showcase__line acme-plugin-showcase__muted" },
        sessionId ? `session ${sessionId}` : "no session id in props",
      ),
      createElement(
        "span",
        { key: "controls", className: "acme-plugin-showcase__controls" },
        [
          createElement(HostToastButton, {
            key: "notify",
            dispatch,
            message: `${PLUGIN_ID} · toolCard for ${facts.id}`,
            label: "Send a toast from the tool card",
          }),
          createElement(
            "button",
            {
              key: "release",
              type: "button",
              className: "acme-plugin-showcase__button pi-slot-btn",
              "data-pi-showcase-release": "toolCard",
              title:
                "Removes this module's registration for the tool card body. " +
                "The row then draws the host's own detail blocks again.",
              onClick: () => releaseSlot("toolCard"),
            },
            "Release this claim (give the card body back)",
          ),
        ],
      ),
    ],
  );
}

/**
 * `inlineConfirm`: the host's inline-confirmation position, taken by the
 * plugin's own card while the registration is up.
 *
 * It is deliberately opened on demand. The host mounts this position only while
 * a permission request is pending and draws the host's own permission card
 * there when no plugin holds it, so a registration at load would replace the
 * user's approval UI. Because the position replaces a host surface, the host
 * hands over the confirmation that surface would have shown (`confirm`): the
 * tool, its argument preview, the risk the host classified it with, the reason
 * it is asking and how many requests wait behind this one. The card re-draws
 * that request in its own form. Deciding it stays host-owned — there is no
 * action for allow or deny here — so the card's own control closes the
 * registration, which brings the host's card back.
 */
function InlineConfirmCard({ sessionId, confirm, dispatch }) {
  useLayerState();
  const request = confirm && typeof confirm === "object" ? confirm : null;
  const facts = request
    ? [
        `tool ${request.toolName}`,
        `risk ${request.risk}`,
        request.agentName ? `asked by subagent ${request.agentName}` : null,
        request.queued > 0 ? `${request.queued} request(s) waiting behind it` : "no request waiting behind it",
        `request ${request.requestId}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "no confirmation in props";
  return createElement(
    "div",
    { className: "acme-plugin-showcase__card", "data-pi-showcase-slot": "inlineConfirm" },
    [
      createElement(
        "span",
        { key: "title", className: "acme-plugin-showcase__card-title" },
        `${PLUGIN_ID} · inlineConfirm`,
      ),
      createElement(
        "span",
        { key: "what", className: "acme-plugin-showcase__line" },
        "This card holds the host's inline-confirmation position, so the host's own permission card is not drawn here. What follows is the request it would have shown.",
      ),
      createElement(
        "span",
        { key: "request", className: "acme-plugin-showcase__line", "data-pi-showcase-confirm": facts },
        facts,
      ),
      createElement(
        "span",
        { key: "args", className: "acme-plugin-showcase__args" },
        `arguments: ${preview(request ? request.args : undefined)}`,
      ),
      createElement(
        "span",
        { key: "reason", className: "acme-plugin-showcase__line" },
        `why the host is asking: ${request && request.reason ? request.reason : "no reason in props"}`,
      ),
      createElement(
        "span",
        { key: "session", className: "acme-plugin-showcase__line acme-plugin-showcase__muted" },
        sessionId ? `session ${sessionId}` : "no session id in props",
      ),
      createElement(
        "span",
        { key: "controls", className: "acme-plugin-showcase__controls" },
        [
          createElement(HostToastButton, {
            key: "notify",
            dispatch,
            message: `${PLUGIN_ID} · inlineConfirm card`,
            label: "Send a toast from the inline card",
          }),
          createElement(
            "button",
            {
              key: "close",
              type: "button",
              className: "acme-plugin-showcase__button pi-slot-btn",
              "data-pi-showcase-close": "inlineConfirm",
              title:
                "Removes this module's registration for the confirmation position. " +
                "Approving or denying is host-owned, so this is the card's only control.",
              onClick: () => setLayerOpen("inlineConfirm", false),
            },
            "Close this card (removes its registration)",
          ),
        ],
      ),
    ],
  );
}

/**
 * `modal`: a blocking, app-level dialog. The host owns the scrim and the
 * blocking; the plugin owns this box. Escape is the host's dismissal of a
 * plugin layer (it hides the layer without touching the plugin's own state),
 * and this button withdraws the registration for good.
 *
 * A layer is the one replace position with no content of the host's own to
 * re-draw — the host owns the scrim and the blocking, the plugin's registration
 * *is* the layer — so the card states which host surface it occupies instead.
 */
function ModalCard({ sessionId }) {
  useLayerState();
  return createElement(
    "div",
    {
      className: "acme-plugin-showcase__layer-card",
      "data-pi-showcase-slot": "modal",
      role: "dialog",
      "aria-label": `${PLUGIN_ID} modal demo`,
    },
    [
      createElement(
        "span",
        { key: "title", className: "acme-plugin-showcase__card-title" },
        `${PLUGIN_ID} · modal`,
      ),
      createElement(
        "span",
        { key: "surface", className: "acme-plugin-showcase__line" },
        "Host surface occupied: the app-level modal layer (the host's own `data-pi-plugin-layer=\"modal\"` box over the window). The host adds the scrim and the blocking, and owns the Escape dismissal — this plugin owns only this card.",
      ),
      createElement(
        "span",
        { key: "what", className: "acme-plugin-showcase__line" },
        "This layer is on screen because this plugin registered a component for the modal position; registration is appearance and removal is disappearance.",
      ),
      createElement(
        "span",
        { key: "session", className: "acme-plugin-showcase__line acme-plugin-showcase__muted" },
        sessionId ? `session ${sessionId}` : "no session id in props",
      ),
      createElement(
        "button",
        {
          key: "close",
          type: "button",
          className: "acme-plugin-showcase__button pi-slot-btn",
          "data-pi-showcase-close": "modal",
          onClick: () => setLayerOpen("modal", false),
        },
        "Close the modal (Escape does the same)",
      ),
    ],
  );
}

/**
 * `overlay`: a transient in-window layer. It does not block: only this box
 * takes the pointer, and the rest of the window stays usable underneath it.
 */
function OverlayCard({ sessionId }) {
  useLayerState();
  return createElement(
    "div",
    {
      className: "acme-plugin-showcase__layer-card is-overlay",
      "data-pi-showcase-slot": "overlay",
      role: "status",
    },
    [
      createElement(
        "span",
        { key: "title", className: "acme-plugin-showcase__card-title" },
        `${PLUGIN_ID} · overlay`,
      ),
      createElement(
        "span",
        { key: "what", className: "acme-plugin-showcase__line" },
        "A non-blocking layer: only this box takes the pointer.",
      ),
      createElement(
        "span",
        { key: "session", className: "acme-plugin-showcase__line acme-plugin-showcase__muted" },
        sessionId ? `session ${sessionId}` : "no session id in props",
      ),
      createElement(
        "button",
        {
          key: "close",
          type: "button",
          className: "acme-plugin-showcase__button pi-slot-btn",
          "data-pi-showcase-close": "overlay",
          onClick: () => setLayerOpen("overlay", false),
        },
        "Close the overlay (Escape does the same)",
      ),
    ],
  );
}

/**
 * The orders the region's cycle button walks: the same three pieces, three
 * sequences. The host hands the region over whole, so the order inside it is
 * this plugin's decision — and this demo keeps all three every time.
 */
const COMPOSER_REGION_ORDERS = [
  ["model", "context", "enhance"],
  ["context", "enhance", "model"],
  ["enhance", "model", "context"],
];

/**
 * The `beforeSend` region: the host's own three pieces, in this plugin's order.
 *
 * The host hands over `modelControl` / `contextControl` / `enhanceControl` as
 * nodes — the elements its own toolbar draws — plus the data behind them
 * (`modelSelection`, `contextUsage`, `enhancement`). This component only places
 * those nodes: every piece is drawn exactly once, in the order shown on the
 * control (`data-pi-showcase-region-order`), and the plugin's own buttons sit
 * beside them. A piece whose data is `null` (the host has no measured turn to
 * draw a context display from) is marked on the control instead of being
 * silently dropped.
 */
function ComposerRegion({
  modelControl,
  modelSelection,
  contextControl,
  contextUsage,
  enhanceControl,
  enhancement,
  draftLength,
  sessionNote,
  dispatch,
}) {
  const [orderIndex, setOrderIndex] = useState(0);
  const order = COMPOSER_REGION_ORDERS[orderIndex];
  const pieces = {
    model: modelControl,
    context: contextControl,
    enhance: enhanceControl,
  };
  const data = {
    model: modelSelection,
    context: contextUsage,
    enhance: enhancement,
  };
  const modalOpen = openLayers.has("modal");
  const overlayOpen = openLayers.has("overlay");
  const cycle = () => {
    const next = (orderIndex + 1) % COMPOSER_REGION_ORDERS.length;
    setOrderIndex(next);
    // Reported to the plugin process like every other control here, so the
    // console shows the order the window is really drawing.
    void reportToProcess(dispatch, "renderer.slot", {
      slot: "composerControl",
      position: "beforeSend",
      order: COMPOSER_REGION_ORDERS[next],
    });
  };
  return createElement(
    "span",
    {
      className: "acme-plugin-showcase__row acme-plugin-showcase__region",
      "data-pi-showcase-region": "beforeSend",
      "data-pi-showcase-region-order": order.join(","),
      title:
        `Showcase demo · the region left of Send · draft ${draftLength} char(s) · ${sessionNote}. ` +
        "The host handed over its model picker, context display and prompt-enhancement " +
        "control as nodes plus their data; this control orders them itself and adds its own buttons.",
    },
    [
      ...order.map((piece) =>
        createElement(
          "span",
          {
            key: piece,
            className: "acme-plugin-showcase__region-piece",
            "data-pi-showcase-region-piece": piece,
            // What the host handed over for this piece: "yes" when its data
            // arrived, "none" when the host had nothing to hand over.
            "data-pi-showcase-region-data": data[piece] ? "yes" : "none",
          },
          [
            pieces[piece],
            data[piece]
              ? null
              : createElement(
                  "span",
                  { key: "none", className: "acme-plugin-showcase__muted" },
                  `${piece}: nothing handed over yet`,
                ),
          ],
        ),
      ),
      createElement(
        "button",
        {
          key: "cycle",
          type: "button",
          className: "acme-plugin-showcase__button pi-slot-btn",
          "data-pi-showcase-trigger": "composerRegionCycle",
          title:
            "Cycles the order of the three pieces the host handed this region. " +
            "No piece is ever dropped; only their sequence changes.",
          onClick: cycle,
        },
        `Showcase: cycle region order (${order.join(" → ")})`,
      ),
      // This plugin's own controls beside the host's pieces — the same layer
      // toggles the right row carries, drawn here because the plugin decides
      // what the region holds. Adding is allowed; the host's pieces stay.
      createElement(
        "button",
        {
          key: "modal",
          type: "button",
          className: "acme-plugin-showcase__button pi-slot-btn",
          "data-pi-showcase-trigger": "modal",
          title: "Registration is what puts the modal layer on screen.",
          onClick: () => setLayerOpen("modal", !modalOpen, dispatch),
        },
        modalOpen ? "Showcase: close modal" : "Showcase: modal",
      ),
      createElement(
        "button",
        {
          key: "overlay",
          type: "button",
          className: "acme-plugin-showcase__button pi-slot-btn",
          "data-pi-showcase-trigger": "overlay",
          title: "Registration is what puts the overlay layer on screen.",
          onClick: () => setLayerOpen("overlay", !overlayOpen, dispatch),
        },
        overlayOpen ? "Showcase: close overlay" : "Showcase: overlay",
      ),
      createElement(ProcessReportButton, { key: "report", dispatch }),
    ],
  );
}

/**
 * `composerControl`: one registration, three control positions.
 *
 * The host mounts the same registration at the end of the composer's left row,
 * at the end of its right row, and in the `beforeSend` region immediately left
 * of the send button; this module declares all three (`positions`) and hands it
 * `{ position, draft, sessionId? }`. The component decides for itself which
 * position it draws in and returns `null` for the others, which leaves no hole.
 * The `draft` prop is what the host handed over at render time and is read-only;
 * the left row's own buttons drive the same draft through the declared
 * `composer.readDraft` / `composer.replaceDraft` actions (D8 keeps the host's
 * own controls where they are). These buttons also control this plugin's own
 * layer registrations, which is something a composer control can really do
 * today.
 *
 * `beforeSend` is the handover position: the host hands over the region whole —
 * its own model picker (`modelControl`), context display (`contextControl`), and
 * prompt-enhancement control (`enhanceControl`) as *nodes*, plus the data behind
 * them (`modelSelection`, `contextUsage`, `enhancement`) — and this component
 * decides the order of those three pieces, keeps all of them, and adds its own
 * buttons beside them (see `ComposerRegion`). It never drops a piece and never
 * draws one twice: it only renders the host's nodes, in its own order.
 *
 * A mount reports this module's live state to the plugin process (see
 * `useMountReport`), so the console's "slot-side reports" tile reflects a window
 * a user has really mounted a position in, with no button press needed.
 */
function ComposerControl({ position, draft, sessionId, dispatch, ...region }) {
  useLayerState();
  useMountReport(dispatch);
  const draftLength = typeof draft === "string" ? draft.length : 0;
  const sessionNote = sessionId ? `session ${sessionId}` : "no session yet";
  if (position === "beforeSend") {
    return createElement(ComposerRegion, {
      draftLength,
      sessionNote,
      dispatch,
      ...region,
    });
  }
  if (position === "left") {
    const open = openLayers.has("inlineConfirm");
    return createElement("span", { className: "acme-plugin-showcase__row" }, [
      createElement(
        "button",
        {
          key: "inlineConfirm",
          type: "button",
          className: "acme-plugin-showcase__button pi-slot-btn",
          "data-pi-showcase-trigger": "inlineConfirm",
          title:
            `Showcase demo · left composer position · draft ${draftLength} char(s) · ${sessionNote}. ` +
            "While this registration is up it takes the host's inline-confirmation position.",
          onClick: () => setLayerOpen("inlineConfirm", !open, dispatch),
        },
        open ? "Showcase: close inline card" : "Showcase: inline card",
      ),
      createElement(ComposerDraftControls, { key: "draft", dispatch }),
    ]);
  }
  if (position === "right") {
    const modalOpen = openLayers.has("modal");
    const overlayOpen = openLayers.has("overlay");
    return createElement("span", { className: "acme-plugin-showcase__row" }, [
      createElement(
        "button",
        {
          key: "modal",
          type: "button",
          className: "acme-plugin-showcase__button pi-slot-btn",
          "data-pi-showcase-trigger": "modal",
          title:
            `Showcase demo · right composer position · draft ${draftLength} char(s) · ${sessionNote}. ` +
            "Registration is what puts the modal layer on screen.",
          onClick: () => setLayerOpen("modal", !modalOpen, dispatch),
        },
        modalOpen ? "Showcase: close modal" : "Showcase: modal",
      ),
      createElement(
        "button",
        {
          key: "overlay",
          type: "button",
          className: "acme-plugin-showcase__button pi-slot-btn",
          "data-pi-showcase-trigger": "overlay",
          title:
            `Showcase demo · right composer position · draft ${draftLength} char(s) · ${sessionNote}. ` +
            "Registration is what puts the overlay layer on screen.",
          onClick: () => setLayerOpen("overlay", !overlayOpen, dispatch),
        },
        overlayOpen ? "Showcase: close overlay" : "Showcase: overlay",
      ),
      // The report control: the smallest thing that can send this module's live
      // state to the plugin process, which is where the sidebar console reads it
      // from. It sits in the same control row as the layer toggles, so what the
      // console shows and what the user just did are one action apart.
      createElement(ProcessReportButton, { key: "report", dispatch }),
    ]);
  }
  return null;
}

/**
 * `completionSource`: candidate rows inside the composer's completion popover.
 *
 * The host mounts this position inside the open popover, below its own command
 * or file rows, and hands it `{ mode, query }`. It is a candidate source, not a
 * filter: the host's rows keep their order, and the keyboard highlight and
 * `Enter`/`Tab` acceptance stay host-owned — a plugin row carries its own
 * activation. This one has none to offer: nothing in the interface inserts a
 * candidate into the draft yet, so the rows say exactly that instead of looking
 * selectable.
 */
function CompletionSource({ mode, query }) {
  const text = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!text || (mode !== "slash" && mode !== "file")) return null;
  const names =
    mode === "slash"
      ? ["showcase-inline", "showcase-modal", "showcase-overlay"].filter((name) =>
          name.startsWith(text),
        )
      : text.startsWith("acme") || "acme".startsWith(text)
        ? ["acme"]
        : [];
  if (!names.length) return null;
  return createElement(
    "span",
    { className: "acme-plugin-showcase__completion", "data-pi-showcase-slot": "completionSource" },
    [
      createElement(
        "span",
        { key: "head", className: "acme-plugin-showcase__muted" },
        `${PLUGIN_ID} · completionSource (${mode}) · modelled candidates for "${text}"`,
      ),
      ...names.map((name) =>
        createElement(
          "span",
          {
            key: name,
            className: "acme-plugin-showcase__row",
            "data-pi-showcase-candidate": name,
            "aria-disabled": "true",
          },
          mode === "slash"
            ? `/${name} — demo row: it cannot insert a command into the draft yet`
            : `@${name} — demo row: it cannot add a reference to the draft yet`,
        ),
      ),
    ],
  );
}

/**
 * `composerReference`: this plugin's own chip beside the composer's chips.
 *
 * The host paints its own chips inside the editor, so this position sits after
 * the editor: a plugin chip follows every host chip. The list is read-only and
 * the chip is a React element, not an atomic editor token — it cannot add a
 * reference to the draft, remove a host chip, or change what the draft sends.
 * It reads the props it was handed and says what it sees.
 */
function ComposerReference({ references, draft, sessionId }) {
  const chips = Array.isArray(references) ? references : [];
  const draftLength = typeof draft === "string" ? draft.length : 0;
  const names = chips
    .map((chip) => (chip && typeof chip.name === "string" ? chip.name : ""))
    .filter(Boolean);
  return createElement(
    "span",
    {
      className: "acme-plugin-showcase__chip pi-slot-chip",
      "data-pi-showcase-slot": "composerReference",
      "data-pi-showcase-reference-count": chips.length,
      title:
        `${PLUGIN_ID} chip · the draft holds ${chips.length} host reference(s) and ${draftLength} character(s)` +
        (sessionId ? ` in session ${sessionId}` : " with no session yet") +
        ". This chip is a React element beside the editor, not an atomic editor token: it cannot add a reference to the draft or remove a host chip.",
    },
    [
      createElement("span", { key: "label" }, `${PLUGIN_ID} chip`),
      createElement(
        "span",
        { key: "count", className: "acme-plugin-showcase__muted" },
        `${chips.length} ref · ${draftLength} ch`,
      ),
      names.length
        ? createElement(
            "span",
            { key: "names", className: "acme-plugin-showcase__muted" },
            names.slice(0, 3).join(", "),
          )
        : null,
    ],
  );
}

/**
 * `codeBlock`: the renderer for the fenced language this plugin claimed.
 *
 * The host hands it `{ language, code, isIncomplete, theme }` and only mounts it
 * for a closed, in-limit block, so `isIncomplete` is always `false` here. The
 * block has no way out to the host at all — it draws what it was given — which
 * is why it is a good place to show a host-callable function being read.
 */
function KeyValueBlock({ language, code }) {
  const rows = kvRows(code);
  return createElement(
    "span",
    { className: "acme-plugin-showcase__kv" },
    [
      createElement(
        "span",
        { key: "head", className: "acme-plugin-showcase__kv-head" },
        `${PLUGIN_ID} draws fenced ${language} · fn kv-rows() → ${rows.length} row(s)`,
      ),
      ...rows.map((row, index) =>
        createElement(
          "span",
          {
            key: `row-${index}`,
            className: row.flagged
              ? "acme-plugin-showcase__kv-row acme-plugin-showcase__kv-flagged"
              : "acme-plugin-showcase__kv-row",
          },
          [
            createElement(
              "span",
              { key: "key", className: "acme-plugin-showcase__kv-key" },
              row.key,
            ),
            createElement("span", { key: "value" }, row.value),
          ],
        ),
      ),
    ],
  );
}

/**
 * Required by the host. There is no `onUnload` here on purpose: the host removes
 * every slot registration, every registered function and the injected sheet when
 * the plugin is unloaded, disabled, or uninstalled (D10), so a plugin that only
 * registers slots and functions has nothing to clean up.
 */
export function onLoad(pi) {
  // A reload re-runs `onLoad` on the module instance the module cache kept, and
  // the host already reclaimed the previous load's registrations on unload, so
  // every handle kept here is stale and the slot inventory starts from what this
  // load really registers. That matters for the release buttons: a card may have
  // given its position back since the last load, and a fresh load takes it again.
  openLayers.clear();
  heldRegistrations.clear();
  heldSlots.clear();
  hostApi = pi;
  pi.ui.injectStyle(STYLES);
  // The two host-callable functions. Names are unique inside this plugin and
  // must match `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`. They are wrapped so the
  // module can report how many calls it really served.
  pi.functions.register("entry-facts", measured("entry-facts", entryFacts));
  pi.functions.register("kv-rows", measured("kv-rows", kvRows));
  registerSlot("entry", EntryCard);
  registerSlot("entryExtra", EntryExtraCard);
  // `codeBlock` carries the language it claims; every other slot takes no
  // options.
  registerSlot("codeBlock", KeyValueBlock, { language: CODE_LANGUAGE });
  registerSlot("toolCard", ToolCard);
  // All three composer positions this registration draws in: the two control
  // rows and the region immediately left of Send, which the host hands over
  // whole (model picker, context display, enhancement control, plus their
  // data). `beforeSend` is one claim; this is where the showcase takes it.
  registerSlot("composerControl", ComposerControl, {
    positions: ["left", "right", "beforeSend"],
  });
  registerSlot("completionSource", CompletionSource);
  registerSlot("composerReference", ComposerReference);
  // The three layer positions are registered on demand by the composer controls
  // above, never here: `LAYER_SLOTS` is the list a reader (and the smoke test)
  // can compare against what is actually open.
  void LAYER_SLOTS;
}
