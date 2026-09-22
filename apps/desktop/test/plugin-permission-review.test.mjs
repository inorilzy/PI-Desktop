import {
  readMainModuleSync,
  readMainSourceSync,
  readPluginsSourceSync,
  readSharedTypesSourceSync,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "..", "..");

const mainSrc = readMainSourceSync();
const pluginIpcSrc = readMainModuleSync("ipc/plugin-ipc.ts");
const runtimeSrc = readFileSync(
  join(desktopRoot, "electron/main/plugin-runtime.ts"),
  "utf8",
);
const pluginsUiSrc = readPluginsSourceSync();
const sharedTypesSrc = readSharedTypesSourceSync();
const protocolSrc = readFileSync(
  join(repoRoot, "packages/shared/src/protocol.ts"),
  "utf8",
);

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { declarationLabel, rendererDeclaration } = await import(
  "../src/features/plugins/model.ts"
);
const { catalogs, flattenCatalog } = await import(
  "../../../packages/i18n/src/index.ts"
);
// The vocabulary is the SDK's, not a copy: a name added or removed there has to
// reach the catalogs in the same change (issue #528).
const { PLUGIN_RENDERER_ACTIONS, PLUGIN_RENDERER_DATA } = await import(
  "../../../packages/plugin-sdk/src/renderer.ts"
);

const DECLARED_DATA = [...PLUGIN_RENDERER_DATA];
const DECLARED_ACTIONS = [...PLUGIN_RENDERER_ACTIONS];

const english = flattenCatalog(catalogs.en);

/** i18next resolution for one catalog: the value, else the key's fallback. */
function translator(flat) {
  return (key, options) => flat[key] ?? options?.defaultValue ?? key;
}

function slice(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `${from} missing`);
  const end = to === undefined ? source.length : source.indexOf(to, start);
  assert.ok(end > start, `${to} missing after ${from}`);
  return source.slice(start, end);
}

test("choosing a dev plugin folder reports a review instead of loading it", () => {
  const pick = slice(
    mainSrc,
    "handle(IPC.invoke.pluginLoadDev,",
    "IPC.invoke.pluginLoadDevConfirm",
  );
  assert.match(pick, /return \{ canceled: false, review: reviewFor\(result\.filePaths\[0\], "load"\) \}/);
  // The folder picker must not load: the answer is what loads it.
  assert.doesNotMatch(pick, /loadFromPath/);
  assert.doesNotMatch(pick, /plugins\.watchDevPlugin/);
  // Nor may it register the plugin before the user has seen the declaration.
  assert.doesNotMatch(pick, /plugins\.loadDev"/);

  const confirm = slice(
    mainSrc,
    "IPC.invoke.pluginLoadDevConfirm",
    "handle(IPC.invoke.pluginReload,",
  );
  assert.match(confirm, /const loaded = await loadDevPlugin\(path, granted, "loadDev"\)/);
  assert.match(confirm, /grantedPermissions/);
});

test("the template scaffold writes files and then asks the same question", () => {
  const create = slice(mainSrc, "IPC.invoke.pluginCreateFromTemplate", "\n  handle(IPC.invoke.pluginInstallFromPath,");
  assert.match(create, /const created = await scaffold\(\{ dir, template \}\)/);
  assert.match(create, /review: reviewFor\(dir, "load"\)/);
  assert.doesNotMatch(create, /loadFromPath/);
  assert.doesNotMatch(create, /watchDevPlugin/);
});

test("an approved load registers the folder with exactly what was accepted", () => {
  const loader = slice(pluginIpcSrc, "const loadDevPlugin = async (", "/** A development plugin folder as a review");
  // Registry row first (it rewrites the declaration), then the load, then the
  // watch whose ceiling is the approval.
  assert.match(loader, /host\.call<\{ plugin: any \}>\("plugins\.loadDev", \{ path \}\)/);
  assert.match(loader, /await plugins\.loadFromPath\(path, grantedPermissions, \{ development: true \}\)/);
  assert.match(loader, /if \(loaded\.plugin\?\.id\) plugins\.watchDevPlugin\(loaded\.plugin\.id\)/);
  assert.ok(
    loader.indexOf("plugins.loadDev\"") < loader.indexOf("loadFromPath"),
    "the registry row is rewritten before the load",
  );
  assert.ok(
    loader.indexOf("loadFromPath") < loader.indexOf("watchDevPlugin"),
    "the approval is recorded only after the plugin loaded under it",
  );
});

test("a widening reload is answered in the renderer, never applied on its own", () => {
  const reload = slice(
    mainSrc,
    "handle(IPC.invoke.pluginReload,",
    "handle(\n    IPC.invoke.pluginReloadConfirm",
  );
  // The review names the file scope as well as permission names: a new glob is
  // asking for more, exactly like a new permission.
  assert.match(reload, /const \{ added, widened \} = beyondApproval\(id, plugin\.path\)/);
  assert.match(reload, /if \(added\.length \|\| widened\.length\) \{/);
  assert.match(reload, /review: reviewFor\(plugin\.path, "reload", \[\.\.\.added, \.\.\.widened\]\)/);
  assert.ok(
    reload.indexOf("beyondApproval(") < reload.indexOf("loadFromPath("),
    "the approval check precedes the load",
  );
  // A plugin already running under the current approval reloads straight away:
  // the common loop (edit, save, reload) must not become a dialog.
  assert.ok(
    reload.indexOf("return {\n          plugin,") < reload.indexOf("loadFromPath("),
    "the review returns before the direct load path",
  );

  const confirm = slice(
    mainSrc,
    "IPC.invoke.pluginReloadConfirm",
    "// Scaffold a starter plugin",
  );
  // The path comes from the host's own registry, never from the renderer.
  assert.match(confirm, /const listed = await host\.call<\{ plugins: any\[\] \}>\("plugins\.list"\)/);
  assert.doesNotMatch(confirm, /input\?\.path/);
  assert.match(confirm, /const loaded = await loadDevPlugin\(plugin\.path, granted, "reload"\)/);
});

test("the approval record is what a reload is measured against", () => {
  const approval = slice(runtimeSrc, "devApproval(pluginId: string)", "\n  /** Stop every watch");
  assert.match(approval, /const dev = this\.devPlugins\.get\(pluginId\)/);
  assert.match(approval, /return dev \? \{ permissions: \[\.\.\.dev\.permissions\], fs: dev\.fs \} : null/);

  const beyond = slice(pluginIpcSrc, "const beyondApproval = (", "handle(IPC.invoke.pluginLoadDev,");
  // No record means this session never reviewed it: the load itself is the
  // review, so everything counts as new.
  assert.match(beyond, /if \(!approval\) \{/);
  assert.match(beyond, /return \{ declared, added: declared\.permissions, widened: \[\] as string\[\] \}/);
  assert.match(beyond, /widened: widenedFsScope\(approval\.fs, declared\.fs\)/);
  assert.match(runtimeSrc, /export function widenedFsScope\(ceiling: PluginFsPolicy, next: PluginFsPolicy\): string\[\]/);

  // The declaration is read from disk and validated, so a broken manifest is
  // refused before a review can offer it.
  const declaration = slice(runtimeSrc, "export function readDevPluginDeclaration", "\n}\n");
  assert.match(declaration, /PLUGIN_INVALID: manifest\.json missing/);
  assert.match(declaration, /const validated = validateManifest\(raw\)/);
  assert.match(declaration, /if \(!validated\.ok \|\| !validated\.manifest\)/);
});

test("the refusal names an action that exists", () => {
  const reload = slice(runtimeSrc, "async reloadDevPlugin(", "\n  async invokePanelBridge");
  assert.match(reload, /PERMISSION_DENIED: manifest now requests/);
  // The old text pointed at a folder picker that reviewed nothing.
  assert.doesNotMatch(reload, /load the plugin again to review/);
  assert.match(reload, /reload it from the Plugins page to review/);
  // The hard refusal itself is unchanged: hot reload still cannot widen.
  assert.ok(
    reload.indexOf("PERMISSION_DENIED") < reload.indexOf("this.loadFromPath"),
    "the permission check must precede the load",
  );
});

test("the renderer holds the declaration until the user answers", () => {
  assert.match(pluginsUiSrc, /const \[pendingReview, setPendingReview\] = useState<PluginPermissionReview \| null>\(null\)/);
  const loadDev = slice(pluginsUiSrc, "const loadDev = () =>", "// A pi CLI extension becomes a development plugin");
  assert.match(loadDev, /const result = await api\.loadDevPlugin\(\)/);
  assert.match(loadDev, /if \(result\.canceled \|\| !result\.review\) return/);
  assert.match(loadDev, /setPendingReview\(result\.review\)/);
  assert.doesNotMatch(loadDev, /loadDevDone/);

  const reload = slice(pluginsUiSrc, "const reloadPlugin = (id: string) =>", "const installPackage = () =>");
  assert.match(reload, /if \(result\.review\) \{/);
  assert.match(reload, /setPendingReview\(result\.review\)/);

  const confirm = slice(pluginsUiSrc, "const confirmReview = async () =>", "const overflowActions = [");
  assert.match(confirm, /await api\.confirmReloadPlugin\(\{/);
  assert.match(confirm, /await api\.confirmLoadDevPlugin\(\{/);
  assert.match(confirm, /grantedPermissions: review\.permissions/);

  // One permission list for both reviews: the risk tiers and labels live in a
  // single component, so the two flows cannot disagree about what is risky.
  assert.match(pluginsUiSrc, /function PermissionGroups\(/);
  const dialogs = slice(pluginsUiSrc, "export function PluginDialogs(", "\n/* ");
  assert.equal(
    dialogs.match(/<PermissionGroups/g)?.length,
    2,
    "both the install review and the development review render the shared list",
  );
  assert.match(dialogs, /plugins\.devReviewTitle/);
  assert.match(dialogs, /plugins\.devReviewNewTitle/);
  assert.match(dialogs, /t\("plugins\.devReviewAccept"\)/);
});

test("the review contract is shared, not re-declared on each side", () => {
  assert.match(sharedTypesSrc, /export type PluginPermissionReview = \{/);
  assert.match(sharedTypesSrc, /kind: "load" \| "reload"/);
  assert.match(protocolSrc, /pluginLoadDevConfirm: "pi-desktop\/plugin\/loadDevConfirm"/);
  assert.match(protocolSrc, /pluginReloadConfirm: "pi-desktop\/plugin\/reloadConfirm"/);
});

/**
 * Issue #528: a manifest may declare what its own UI code reads and calls. The
 * review shows that list back and does nothing else — a plugin that declares
 * neither must look exactly as it did before the fields existed.
 */
test("a plugin that declares nothing renders no declaration block", () => {
  for (const plugin of [
    undefined,
    null,
    {},
    { rendererData: [] },
    { rendererActions: [] },
    { rendererData: [], rendererActions: [] },
  ]) {
    assert.equal(rendererDeclaration(plugin), null, JSON.stringify(plugin));
  }

  // The dialog asks the same question before it draws anything, so "declared
  // nothing" cannot turn into an empty heading or a placeholder line.
  const block = slice(pluginsUiSrc, "function RendererDeclaration(", "\n/* ");
  assert.match(block, /const declaration = rendererDeclaration\(plugin\)/);
  assert.match(block, /if \(!declaration\) return null;/);
  assert.ok(
    block.indexOf("if (!declaration) return null;") < block.indexOf("plugins-declaration"),
    "the guard runs before the first piece of the block",
  );
  // No hardcoded copy: every visible string comes from the catalog.
  assert.doesNotMatch(block, />\s*[A-Za-z]/);
});

test("declared data and actions reach the review in the author's order", () => {
  assert.deepEqual(
    rendererDeclaration({
      rendererData: ["entry", "draft"],
      rendererActions: ["plugin.call", "ui.toast"],
    }),
    { data: ["entry", "draft"], actions: ["plugin.call", "ui.toast"] },
  );
  // One list alone is enough for the block; the other group is simply absent.
  assert.deepEqual(rendererDeclaration({ rendererData: ["theme"] }), {
    data: ["theme"],
    actions: [],
  });
});

test("a known value gets its label and an unknown value keeps its own name", () => {
  const englishT = translator(english);
  assert.equal(declarationLabel("data", "entry", englishT), "Transcript entries");
  assert.equal(declarationLabel("actions", "ui.toast", englishT), "Show a notification");
  // A name outside the vocabulary is still something the plugin declared, so it
  // is shown as written instead of being dropped or left as a catalog key.
  for (const unknown of ["acme.telemetry", "entryExtra", "ui.openPanel"]) {
    assert.equal(declarationLabel("data", unknown, englishT), unknown);
    assert.equal(declarationLabel("actions", unknown, englishT), unknown);
    assert.equal(DECLARED_DATA.includes(unknown), false);
  }
  // The same value in both lists keeps its own namespace: an action name never
  // borrows the data label or the other way round.
  assert.equal(declarationLabel("data", "code", englishT), "Code blocks");
  assert.equal(declarationLabel("actions", "code", englishT), "code");

  const block = slice(pluginsUiSrc, "function RendererDeclaration(", "\n/* ");
  assert.match(block, /declarationLabel\("data", value, t\)/);
  assert.match(block, /declarationLabel\("actions", value, t\)/);
  // Label mapping is driven by the SDK vocabulary, so a name the host stops
  // understanding falls back to the raw value instead of a stale label.
  const label = slice(pluginsUiSrc, "const DECLARED_VALUES", "\n/* ");
  assert.match(label, /data: PLUGIN_RENDERER_DATA,/);
  assert.match(label, /actions: PLUGIN_RENDERER_ACTIONS,/);
  assert.match(label, /defaultValue: value/);
});

test("every locale names every value in the declaration vocabulary", () => {
  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    for (const key of [
      "plugins.declaration.title",
      "plugins.declaration.dataLabel",
      "plugins.declaration.actionsLabel",
    ]) {
      assert.equal(typeof flat[key], "string", `${id} ${key}`);
    }
    for (const [kind, values] of [
      ["data", DECLARED_DATA],
      ["actions", DECLARED_ACTIONS],
    ]) {
      for (const value of values) {
        const key = `plugins.declaration.${kind}.${value}`;
        const text = flat[key];
        assert.equal(typeof text, "string", `${id} ${key}`);
        assert.notEqual(text, value, `${id} ${key} repeats the raw value`);
        if (id !== "en") {
          assert.notEqual(text, english[key], `${id} ${key} is still English`);
        }
      }
    }
  }
});

test("the declaration reaches the review that owns the manifest it belongs to", () => {
  // The development review reads the folder's manifest that the load will use,
  // and passes both lists through, so the renderer never has to read one.
  assert.match(pluginIpcSrc, /rendererData: declared\.manifest\.rendererData \?\? \[\]/);
  assert.match(
    pluginIpcSrc,
    /rendererActions: declared\.manifest\.rendererActions \?\? \[\]/,
  );
  // The shared contract stays plain `string[]`: it sits under the SDK and does
  // not hold the vocabulary.
  assert.match(sharedTypesSrc, /rendererData\?: string\[\];/);
  assert.match(sharedTypesSrc, /rendererActions\?: string\[\];/);

  // Only that review draws the block. An install or update review is answered
  // from catalog metadata or from the installed plugin's own row, and neither
  // is the manifest being installed: rendering their lists would state what
  // some other version declares while the user consents to this one.
  const dialogs = slice(pluginsUiSrc, "export function PluginDialogs(", "\n/* ");
  assert.equal(dialogs.match(/<RendererDeclaration /g)?.length, 1);
  assert.match(dialogs, /<RendererDeclaration t=\{t\} plugin=\{pendingReview\} \/>/);
  assert.doesNotMatch(dialogs, /<RendererDeclaration[^>]*pendingInstall/);
  // The block takes a review payload, not any object that happens to carry the
  // two lists, so a plugin row cannot be handed to it by mistake.
  assert.match(dialogs, /plugin\?: PluginPermissionReview \| null;/);

  // No path feeds the installed plugin's or the catalog's lists into a review.
  assert.doesNotMatch(pluginsUiSrc, /rendererData: plugin\.rendererData/);
  assert.doesNotMatch(pluginsUiSrc, /rendererActions: plugin\.rendererActions/);
  assert.doesNotMatch(pluginsUiSrc, /rendererData: input\.rendererData/);
  assert.doesNotMatch(pluginsUiSrc, /rendererActions: input\.rendererActions/);
});
