/**
 * The `codeBlock` position end to end through the real Markdown pipeline.
 *
 * Every slot component is handed the plugin's own `dispatch` and every mount
 * hands the loader the row it renders for (ADR 0294). `entryExtra` always did
 * that through `PluginSlot`; `codeBlock` used to render its registration
 * directly, so a code-block plugin received no `dispatch` and the block never
 * carried its plugin's declared actions to the loader. These cases render
 * `Markdown.tsx` through Vite SSR, so a block really travels the production
 * chain: Markdown -> PreBlock -> PluginSlot -> relay.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/** A plugin row exactly as the plugins page hands it to a mount point. */
const PLUGIN = {
  id: "acme.notes",
  name: "Notes",
  version: "1.0.0",
  capabilities: ["renderer"],
  rendererData: ["code", "theme"],
  rendererActions: ["ui.toast"],
};

let server;
let i18n;
let Markdown;
let pluginSlots;
let resetPluginSlots;
let relay;
let loader;
let useAppStore;

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  // `useThemeMode` reads the theme off the document during render.
  globalThis.document = { documentElement: { dataset: {} } };
  ({ Markdown } = await server.ssrLoadModule("/src/components/Markdown.tsx"));
  ({ pluginSlots, resetPluginSlots } = await server.ssrLoadModule(
    "/src/plugins/renderer-slots/registry.ts",
  ));
  relay = await server.ssrLoadModule("/src/plugins/renderer-host/relay.ts");
  loader = await server.ssrLoadModule("/src/plugins/renderer-host/loader.ts");
  ({ useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts"));
  i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
});

after(async () => {
  await server?.close();
});

function render(source) {
  return renderToStaticMarkup(
    createElement(I18nextProvider, { i18n }, createElement(Markdown, { source })),
  );
}

/** The component a plugin would register for its own fenced language. */
function chartComponent(onProps) {
  return (props) => {
    onProps?.(props);
    return createElement("span", { className: "acme-chart" }, "drawn");
  };
}

function reset(codeBlockPlugin = PLUGIN) {
  resetPluginSlots();
  relay.resetRendererRelay();
  loader.resetRendererPlugins();
  // A server render reads the store's *initial* state (that is the snapshot
  // `useAppStore` hands React), so the plugin row is installed there.
  Object.assign(useAppStore.getInitialState(), {
    plugins: codeBlockPlugin ? [codeBlockPlugin] : [],
  });
}

test("a codeBlock plugin draws through the outlet with dispatch, and reaches the relay", async () => {
  reset();
  const seen = [];
  const removeToast = relay.registerHostRendererAction("ui.toast", (payload, pluginId) => {
    seen.push({ payload, pluginId });
    return { shown: true };
  });
  let received;
  pluginSlots.register(
    "acme.notes",
    "codeBlock",
    chartComponent((props) => {
      received = props;
    }),
    { language: "acme.notes:chart" },
  );

  const source = "Before.\n\n```acme.notes:chart\nA --> B\n```\n";
  const markup = render(source);

  // The plugin drew the block, and the host's own block did not.
  assert.match(markup, /class="acme-chart"/);
  assert.doesNotMatch(markup, /class="code-block"/);
  // The plugin container is the block's container, source anchors included.
  const container = /<div[^>]*data-pi-plugin="acme\.notes"[^>]*>/.exec(markup)?.[0];
  assert.ok(container, "the drawn block sits in the plugin's container");
  const start = source.indexOf("```acme.notes:chart");
  const end = source.lastIndexOf("```") + 3;
  assert.match(container, new RegExp(`data-source-start="${start}"`));
  assert.match(container, new RegExp(`data-source-end="${end}"`));

  // Exactly the codeBlock contract's data, plus the plugin's own dispatch.
  assert.equal(received.language, "acme.notes:chart");
  assert.equal(received.code, "A --> B");
  assert.equal(received.isIncomplete, false);
  assert.equal(typeof received.dispatch, "function");

  // A declared action runs in the host and answers the plugin, under the id of
  // the plugin that dispatched.
  assert.deepEqual(await received.dispatch("ui.toast", { text: "hi" }), { shown: true });
  assert.deepEqual(seen, [{ payload: { text: "hi" }, pluginId: "acme.notes" }]);

  // An action the plugin never declared is refused and diagnosed, not silent.
  await assert.rejects(
    () => received.dispatch("composer.replaceDraft", { text: "x" }),
    (error) =>
      error.code === "PLUGIN_ACTION_UNDECLARED" && error.action === "composer.replaceDraft",
  );
  assert.deepEqual(
    pluginSlots.listDiagnostics().map((entry) => [entry.pluginId, entry.code]),
    [["acme.notes", "PLUGIN_ACTION_UNDECLARED"]],
  );
  removeToast();
});

test("a language nobody claims keeps the host's own code block", async () => {
  reset();
  let received = null;
  pluginSlots.register(
    "acme.notes",
    "codeBlock",
    chartComponent((props) => {
      received = props;
    }),
    { language: "acme.notes:chart" },
  );

  const markup = render("```acme.notes:other\nA --> B\n```\n");
  assert.equal(received, null, "a plugin is never asked for a language it did not claim");
  assert.doesNotMatch(markup, /acme-chart|data-pi-plugin/);
  assert.match(markup, /class="code-block"/);
  assert.match(markup, /acme\.notes:other/);

  // The same holds when no plugin registers for the slot at all.
  resetPluginSlots();
  const bare = render("```acme.notes:chart\nA --> B\n```\n");
  assert.equal(received, null);
  assert.doesNotMatch(bare, /acme-chart|data-pi-plugin/);
  assert.match(bare, /class="code-block"/);
});

test("an open fence never reaches a plugin component", async () => {
  reset();
  let received = null;
  pluginSlots.register(
    "acme.notes",
    "codeBlock",
    chartComponent((props) => {
      received = props;
    }),
    { language: "acme.notes:chart" },
  );

  const markup = render("```acme.notes:chart\nA --> B\n");
  assert.equal(received, null);
  assert.match(markup, /class="code-block"/);
});

test("the codeBlock mount carries its candidates without a hand-rolled relay", () => {
  // The mount is the outlet, not a second copy of it: a hand-wired path would
  // have to repeat loading, dispatch, the boundary and the container contract.
  const source = readFileSync(new URL("../src/components/Markdown.tsx", import.meta.url), "utf8");
  assert.match(source, /<PluginSlot\s+slot="codeBlock"/);
  assert.doesNotMatch(source, /PluginCodeBlockBoundary/);
  assert.doesNotMatch(source, /slotDispatchFor/);
});

test("a codeBlock component's dispatch reaches the installed host actions", async () => {
  reset();
  // What the app entry does once at startup; a slot render alone would only
  // have the relay, with every declared action unrouted.
  const { installRendererHostActions } = await server.ssrLoadModule(
    "/src/plugins/renderer-host/host-actions.ts",
  );
  installRendererHostActions();
  useAppStore.setState({ toasts: [] });

  let received;
  pluginSlots.register(
    "acme.notes",
    "codeBlock",
    chartComponent((props) => {
      received = props;
    }),
    { language: "acme.notes:chart" },
  );

  render("```acme.notes:chart\nA --> B\n```\n");
  assert.equal(typeof received.dispatch, "function");
  await received.dispatch("ui.toast", { message: "from a code block", variant: "error" });
  assert.deepEqual(
    useAppStore.getState().toasts.map((toast) => [toast.message, toast.variant]),
    [["from a code block", "error"]],
  );
});
