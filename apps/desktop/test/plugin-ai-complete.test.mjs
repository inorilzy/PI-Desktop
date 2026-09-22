import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Plugin-level AI completion (`pi.ai.complete`, permission
 * `agent.model.complete`, legacy `agent.complete`) on the Electron-main side.
 *
 * The loaded-plugin cases drive a real forked host process. The rest exercise
 * `PluginRuntime` directly: the completion path keeps credentials in main and
 * never touches a plugin process, so no child is needed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  MAX_COMPLETE_MESSAGE_CHARS,
  MAX_COMPLETE_SYSTEM_CHARS,
  MAX_COMPLETES_PER_WINDOW,
  PluginRuntime,
} = await import("../electron/main/plugin-runtime.ts");

/** The product grant and the pre-rename one the gate still accepts. */
const AI_GRANT = "agent.model.complete";
const LEGACY_AI_GRANT = "agent.complete";

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

function writePlugin({ id, permissions, main }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-ai-complete-plugin-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version: "0.0.1",
      main: "main.js",
      permissions,
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return dir;
}

/**
 * One runtime per case. `completes` records what reached the provider and
 * `audits` what the runtime wrote about it; a case that passes its own
 * `complete` still gets both collectors.
 */
function aiRuntime(services = {}) {
  const completes = [];
  const audits = [];
  const runtime = new PluginRuntime({
    complete: async (input) => {
      completes.push(input);
      return { text: "ok", modelKey: input.modelKey };
    },
    ...services,
    audit: (entry) => {
      audits.push(entry);
      services.audit?.(entry);
    },
  });
  return { runtime, completes, audits };
}

/** One `PluginModelInfo` row; deliberately WITHOUT the internal `modelKey`. */
function modelRow(key, extra = {}) {
  const [providerId, ...rest] = String(key).split("/");
  return {
    key,
    providerId,
    providerName: providerId,
    modelId: rest.join("/"),
    label: key,
    supportsReasoning: false,
    thinkingLevels: [],
    ...extra,
  };
}

function completion(permissions, input = {}) {
  return [
    "demo.ext",
    { permissions, modelKey: "prov/model", messages: [{ role: "user", content: "hi" }], ...input },
  ];
}

test("pi.ai.complete answers under the agent.model.complete grant", async () => {
  const { runtime, completes } = aiRuntime({ listModels: async () => [] });
  const result = await runtime.invokeAgentModelComplete(...completion([AI_GRANT]));
  assert.equal(result.modelKey, "prov/model");
  assert.equal(completes.length, 1);
  assert.equal(completes[0].modelKey, "prov/model");
});

test("pi.ai.complete answers under the legacy agent.complete grant", async () => {
  const { runtime, completes } = aiRuntime({ listModels: async () => [] });
  const result = await runtime.invokeAgentModelComplete(...completion([LEGACY_AI_GRANT]));
  assert.equal(result.modelKey, "prov/model");
  assert.equal(completes.length, 1);
});

test("pi.ai.complete without either completion grant is refused and never calls the provider", async () => {
  const { runtime, completes } = aiRuntime({
    complete: async () => {
      throw new Error("the provider must not be called after a refusal");
    },
  });
  await assert.rejects(
    () => runtime.invokeAgentModelComplete(...completion(["models.list", "session.read"])),
    (error) => error.code === "PERMISSION_DENIED",
  );
  assert.deepEqual(completes, []);
});

test("the completion permission gate writes no audit entry (unlike assertPermission)", async () => {
  // `assertPermission` audits every denial; the inline completion gate throws
  // without writing anything, so a refused `pi.ai.complete` leaves no trace on
  // the plugin row.
  const { runtime, audits } = aiRuntime({});
  await assert.rejects(
    () => runtime.invokeAgentModelComplete(...completion([])),
    (error) => error.code === "PERMISSION_DENIED",
  );
  assert.deepEqual(audits, []);
});

test("an omitted modelKey resolves the flagged host default from the ready catalog", async () => {
  const { runtime, completes } = aiRuntime({
    listModels: async () => [
      modelRow("a/one"),
      modelRow("b/two", { isDefault: true }),
    ],
  });
  const result = await runtime.invokeAgentModelComplete(...completion([AI_GRANT], { modelKey: undefined }));
  assert.equal(result.modelKey, "b/two");
  assert.equal(completes[0].modelKey, "b/two");
});

test("an omitted modelKey falls back to the first catalog row that carries a key", async () => {
  const { runtime, completes } = aiRuntime({
    listModels: async () => [
      { providerId: "ghost", providerName: "Ghost", modelId: "gone" },
      modelRow("a/one"),
      modelRow("b/two"),
    ],
  });
  const result = await runtime.invokeAgentModelComplete(...completion([AI_GRANT], { modelKey: "  " }));
  assert.equal(result.modelKey, "a/one");
  assert.equal(completes[0].modelKey, "a/one");
});

test("an omitted modelKey without a usable catalog row throws NO_MODEL", async () => {
  const catalogs = [
    ["an empty catalog", async () => []],
    ["no catalog service", undefined],
    ["rows without a key field", async () => [{ providerId: "only", providerName: "Only", modelId: "shape" }]],
    ["a blank key", async () => [modelRow("   ")]],
    ["a key without a provider prefix", async () => [modelRow("providerless")]],
    ["a non-string key", async () => [{ ...modelRow("a/one"), key: 42 }]],
  ];
  for (const [label, listModels] of catalogs) {
    const { runtime, completes } = aiRuntime(listModels ? { listModels } : {});
    await assert.rejects(
      () =>
        runtime.invokeAgentModelComplete(
          ...completion([AI_GRANT], { modelKey: undefined }),
        ),
      (error) => error.code === "NO_MODEL",
      label,
    );
    assert.deepEqual(completes, [], label);
  }
});

test("an explicit modelKey is trimmed, passed through, and never consults the catalog", async () => {
  let listCalls = 0;
  const { runtime, completes } = aiRuntime({
    listModels: async () => {
      listCalls += 1;
      return [];
    },
  });
  const result = await runtime.invokeAgentModelComplete(
    ...completion([AI_GRANT], { modelKey: "  prov/org/model  " }),
  );
  assert.equal(result.modelKey, "prov/org/model");
  assert.equal(completes[0].modelKey, "prov/org/model");
  assert.equal(listCalls, 0);
});

test("an explicit modelKey without a provider prefix is refused INVALID_ARGUMENT", async () => {
  const { runtime, completes } = aiRuntime({ listModels: async () => [] });
  await assert.rejects(
    () =>
      runtime.invokeAgentModelComplete(
        ...completion([AI_GRANT], { modelKey: "no-slash" }),
      ),
    (error) => error.code === "INVALID_ARGUMENT" && /providerId\/modelId/.test(error.message),
  );
  assert.deepEqual(completes, []);
});

test("the system prompt limit is exactly 32 KiB", async () => {
  assert.equal(MAX_COMPLETE_SYSTEM_CHARS, 32 * 1024);
  const { runtime, completes } = aiRuntime({});
  await runtime.invokeAgentModelComplete(
    ...completion([AI_GRANT], { system: "s".repeat(MAX_COMPLETE_SYSTEM_CHARS) }),
  );
  assert.equal(completes.length, 1);
  await assert.rejects(
    () =>
      runtime.invokeAgentModelComplete(
        ...completion([AI_GRANT], { system: "s".repeat(MAX_COMPLETE_SYSTEM_CHARS + 1) }),
      ),
    (error) => error.code === "INVALID_ARGUMENT" && /32 KiB/.test(error.message),
  );
  assert.equal(completes.length, 1);
});

test("the message budget is 200k characters across every message", async () => {
  assert.equal(MAX_COMPLETE_MESSAGE_CHARS, 200_000);
  const { runtime, completes } = aiRuntime({});
  const half = "m".repeat(MAX_COMPLETE_MESSAGE_CHARS / 2);
  await runtime.invokeAgentModelComplete(
    ...completion([AI_GRANT], {
      messages: [
        { role: "user", content: half },
        { role: "assistant", content: half },
      ],
    }),
  );
  assert.equal(completes.length, 1);
  await assert.rejects(
    () =>
      runtime.invokeAgentModelComplete(
        ...completion([AI_GRANT], {
          messages: [{ role: "user", content: "m".repeat(MAX_COMPLETE_MESSAGE_CHARS + 1) }],
        }),
      ),
    (error) => error.code === "INVALID_ARGUMENT" && /200k characters/.test(error.message),
  );
  assert.equal(completes.length, 1);
});

test("the completion after MAX_COMPLETES_PER_WINDOW calls is refused RATE_LIMITED", async () => {
  assert.equal(MAX_COMPLETES_PER_WINDOW, 8);
  const { runtime, completes, audits } = aiRuntime({});
  const codes = [];
  for (let index = 0; index < MAX_COMPLETES_PER_WINDOW + 1; index += 1) {
    try {
      await runtime.invokeAgentModelComplete(...completion([AI_GRANT]));
    } catch (error) {
      codes.push(error.code);
    }
  }
  assert.equal(completes.length, MAX_COMPLETES_PER_WINDOW);
  assert.deepEqual(codes, ["RATE_LIMITED"]);
  const refusals = audits.filter((entry) => entry.errorCode === "RATE_LIMITED");
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].pluginId, "demo.ext");
  // The audit entry still carries the pre-rename api name for all three
  // method names, so a reader cannot tell which one the call used.
  assert.equal(refusals[0].api, "agent.complete");
  assert.equal(refusals[0].ok, false);
});

test("the broker routes agent.complete, agent.model.complete, and ai.complete to the same handler", async () => {
  // The broker is private: driving it directly keeps the switch under test
  // without forking a host process for each method name.
  const { runtime, completes } = aiRuntime({});
  const loaded = { manifest: { id: "demo.dispatch", name: "Demo" }, permissions: new Set([AI_GRANT]) };
  for (const api of [LEGACY_AI_GRANT, AI_GRANT, "ai.complete"]) {
    const result = await runtime.dispatchHostCall(loaded, api, [
      { modelKey: "prov/model", messages: [{ role: "user", content: "hi" }] },
    ]);
    assert.equal(result.modelKey, "prov/model", api);
  }
  assert.equal(completes.length, 3);
});

test("the broker gates completion on the loaded record, not on the args the caller sends", async () => {
  const { runtime, completes, audits } = aiRuntime({});
  const loaded = { manifest: { id: "demo.locked", name: "Locked" }, permissions: new Set(["models.list"]) };
  await assert.rejects(
    () =>
      runtime.dispatchHostCall(loaded, "ai.complete", [
        { permissions: [AI_GRANT], modelKey: "prov/model", messages: [] },
      ]),
    (error) => error.code === "PERMISSION_DENIED",
  );
  assert.deepEqual(completes, []);
  // Same inline gate as the plugin path: a denial is not audited.
  assert.deepEqual(audits, []);
});

test("the broker refuses a host API that is not on the allowlist", async () => {
  const { runtime, audits } = aiRuntime({});
  const loaded = { manifest: { id: "demo.dispatch", name: "Demo" }, permissions: new Set([AI_GRANT]) };
  await assert.rejects(
    () => runtime.dispatchHostCall(loaded, "nope.nope", []),
    (error) => error.code === "UNSUPPORTED" && /not available/.test(error.message),
  );
  const refusals = audits.filter((entry) => entry.api === "nope.nope");
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].pluginId, "demo.dispatch");
  assert.equal(refusals[0].ok, false);
  assert.equal(refusals[0].errorCode, "UNSUPPORTED");
});

test("HOST_API_ALLOWLIST lists all three completion method names", async () => {
  // The three names are matched by their own switch cases before the allowlist
  // is consulted, so membership is defence in depth and only the literal can be
  // pinned here.
  const source = await readFile(new URL("../electron/main/plugin-runtime.ts", import.meta.url), "utf8");
  const start = source.indexOf("const HOST_API_ALLOWLIST = new Set([");
  assert.ok(start >= 0, "HOST_API_ALLOWLIST not found");
  const allowlist = source.slice(start, source.indexOf("]);", start));
  for (const name of [LEGACY_AI_GRANT, AI_GRANT, "ai.complete"]) {
    assert.match(allowlist, new RegExp(`"${name.replace(".", "\\.")}",`), name);
  }
});

test("an extension without a loaded record is allowed by the grant the caller passes", async () => {
  const { runtime, completes } = aiRuntime({});
  const result = await runtime.invokeAgentModelComplete(
    "some.unknown-extension",
    {
      permissions: [AI_GRANT],
      modelKey: "prov/model",
      messages: [{ role: "user", content: "hi" }],
    },
  );
  assert.equal(result.modelKey, "prov/model");
  assert.equal(completes.length, 1);
});

test("an extension without a loaded record cannot pass a permission the gate does not know", async () => {
  for (const permissions of [[], ["ai.complete"], ["agent.complete.stream"]]) {
    const { runtime, completes } = aiRuntime({});
    await assert.rejects(
      () =>
        runtime.invokeAgentModelComplete("some.unknown-extension", {
          permissions,
          modelKey: "prov/model",
          messages: [],
        }),
      (error) => error.code === "PERMISSION_DENIED",
      permissions.join(",") || "none",
    );
    assert.deepEqual(completes, []);
  }
});

test("the documented purpose label never reaches the completion audit entry", async () => {
  const { runtime, audits } = aiRuntime({});
  await runtime.invokeAgentModelComplete(
    ...completion([AI_GRANT], { purpose: "prompt-enhance" }),
  );
  const entry = audits.find((candidate) => candidate.api === "agent.complete" && candidate.ok === true);
  assert.ok(entry, "a successful completion should be audited");
  assert.equal("purpose" in entry, false);
});

test("pi.ai.complete in a plugin process resolves the host default without a models.list grant", async (t) => {
  const completes = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    listModels: async () => [modelRow("a/one"), modelRow("b/two", { isDefault: true })],
    complete: async (input) => {
      completes.push(input);
      return { text: "ship smaller", modelKey: input.modelKey };
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const permissions = ["agent.tool.register", AI_GRANT];
  const dir = writePlugin({
    id: "demo.ai",
    permissions,
    main: `
      module.exports = {
        async onLoad() {
          await pi.agent.registerTool({
            name: "enhance",
            description: "enhance",
            schema: { type: "object", properties: {} },
            execute: async () => {
              const result = await pi.ai.complete({
                messages: [{ role: "user", content: "tighten this" }],
              });
              return { text: result.text, modelKey: result.modelKey };
            },
          });
        },
      };
    `,
  });
  await runtime.loadFromPath(dir, permissions);

  const tool = runtime.getTools().find((entry) => entry.name === "enhance");
  const output = await tool.execute({}, { sessionId: "sess-1" });
  assert.equal(output.modelKey, "b/two");
  assert.equal(output.text, "ship smaller");
  assert.equal(completes[0].modelKey, "b/two");
});

test("a plugin reads the host NO_MODEL code when the catalog offers no model", async (t) => {
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    listModels: async () => [{ providerId: "only", providerName: "Only", modelId: "shape" }],
    complete: async () => {
      throw new Error("the provider must not be called without a model");
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const permissions = ["agent.tool.register", AI_GRANT];
  const dir = writePlugin({
    id: "demo.no-model",
    permissions,
    main: `
      module.exports = {
        async onLoad() {
          await pi.agent.registerTool({
            name: "enhance",
            description: "enhance",
            schema: { type: "object", properties: {} },
            execute: async () => {
              try {
                await pi.ai.complete({ messages: [{ role: "user", content: "x" }] });
                return { code: null, message: null };
              } catch (error) {
                return { code: error.code || null, message: error.message || null };
              }
            },
          });
        },
      };
    `,
  });
  await runtime.loadFromPath(dir, permissions);

  const tool = runtime.getTools().find((entry) => entry.name === "enhance");
  const output = await tool.execute({}, { sessionId: "sess-1" });
  assert.equal(output.code, "NO_MODEL");
  assert.match(output.message, /no configured model/);
});
