import { readSettingsSourceSync, readPluginsSourceSync, readMainSourceSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadStyles } from "./helpers/styles.mjs";
import { en } from "../../../packages/i18n/src/locales/en/index.ts";
import { zhCN } from "../../../packages/i18n/src/locales/zh-CN/index.ts";
import { tr } from "../../../packages/i18n/src/locales/tr/index.ts";

const catalogs = { en, "zh-CN": zhCN, tr };

const here = dirname(fileURLToPath(import.meta.url));
const extDir = join(here, "../src/components/extensions");
const components = new Map(
  readdirSync(extDir)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => [name, readFileSync(join(extDir, name), "utf8")]),
);
const settingsDir = join(here, "../src/components/settings");
const settingsComponents = new Map(
  readdirSync(settingsDir)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => [name, readFileSync(join(settingsDir, name), "utf8")]),
);
const pageSrc = readPluginsSourceSync();
const marketSettingsSrc = readFileSync(
  join(here, "../src/components/plugins/MarketplaceSourceSettings.tsx"),
  "utf8",
);
const settingsPageSrc = readSettingsSourceSync();
const electronMainSrc = readMainSourceSync();
const hostCapabilitySources = [
  readFileSync(join(here, "../../../crates/host-core/src/agent_capabilities.rs"), "utf8"),
  readFileSync(join(here, "../../../crates/host-core/src/user_skills.rs"), "utf8"),
  readFileSync(join(here, "../../../crates/host-core/src/mcp_servers.rs"), "utf8"),
  readFileSync(join(here, "../../../crates/host-core/src/user_subagents.rs"), "utf8"),
].join("\n");
const styles = await loadStyles();
const allSources = [
  ...components.values(),
  ...settingsComponents.values(),
  pageSrc,
  settingsPageSrc,
].join("\n");

function lookup(catalog, key) {
  return key.split(".").reduce((node, part) => (node == null ? undefined : node[part]), catalog);
}

function translationKeys(source) {
  const keys = new Set();
  for (const match of source.matchAll(/\bt\(\s*"((?:extensions|common)\.[^"]+)"/g)) {
    keys.add(match[1]);
  }
  for (const match of source.matchAll(/"((?:extensions|common)\.[A-Za-z0-9_.]+)"/g)) {
    keys.add(match[1]);
  }
  return keys;
}

test("every active extensions key exists in both catalogs", () => {
  const keys = translationKeys(allSources);
  assert.ok(keys.size > 40, `expected many extensions keys, saw ${keys.size}`);
  const missing = Object.fromEntries(Object.keys(catalogs).map((id) => [id, []]));
  for (const key of keys) {
    for (const [id, catalog] of Object.entries(catalogs)) {
      if (typeof lookup(catalog, key) !== "string") missing[id].push(key);
    }
  }
  assert.deepEqual(
    missing,
    Object.fromEntries(Object.keys(catalogs).map((id) => [id, []])),
  );
});

test("count interpolations carry plural forms in both catalogs", () => {
  const counted = new Set();
  for (const match of allSources.matchAll(
    /\bt\(\s*"((?:extensions|common)\.[^"]+)",\s*\{[^)]*?\bcount\b/gs,
  )) {
    counted.add(match[1]);
  }
  assert.ok(counted.size >= 2, `expected counted keys, saw ${counted.size}`);
  for (const key of counted) {
    for (const [name, catalog] of Object.entries(catalogs)) {
      assert.equal(typeof lookup(catalog, `${key}_one`), "string", `${name} ${key}_one`);
      assert.equal(typeof lookup(catalog, `${key}_other`), "string", `${name} ${key}_other`);
    }
  }
});

test("the extensions page keeps only installed and market tabs", () => {
  assert.match(pageSrc, /type TabId = "installed" \| "market"/);
  for (const id of [
    "plugins-tab-installed",
    "plugins-tab-market",
    "plugins-panel-installed",
    "plugins-panel-market",
  ]) {
    assert.ok(pageSrc.includes(id), `missing extension surface ${id}`);
  }
  for (const id of ["mcp", "skills", "subagents"]) {
    assert.doesNotMatch(pageSrc, new RegExp(`plugins-(?:tab|panel)-${id}`));
  }
});

test("the extensions page uses tabs instead of the removed capability overview", () => {
  assert.doesNotMatch(pageSrc, /plugins-hero|plugins-stat|const summary\s*=/);
  assert.match(pageSrc, /className="plugins-segment"/);
});

test("marketplace source settings omit redundant explanatory copy", () => {
  assert.match(marketSettingsSrc, /marketProviderTitle/);
  assert.doesNotMatch(
    marketSettingsSrc,
    /marketProviderDesc|marketProviderMirrorHint|marketActiveSource|plugins-market-settings-active/,
  );
  assert.match(marketSettingsSrc, /marketCustomUrlDesc/);
});

test("installed plugin rows keep secondary detail behind a disclosure", () => {
  assert.match(pageSrc, /function PluginRowDetails/);
  assert.match(pageSrc, /<details className="plugins-row-details"/);
  assert.match(pageSrc, /<ScopeControl[\s\S]*?compact/);
});


test("the renderer row says whether the module is loaded, beside its diagnostics", () => {
  // Loading a renderer module is lazy, so a plugin whose module was never
  // triggered carries no diagnostics at all: without this line it looks exactly
  // like one that works. The answer is renderer state the row already holds —
  // the loader's live-module map — so the row asks no one over IPC.
  assert.match(pageSrc, /import \{ isRendererPluginLoaded \}/);
  assert.match(
    pageSrc,
    /const rendererLoaded = hasRenderer && isRendererPluginLoaded\(plugin\.id\)/,
  );
  assert.match(pageSrc, /data-renderer-loaded=\{rendererLoaded \? "true" : "false"\}/);
  assert.match(
    pageSrc,
    /rendererLoaded\s*\n?\s*\? "plugins\.rendererModuleLoaded"\s*\n?\s*: "plugins\.rendererModuleNotLoaded"/,
  );

  // The block reads local renderer state and nothing else: no bridge call, no
  // IPC channel of its own.
  const start = pageSrc.indexOf("const rendererLoaded");
  const end = pageSrc.indexOf("plugins.rendererDiagnosticsEmpty");
  assert.ok(start >= 0 && end > start, "the renderer load-state block is missing");
  assert.doesNotMatch(pageSrc.slice(start, end), /api\.|\binvoke\(/);

  // Both states are stated in the plugin row's own vocabulary, in every locale
  // this suite can read (the i18n package gate covers the other five).
  for (const [id, catalog] of Object.entries(catalogs)) {
    for (const key of [
      "plugins.rendererModuleTitle",
      "plugins.rendererModuleLoaded",
      "plugins.rendererModuleNotLoaded",
    ]) {
      assert.equal(typeof lookup(catalog, key), "string", `${id} ${key}`);
    }
  }
});

test("extension row actions stay visible and labelled", () => {
  assert.match(pageSrc, /<TooltipButton[\s\S]*?tooltip=\{t\("plugins\.openPanel"\)\}/);
  assert.match(pageSrc, /<TooltipButton[\s\S]*?tooltip=\{t\("plugins\.rowActions", \{ name: plugin\.name \}\)\}/);
  assert.match(styles, /\.ui-tooltip\s*\{[\s\S]*?position:\s*fixed;/);
  const actionBlock = styles.match(/\.ext-row-actions\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(actionBlock, /opacity:\s*1/);
});

test("the client hides development-only demo plugins from marketplace results", () => {
  assert.match(pageSrc, /function isClientVisibleMarketPlugin/);
  assert.match(pageSrc, /!plugin\.id\.startsWith\("demo\."\)/);
  assert.match(pageSrc, /setMarket\(\(res\.plugins \?\? \[\]\)\.filter\(isClientVisibleMarketPlugin\)\)/);
});

test("Settings exposes three independent Agent capability destinations", () => {
  assert.match(settingsPageSrc, /tab === "skills" && <AgentSkillsPage \/>/);
  assert.match(settingsPageSrc, /tab === "mcp" && <AgentMcpPage \/>/);
  assert.match(settingsPageSrc, /tab === "subagents" && <AgentSubagentsPage \/>/);
  assert.match(settingsComponents.get("AgentCapabilityLayout.tsx"), /AgentCapabilityPage/);
  assert.match(settingsComponents.get("AgentCapabilityLayout.tsx"), /agent-capability-list/);
  for (const name of ["AgentSkillsPage.tsx", "AgentMcpPage.tsx"]) {
    const source = settingsComponents.get(name);
    assert.match(source, /useAgentProjects\(\)/, name);
    assert.match(source, /AgentProjectPicker/, name);
    assert.match(source, /level: "global"/);
    assert.match(source, /level: "project"/);
  }
  assert.doesNotMatch(settingsComponents.get("AgentSubagentsPage.tsx"), /AgentProjectPicker|projectPath/);
});

test("capability sections flow at natural height with skeleton loading", () => {
  assert.doesNotMatch(styles, /\.agent-capability-list\s*\{[^}]*?height:\s*\d+px/);
  assert.match(styles, /\.agent-capability-skeleton\s*\{/);
  assert.match(settingsComponents.get("AgentCapabilityLayout.tsx"), /loading \? </);
});

test("skill import is one native file and physically targets the selected level", () => {
  const start = electronMainSrc.indexOf("handle(IPC.invoke.skillImport");
  const end = electronMainSrc.indexOf("handle(\n    IPC.invoke.skillUpdate", start);
  const handler = electronMainSrc.slice(start, end);
  assert.ok(start >= 0 && end > start, "skill import handler is missing");
  assert.match(handler, /properties: \["openFile"\]/);
  assert.doesNotMatch(handler, /\bmultiple\b/);
  assert.match(handler, /host\.call\("skills\.import"/);
  assert.match(settingsComponents.get("AgentSkillsPage.tsx"), /api\.importUserSkill\(/);
  assert.match(hostCapabilitySources, /fs::copy\(source, target\)/);
});

test("MCP management reuses the modal and validates its locked id and transport branches", () => {
  const page = settingsComponents.get("AgentMcpPage.tsx");
  const sheet = components.get("McpEditorSheet.tsx");
  assert.match(page, /<McpEditorSheet/);
  assert.match(page, /draftFromRecord/);
  assert.match(page, /sameLevel/);
  assert.match(sheet, /disabled=\{!!editing\}/);
  assert.match(sheet, /mcpDraftError/);
  assert.match(sheet, /command\.includes\("\.\."\)/);
  assert.match(sheet, /isNonLoopbackHttpMcpUrl/);
  assert.match(sheet, /role="dialog" aria-modal/);
});

test("project records shadow global records before disabled records are filtered", () => {
  assert.match(hostCapabilitySources, /existing\.id != record\.id/);
  assert.match(hostCapabilitySources, /if record\.enabled \{/);
  assert.match(hostCapabilitySources, /record\.name\.eq_ignore_ascii_case/);
});

test("subagents are global-only and use the agents root", () => {
  const page = settingsComponents.get("AgentSubagentsPage.tsx");
  const helper = readFileSync(join(settingsDir, "subagent-settings.ts"), "utf8");
  assert.match(page, /GLOBAL_SUBAGENTS_PATH = "~\/\.agents\/subagents"/);
  // Global-only means no level to pick and no project to resolve against. It no
  // longer means read-only: authoring lives here now (D257).
  assert.doesNotMatch(page, /AgentProjectPicker|projectPath/);
  assert.doesNotMatch(helper, /AgentProjectPicker|projectPath/);
  assert.match(helper, /level: "global"/);
  assert.match(page, /api\.subagentCatalog|fetchSubagentPageData/);
  assert.match(electronMainSrc, /IPC\.invoke\.subagentList/);
  assert.match(hostCapabilitySources, /capability_dir\(CapabilityLevel::Global, None, "subagents"\)/);
});

test("capability implementation does not use legacy .pi capability roots", () => {
  const implementation = [
    ...settingsComponents.values(),
    pageSrc,
    settingsPageSrc,
    electronMainSrc,
    hostCapabilitySources,
  ].join("\n");
  assert.doesNotMatch(implementation, /\.pi\/(?:agents|skills|mcp)/);
  assert.match(implementation, /~\/\.agents\/skills/);
  assert.match(implementation, /~\/\.agents\/servers/);
  assert.match(implementation, /~\/\.agents\/subagents/);
});

test("agent capability styling uses design tokens and supports reduced motion", () => {
  const start = styles.indexOf("/* -------------------------------------------------------------------------\n * Settings > Agent capability destinations (Skills / MCP / Subagents).");
  assert.ok(start >= 0, "agent capability styles are missing");
  const section = styles.slice(start);
  assert.match(section, /var\(--ds-bg-/);
  assert.match(section, /var\(--ds-text-/);
  assert.match(section, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(section, /\.agent-capability-row\.is-off/);
});
