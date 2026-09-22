/**
 * The plugin-provided functions the host may call while it renders (ADR 0294
 * decision 6).
 *
 * Some positions sit inside rendering — a per-message block whose height the
 * transcript must know before it can lay out, a code-block decoration, a value
 * read while a composer control is computed — and cannot wait for an async
 * round trip without flickering or reflowing afterwards. This module is the
 * host side of the interface those positions use: a plugin registers a pure,
 * synchronous function through the `pi` object it was handed
 * (`pi.functions.register`), and the host calls it directly, in this realm, on
 * any render.
 *
 * No production caller ships with this change: the host positions that need a
 * synchronous plugin answer are among the eight slots that are still not
 * mounted, so today the only callers are tests. The seam is the point.
 *
 * A synchronous call cannot be preempted — once the plugin's own code is
 * running, the host cannot stop it. The budget is therefore enforced after the
 * fact: an answer that arrived past `PLUGIN_FUNCTION_BUDGET_MS` is discarded as
 * if the plugin had no opinion, and the breaker is what protects the renders
 * after it. Three consecutive throwing or over-budget calls disable that one
 * function for the rest of the plugin's loaded lifetime; a successful call
 * resets the count. Every failure is reported on the plugin's row under its own
 * code, so an author can see why the host stopped asking, and the single
 * `PLUGIN_FUNCTION_DISABLED` report names the failure that tripped it.
 *
 * This is a contract for plugins that behave, not a security boundary: the
 * module shares the host's realm (ADR 0291 decision 6), so a plugin that wants
 * to do I/O does not need this API to.
 */
import type {
  PiRendererFunctionCallResult,
  PiRendererFunctionFailureCode,
  PiRendererFunctionHandle,
  PiRendererHostFunction,
} from "@pi-desktop/plugin-sdk";
import { pluginSlots } from "../renderer-slots/registry";

/** One frame at 60 Hz: the whole budget a render-time function gets. */
export const PLUGIN_FUNCTION_BUDGET_MS = 16;

/** Consecutive throwing or over-budget calls that disable one function. */
export const PLUGIN_FUNCTION_MAX_STRIKES = 3;

/** The name grammar the SDK documents: lowercase segments joined by `.`, `_`, `-`. */
const PLUGIN_FUNCTION_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

/** The SDK's 64-character ceiling on a function name. */
const PLUGIN_FUNCTION_NAME_MAX_LENGTH = 64;

/** One plugin's function and everything the host remembers about calling it. */
type RegisteredFunction = {
  fn: PiRendererHostFunction;
  /** Consecutive throwing or over-budget calls; a success resets it to 0. */
  strikes: number;
  /** Set once the breaker tripped: the detail every later call is answered with. */
  disabledDetail?: string;
};

/**
 * One map per plugin, keyed by the name the plugin chose. Names are per plugin:
 * two plugins may both register `height`, and one plugin's functions are
 * dropped wholesale when its module is disposed (D10).
 */
const functions = new Map<string, Map<string, RegisteredFunction>>();

/** `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`, at most 64 characters. */
function isValidFunctionName(name: string): boolean {
  return (
    name.length <= PLUGIN_FUNCTION_NAME_MAX_LENGTH && PLUGIN_FUNCTION_NAME_PATTERN.test(name)
  );
}

/** A name as it appears in a diagnostic: quoted when it is one, typed when it is not. */
function describeName(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : typeof value;
}

/**
 * Builds the coded error `pi.functions.register` throws and records the same
 * refusal as a diagnostic, mirroring how `pluginSlots.register` refuses a
 * component: the error reaches the plugin that called `register`, the
 * diagnostic stays on the plugin's row after the plugin has caught it.
 */
function refuseRendererFunction(
  pluginId: string,
  name: unknown,
  code: "PLUGIN_FUNCTION_INVALID_NAME" | "PLUGIN_FUNCTION_DUPLICATE_NAME",
  detail: string,
): Error {
  pluginSlots.report({ pluginId, code, detail });
  return Object.assign(new Error(code), { code, pluginId, name, detail });
}

/** Reports one failed host call and builds the answer the caller receives. */
function refuseCall(
  pluginId: string,
  code: PiRendererFunctionFailureCode,
  detail: string,
): PiRendererFunctionCallResult {
  pluginSlots.report({ pluginId, code, detail });
  return { ok: false, code, detail };
}

/** Milliseconds rounded to two decimals: a diagnostic is read, not parsed. */
function roundMs(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function threwDetail(name: string, error: unknown): string {
  return `"${name}" threw: ${error instanceof Error ? error.message : String(error)}`;
}

function overBudgetDetail(name: string, elapsedMs: number): string {
  return (
    `"${name}" returned after ${roundMs(elapsedMs)} ms, over the ` +
    `${PLUGIN_FUNCTION_BUDGET_MS} ms budget; the answer was discarded`
  );
}

/**
 * Registers one function for one plugin under `name`, or refuses with a coded
 * error: a name outside the grammar (or longer than 64 characters) is
 * `PLUGIN_FUNCTION_INVALID_NAME`, and a name this plugin already registered is
 * `PLUGIN_FUNCTION_DUPLICATE_NAME` rather than a silent replacement. Both
 * refusals are diagnosed here, so the plugin that called `register` learns the
 * code and the row keeps the reason.
 *
 * The handle withdraws exactly this registration, and with it the breaker
 * state; removing it makes the name available again.
 */
export function registerRendererFunction(
  pluginId: string,
  name: string,
  fn: PiRendererHostFunction,
): PiRendererFunctionHandle {
  if (typeof name !== "string" || !isValidFunctionName(name)) {
    throw refuseRendererFunction(
      pluginId,
      name,
      "PLUGIN_FUNCTION_INVALID_NAME",
      `expected a name matching ${PLUGIN_FUNCTION_NAME_PATTERN} with at most ` +
        `${PLUGIN_FUNCTION_NAME_MAX_LENGTH} characters, received ${describeName(name)}`,
    );
  }
  let byName = functions.get(pluginId);
  if (byName?.has(name)) {
    throw refuseRendererFunction(
      pluginId,
      name,
      "PLUGIN_FUNCTION_DUPLICATE_NAME",
      `the plugin already registered "${name}"; remove the existing handle first`,
    );
  }
  if (!byName) {
    byName = new Map();
    functions.set(pluginId, byName);
  }
  const entry: RegisteredFunction = { fn, strikes: 0 };
  byName.set(name, entry);
  return {
    name,
    remove: () => {
      // Identity, not name: a handle held across a dispose must not withdraw a
      // registration made after it.
      if (byName.get(name) === entry) byName.delete(name);
    },
  };
}

/**
 * One failing call: reported under its own code either way, and the third
 * consecutive failure trips the breaker. The trip is reported exactly once,
 * when it happens; later calls are answered from the stored detail without
 * adding another diagnostic, so a render loop cannot flood the plugin's row.
 */
function strike(
  pluginId: string,
  name: string,
  entry: RegisteredFunction,
  code: "PLUGIN_FUNCTION_THREW" | "PLUGIN_FUNCTION_OVER_BUDGET",
  detail: string,
): PiRendererFunctionCallResult {
  entry.strikes += 1;
  pluginSlots.report({ pluginId, code, detail });
  if (entry.strikes >= PLUGIN_FUNCTION_MAX_STRIKES) {
    entry.disabledDetail =
      `"${name}" was disabled after ${entry.strikes} consecutive failures; ` +
      `the last one was ${code}: ${detail}`;
    pluginSlots.report({
      pluginId,
      code: "PLUGIN_FUNCTION_DISABLED",
      detail: entry.disabledDetail,
    });
  }
  return { ok: false, code, detail };
}

/**
 * Calls one registered function and answers with its value or the code the host
 * refused the call under. It never throws: a render position that asked for a
 * synchronous answer gets `ok: false` and carries on with its own value.
 *
 * `input` is handed over unchanged, and the call is measured with
 * `performance.now()` around a direct invocation. A synchronous call cannot be
 * preempted, so the budget is enforced by discarding a late answer and by the
 * breaker — never by cancelling the call.
 */
export function callRendererFunction(
  pluginId: string,
  name: string,
  input?: unknown,
): PiRendererFunctionCallResult {
  const entry = functions.get(pluginId)?.get(name);
  if (!entry) {
    // Also the answer after a dispose or unload: the map is gone, so a stale
    // render can never call into a dead module.
    return refuseCall(
      pluginId,
      "PLUGIN_FUNCTION_MISSING",
      `no function named "${name}" is registered for this plugin`,
    );
  }
  if (entry.disabledDetail !== undefined) {
    return { ok: false, code: "PLUGIN_FUNCTION_DISABLED", detail: entry.disabledDetail };
  }
  const startedAt = performance.now();
  let value: unknown;
  try {
    value = entry.fn(input);
  } catch (error) {
    return strike(pluginId, name, entry, "PLUGIN_FUNCTION_THREW", threwDetail(name, error));
  }
  const elapsedMs = performance.now() - startedAt;
  if (elapsedMs > PLUGIN_FUNCTION_BUDGET_MS) {
    return strike(
      pluginId,
      name,
      entry,
      "PLUGIN_FUNCTION_OVER_BUDGET",
      overBudgetDetail(name, elapsedMs),
    );
  }
  // A healthy call is what clears the count, so a function that recovers is not
  // disabled by the failures that came before it.
  entry.strikes = 0;
  return { ok: true, value };
}

/** Drops every function and every breaker one plugin owns (dispose / unload, D10). */
export function removeRendererFunctions(pluginId: string): void {
  functions.delete(pluginId);
}

/** Test seam: back to a registry no plugin has ever touched. */
export function resetRendererFunctions(): void {
  functions.clear();
}
