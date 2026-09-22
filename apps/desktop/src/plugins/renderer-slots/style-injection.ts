/**
 * Style isolation for trusted-renderer plugins (ADR 0291, contract v4).
 *
 * Shadow DOM was rejected: the shell portals call sites across many files, so
 * a shadow root would break host portals long before it contained a hostile
 * plugin.
 *
 * Instead every plugin stylesheet goes through this module. The host owns the
 * `<style>` element, **auto-scopes** every selector under the plugin's
 * `data-pi-plugin` container, rewrites `:root` to that container, refuses
 * `html` / `body` / `*` and `@import`, prefixes `@keyframes` / `@font-face`
 * names, and removes the sheet on unload.
 *
 * Rewrite is part of the contract and is observable: the element is marked
 * `data-pi-plugin-style-mode="scoped"` when the source was rewritten. Authors
 * debug the host-normalized CSS via `scopePluginStyle` from the SDK.
 */
import {
  PLUGIN_STYLE_FORBIDDEN_ROOT_SELECTORS,
  scopePluginStyle,
} from "@pi-desktop/plugin-sdk";
import { pluginSlots } from "./registry";

const STYLE_ATTRIBUTE = "data-pi-plugin-style";
const STYLE_MODE_ATTRIBUTE = "data-pi-plugin-style-mode";

/**
 * The first selector that would reach past the plugin's container and cannot
 * be scoped — `html`, `body`, or `*` — or null when the sheet is allowed.
 *
 * This is a scanner, not a CSS parser: it strips comments, then looks at every
 * selector segment (the text between a `}`/`;`/start and the next `{`) and
 * checks each comma-separated part on its own. Nested blocks inside `@media`
 * are checked too.
 */
export function forbiddenSelector(css: string): string | null {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (let brace = withoutComments.indexOf("{"); brace >= 0; brace = withoutComments.indexOf("{", brace + 1)) {
    const start = Math.max(
      withoutComments.lastIndexOf("}", brace - 1),
      withoutComments.lastIndexOf("}", brace - 1),
      withoutComments.lastIndexOf("{", brace - 1),
      withoutComments.lastIndexOf(";", brace),
    );
    const selectorText = withoutComments.slice(start + 1, brace);
    if (!selectorText.trim()) continue;
    if (selectorText.trimStart().startsWith("@")) continue;
    for (const part of selectorText.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      for (const root of PLUGIN_STYLE_FORBIDDEN_ROOT_SELECTORS) {
        const pattern = new RegExp(`^${root.replace(/[*:]/g, "\\$&")}(?![\\w-])`, "i");
        if (pattern.test(trimmed)) return trimmed;
      }
    }
  }
  return null;
}

/** True when the sheet references host-internal design tokens. Soft diagnostic. */
export function referencesPrivateHostTokens(css: string): boolean {
  return /--ds-[a-z0-9-]+/i.test(css);
}

export type PluginStyleHandle = { remove(): void };

/**
 * Inject a plugin's stylesheet under the given plugin id. The CSS is rewritten
 * into the plugin's own container first. Throws `PLUGIN_STYLE_REFUSED` when
 * the sheet targets a host root, uses `@import`, or cannot be scoped — the
 * caller reports it instead of shipping half a stylesheet.
 */
export function injectPluginStyle(pluginId: string, css: string): PluginStyleHandle {
  const forbidden = forbiddenSelector(css);
  if (forbidden) {
    const error = new Error(
      `PLUGIN_STYLE_REFUSED: ${JSON.stringify(forbidden)} targets a host root`,
    ) as Error & { code?: string };
    error.code = "PLUGIN_STYLE_REFUSED";
    pluginSlots.report({
      pluginId,
      code: "PLUGIN_STYLE_REFUSED",
      detail: `${JSON.stringify(forbidden)} targets a host root`,
    });
    throw error;
  }
  let scoped: string;
  try {
    scoped = scopePluginStyle(pluginId, css);
  } catch (error) {
    const coded = error as Error & { code?: string };
    if (coded.code !== "PLUGIN_STYLE_REFUSED") throw error;
    pluginSlots.report({
      pluginId,
      code: "PLUGIN_STYLE_REFUSED",
      detail: coded.message,
    });
    throw coded;
  }
  if (referencesPrivateHostTokens(css)) {
    pluginSlots.report({
      pluginId,
      code: "PLUGIN_STYLE_PRIVATE_TOKEN",
      detail: "sheet references host-internal --ds-* tokens; use --pi-slot-* instead",
    });
  }
  if (scoped !== css.replace(/\/\*[\s\S]*?\*\//g, "").trim()) {
    pluginSlots.report({
      pluginId,
      code: "PLUGIN_STYLE_SCOPED",
      detail: "selectors were rewritten under the plugin's data-pi-plugin container",
    });
  }
  const element = document.createElement("style");
  element.setAttribute(STYLE_ATTRIBUTE, pluginId);
  element.setAttribute(STYLE_MODE_ATTRIBUTE, "scoped");
  element.textContent = scoped;
  document.head.appendChild(element);
  return {
    remove: () => {
      element.remove();
    },
  };
}

/** Drop every sheet a plugin owns. Safe to call when it never injected any. */
export function removePluginStyles(pluginId: string): void {
  for (const element of document.querySelectorAll(`style[${STYLE_ATTRIBUTE}="${pluginId}"]`)) {
    element.remove();
  }
}
