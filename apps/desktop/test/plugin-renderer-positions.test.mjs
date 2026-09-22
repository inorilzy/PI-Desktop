/**
 * The transcript and overlay positions a plugin can mount into (spec
 * 07-plugins/16 2A.5, ADR 0291 / ADR 0294).
 *
 * `entryExtra` and `codeBlock` shipped with the outlet; this suite covers the
 * five that follow — `entry`, `toolCard`, `inlineConfirm`, `modal`, `overlay` —
 * through the real components: a plugin registers a component, the host renders
 * it, and the host's own rendering must be what a window without that plugin
 * keeps. Every case checks both halves, because "a plugin fills the position"
 * and "nothing changes for a user with no plugin" are the same contract.
 *
 * The components are loaded through Vite SSR, so a row really travels its
 * production chain: MessageRow/ToolRow/ChatTranscript -> PluginSlot -> relay,
 * and the layers really portal into the host's overlay root.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const PLUGIN = {
  id: "acme.notes",
  name: "Notes",
  version: "1.0.0",
  capabilities: ["renderer"],
  rendererData: ["entry", "session"],
  rendererActions: ["ui.toast"],
};

const OTHER_PLUGIN = { ...PLUGIN, id: "acme.other", name: "Other" };

let server;
let i18n;
let MessageRow;
let ToolRow;
let ChatTranscript;
let PluginLayerHost;
let pluginSlots;
let resetPluginSlots;
let relay;
let loader;
let useAppStore;

/** Every node the host asked the overlay root to hold, by the stub's count. */
let portalCalls;

/** Every element `overlayRoot()` had to create, in order. */
const overlayRoots = [];

function fakeElement(tag) {
  return {
    tag,
    id: "",
    children: [],
    setAttribute() {},
    // `createPortal` accepts a node with `nodeType` 1.
    nodeType: 1,
    appendChild(node) {
      this.children.push(node);
      return node;
    },
  };
}

before(async () => {
  // `overlayRoot()` mints `#pi-desktop-overlays` on the first portal, so the
  // fake document is also the record of whether a layer was mounted at all.
  globalThis.document = {
    documentElement: { dataset: {}, appendChild() {} },
    getElementById: () => null,
    createElement: (tag) => {
      const element = fakeElement(tag);
      overlayRoots.push(element);
      return element;
    },
  };
  // `lib/api` captures the preload bridge at import time.
  globalThis.piDesktop = {
    invoke: async () => ({ ok: true, data: null }),
    on: () => () => {},
    channels: {},
    platform: "darwin",
  };
  // `overlayRoot()` checks `existing instanceof HTMLElement` before minting one,
  // and mints `#pi-desktop-overlays` on the first portal — so the fake document
  // is also the record of whether a layer was portaled at all.
  globalThis.HTMLElement = class HTMLElement {};
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    // The layer positions portal through `components/ui`, and the legacy server
    // renderer refuses portals. Only that one boundary is flattened, and only
    // for the specifier `PluginLayerHost` uses; the transcript rows keep the
    // real kit.
    resolve: {
      alias: [
        {
          find: "../../components/ui",
          replacement: fileURLToPath(
            new URL("./helpers/portal-inline.mjs", import.meta.url),
          ),
        },
      ],
    },
  });
  ({ MessageRow } = await server.ssrLoadModule(
    "/src/features/chat/transcript/MessageRow.tsx",
  ));
  ({ ToolRow } = await server.ssrLoadModule(
    "/src/features/chat/transcript/ToolRow.tsx",
  ));
  ({ ChatTranscript } = await server.ssrLoadModule(
    "/src/features/chat/transcript/ChatTranscript.tsx",
  ));
  ({ PluginLayerHost } = await server.ssrLoadModule(
    "/src/plugins/renderer-slots/PluginLayerHost.tsx",
  ));
  ({ pluginSlots, resetPluginSlots } = await server.ssrLoadModule(
    "/src/plugins/renderer-slots/registry.ts",
  ));
  relay = await server.ssrLoadModule("/src/plugins/renderer-host/relay.ts");
  loader = await server.ssrLoadModule("/src/plugins/renderer-host/loader.ts");
  ({ useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts"));
  i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
  ({ portalCalls } = await server.ssrLoadModule("/test/helpers/portal-inline.mjs"));
});

after(async () => {
  await server?.close();
});

function render(node) {
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, node));
}

/** A window whose plugin list holds `plugins`, with a clean renderer host. */
function reset(plugins = [PLUGIN]) {
  resetPluginSlots();
  relay.resetRendererRelay();
  loader.resetRendererPlugins();
  portalCalls.length = 0;
  // A server render reads the store's *initial* state, the snapshot
  // `useAppStore` hands React, so the row is installed there.
  Object.assign(useAppStore.getInitialState(), {
    plugins,
    activeSessionId: "session-1",
    pluginRewrites: {},
  });
}

const userMessage = {
  id: "m1",
  role: "user",
  content: "Review the changes",
  status: "complete",
  createdAt: "2026-09-19T12:00:00.000Z",
};

/** A tool row whose tool carries `acme.notes`'s forced prefix (D015). */
const ownedToolMessage = {
  id: "t1",
  role: "tool",
  content: "",
  createdAt: "2026-09-19T12:00:00.000Z",
  toolName: "plugin_acme_notes_chart",
  toolCallId: "call-1",
  toolStatus: "success",
  toolArgs: { value: "abc" },
  toolResult: { ok: true, rows: 2 },
};

function textComponent(className, seen) {
  return (props) => {
    seen?.push(props);
    return createElement("div", { className }, "plugin surface");
  };
}

test("`entry` replaces the whole message, and its absence is the host's own row", () => {
  reset();
  const bare = render(createElement(MessageRow, { message: userMessage, isRunning: false }));
  assert.match(bare, /class="message-row user"/);
  assert.match(bare, /class="message-bubble"/);
  assert.match(bare, /Review the changes/);
  assert.doesNotMatch(bare, /data-pi-plugin/);

  const seen = [];
  pluginSlots.register("acme.notes", "entry", textComponent("acme-entry", seen));
  const markup = render(createElement(MessageRow, { message: userMessage, isRunning: false }));
  assert.match(markup, /class="acme-entry"/);
  assert.match(markup, /data-pi-plugin="acme\.notes"/);
  assert.match(markup, /data-pi-plugin-slot="entry"/);
  // The host's own message gave the position up, and the row's other areas are
  // still the row's: only the message was the plugin's to draw.
  assert.doesNotMatch(markup, /class="message-bubble"/);
  assert.equal(seen[0].entry.id, "m1");
  assert.equal(seen[0].entry.role, "user");
  assert.equal(seen[0].sessionId, "session-1");
  assert.equal(typeof seen[0].dispatch, "function");
  // D14: no producer is known for a human message, so no plugin is claimed.
  assert.equal(seen[0].entry.pluginId, undefined);
});

test("`toolCard` draws the body of a plugin's own tool, and only that tool's row", () => {
  reset();
  // A plugin tool whose plugin registered nothing keeps today's row.
  const bare = render(createElement(ToolRow, { message: ownedToolMessage }));
  assert.doesNotMatch(bare, /data-pi-plugin/);

  const seen = [];
  pluginSlots.register("acme.notes", "toolCard", textComponent("acme-tool-card", seen));
  const markup = render(createElement(ToolRow, { message: ownedToolMessage }));
  assert.match(markup, /class="acme-tool-card"/);
  assert.match(markup, /data-pi-plugin="acme\.notes"/);
  assert.match(markup, /data-pi-plugin-slot="toolCard"/);
  assert.match(markup, /class="tool-row-body"/);
  // The host's own blocks are what the plugin's body replaced.
  assert.doesNotMatch(markup, /tool-row-content/);
  // The position's data names the row and the plugin the host attributed it to
  // from the tool's forced prefix, which is what lets the component confirm it
  // is drawing its own tool.
  assert.equal(seen[0].entry.id, "t1");
  assert.equal(seen[0].entry.role, "assistant");
  assert.equal(seen[0].entry.pluginId, "acme.notes");
  assert.equal(seen[0].sessionId, "session-1");
  assert.equal(typeof seen[0].dispatch, "function");

  // A host tool's card is never taken over…
  const hostTool = render(
    createElement(ToolRow, {
      message: { ...ownedToolMessage, toolName: "Read", toolArgs: { path: "a.ts" } },
    }),
  );
  assert.doesNotMatch(hostTool, /acme-tool-card|data-pi-plugin/);
  // …and neither is another plugin's tool.
  const otherTool = render(
    createElement(ToolRow, {
      message: { ...ownedToolMessage, toolName: "plugin_acme_other_plot" },
    }),
  );
  assert.doesNotMatch(otherTool, /acme-tool-card|data-pi-plugin/);
});

test("`toolCard` is not offered to a plugin that is no longer installed", () => {
  reset([]);
  pluginSlots.register("acme.notes", "toolCard", textComponent("acme-tool-card"));
  const markup = render(createElement(ToolRow, { message: ownedToolMessage }));
  assert.doesNotMatch(markup, /acme-tool-card|data-pi-plugin/);
});

test("`inlineConfirm` takes the host's inline confirmation position, or leaves it", () => {
  reset([PLUGIN, OTHER_PLUGIN]);
  const pendingPermission = {
    requestId: "request-1",
    sessionId: "session-1",
    toolCallId: "call-1",
    toolName: "Bash",
    argsPreview: { command: "ls" },
    risk: "medium",
    reason: "runs a command",
    receivedAt: Date.now(),
  };
  const bare = render(
    createElement(ChatTranscript, {
      sessionId: "session-1",
      messages: [userMessage],
      isRunning: false,
      pendingPermission,
    }),
  );
  assert.match(bare, /class="permission-card/);
  assert.doesNotMatch(bare, /data-pi-plugin/);

  const seen = [];
  pluginSlots.register(
    "acme.notes",
    "inlineConfirm",
    textComponent("acme-inline-confirm", seen),
  );
  const markup = render(
    createElement(ChatTranscript, {
      sessionId: "session-1",
      messages: [userMessage],
      isRunning: false,
      pendingPermission,
    }),
  );
  assert.match(markup, /class="acme-inline-confirm"/);
  assert.match(markup, /data-pi-plugin="acme\.notes"/);
  assert.match(markup, /data-pi-plugin-slot="inlineConfirm"/);
  assert.doesNotMatch(markup, /class="permission-card/);
  assert.equal(seen[0].sessionId, "session-1");
  assert.equal(typeof seen[0].dispatch, "function");
});

test("`modal` and `overlay` take the host's overlay root, and only when filled", () => {
  reset();
  const empty = render(createElement(PluginLayerHost));
  assert.equal(empty, "");
  // No plugin fills either layer, so the host does not even ask for the root.
  assert.equal(portalCalls.length, 0);

  const modalSeen = [];
  const overlaySeen = [];
  pluginSlots.register("acme.notes", "modal", textComponent("acme-modal", modalSeen));
  const modal = render(createElement(PluginLayerHost));
  assert.match(modal, /data-pi-plugin-layer="modal"/);
  assert.match(modal, /class="overlay pi-plugin-layer is-modal"/);
  assert.match(modal, /class="acme-modal"/);
  assert.match(modal, /data-pi-plugin-slot="modal"/);
  assert.equal(modalSeen[0].sessionId, "session-1");
  assert.equal(typeof modalSeen[0].dispatch, "function");
  // Only the modal was placed in the root; the overlay position still mounts
  // nothing at all.
  assert.equal(portalCalls.length, 1);
  assert.doesNotMatch(modal, /is-overlay/);

  pluginSlots.register("acme.notes", "overlay", textComponent("acme-overlay", overlaySeen));
  const both = render(createElement(PluginLayerHost));
  assert.match(both, /data-pi-plugin-layer="overlay"/);
  assert.match(both, /class="pi-plugin-layer is-overlay"/);
  assert.match(both, /class="acme-overlay"/);
  assert.equal(overlaySeen[0].sessionId, "session-1");
  assert.equal(portalCalls.length, 3);
  // The overlay is the transient layer, not the blocking dialog: it does not
  // carry the host's own scrim.
  assert.doesNotMatch(both, /class="overlay pi-plugin-layer is-overlay"/);
});

test("Escape is the host's way out of a plugin layer, and it leaves the host's own alone", () => {
  // The dismissal itself is a window keydown effect, and this process has no
  // DOM to run effects in, so the contract is pinned at the source: the host
  // listens for Escape and hides the layer it owns, and it neither captures the
  // key nor prevents it, which is what keeps the host's own dialogs closing on
  // Escape exactly as before.
  const source = readFileSync(
    new URL("../src/plugins/renderer-slots/PluginLayerHost.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /window\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(source, /event\.key !== "Escape"/);
  assert.doesNotMatch(source, /preventDefault|stopPropagation|capture: true/);
  // The withdrawal is host state keyed by the plugin that owns the layer, held
  // by the slot registry so the plugin's own layer actions write the same state
  // this effect does.
  assert.match(source, /pluginSlots\.isLayerWithdrawn\(registration\.pluginId, slot\)/);
  assert.match(source, /pluginSlots\.setLayerWithdrawn\(registration\.pluginId, slot, true\)/);
});

test("a withdrawn layer leaves the screen while its registration stays", () => {
  reset();
  pluginSlots.register("acme.notes", "overlay", textComponent("acme-overlay"));
  assert.match(render(createElement(PluginLayerHost)), /acme-overlay/);

  // This is what Escape does, and what the plugin's own `ui.closeOverlay` does:
  // the host withdraws the layer. The registration is untouched — which is why
  // restoring the layer needs nothing from the plugin but `ui.openOverlay`.
  assert.equal(pluginSlots.setLayerWithdrawn("acme.notes", "overlay", true), true);
  assert.equal(render(createElement(PluginLayerHost)), "");
  assert.equal(
    pluginSlots.list("overlay").length,
    1,
    "withdrawing a layer is not withdrawing its registration",
  );

  assert.equal(pluginSlots.setLayerWithdrawn("acme.notes", "overlay", false), true);
  assert.match(render(createElement(PluginLayerHost)), /acme-overlay/);

  // Only the plugin that owns a layer can withdraw it: another plugin's request
  // for that position answers false and changes nothing.
  pluginSlots.register("acme.other", "overlay", textComponent("acme-other-overlay"));
  assert.equal(pluginSlots.setLayerWithdrawn("acme.other", "modal", true), false);
  assert.equal(pluginSlots.isLayerWithdrawn("acme.notes", "overlay"), false);
  const both = render(createElement(PluginLayerHost));
  assert.match(both, /acme-overlay/);
  assert.match(both, /acme-other-overlay/);
});

test("a plugin that is unloaded takes its modal and its overlay with it (D10)", () => {
  reset();
  pluginSlots.register("acme.notes", "modal", textComponent("acme-modal"));
  pluginSlots.register("acme.notes", "overlay", textComponent("acme-overlay"));
  const before = render(createElement(PluginLayerHost));
  assert.match(before, /acme-modal/);
  assert.match(before, /acme-overlay/);

  // Unload, disable and uninstall all end here: the registrations are gone, so
  // the next render has no layer to draw and nothing is left on screen.
  pluginSlots.unregisterPlugin("acme.notes");
  const afterUnload = render(createElement(PluginLayerHost));
  assert.equal(afterUnload, "");
  assert.doesNotMatch(afterUnload, /data-pi-plugin-layer/);
});
