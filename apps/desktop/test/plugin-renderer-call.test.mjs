/**
 * The main-process half of `plugin.call` (ADR 0294 decision 4): a renderer
 * slot's forwarded action reaches the calling plugin's own headless entry, and
 * every refusal on the way is a coded error rather than a silent no-op.
 *
 * These cases drive the real `PluginRuntime` with a real forked plugin host
 * process, so the declaration check reads the manifest the runtime loaded and
 * the answer travels back over the same child channel a panel call uses.
 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const hostEntry = fileURLToPath(
  new URL("../electron/main/plugin-host-process.mjs", import.meta.url),
);

const ECHO_PLUGIN = `
  async function onRendererCall(method, args) {
    if (method === "slots.echo") return { method, args, id: pi.plugin.getId() };
    if (method === "slots.nothing") return undefined;
    if (method === "slots.throw") {
      throw Object.assign(new Error("plugin refused"), { code: "ACME_REFUSED" });
    }
    if (method === "slots.hang") return new Promise(() => {});
    throw new Error("no such method: " + method);
  }
  module.exports = { onRendererCall };
`;

const DECLARED = ["plugin.call"];

function manifest(overrides) {
  return {
    schemaVersion: 1,
    id: "demo.renderer",
    name: "Renderer Call",
    version: "0.0.1",
    main: "main.js",
    rendererActions: DECLARED,
    ...overrides,
  };
}

/** One loaded plugin plus the runtime that owns it, torn down by the test. */
async function fixture(t, { pluginManifest, main }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-renderer-call-"));
  const id = pluginManifest.id;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(pluginManifest));
  if (main !== undefined) writeFileSync(join(dir, "main.js"), main);

  const runtime = new PluginRuntime({
    hostEntry,
    spawnProcess({ entry }) {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      return {
        postMessage: (message) => {
          if (child.connected) child.send(message);
        },
        onMessage: (handler) => child.on("message", handler),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
  });
  t.after(async () => {
    await runtime.unload(id).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await runtime.loadFromPath(dir, pluginManifest.permissions ?? []);
  return { id, runtime };
}

/** The coded refusal, checked under both names the IPC envelope reads. */
async function refusal(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    // `errorCode` is what the `Result` envelope carries to the renderer
    // (register.ts `wrap` reads it before falling back to `INTERNAL`), so a
    // code that only lived on `code` would reach the plugin row as INTERNAL.
    assert.equal(error.errorCode, code);
    return true;
  });
}

test("a declared plugin.call reaches the plugin's own entry and comes back unchanged", async (t) => {
  const { id, runtime } = await fixture(t, {
    pluginManifest: manifest({}),
    main: ECHO_PLUGIN,
  });

  assert.deepEqual(await runtime.invokeRendererCall(id, "slots.echo", { text: "hi" }), {
    method: "slots.echo",
    args: { text: "hi" },
    id: "demo.renderer",
  });
  // An answer that carries nothing arrives as `null`, never as `undefined`:
  // the renderer has to distinguish "no answer" from "the channel broke".
  assert.equal(await runtime.invokeRendererCall(id, "slots.nothing", null), null);
  // A code the plugin chose survives, so a plugin author can branch on it.
  await refusal(runtime.invokeRendererCall(id, "slots.throw", null), "ACME_REFUSED");
});

test("a plugin that does not declare plugin.call is refused before anything is forwarded", async (t) => {
  const { id, runtime } = await fixture(t, {
    pluginManifest: manifest({ rendererActions: ["ui.toast"] }),
    main: ECHO_PLUGIN,
  });

  await refusal(runtime.invokeRendererCall(id, "slots.echo", null), "PLUGIN_CALL_UNDECLARED");
});

test("a plugin.call with no plugin id or method name is refused", async (t) => {
  const { runtime } = await fixture(t, {
    pluginManifest: manifest({}),
    main: ECHO_PLUGIN,
  });

  await refusal(runtime.invokeRendererCall("", "slots.echo", null), "PLUGIN_CALL_INVALID");
  await refusal(runtime.invokeRendererCall("demo.renderer", "", null), "PLUGIN_CALL_INVALID");
});

test("an unknown or unloaded plugin id is refused", async (t) => {
  const { id, runtime } = await fixture(t, {
    pluginManifest: manifest({}),
    main: ECHO_PLUGIN,
  });

  await refusal(runtime.invokeRendererCall("nope.unknown", "slots.echo", null), "PLUGIN_CALL_UNKNOWN_PLUGIN");
  await runtime.unload(id);
  await refusal(runtime.invokeRendererCall(id, "slots.echo", null), "PLUGIN_CALL_UNKNOWN_PLUGIN");
});

test("a UI-only plugin has no entry of its own and is refused, not served by a neighbour", async (t) => {
  const { id, runtime } = await fixture(t, {
    pluginManifest: manifest({
      main: undefined,
      renderer: "index.mjs",
      permissions: ["renderer.extension"],
    }),
  });
  // "Its own entry" does not exist (ADR 0294 decision 4): there is no page
  // relay to fall back on, and answering from another plugin's process would
  // run the call in a plugin the renderer never named.
  await refusal(runtime.invokeRendererCall(id, "slots.echo", null), "PLUGIN_CALL_NO_ENTRY");
});

test("a plugin that hosts no renderer methods refuses with a coded no-handler answer", async (t) => {
  const { id, runtime } = await fixture(t, {
    pluginManifest: manifest({}),
    main: `module.exports = { onLoad: async () => {} };`,
  });

  await refusal(runtime.invokeRendererCall(id, "slots.echo", null), "PLUGIN_CALL_NO_HANDLER");
});

test("a renderer call that never answers times out under its own code", { timeout: 5000 }, async (t) => {
  const { id, runtime } = await fixture(t, {
    pluginManifest: manifest({}),
    main: ECHO_PLUGIN,
  });

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = runtime.invokeRendererCall(id, "slots.hang", null);
  const rejected = refusal(pending, "PLUGIN_CALL_TIMEOUT");
  t.mock.timers.tick(30_000);
  t.mock.timers.reset();
  await rejected;
});
