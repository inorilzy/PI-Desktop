import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The `aiComplete` half of the trusted-extension bridge in `runtime/sidecar.ts`.
 *
 * That module imports Electron (`shell`, `WebContentsView` through
 * `../browser-view`) and `startSidecar` constructs the real agent sidecar
 * process, so the module hook below substitutes both with stubs. Everything
 * under test — the `setTrustedExtensionBridge` wiring and the `aiComplete`
 * handler — is the real source.
 */
const loaderDir = mkdtempSync(join(tmpdir(), "pi-sidecar-loader-"));
const loaderPath = join(loaderDir, "loader.mjs");
writeFileSync(
  loaderPath,
  `
const ELECTRON_STUB = "data:text/javascript," + encodeURIComponent(
  'export const shell = { openExternal: async () => undefined };\\n' +
  'export class WebContentsView {}\\n' +
  'export default {};\\n',
);
// Stands in for the agent sidecar process: collects the calls the runtime
// wires into it, so the registered bridge can be reached without IPC.
const AGENT_SIDECAR_STUB = "data:text/javascript," + encodeURIComponent(
  'export class AgentSidecar {\\n' +
  '  constructor(onStderr) { globalThis.__piAgentSidecars.push(this); this.onStderr = onStderr; this.bridge = null; this.localTools = new Map(); this.calls = []; }\\n' +
  '  onNotification() { return () => undefined; }\\n' +
  '  onExit() { return () => undefined; }\\n' +
  '  setTrustedExtensionBridge(bridge) { this.bridge = bridge; }\\n' +
  '  setProjectInstructionResolver(resolver) { this.resolver = resolver; }\\n' +
  '  setVendorAuthResolver(resolver) { this.vendorAuth = resolver; }\\n' +
  '  setSubagentModelResolver(resolver) { this.subagentModel = resolver; }\\n' +
  '  setLocalTool(name, handler) { this.localTools.set(name, handler); }\\n' +
  '  setHost(host) { this.host = host; }\\n' +
  '  async call(method, params) { this.calls.push([method, params]); return {}; }\\n' +
  '}\\n' +
  'export default { AgentSidecar };\\n',
);
export async function resolve(specifier, context, next) {
  if (specifier === "electron") return { url: ELECTRON_STUB, shortCircuit: true };
  if (specifier === "../agent-sidecar" && context.parentURL?.includes("/runtime/sidecar.ts")) {
    return { url: AGENT_SIDECAR_STUB, shortCircuit: true };
  }
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return next(specifier, context);
  // The same bundler-style fallbacks the other main-process tests register.
  try {
    return await next(specifier, context);
  } catch (error) {
    const typescript = specifier.endsWith(".js")
      ? \`\${specifier.slice(0, -".js".length)}.ts\`
      : /\\.[a-z]+$/i.test(specifier)
        ? null
        : \`\${specifier}.ts\`;
    if (typescript === null) throw error;
    return next(typescript, context);
  }
}
`,
  "utf8",
);
register(pathToFileURL(loaderPath));

globalThis.__piAgentSidecars = [];
const { createSidecarRuntime } = await import("../electron/main/runtime/sidecar.ts");

/** The wiring minus the completion handler every case has to observe. */
function dependencies(invokeAgentModelComplete) {
  return {
    runtimeState: {},
    steeringReplies: new Set(),
    logger: { app: () => undefined, child: () => () => undefined, flushChild: () => undefined },
    sendToRenderer: () => undefined,
    persistAgentEvent: () => undefined,
    activeTurns: new Map(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    inflightCheckpointer: { flush: async () => undefined, settle: () => undefined },
    finishTurn: () => undefined,
    finishApprovedExecution: async () => undefined,
    superviseRestart: async () => undefined,
    isStaleTerminalEvent: () => false,
    isQuitting: () => false,
    dataDir: "C:/tmp/pi-sidecar-test",
    agentExtensions: {
      publishCommands: () => undefined,
      publishDiagnostics: () => undefined,
      requestUi: async () => ({}),
    },
    vendorOAuth: {},
    listRuntimeProviders: async () => [],
    modelsDevCatalog: {},
    effectiveSubagentModelConfig: () => undefined,
    browserHost: {},
    plugins: { invokeAgentModelComplete, getSkills: () => [] },
    sessionProjects: new Map(),
    loadUserSkillBody: async () => undefined,
    activeUserSkills: async () => [],
    pluginActiveInProject: () => true,
    currentNetworkProxy: () => undefined,
  };
}

/** Start one sidecar runtime and hand back the bridge it registered. */
async function wiring(handler) {
  const forwarded = [];
  const runtime = createSidecarRuntime(
    dependencies(async (pluginId, input) => {
      forwarded.push({ pluginId, input });
      return handler
        ? handler(pluginId, input)
        : { text: "ship smaller", modelKey: input.modelKey ?? null };
    }),
  );
  await runtime.startSidecar();
  const sidecar = globalThis.__piAgentSidecars.at(-1);
  assert.ok(sidecar?.bridge?.aiComplete, "the runtime should register the trusted-extension bridge");
  return { bridge: sidecar.bridge, forwarded, sidecar };
}

test("the sidecar aiComplete bridge forwards the caller's fields and defaults the grant", async () => {
  const { bridge, forwarded } = await wiring();
  const result = await bridge.aiComplete({
    pluginId: "demo.ext",
    messages: [{ role: "user", content: "tighten this" }],
    system: "be terse",
    modelKey: "prov/model",
    purpose: "prompt-enhance",
  });
  assert.deepEqual(result, { text: "ship smaller", modelKey: "prov/model" });
  assert.deepEqual(forwarded, [
    {
      pluginId: "demo.ext",
      input: {
        messages: [{ role: "user", content: "tighten this" }],
        system: "be terse",
        modelKey: "prov/model",
        purpose: "prompt-enhance",
        permissions: ["agent.model.complete"],
      },
    },
  ]);
});

test("a caller that names its own grants keeps exactly those", async () => {
  const { bridge, forwarded } = await wiring();
  await bridge.aiComplete({
    pluginId: "demo.ext",
    messages: [],
    permissions: ["agent.complete"],
  });
  assert.deepEqual(forwarded[0].input.permissions, ["agent.complete"]);
});

test("an unnamed caller is labelled extension", async () => {
  const { bridge, forwarded } = await wiring();
  await bridge.aiComplete({ messages: [] });
  assert.equal(forwarded[0].pluginId, "extension");
});

test("a caller that names a blank plugin id is labelled extension too", async () => {
  const { bridge, forwarded } = await wiring();
  await bridge.aiComplete({ pluginId: "   ", messages: [] });
  assert.equal(forwarded[0].pluginId, "extension");
});

test("a completion failure becomes a coded result instead of a rejection", async () => {
  const { bridge } = await wiring(async () => {
    throw Object.assign(new Error("no configured model for agent.model.complete"), {
      code: "NO_MODEL",
    });
  });
  const refused = await bridge.aiComplete({ pluginId: "demo.ext", messages: [] });
  assert.deepEqual(refused, {
    ok: false,
    code: "NO_MODEL",
    detail: "no configured model for agent.model.complete",
  });
});

test("an uncoded completion failure is reported as PROVIDER_ERROR", async () => {
  const { bridge } = await wiring(async () => {
    throw new Error("socket hang up");
  });
  const refused = await bridge.aiComplete({ pluginId: "demo.ext", messages: [] });
  assert.deepEqual(refused, { ok: false, code: "PROVIDER_ERROR", detail: "socket hang up" });
});
