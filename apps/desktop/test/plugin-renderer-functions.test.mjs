/**
 * Unit tests for the host-callable plugin functions (ADR 0294 decision 6).
 *
 * These functions are the one part of the renderer interface the host calls
 * itself, while it renders: a position that needed an async round trip would
 * flicker or reflow after the fact. The production positions that need a
 * synchronous answer are not mounted yet, so the module has no production
 * caller — what is under test is the host's own bookkeeping: what it does with
 * a value, with a throw, with an answer that arrived too late, with a name it
 * cannot accept, and with a function that keeps misbehaving.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

// `host-functions` reports through the slot registry, and the loader is loaded
// for its dispose path, so the two globals those modules expect exist here as
// they do in the app. Nothing in this file injects a sheet or calls the bridge.
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
};

/** The budget's only clock is `performance.now()`, so the test owns it. */
let clock = 0;
globalThis.performance = { now: () => clock };

const { pluginSlots, resetPluginSlots } = await import(
  "../src/plugins/renderer-slots/registry.ts"
);
const {
  PLUGIN_FUNCTION_BUDGET_MS,
  PLUGIN_FUNCTION_MAX_STRIKES,
  callRendererFunction,
  registerRendererFunction,
  resetRendererFunctions,
} = await import("../src/plugins/renderer-host/host-functions.ts");
const { disposeRendererPlugin, resetRendererPlugins } = await import(
  "../src/plugins/renderer-host/loader.ts"
);

const PLUGIN = "acme.functions";

function reset() {
  resetRendererFunctions();
  resetRendererPlugins();
  resetPluginSlots();
  clock = 0;
}

/** The diagnostic codes one plugin's row carries, oldest first. */
function codesFor(pluginId = PLUGIN) {
  return pluginSlots
    .listDiagnostics()
    .filter((diagnostic) => diagnostic.pluginId === pluginId)
    .map((diagnostic) => diagnostic.code);
}

test("a registered function answers with its value", () => {
  reset();
  const input = { rows: 3 };
  registerRendererFunction(PLUGIN, "layout.height", (given) => ({ height: given.rows * 2 }));
  assert.deepEqual(callRendererFunction(PLUGIN, "layout.height", input), {
    ok: true,
    value: { height: 6 },
  });
  assert.deepEqual(codesFor(), []);
});

test("an input the host never passes arrives as undefined, not as a second call shape", () => {
  reset();
  registerRendererFunction(PLUGIN, "peek", (given) => (given === undefined ? "nothing" : "something"));
  assert.deepEqual(callRendererFunction(PLUGIN, "peek"), { ok: true, value: "nothing" });
});

test("a name nobody registered is a coded refusal, not a throw", () => {
  reset();
  const result = callRendererFunction(PLUGIN, "layout.height");
  assert.equal(result.ok, false);
  assert.equal(result.code, "PLUGIN_FUNCTION_MISSING");
  assert.match(result.detail, /layout\.height/);
  assert.deepEqual(codesFor(), ["PLUGIN_FUNCTION_MISSING"]);
});

test("a throwing function is refused under its own code", () => {
  reset();
  registerRendererFunction(PLUGIN, "boom", () => {
    throw new Error("nope");
  });
  const result = callRendererFunction(PLUGIN, "boom");
  assert.equal(result.ok, false);
  assert.equal(result.code, "PLUGIN_FUNCTION_THREW");
  assert.match(result.detail, /nope/);
  assert.deepEqual(codesFor(), ["PLUGIN_FUNCTION_THREW"]);
});

test("an answer past the one-frame budget is discarded, not used late", () => {
  reset();
  registerRendererFunction(PLUGIN, "slow", () => {
    clock = PLUGIN_FUNCTION_BUDGET_MS + 1;
    return "late";
  });
  const result = callRendererFunction(PLUGIN, "slow");
  assert.equal(result.ok, false);
  assert.equal(result.code, "PLUGIN_FUNCTION_OVER_BUDGET");
  assert.match(result.detail, /discarded/);
  assert.deepEqual(codesFor(), ["PLUGIN_FUNCTION_OVER_BUDGET"]);
});

test("an answer exactly at the budget is still used", () => {
  reset();
  registerRendererFunction(PLUGIN, "exact", () => {
    clock = PLUGIN_FUNCTION_BUDGET_MS;
    return "in time";
  });
  assert.deepEqual(callRendererFunction(PLUGIN, "exact"), { ok: true, value: "in time" });
  assert.deepEqual(codesFor(), []);
});

test("consecutive failures disable one function and stop calling it", () => {
  reset();
  let calls = 0;
  registerRendererFunction(PLUGIN, "flaky", () => {
    calls += 1;
    clock += PLUGIN_FUNCTION_BUDGET_MS + 5;
    return calls;
  });
  for (let attempt = 1; attempt <= PLUGIN_FUNCTION_MAX_STRIKES; attempt += 1) {
    const result = callRendererFunction(PLUGIN, "flaky");
    assert.equal(result.code, "PLUGIN_FUNCTION_OVER_BUDGET");
  }
  const callsBefore = calls;
  const disabled = callRendererFunction(PLUGIN, "flaky");
  assert.equal(disabled.ok, false);
  assert.equal(disabled.code, "PLUGIN_FUNCTION_DISABLED");
  assert.match(disabled.detail, /PLUGIN_FUNCTION_OVER_BUDGET/);
  // The breaker is what protects the renders after it: the plugin's code is not
  // entered again, and the row is not flooded while a render loop asks on.
  assert.equal(calls, callsBefore);
  assert.equal(callRendererFunction(PLUGIN, "flaky").code, "PLUGIN_FUNCTION_DISABLED");
  const codes = codesFor();
  assert.equal(codes.filter((code) => code === "PLUGIN_FUNCTION_DISABLED").length, 1);
  assert.equal(codes.filter((code) => code === "PLUGIN_FUNCTION_OVER_BUDGET").length, 3);
});

test("one healthy call clears the strikes", () => {
  reset();
  const behaviour = { slow: true };
  registerRendererFunction(PLUGIN, "recovering", () => {
    clock += behaviour.slow ? PLUGIN_FUNCTION_BUDGET_MS + 5 : PLUGIN_FUNCTION_BUDGET_MS;
    return "value";
  });
  assert.equal(callRendererFunction(PLUGIN, "recovering").code, "PLUGIN_FUNCTION_OVER_BUDGET");
  assert.equal(callRendererFunction(PLUGIN, "recovering").code, "PLUGIN_FUNCTION_OVER_BUDGET");
  behaviour.slow = false;
  assert.deepEqual(callRendererFunction(PLUGIN, "recovering"), { ok: true, value: "value" });
  behaviour.slow = true;
  assert.equal(callRendererFunction(PLUGIN, "recovering").code, "PLUGIN_FUNCTION_OVER_BUDGET");
  assert.equal(callRendererFunction(PLUGIN, "recovering").code, "PLUGIN_FUNCTION_OVER_BUDGET");
  // Two strikes after the reset: still callable, and still not disabled.
  assert.equal(callRendererFunction(PLUGIN, "recovering").code, "PLUGIN_FUNCTION_OVER_BUDGET");
  assert.equal(callRendererFunction(PLUGIN, "recovering").code, "PLUGIN_FUNCTION_DISABLED");
});

test("a name outside the grammar is refused before anything is registered", () => {
  reset();
  for (const name of ["", "Bad", "9lives", "trailing.", "spaced name", "a".repeat(65)]) {
    assert.throws(
      () => registerRendererFunction(PLUGIN, name, () => 1),
      /PLUGIN_FUNCTION_INVALID_NAME/,
      name,
    );
  }
  assert.equal(callRendererFunction(PLUGIN, "bad").code, "PLUGIN_FUNCTION_MISSING");
  assert.deepEqual(
    codesFor().filter((code) => code !== "PLUGIN_FUNCTION_MISSING"),
    [
      "PLUGIN_FUNCTION_INVALID_NAME",
      "PLUGIN_FUNCTION_INVALID_NAME",
      "PLUGIN_FUNCTION_INVALID_NAME",
      "PLUGIN_FUNCTION_INVALID_NAME",
      "PLUGIN_FUNCTION_INVALID_NAME",
      "PLUGIN_FUNCTION_INVALID_NAME",
    ],
  );
});

test("a duplicate name is refused rather than replaced", () => {
  reset();
  registerRendererFunction(PLUGIN, "height", () => 1);
  assert.throws(() => registerRendererFunction(PLUGIN, "height", () => 2), /PLUGIN_FUNCTION_DUPLICATE_NAME/);
  assert.deepEqual(callRendererFunction(PLUGIN, "height"), { ok: true, value: 1 });
  assert.equal(codesFor().filter((code) => code === "PLUGIN_FUNCTION_DUPLICATE_NAME").length, 1);
});

test("removing a handle frees the name for the next registration", () => {
  reset();
  const handle = registerRendererFunction(PLUGIN, "height", () => 1);
  assert.equal(handle.name, "height");
  handle.remove();
  assert.equal(callRendererFunction(PLUGIN, "height").code, "PLUGIN_FUNCTION_MISSING");
  registerRendererFunction(PLUGIN, "height", () => 2);
  assert.deepEqual(callRendererFunction(PLUGIN, "height"), { ok: true, value: 2 });
});

test("names are per plugin, so two plugins may both use one", () => {
  reset();
  registerRendererFunction("acme.one", "height", () => "one");
  registerRendererFunction("acme.two", "height", () => "two");
  assert.deepEqual(callRendererFunction("acme.one", "height"), { ok: true, value: "one" });
  assert.deepEqual(callRendererFunction("acme.two", "height"), { ok: true, value: "two" });
});

test("a disposed or reset plugin leaves nothing behind", async () => {
  reset();
  registerRendererFunction(PLUGIN, "height", () => 1);
  await disposeRendererPlugin(PLUGIN);
  assert.equal(callRendererFunction(PLUGIN, "height").code, "PLUGIN_FUNCTION_MISSING");

  registerRendererFunction(PLUGIN, "height", () => 2);
  resetRendererPlugins();
  assert.equal(callRendererFunction(PLUGIN, "height").code, "PLUGIN_FUNCTION_MISSING");
});

test("the loader hands the plugin its registration point and revokes it on dispose", () => {
  // Source-level, like the other contract tests in this suite: `buildApi` is
  // private, and the shape it hands out is the contract worth pinning.
  const loader = readFileSync(
    new URL("../src/plugins/renderer-host/loader.ts", import.meta.url),
    "utf8",
  );
  assert.match(loader, /register: \(name, fn\) => registerRendererFunction\(pluginId, name, fn\)/);
  assert.match(loader, /removeRendererFunctions\(pluginId\)/);
  assert.match(loader, /resetRendererFunctions\(\)/);

  const sdk = readFileSync(
    new URL("../../../packages/plugin-sdk/src/renderer.ts", import.meta.url),
    "utf8",
  );
  for (const name of [
    "PiRendererHostFunction",
    "PiRendererFunctionHandle",
    "PiRendererFunctionFailureCode",
    "PiRendererFunctionCallResult",
  ]) {
    assert.match(sdk, new RegExp(`export type ${name}\\b`), name);
  }
  assert.match(sdk, /readonly functions: \{/);
  const root = readFileSync(
    new URL("../../../packages/plugin-sdk/src/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(root, /type PiRendererFunctionCallResult/);
});
