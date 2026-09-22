/**
 * The renderer-side loader for trusted plugin modules (ADR 0291).
 *
 * Loading is lazy (D6 + ADR 0291 decision 5): nothing is fetched until a slot a
 * plugin might fill is actually rendered. That keeps a plugin that never draws
 * anything from costing an evaluation, and it keeps the application start free
 * of plugin code.
 *
 * Every failure path ends in a diagnostic rather than silence: a plugin author
 * who sees nothing on screen has to be able to find out which of the four gates
 * refused them — no declared entry, no permission, a module that does not
 * export `onLoad`, or a module that threw.
 */
import {
  PLUGIN_RENDERER_SCHEME,
  type PiRendererApi,
  type PiRendererModule,
  type PiRendererSlotOptions,
  type PiRendererStyleHandle,
  type PluginRendererSlot,
} from "@pi-desktop/plugin-sdk";
import { api } from "../../lib/api";
import { pluginSlots } from "../renderer-slots/registry";
import { injectPluginStyle, removePluginStyles } from "../renderer-slots/style-injection";
import { installRendererImportMap } from "./react-shim";
import {
  registerRendererFunction,
  removeRendererFunctions,
  resetRendererFunctions,
} from "./host-functions";

/** One entry per plugin: in flight or settled, so a slot never loads twice. */
const attempts = new Map<string, Promise<void>>();

const modules = new Map<string, PiRendererModule>();

/**
 * What each plugin's manifest declared it dispatches, as the mount point
 * carried it here. It is row data rather than load state: the relay reads it by
 * plugin id, long after the render that started the load is gone.
 */
const declaredActions = new Map<string, ReadonlySet<string>>();

/** Shared empty set: a plugin the host never saw has declared nothing. */
const NO_DECLARED_ACTIONS: ReadonlySet<string> = new Set();

/** The `rendererActions` one plugin declared; empty when the host never saw it. */
export function declaredRendererActions(pluginId: string): ReadonlySet<string> {
  return declaredActions.get(pluginId) ?? NO_DECLARED_ACTIONS;
}

/**
 * Records what one plugin's manifest declared it dispatches, without starting
 * or reusing a load. A mount point holds this row data before the module it
 * names exists, so it is written as the mount renders rather than only from
 * `ensureRendererPlugin`: a component that dispatches during its first commit
 * is answered from the declaration, not from whether an effect has run. A
 * declaration that has not changed does not rebuild its set.
 */
export function rememberRendererActions(pluginId: string, actions?: readonly string[]): void {
  const next = actions ?? [];
  const current = declaredActions.get(pluginId);
  if (
    current &&
    current.size === next.length &&
    next.every((action) => current.has(action))
  ) {
    return;
  }
  declaredActions.set(pluginId, new Set(next));
}

/** Everything one load attempt needs: the plugin row's own answers. */
type RendererPluginLoadOptions = {
  declared: boolean;
  version?: string;
  /** `manifest.rendererActions`, from the candidate that reached the slot. */
  actions?: readonly string[];
};

/** `plugin-renderer://<pluginId>/<path>`, path segments encoded individually. */
export function rendererEntryUrl(pluginId: string, entry: string): string {
  const clean = entry.replace(/^\.\//, "").replace(/\\/g, "/");
  const encoded = clean
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${PLUGIN_RENDERER_SCHEME}://${pluginId}/${encoded}`;
}

/**
 * The `pi` object one plugin's renderer module is handed.
 *
 * Exported as a test seam: the module import around it needs a real
 * `plugin-renderer://` URL, so what the API answers — including the code it
 * refuses a registration with — is pinned here instead.
 *
 * It is the whole host API a plugin gets, built per plugin, which is what keeps
 * the API per-plugin. It is a contract, not a boundary: the module shares this
 * realm (ADR 0291), so it can also reach `window.piDesktop`.
 */
export function buildRendererApi(pluginId: string, version: string): PiRendererApi {
  const styles = new Set<PiRendererStyleHandle>();
  return {
    plugin: { id: pluginId, version },
    slots: {
      register<Props>(
        slot: PluginRendererSlot,
        component: (props: Props) => unknown,
        options?: PiRendererSlotOptions,
      ): ReturnType<PiRendererApi["slots"]["register"]> {
        const handle = pluginSlots.register(pluginId, slot, component, options);
        if (!handle) {
          // `register` already reported why, and that report is the answer the
          // caller gets: a plugin can tell a replace position somebody else
          // holds (`PLUGIN_SLOT_DUPLICATE`, spec 07-plugins/16 2A.5) from a
          // component the registry could not use. Returning a no-op handle
          // would only invite the plugin to think it succeeded.
          const refusals = pluginSlots.listDiagnostics(pluginId);
          const refusal = refusals[refusals.length - 1];
          const code = refusal?.code ?? "PLUGIN_SLOT_INVALID_COMPONENT";
          throw Object.assign(new Error(code), {
            code,
            ...(refusal?.detail === undefined ? {} : { detail: refusal.detail }),
          });
        }
        return {
          slot,
          remove: () => {
            handle.remove();
          },
        };
      },
    },
    functions: {
      // Registration only ever goes through this object, and the module that
      // stores it keys by plugin id: a plugin can only ever touch its own.
      register: (name, fn) => registerRendererFunction(pluginId, name, fn),
    },
    ui: {
      injectStyle(css: string): PiRendererStyleHandle {
        const handle = injectPluginStyle(pluginId, css);
        styles.add(handle);
        return {
          remove: () => {
            styles.delete(handle);
            handle.remove();
          },
        };
      },
    },
  };
}

/** True while a plugin's module is loaded and its slots are live. */
export function isRendererPluginLoaded(pluginId: string): boolean {
  return modules.has(pluginId);
}

/**
 * Load one plugin's renderer entry, once. `declared` is the plugin row's own
 * answer — a plugin that never declared `renderer` is skipped here and reported
 * rather than fetched, which is the host side of D12.
 */
export function ensureRendererPlugin(
  pluginId: string,
  options: RendererPluginLoadOptions,
): Promise<void> {
  // The declaration is recorded before the load is started or reused: the host
  // already knows it from the plugin row, and a dispatch is answered from it
  // even while — or after — the module itself fails to arrive.
  rememberRendererActions(pluginId, options.actions);
  const inFlight = attempts.get(pluginId);
  if (inFlight) return inFlight;
  const attempt = load(pluginId, options);
  attempts.set(pluginId, attempt);
  return attempt;
}

async function load(pluginId: string, options: RendererPluginLoadOptions): Promise<void> {
  if (!options.declared) {
    pluginSlots.report({
      pluginId,
      code: "PLUGIN_SLOT_NOT_DECLARED",
      detail: "the manifest declares no renderer entry, so it cannot own a slot",
    });
    return;
  }
  let entry: string | null = null;
  try {
    entry = (await api.pluginRendererEntry(pluginId)).entry;
  } catch (error) {
    pluginSlots.report({
      pluginId,
      code: "PLUGIN_SLOT_LOAD_FAILED",
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!entry) {
    // Declared, but the host is not serving it: no `renderer.extension` grant,
    // or the plugin is no longer loaded. Both are answers, not accidents.
    pluginSlots.report({
      pluginId,
      code: "PLUGIN_SLOT_NOT_DECLARED",
      detail: "no renderer entry is being served for this plugin",
    });
    return;
  }
  installRendererImportMap();
  let namespace: Record<string, unknown>;
  try {
    // The scheme is host-owned and served by the main process, so this is a
    // fetch of the plugin's own package rather than an arbitrary URL.
    namespace = (await import(/* @vite-ignore */ rendererEntryUrl(pluginId, entry))) as Record<
      string,
      unknown
    >;
  } catch (error) {
    pluginSlots.report({
      pluginId,
      code: "PLUGIN_SLOT_LOAD_FAILED",
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const module = (namespace.default ?? namespace) as PiRendererModule;
  if (typeof module?.onLoad !== "function") {
    pluginSlots.report({
      pluginId,
      code: "PLUGIN_INVALID: renderer entry must export onLoad",
      detail: entry,
    });
    return;
  }
  try {
    await module.onLoad(buildRendererApi(pluginId, options.version ?? ""));
  } catch (error) {
    pluginSlots.report({
      pluginId,
      code: "PLUGIN_SLOT_LOAD_FAILED",
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  modules.set(pluginId, module);
  // The plugins page reads "loaded yet?" from this map, so the row has to
  // re-render when the answer changes: a module that registers nothing would
  // otherwise leave the row saying it was never loaded.
  pluginSlots.notifyRendererStateChanged();
}

/**
 * Release everything one plugin owns: its unload hook, its slots and its
 * stylesheets (D10). A plugin that disappears leaves no position, no style and
 * no registration behind.
 */
export async function disposeRendererPlugin(pluginId: string): Promise<void> {
  const module = modules.get(pluginId);
  modules.delete(pluginId);
  attempts.delete(pluginId);
  declaredActions.delete(pluginId);
  // A row that read "loaded" has to be able to read "not loaded yet" again.
  if (module) pluginSlots.notifyRendererStateChanged();
  // The functions a plugin registered go with it (D10): a stale render can
  // never reach into a module that is gone.
  removeRendererFunctions(pluginId);
  pluginSlots.unregisterPlugin(pluginId);
  removePluginStyles(pluginId);
  if (typeof module?.onUnload === "function") {
    try {
      await module.onUnload();
    } catch {
      // A throwing unload hook must not keep the position alive.
    }
  }
}

/**
 * Plugins whose renderer module is live right now. The shell reconciles this
 * against its plugin list: anything here that is no longer installed, loaded or
 * granted gets disposed, which is what makes an uninstall release its positions
 * and its stylesheet without the plugin cooperating.
 */
export function loadedRendererPlugins(): string[] {
  return [...modules.keys()];
}

/** Test seam. */
export function resetRendererPlugins(): void {
  attempts.clear();
  modules.clear();
  declaredActions.clear();
  resetRendererFunctions();
}
