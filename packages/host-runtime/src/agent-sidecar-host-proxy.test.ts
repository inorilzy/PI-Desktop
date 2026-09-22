/**
 * The reverse `host.proxy` half of the agent sidecar (`ai.complete` /
 * `agent.complete`, ADR 0295 slot 6 withdrawal).
 *
 * The constructor spawns a real sidecar process, so these cases run against an
 * instance whose prototype is the real class and whose `writeToChild` is
 * captured: `onLine` — the frame dispatch under test — is the real method, and
 * every response the sidecar would receive is asserted as a parsed frame.
 */
import { describe, expect, it } from "vitest";

import { AgentSidecar, type TrustedExtensionSidecarBridge } from "./agent-sidecar.js";

type SidecarInternals = {
  trustedExtensionBridge: TrustedExtensionSidecarBridge | null;
  writeToChild: (payload: string) => boolean;
  onLine: (line: string) => Promise<void>;
};

type Frame = {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

function harness(
  options: {
    bridge?: Partial<TrustedExtensionSidecarBridge> | null;
    host?: { call: (method: string, params: unknown) => Promise<unknown> };
  } = {},
) {
  const frames: Frame[] = [];
  const completes: Array<Record<string, unknown>> = [];
  const base: TrustedExtensionSidecarBridge = {
    publishCommands: () => undefined,
    publishDiagnostics: () => undefined,
    requestUi: async () => ({ ok: true }),
    configureModel: async () => ({ ok: true }),
    queuePush: async () => ({ ok: true }),
    queuePrioritize: async () => ({ ok: true }),
    aiComplete: async (params) => {
      completes.push(params);
      return { ok: true, text: "ship smaller", modelKey: "prov/model" };
    },
    turnAbort: () => undefined,
    ...(options.bridge === null ? {} : options.bridge),
  };
  const sidecar = Object.create(AgentSidecar.prototype) as AgentSidecar & {
    host?: { call: (method: string, params: unknown) => Promise<unknown> };
  };
  const internals = sidecar as unknown as SidecarInternals;
  internals.trustedExtensionBridge = options.bridge === null ? null : base;
  if (options.host) sidecar.host = options.host;
  internals.writeToChild = (payload: string) => {
    frames.push(JSON.parse(payload) as Frame);
    return true;
  };
  const proxy = (method: string, params: Record<string, unknown> = {}) =>
    internals.onLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "host.proxy", params: { method, params } }),
    );
  return { frames, completes, proxy };
}

describe("agent sidecar host proxy", () => {
  it("proxies agent.complete and ai.complete to the plugin completion bridge", async () => {
    const { frames, completes, proxy } = harness();
    for (const method of ["agent.complete", "ai.complete"]) {
      await proxy(method, { pluginId: "demo.ext", messages: [], modelKey: "prov/model" });
      expect(completes.at(-1)).toEqual({
        pluginId: "demo.ext",
        messages: [],
        modelKey: "prov/model",
      });
    }
    expect(frames.map((frame) => frame.result)).toEqual([
      { ok: true, text: "ship smaller", modelKey: "prov/model" },
      { ok: true, text: "ship smaller", modelKey: "prov/model" },
    ]);
    expect(frames.every((frame) => frame.error === undefined)).toBe(true);
  });

  it("refuses a host method that is not on the reverse-proxy allowlist", async () => {
    const { frames, completes, proxy } = harness();
    await proxy("session.delete", { id: "s1" });
    expect(completes).toEqual([]);
    expect(frames).toHaveLength(1);
    expect(frames[0].result).toBeUndefined();
    expect(frames[0].error?.code).toBe(-32601);
    expect(frames[0].error?.message).toMatch(/host method not allowed from sidecar: session\.delete/);
  });

  it("fails closed when no trusted extension bridge was registered", async () => {
    const { frames, completes, proxy } = harness({ bridge: null });
    await proxy("ai.complete", { pluginId: "demo.ext", messages: [] });
    expect(completes).toEqual([]);
    expect(frames).toHaveLength(1);
    expect(frames[0].error?.message).toBe("trusted extension bridge unavailable");
  });

  it("answers an allowlisted non-extension method through host-core", async () => {
    // `session.get` needs no bridge handler: it is proxied to host-core
    // unchanged, which is what makes the allowlist refusal above meaningful.
    const calls: Array<{ method: string; params: unknown }> = [];
    const { frames, proxy } = harness({
      host: {
        call: async (method, params) => {
          calls.push({ method, params });
          return { session: { id: "s1" } };
        },
      },
    });
    await proxy("session.get", { id: "s1" });
    expect(calls).toEqual([{ method: "session.get", params: { id: "s1" } }]);
    expect(frames).toEqual([
      { jsonrpc: "2.0", id: 1, result: { session: { id: "s1" } } },
    ]);
  });
});
