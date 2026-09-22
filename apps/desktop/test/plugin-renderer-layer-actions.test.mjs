/**
 * The four layer actions: `ui.openModal`, `ui.closeModal`, `ui.openOverlay`,
 * `ui.closeOverlay` (ADR 0294, spec 07-plugins/16 §2A.7).
 *
 * A layer's appearance is its registration, so these four are not "open a
 * window" verbs: they withdraw or restore the layer the calling plugin has
 * already registered, and a call with no registration of its own behind it is a
 * coded refusal rather than a call that resolves into nothing. The cases below
 * render the real `PluginLayerHost` against the real registry, relay, and
 * host-action module, so what the assertions read is what the window would draw:
 * the plugin's component stays registered throughout the dismissal and comes
 * back unchanged.
 *
 * The store and the shell's portal helper are the only mocked edges. React's
 * server renderer does not run effects, so the host's Escape handler — which
 * writes the same registry state these actions do — is exercised directly
 * through that state.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

// The outlet's loader reports through the registry and the style module expects
// a document; both exist in the app. Nothing here injects a sheet.
globalThis.document = {
  head: { children: [], appendChild: (element) => element },
  createElement: () => ({
    setAttribute() {},
    getAttribute: () => null,
    remove() {},
  }),
  querySelectorAll: () => [],
};
globalThis.piDesktop = {
  invoke: async () => ({ ok: true, data: null }),
  on: () => () => {},
  channels: {},
  platform: "darwin",
};

const registryModule = await import("../src/plugins/renderer-slots/registry.ts");
const { pluginSlots, resetPluginSlots } = registryModule;
const relay = await import("../src/plugins/renderer-host/relay.ts");
const loader = await import("../src/plugins/renderer-host/loader.ts");
const candidatesModule = await import("../src/plugins/renderer-slots/candidates.ts");
const pluginSdk = await import("@pi-desktop/plugin-sdk");

/**
 * The one mocked store edge: the plugin rows the mount points read and the
 * active session. The layer actions never call into it.
 */
const storeState = { plugins: [], activeSessionId: "session-1" };
const useAppStore = (selector) => selector(storeState);
useAppStore.getState = () => storeState;
useAppStore.setState = () => {};
useAppStore.subscribe = () => () => {};
const storeModule = { useAppStore };

/**
 * A slot component is compiled the way the other presentation tests load a TSX
 * module: transpiled, then run against an explicit import map, so an import the
 * test forgets is named instead of silently resolving to something else.
 */
function loadTsx(relativePath, imports) {
  const file = new URL(relativePath, import.meta.url);
  const source = readFileSync(file, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unmocked dependency of ${relativePath}: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const { installRendererHostActions } = loadTsx(
  "../src/plugins/renderer-host/host-actions.ts",
  {
    "../../lib/api": { api: { pluginRendererCall: async () => null } },
    "../../stores/app-store": storeModule,
    "../renderer-slots/registry": registryModule,
    "./relay": relay,
  },
);

const { PluginSlot, useSlotRegistrations } = loadTsx(
  "../src/plugins/renderer-slots/SlotOutlet.tsx",
  {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "@pi-desktop/plugin-sdk": pluginSdk,
    "../renderer-host/loader": loader,
    "../renderer-host/relay": relay,
    "./registry": registryModule,
  },
);

const { useRendererCandidates } = loadTsx(
  "../src/plugins/renderer-slots/use-renderer-candidates.ts",
  {
    react: React,
    "../../stores/app-store": storeModule,
    "./candidates": candidatesModule,
  },
);

const { PluginLayerHost } = loadTsx(
  "../src/plugins/renderer-slots/PluginLayerHost.tsx",
  {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    // The portal host needs a real DOM; what this file asserts is what the
    // layer draws, so the box is rendered where the host asked for it.
    "../../components/ui": { portalOverlay: (node) => node },
    "../../stores/app-store": storeModule,
    "./SlotOutlet": { PluginSlot, useSlotRegistrations },
    "./registry": registryModule,
    "./use-renderer-candidates": { useRendererCandidates },
  },
);

/** A plugin row the mount points read: `renderer` granted, actions declared. */
function pluginRow(id, rendererActions) {
  return {
    id,
    version: "1.0.0",
    capabilities: ["renderer"],
    rendererData: [],
    rendererActions,
  };
}

/** A layer body that names its owner in the markup the host draws. */
function layerBody(className) {
  return () => React.createElement("span", { className }, className);
}

function reset(plugins = []) {
  resetPluginSlots();
  relay.resetRendererRelay();
  loader.resetRendererPlugins();
  storeState.plugins = plugins;
  storeState.activeSessionId = "session-1";
  installRendererHostActions();
}

function renderLayers() {
  return renderToStaticMarkup(React.createElement(PluginLayerHost));
}

test("a plugin dismisses and restores its own layer through its own actions", async () => {
  reset([pluginRow("acme.layers", ["ui.openModal", "ui.closeModal"])]);
  const handle = pluginSlots.register("acme.layers", "modal", layerBody("acme-modal-body"));
  assert.notEqual(handle, null, "the modal registration was refused");

  const opened = renderLayers();
  assert.match(opened, /data-pi-plugin-layer="modal"/);
  assert.match(opened, /acme-modal-body/);

  // `ui.closeModal` withdraws the layer without touching the registration.
  assert.deepEqual(await relay.dispatchFromPlugin("acme.layers", "ui.closeModal"), {
    ok: true,
    slot: "modal",
    visible: false,
  });
  assert.equal(pluginSlots.isLayerWithdrawn("acme.layers", "modal"), true);
  assert.equal(
    pluginSlots.list("modal").length,
    1,
    "the registration is what the plugin owns; a dismissal does not remove it",
  );
  const closed = renderLayers();
  assert.doesNotMatch(closed, /data-pi-plugin-layer/);
  assert.doesNotMatch(closed, /acme-modal-body/);

  // `ui.openModal` shows the same registration again.
  assert.deepEqual(await relay.dispatchFromPlugin("acme.layers", "ui.openModal"), {
    ok: true,
    slot: "modal",
    visible: true,
  });
  assert.equal(pluginSlots.isLayerWithdrawn("acme.layers", "modal"), false);
  const reopened = renderLayers();
  assert.match(reopened, /data-pi-plugin-layer="modal"/);
  assert.match(reopened, /acme-modal-body/);

  // The host's own Escape writes that same state, so what it drops is restored
  // by the plugin's next `ui.openModal` rather than by a new registration.
  assert.equal(pluginSlots.setLayerWithdrawn("acme.layers", "modal", true), true);
  assert.doesNotMatch(renderLayers(), /acme-modal-body/);
  await relay.dispatchFromPlugin("acme.layers", "ui.openModal");
  assert.match(renderLayers(), /acme-modal-body/);

  // A declaration is still what an action is checked against first: this plugin
  // never declared the overlay actions, and no handler is reached for them.
  await assert.rejects(
    () => relay.dispatchFromPlugin("acme.layers", "ui.closeOverlay"),
    (error) => error.code === "PLUGIN_ACTION_UNDECLARED",
  );

  // A fresh registration is a layer on screen: the withdrawal belonged to the
  // registration it replaced.
  handle.remove();
  assert.doesNotMatch(renderLayers(), /data-pi-plugin-layer/);
  const fresh = pluginSlots.register("acme.layers", "modal", layerBody("acme-modal-body"));
  assert.notEqual(fresh, null, "the modal position was not free again");
  assert.equal(pluginSlots.isLayerWithdrawn("acme.layers", "modal"), false);
  assert.match(renderLayers(), /acme-modal-body/);
  fresh.remove();
});

test("a plugin can only withdraw its own layer position", async () => {
  reset([
    pluginRow("acme.a", ["ui.closeModal", "ui.closeOverlay"]),
    pluginRow("acme.b", ["ui.closeModal", "ui.closeOverlay"]),
  ]);
  pluginSlots.register("acme.a", "overlay", layerBody("acme-a-overlay"));
  pluginSlots.register("acme.b", "overlay", layerBody("acme-b-overlay"));
  pluginSlots.register("acme.a", "modal", layerBody("acme-a-modal"));

  const both = renderLayers();
  assert.match(both, /acme-a-overlay/);
  assert.match(both, /acme-b-overlay/);
  assert.match(both, /acme-a-modal/);

  // B closes its own overlay. A's layer is not B's to touch.
  assert.deepEqual(await relay.dispatchFromPlugin("acme.b", "ui.closeOverlay"), {
    ok: true,
    slot: "overlay",
    visible: false,
  });
  assert.equal(pluginSlots.isLayerWithdrawn("acme.b", "overlay"), true);
  assert.equal(pluginSlots.isLayerWithdrawn("acme.a", "overlay"), false);
  const afterB = renderLayers();
  assert.match(afterB, /acme-a-overlay/);
  assert.doesNotMatch(afterB, /acme-b-overlay/);

  // The two positions are separate: A's modal closes, A's overlay stays.
  assert.deepEqual(await relay.dispatchFromPlugin("acme.a", "ui.closeModal"), {
    ok: true,
    slot: "modal",
    visible: false,
  });
  const afterA = renderLayers();
  assert.doesNotMatch(afterA, /acme-a-modal/);
  assert.match(afterA, /acme-a-overlay/);

  // B has no modal of its own, so it cannot close one — and the only layer on
  // screen, A's overlay, is untouched by the attempt.
  await assert.rejects(
    () => relay.dispatchFromPlugin("acme.b", "ui.closeModal"),
    (error) => error.code === "PLUGIN_ACTION_LAYER_NOT_REGISTERED",
  );
  assert.equal(pluginSlots.isLayerWithdrawn("acme.a", "overlay"), false);
  assert.equal(pluginSlots.isLayerWithdrawn("acme.a", "modal"), true);
  assert.match(renderLayers(), /acme-a-overlay/);
});

test("every layer action is refused with a code when the plugin registered nothing", async () => {
  reset([
    pluginRow("acme.empty", [
      "ui.openModal",
      "ui.closeModal",
      "ui.openOverlay",
      "ui.closeOverlay",
    ]),
  ]);
  // The declaration is checked before any handler is reached, and what holds it
  // is any position that draws this plugin: a layer host draws nothing while no
  // layer is registered, so the row is recorded here the way every mounted
  // position records it at render time. Without it, the refusal below would be
  // `PLUGIN_ACTION_UNDECLARED` instead of the handler's own code.
  loader.rememberRendererActions("acme.empty", [
    "ui.openModal",
    "ui.closeModal",
    "ui.openOverlay",
    "ui.closeOverlay",
  ]);
  assert.equal(renderLayers(), "", "nothing is registered, so nothing is drawn");

  const dispatched = ["ui.openModal", "ui.closeModal", "ui.openOverlay", "ui.closeOverlay"];
  for (const action of dispatched) {
    await assert.rejects(
      () => relay.dispatchFromPlugin("acme.empty", action),
      (error) => {
        assert.equal(error.code, "PLUGIN_ACTION_LAYER_NOT_REGISTERED");
        assert.equal(error.pluginId, "acme.empty");
        assert.equal(error.action, action);
        return true;
      },
      `${action} must be refused rather than resolved`,
    );
  }

  // One diagnostic per refusal on this plugin's own row, and no state change:
  // a layer that was never registered cannot be withdrawn.
  const refusals = pluginSlots
    .listDiagnostics("acme.empty")
    .filter((entry) => entry.code === "PLUGIN_ACTION_LAYER_NOT_REGISTERED");
  assert.equal(refusals.length, dispatched.length);
  assert.deepEqual(
    refusals.map((entry) => entry.detail),
    dispatched.map((action, index) =>
      `${dispatched[index]} found no "${index < 2 ? "modal" : "overlay"}" layer registered by this plugin`,
    ),
  );
  assert.equal(pluginSlots.isLayerWithdrawn("acme.empty", "modal"), false);
  assert.equal(pluginSlots.isLayerWithdrawn("acme.empty", "overlay"), false);
  assert.equal(renderLayers(), "");
});
