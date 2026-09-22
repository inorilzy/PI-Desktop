import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  isLocalNetDomain,
  LEGACY_FS_PERMISSIONS,
  PLUGIN_FS_MODES,
  PLUGIN_ID_PATTERN,
  PLUGIN_PERMISSIONS,
  PLUGIN_RENDERER_ACTIONS,
  PLUGIN_VIEW_ICONS,
  validateManifest,
  type PluginManifest,
} from "@pi-desktop/plugin-sdk";
import {
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_FILES,
  selectPackageFiles,
  walkPluginDir,
} from "./walk.js";

/**
 * Permissions the permission dialog surfaces as high risk. Kept in sync with
 * `PERMISSION_RISK` in apps/desktop/src/features/plugins/model.ts, which is the
 * copy the install dialog actually renders.
 */
export const HIGH_RISK_PERMISSIONS = [
  "net.fetch",
  "net.websocket",
  "fs.write",
  "fs.delete",
  "fs.write.workspace",
  "fs.delete.workspace",
  "agent.prompt.inject",
  "agent.tool.register",
  "agent.complete",
  "agent.extension",
  "renderer.extension",
  "agent.model.complete",
  "runtime.send.before",
  "runtime.session.lifecycle",
  "runtime.session.read",
  "runtime.tool.extend",
  "runtime.tool.gate",
  "runtime.turn.abort",
  "runtime.turn.closing",
  "runtime.turn.continue",
  "runtime.turn.recap",
  "desktop.control",
  "session.read",
  "session.delete.own",
  "browser.cdp",
  "audio.capture.background",
  "speech.adapter.register",
  "mcp.server.local",
  "mcp.server.remote",
  "background.service",
] as const;

/** Host API surface each permission unlocks, used for the unused-permission hint. */
const PERMISSION_API_HINTS: Record<string, string[]> = {
  "ui.panel": ["ui.openPanel", "ui.closePanel"],
  notify: [
    "ui.notify",
    "ui.getNotificationPermission",
    "ui.requestNotificationPermission",
    "ui.showNativeNotification",
  ],
  "clipboard.read": ["clipboard.readText", "clipboard.getHistory"],
  "clipboard.write": ["clipboard.writeText"],
  "fs.read": [
    "fs.readText",
    "fs.stat",
    "fs.readRange",
    "fs.readPreview",
    "fs.openDefault",
    "fs.reveal",
    "fs.glob",
    "fs.list",
    "fs.requestDirectory",
  ],
  "fs.write": ["fs.writeText"],
  "fs.delete": ["fs.remove"],
  "agent.tool.register": ["agent.registerTool"],
  "speech.adapter.register": ["speech.registerAdapter"],
  "net.fetch": ["net.fetch"],
  "audio.capture.background": [
    "audio.getInputDevices",
    "audio.openInput",
    "audio.closeInput",
    "audio.getCaptureState",
    "audio.onInputFrame",
  ],
  "audio.playback.background": [
    "audio.openOutput",
    "audio.writeOutput",
    "audio.stopOutput",
    "audio.closeOutput",
  ],
  "keyboard.globalShortcut": [
    "keyboard.registerGlobalShortcut",
    "keyboard.unregisterGlobalShortcut",
    "keyboard.listGlobalShortcuts",
  ],
  "net.websocket": ["net.websocket.connect", "net.websocket.send", "net.websocket.close"],
  "shell.openExternal": ["shell.openExternal"],
  "browser.cdp": [
    "browser.navigate",
    "browser.snapshot",
    "browser.screenshot",
    "browser.click",
    "browser.fill",
    "browser.evaluate",
    "browser.console",
    "browser.cdp",
  ],
};

export type CheckIssue = {
  /** Stable machine code, e.g. `manifest.missing` or `permission.unknown`. */
  code: string;
  message: string;
};

export type CheckResult = {
  ok: boolean;
  dir: string;
  manifest?: PluginManifest;
  errors: CheckIssue[];
  warnings: CheckIssue[];
  fileCount: number;
  totalBytes: number;
};

/** Skill entries are either a bare path or an object carrying one. */
function skillPaths(manifest: PluginManifest): string[] {
  const entries = (manifest.contributes?.skills ?? []) as Array<unknown>;
  const paths: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") paths.push(entry);
    else if (entry && typeof entry === "object") {
      const path = (entry as { path?: unknown }).path;
      if (typeof path === "string") paths.push(path);
    }
  }
  return paths;
}

function isEscapingPath(value: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    return true;
  }
  return value.split(/[\\/]/).includes("..");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Sources the renderer-action scan reads. `manifest.renderer` is an entry into
 * a module graph a bundler, a path alias, or a dynamic import can hide from us,
 * and one we resolved too narrowly would report a declared action as unused
 * when it is not. The scan therefore reads every plugin-relative
 * JavaScript/TypeScript source, skipping `node_modules`, dot-directories, and
 * build output.
 */
const RENDERER_SOURCE_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"] as const;
const RENDERER_SOURCE_SKIPPED_DIRS = new Set(["dist", "build", "out", "coverage"]);

function isRendererSourcePath(relPath: string): boolean {
  const segments = relPath.split("/");
  const name = segments.pop() ?? "";
  if (segments.some((dir) => dir.startsWith(".") || RENDERER_SOURCE_SKIPPED_DIRS.has(dir))) {
    return false;
  }
  return RENDERER_SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/** Quote characters that make an action name a literal instead of an identifier. */
const ACTION_QUOTES = "\"'`";

/**
 * Match a quoted action name only: `"ui.toast"`, `'ui.toast'`, `` `ui.toast` ``.
 * `dispatch(ui.toast)`, a variable holding the name, or a longer name that
 * merely starts with an action (`"ui.toastLater"`) is not a dispatch.
 */
function quotedActionPattern(action: string): RegExp {
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`([${ACTION_QUOTES}])${escaped}\\1`);
}

/**
 * Validate a plugin directory against every rule host-core enforces at install
 * time, so a clean `check` means `install` will not reject the package.
 *
 * Errors block packaging; warnings are advice a plugin author should read
 * before publishing but that will still install.
 */
export async function check(dirInput: string): Promise<CheckResult> {
  const dir = resolve(dirInput);
  const errors: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];
  const fail = (code: string, message: string): CheckResult => ({
    ok: false,
    dir,
    errors: [...errors, { code, message }],
    warnings,
    fileCount: 0,
    totalBytes: 0,
  });

  let raw: string;
  try {
    raw = await readFile(join(dir, "manifest.json"), "utf8");
  } catch {
    return fail("manifest.missing", "manifest.json is missing");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return fail("manifest.invalid-json", `manifest.json is not valid JSON: ${String(error)}`);
  }

  const validated = validateManifest(parsed);
  if (!validated.ok || !validated.manifest) {
    return fail("manifest.invalid", validated.error ?? "manifest is invalid");
  }
  const manifest = validated.manifest;

  if (!PLUGIN_ID_PATTERN.test(manifest.id)) {
    errors.push({
      code: "manifest.invalid-id",
      message: `manifest.id "${manifest.id}" must be a lowercase dotted id such as "acme.notes" (${PLUGIN_ID_PATTERN.source})`,
    });
  }

  // `main` is optional since the renderer host landed: a UI-only plugin may
  // declare just `renderer`, or only a page. Whatever is declared still has to
  // exist, and `renderer` is checked the same way one line below.
  const declaredMain = typeof manifest.main === "string" ? manifest.main : "";
  if (declaredMain && !(await fileExists(join(dir, declaredMain)))) {
    errors.push({
      code: "main.missing",
      message: `manifest.main "${declaredMain}" does not exist`,
    });
  }

  const declaredRenderer = typeof manifest.renderer === "string" ? manifest.renderer : "";
  if (declaredRenderer && !(await fileExists(join(dir, declaredRenderer)))) {
    errors.push({
      code: "renderer.missing",
      message: `manifest.renderer "${declaredRenderer}" does not exist`,
    });
  }

  const icon = manifest.icon;
  if (typeof icon === "string" && icon.trim()) {
    // A missing icon degrades to the letter tile, so this is advice; an author
    // who declared one meant to ship it.
    if (isEscapingPath(icon) || !(await fileExists(join(dir, icon)))) {
      warnings.push({
        code: "icon.missing",
        message: `manifest.icon "${icon}" does not exist in the plugin directory, so the host shows a letter tile`,
      });
    }
  }

  const panel = manifest.ui?.panel;
  if (panel && !(await fileExists(join(dir, panel)))) {
    errors.push({ code: "panel.missing", message: `ui.panel "${panel}" does not exist` });
  }

  for (const view of manifest.contributes?.views ?? []) {
    const entry = view?.entry;
    if (typeof entry !== "string" || !entry.trim()) continue;
    if (isEscapingPath(entry)) {
      errors.push({
        code: "view.escapes",
        message: `contributes.views entry "${entry}" must be relative and must not contain ".."`,
      });
      continue;
    }
    if (!(await fileExists(join(dir, entry)))) {
      errors.push({
        code: "view.missing",
        message: `view entry "${entry}" does not exist`,
      });
      continue;
    }
    // An unknown token is not fatal — the host draws a letter tile — but it is
    // almost always a typo, and the author cannot see that from the manifest.
    if (view.icon && !PLUGIN_VIEW_ICONS.includes(view.icon as never)) {
      warnings.push({
        code: "view.unknown-icon",
        message: `view "${view.id}" names icon "${view.icon}", which is not a known token, so it renders as a letter tile`,
      });
    }
  }

  for (const path of skillPaths(manifest)) {
    if (isEscapingPath(path)) {
      errors.push({
        code: "skill.escapes",
        message: `contributes.skills path "${path}" must be relative and must not contain ".."`,
      });
      continue;
    }
    if (!(await fileExists(join(dir, path)))) {
      errors.push({ code: "skill.missing", message: `skill file "${path}" does not exist` });
      continue;
    }
    const doc = await readFile(join(dir, path), "utf8");
    if (!doc.trim()) {
      errors.push({ code: "skill.empty", message: `skill file "${path}" is empty` });
    } else if (!/^---[ \t]*\r?\n/.test(doc.replace(/^﻿/, ""))) {
      warnings.push({
        code: "skill.no-frontmatter",
        message: `skill "${path}" has no "name"/"description" front matter, so the agent gets no summary of when to apply it`,
      });
    }
  }

  const permissions = manifest.permissions ?? [];
  const known = new Set<string>(PLUGIN_PERMISSIONS);
  for (const permission of permissions) {
    if (known.has(permission)) continue;
    // The pre-scope names still install, so they are advice rather than a
    // blocker — but they are downgraded, and an author who does not read that
    // here reads it as a mysteriously refused call later.
    if (permission in LEGACY_FS_PERMISSIONS) {
      warnings.push({
        code: "permission.legacy-fs",
        message: `permission "${permission}" predates file scopes: the host rewrites it to "fs.${LEGACY_FS_PERMISSIONS[permission]}" and grants ${
          permission === "fs.read.workspace"
            ? "the whole workspace for reading"
            : permission === "fs.delete.workspace"
              ? "only the files this plugin wrote"
              : "nothing until manifest.fs says where"
        }`,
      });
      continue;
    }
    errors.push({
      code: "permission.unknown",
      message: `permission "${permission}" is not a known PI-Desktop permission`,
    });
  }
  // A write or delete permission with no declared range installs and then
  // cannot touch anything: an undeclared scope reduces to nothing, not to the
  // workspace. Same rule as the marketplace catalog preflight.
  for (const mode of PLUGIN_FS_MODES) {
    if (mode === "read" || !permissions.includes(`fs.${mode}`)) continue;
    const rule = manifest.fs?.[mode];
    const declared =
      (rule?.scope?.length ?? 0) > 0 ||
      rule?.root === "userSelected" ||
      (mode === "delete" && rule?.own === true);
    if (!declared) {
      warnings.push({
        code: "permission.fs-no-scope",
        message: `"fs.${mode}" is declared without a manifest.fs.${mode} scope, so every ${mode} asks the user${
          mode === "delete" ? ' (add a scope, or "own": true to reach what this plugin wrote)' : ""
        }`,
      });
    }
  }
  const highRisk = permissions.filter((p) =>
    (HIGH_RISK_PERMISSIONS as readonly string[]).includes(p),
  );
  if (highRisk.length) {
    warnings.push({
      code: "permission.high-risk",
      message: `high-risk permissions require an explicit user grant: ${highRisk.join(", ")}`,
    });
  }
  if (skillPaths(manifest).length && !permissions.includes("agent.prompt.inject")) {
    warnings.push({
      code: "permission.skills-inert",
      message:
        'contributes.skills is declared without "agent.prompt.inject", so the skills are never sent to the agent',
    });
  }
  // The allowlist accepts these hosts because a plugin that talks to a local
  // daemon is legitimate, but an entry that reaches loopback, link-local, or
  // the cloud metadata service also reaches whatever credentials live there.
  const localDomains = (manifest.net?.domains ?? []).filter(
    (domain) => typeof domain === "string" && isLocalNetDomain(domain),
  );
  if (localDomains.length) {
    warnings.push({
      code: "net.local-domain",
      message: `net.domains admits local or cloud-metadata hosts (${localDomains.join(", ")}); a plugin with net.fetch can reach local services and instance credentials through them`,
    });
  }
  if (manifest.contributes?.agentTools?.length && !permissions.includes("agent.tool.register")) {
    errors.push({
      code: "permission.tools-missing",
      message:
        'contributes.agentTools requires the "agent.tool.register" permission',
    });
  }
  if (panel && !permissions.includes("ui.panel")) {
    errors.push({
      code: "permission.panel-missing",
      message: 'ui.panel requires the "ui.panel" permission',
    });
  }
  if (manifest.contributes?.views?.length && !permissions.includes("ui.view")) {
    errors.push({
      code: "permission.views-missing",
      message: 'contributes.views requires the "ui.view" permission',
    });
  }

  const walk = await walkPluginDir(dir);
  // Measure what `pack` ships, not what sits in the directory: `dist/` and
  // credential files never enter the package (see `selectPackageFiles`).
  const selection = selectPackageFiles(walk.files);
  if (walk.symlinks.length) {
    errors.push({
      code: "package.symlink",
      message: `symlinks are not allowed in a plugin package: ${walk.symlinks.slice(0, 5).join(", ")}`,
    });
  }
  if (walk.truncated || selection.files.length > MAX_PACKAGE_FILES) {
    errors.push({
      code: "package.too-many-files",
      message: `a plugin package may contain at most ${MAX_PACKAGE_FILES} files`,
    });
  }
  if (selection.totalBytes > MAX_PACKAGE_BYTES) {
    errors.push({
      code: "package.too-large",
      message: `a plugin package may not exceed ${MAX_PACKAGE_BYTES / (1024 * 1024)}MB`,
    });
  }
  if (selection.skippedSecrets.length) {
    warnings.push({
      code: "package.secret-skipped",
      message: `credential files are left out of the package: ${selection.skippedSecrets
        .map((file) => file.path)
        .join(", ")}`,
    });
  }

  // Entry-source hints: a declared permission that the code never exercises is
  // a needless prompt for the user, and the reverse is a runtime denial.
  // Only a declared headless module has source to inspect; a UI-only plugin has
  // no headless code for a permission to be exercised in.
  const mainSource = declaredMain
    ? await readFile(join(dir, declaredMain), "utf8").catch(() => "")
    : "";
  if (mainSource) {
    for (const permission of permissions) {
      const apis = PERMISSION_API_HINTS[permission];
      if (!apis) continue;
      if (!apis.some((api) => mainSource.includes(api))) {
        warnings.push({
          code: "permission.unused",
          message: `permission "${permission}" is declared but ${declaredMain} never calls ${apis.join(" / ")}`,
        });
      }
    }
  }

  // The declared renderer actions against the action names the plugin's own
  // renderer sources quote. A name present on one side only is what a
  // plugin-center reviewer reads here: the vocabulary is host-owned, so a plugin
  // cannot invent an action, and a declaration nothing dispatches is a claim
  // that does not hold. The declaration is not a gate, so both directions are
  // advice rather than an install blocker.
  const rendererSources = declaredRenderer
    ? walk.files.filter((file) => isRendererSourcePath(file.path))
    : [];
  if (rendererSources.length) {
    const sources: Array<{ path: string; text: string }> = [];
    for (const file of rendererSources) {
      sources.push({
        path: file.path,
        text: await readFile(file.absolutePath, "utf8").catch(() => ""),
      });
    }
    const declaredActions = new Set(manifest.rendererActions ?? []);
    for (const action of PLUGIN_RENDERER_ACTIONS) {
      const pattern = quotedActionPattern(action);
      const files = sources
        .filter((source) => pattern.test(source.text))
        .map((source) => source.path);
      if (!files.length) {
        if (declaredActions.has(action)) {
          warnings.push({
            code: "renderer-action.unused",
            message: `manifest.rendererActions declares "${action}" but no scanned plugin source quotes it (${sources.length} source(s) scanned; node_modules and build output excluded)`,
          });
        }
        continue;
      }
      if (!declaredActions.has(action)) {
        warnings.push({
          code: "renderer-action.undeclared",
          message: `renderer action "${action}" appears in ${files.join(", ")} but manifest.rendererActions does not declare it`,
        });
      }
    }
  }

  const contributes = manifest.contributes ?? {};
  const hasContribution = Object.values(contributes).some((value) =>
    Array.isArray(value) ? value.length > 0 : Boolean(value),
  );
  if (!hasContribution) {
    warnings.push({
      code: "contributes.empty",
      message: "the manifest contributes nothing, so the plugin has no visible effect",
    });
  }

  return {
    ok: errors.length === 0,
    dir,
    manifest,
    errors,
    warnings,
    fileCount: selection.files.length,
    totalBytes: selection.totalBytes,
  };
}
