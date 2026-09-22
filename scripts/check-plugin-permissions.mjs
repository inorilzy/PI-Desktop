#!/usr/bin/env node
/**
 * Keep the places a permission name lives in step (spec 07-plugins/13 §5).
 *
 * A permission name is spread across the SDK's list, the desktop risk table,
 * the devkit's high-risk mirror, eight locale catalogs and the matrix document.
 * Nothing about that is hard — which is exactly why it drifts: a name added in
 * one place and forgotten in another shows the raw identifier in the install
 * dialog, or reports the wrong risk tier, and every other gate stays green.
 *
 * This script is the mechanical half of that contract: it reads the real files
 * (and the built locale catalogs, because a catalog is data) and fails on the
 * first gap instead of trusting a checklist.
 *
 * Run after `pnpm build:js`; `pnpm lint` runs it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** The 38 names that shipped before the renderer host (ADR 0291). Add-only. */
const LEGACY_PERMISSIONS = [
  "ui.panel",
  "ui.view",
  "ui.microphone",
  "ui.theme",
  "ui.settings",
  "ui.window.appearance",
  "clipboard.read",
  "clipboard.write",
  "notify",
  "fs.read",
  "fs.write",
  "fs.delete",
  "agent.tool.register",
  "agent.prompt.inject",
  "agent.complete",
  "agent.extension",
  "provider.register",
  "desktop.control",
  "models.list",
  "project.create",
  "session.read",
  "session.import",
  "session.read.own",
  "session.update.own",
  "session.delete.own",
  "net.fetch",
  "shell.openExternal",
  "mcp.server.local",
  "mcp.server.remote",
  "background.service",
  "bus.publish",
  "bus.subscribe",
  "browser.cdp",
  "audio.capture.background",
  "audio.playback.background",
  "speech.adapter.register",
  "keyboard.globalShortcut",
  "net.websocket",
];

/**
 * Names that predate this check and still have no install-dialog copy. The
 * dialog falls back to the raw identifier for them. They are frozen rather than
 * waived: the check fails if a NEW name arrives without copy, and it also fails
 * if one of these gains copy without being removed from this list, so the debt
 * can only shrink.
 */
const KNOWN_MISSING_COPY = [
  "ui.view",
  "ui.settings",
  "project.create",
  "session.import",
  "session.read.own",
  "session.update.own",
  "session.delete.own",
];

/**
 * Legacy file-permission names that keep display copy for plugins installed
 * before scopes existed. They are deliberately not in `PLUGIN_PERMISSIONS`, and
 * the SDK asserts as much, so copy for them is expected rather than drift.
 */
const LEGACY_COPY_ONLY = ["fs.read.workspace", "fs.write.workspace", "fs.delete.workspace"];

/** The locales the shell ships. */
const LOCALES = ["en", "zh-CN", "zh-TW", "de", "es", "tr", "fr", "ko"];

const EXPORT_FOR = {
  en: "en",
  "zh-CN": "zhCN",
  "zh-TW": "zhTW",
  de: "de",
  es: "es",
  tr: "tr",
  fr: "fr",
  ko: "ko",
};

const problems = [];
const fail = (message) => problems.push(message);

function read(relative) {
  return readFileSync(join(root, relative), "utf8");
}

/** Quoted entries inside the first `<marker> [ … ]` array literal. */
function arrayLiteral(source, marker, where) {
  const block = new RegExp(`${marker}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(source);
  if (!block) {
    fail(`${where}: could not find the ${marker} array`);
    return [];
  }
  return [...block[1].matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
}

// ── 1. the SDK's list, which is the source of truth ─────────────────────────
const sdk = read("packages/plugin-sdk/src/index.ts");
const declared = arrayLiteral(sdk, "PLUGIN_PERMISSIONS", "plugin-sdk");
if (declared.length === 0) fail("plugin-sdk: PLUGIN_PERMISSIONS looks empty");
if (new Set(declared).size !== declared.length) {
  fail("plugin-sdk: PLUGIN_PERMISSIONS repeats a name");
}
for (const name of LEGACY_PERMISSIONS) {
  if (!declared.includes(name)) {
    fail(`plugin-sdk: "${name}" was removed; permission names are add-only`);
  }
}

// ── 2. the desktop risk table ───────────────────────────────────────────────
const model = read("apps/desktop/src/features/plugins/model.ts");
const riskBlock = /PERMISSION_RISK[^{]*\{([\s\S]*?)\n\};/.exec(model);
if (!riskBlock) fail("desktop: could not find PERMISSION_RISK");
const risk = new Map();
// Keys are quoted in the table except one (`notify`), which is a legal object
// key, so the pattern accepts both.
for (const match of (riskBlock?.[1] ?? "").matchAll(
  /(?:^|\n)\s*"?([a-z][\w.]*)"?\s*:\s*"(low|medium|high)"/g,
)) {
  risk.set(match[1], match[2]);
}
for (const name of declared) {
  if (!risk.has(name)) {
    fail(`desktop: PERMISSION_RISK has no entry for "${name}"; it would silently render as high`);
  }
}

// ── 3. the devkit's high-risk mirror ────────────────────────────────────────
const devkit = read("packages/plugin-devkit/src/check.ts");
const devkitHigh = new Set(arrayLiteral(devkit, "HIGH_RISK_PERMISSIONS", "plugin-devkit"));
const modelHigh = new Set([...risk].filter(([, tier]) => tier === "high").map(([name]) => name));
for (const name of modelHigh) {
  if (!devkitHigh.has(name)) {
    fail(`plugin-devkit: "${name}" is high risk in the desktop table but missing here`);
  }
}
for (const name of devkitHigh) {
  if (!modelHigh.has(name)) {
    fail(`plugin-devkit: "${name}" is high risk here but not in the desktop table`);
  }
}

// ── 4. every locale shows a label and a help line ───────────────────────────
let catalogs;
try {
  // A dynamic import needs a URL on Windows: a bare `C:\…` path is read as a
  // `c:` scheme and refuses to load.
  catalogs = await import(pathToFileURL(join(root, "packages/i18n/dist/index.js")).href);
} catch {
  console.error("packages/i18n/dist is missing; run `pnpm build:js` first.");
  process.exit(1);
}
for (const locale of LOCALES) {
  const catalog = catalogs[EXPORT_FOR[locale]];
  if (!catalog) {
    fail(`i18n: no catalog export for "${locale}"`);
    continue;
  }
  const labels = catalog.plugins?.permissions ?? {};
  const help = catalog.plugins?.permissionHelp ?? {};
  for (const name of declared) {
    if (KNOWN_MISSING_COPY.includes(name)) continue;
    if (!(name in labels)) fail(`i18n[${locale}]: plugins.permissions is missing "${name}"`);
    if (!(name in help)) fail(`i18n[${locale}]: plugins.permissionHelp is missing "${name}"`);
  }
  for (const name of Object.keys(labels)) {
    if (declared.includes(name) || LEGACY_COPY_ONLY.includes(name)) continue;
    fail(`i18n[${locale}]: "${name}" has display copy but is not a permission any more`);
  }
}
for (const name of LEGACY_COPY_ONLY) {
  if (declared.includes(name)) {
    fail(`plugin-sdk: "${name}" is both declared and listed as legacy copy-only`);
  }
}

// ── 5. the frozen debt stays honest ────────────────────────────────────────
for (const name of KNOWN_MISSING_COPY) {
  if (!declared.includes(name)) {
    fail(`plugin-sdk: "${name}" is listed as missing copy but is not a permission any more`);
    continue;
  }
  const english = catalogs.en?.plugins?.permissions ?? {};
  if (name in english) {
    fail(`i18n: "${name}" now has display copy; remove it from KNOWN_MISSING_COPY so the debt shrinks`);
  }
}

// ── 6. the matrix document lists every name ────────────────────────────────
const matrix = read("docs/spec/07-plugins/13-plugin-permissions-matrix.md");
for (const name of declared) {
  if (!matrix.includes(`\`${name}\``)) fail(`spec 13: no row for "${name}"`);
}

// ── report ─────────────────────────────────────────────────────────────────
if (problems.length) {
  console.error(`Plugin permission sync check failed (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `Plugin permissions OK: ${declared.length} names across the SDK, desktop risk table, ` +
    `devkit mirror, ${LOCALES.length} locales and spec 13 ` +
    `(${KNOWN_MISSING_COPY.length} known without display copy).`,
);
