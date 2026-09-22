/**
 * `pi.ai.complete` and the withdrawn slot-6 event boundary, as a trusted
 * extension meets them (ADR 0295 rules 2 and 5, spec 07-plugins/16 §6 and §9).
 *
 * Every case writes a real extension module to disk and loads it through the
 * real runner, so the module talks to the API object the runner builds rather
 * than to a stand-in.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLUGIN_MODEL_COMPLETE_PERMISSION,
  WITHDRAWN_RUNTIME_EVENTS,
  isWithdrawnRuntimeEvent,
} from "@pi-desktop/shared";
import { TRUSTED_EXTENSION_EVENTS, TrustedExtensionRunner } from "./runner.js";
import type { TrustedExtensionBridge } from "./runner.js";
import type { TrustedExtensionSpec } from "./types.js";

/** Tier permission every trusted extension is loaded with. */
const TIER = "agent.extension";
/** The grant `pi.ai.complete` is registered under since slot 6 was withdrawn. */
const AI_GRANT = PLUGIN_MODEL_COMPLETE_PERMISSION;
/** The pre-rename grant the runner still accepts next to `agent.model.complete`. */
const LEGACY_AI_GRANT = "agent.complete";

let root: string;
let loaded = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-ai-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * The host the runner forwards to. Only `aiComplete` is interesting here, so
 * the rest answer what the API object needs; `overrides` replaces a member
 * when a case needs a different host answer.
 */
function fakeBridge(overrides: Partial<TrustedExtensionBridge> = {}) {
  const log: { aiCompletes: unknown[] } = { aiCompletes: [] };
  const bridge: TrustedExtensionBridge = {
    sessionId: "s1",
    cwd: process.cwd(),
    getModel: () => undefined,
    setModel: async () => true,
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
    isIdle: () => true,
    getAbortSignal: () => undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getSessionName: () => undefined,
    setSessionName: () => {},
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    turnFacts: async () => undefined,
    recapSession: async () => ({ messages: [], truncated: false }),
    continueTurn: async () => undefined,
    aiComplete: async (input) => {
      log.aiCompletes.push(input);
      return { ok: true, text: "enhanced", modelKey: "openai/gpt" };
    },
    requestUi: async (_e, r) => ({ kind: r.kind }) as never,
    publishCommands: () => {},
    publishDiagnostics: () => {},
    ...overrides,
  };
  return { bridge, log };
}

/**
 * Where the module under test pushes its answers. A fresh array per case, so
 * nothing leaks between cases and no `sleep` is needed to observe a result:
 * the handler's `await` completes inside `runner.load()`.
 */
function answers(): unknown[] {
  const collected: unknown[] = [];
  (globalThis as Record<string, unknown>).__ai = collected;
  return collected;
}

/** One extension module on disk, loaded through the real runner. */
async function loadExtension(
  source: string,
  permissions: readonly string[],
  bridge: TrustedExtensionBridge,
): Promise<{ runner: TrustedExtensionRunner; spec: TrustedExtensionSpec }> {
  const entry = join(root, `ext-${loaded++}.ts`);
  writeFileSync(entry, source);
  const spec: TrustedExtensionSpec = {
    id: entry,
    entry,
    label: "ai-ext",
    source: "user",
    root,
    permissions,
  };
  const runner = new TrustedExtensionRunner({ specs: [spec], bridge });
  await runner.load();
  return { runner, spec };
}

describe("extension pi.ai.complete", () => {
  it("refuses without agent.model.complete / agent.complete", async () => {
    const got = answers();
    const { bridge, log } = fakeBridge();
    const { runner } = await loadExtension(
      `export default function (pi: any) {
  pi.on("session_start", async () => {
    (globalThis as any).__ai.push(await pi.ai.complete({ messages: [{ role: "user", content: "x" }] }));
  });
}`,
      [TIER],
      bridge,
    );

    // The refusal never reaches the host, and the plugin reads why.
    expect(log.aiCompletes).toEqual([]);
    expect(got).toEqual([{ ok: false, code: "PERMISSION_DENIED" }]);
    expect(runner.getDiagnostics()).toEqual([
      expect.objectContaining({
        kind: "permission_denied",
        member: "ai.complete",
        message: expect.stringContaining(AI_GRANT),
        count: 1,
      }),
    ]);
  });

  it("reaches the bridge on the legacy agent.complete grant", async () => {
    const got = answers();
    const { bridge, log } = fakeBridge();
    const { runner, spec: ext } = await loadExtension(
      `export default function (pi: any) {
  pi.on("session_start", async () => {
    (globalThis as any).__ai.push(await pi.ai.complete({ messages: [{ role: "user", content: "hello" }] }));
  });
}`,
      [TIER, LEGACY_AI_GRANT],
      bridge,
    );

    expect(got).toEqual([{ ok: true, text: "enhanced", modelKey: "openai/gpt" }]);
    expect(log.aiCompletes).toEqual([
      {
        messages: [{ role: "user", content: "hello" }],
        pluginId: ext.id,
        permissions: [TIER, LEGACY_AI_GRANT],
      },
    ]);
    expect(runner.getDiagnostics()).toEqual([]);
  });

  it("calls the host bridge when the plugin holds agent.model.complete", async () => {
    const got = answers();
    const { bridge, log } = fakeBridge();
    const { runner, spec: ext } = await loadExtension(
      `export default function (pi: any) {
  pi.on("session_start", async () => {
    (globalThis as any).__ai.push(await pi.ai.complete({
      purpose: "prompt-enhance",
      messages: [{ role: "user", content: "hello" }],
      system: "only this system",
    }));
  });
}`,
      [TIER, AI_GRANT],
      bridge,
    );

    expect(log.aiCompletes).toHaveLength(1);
    expect(log.aiCompletes[0]).toMatchObject({
      pluginId: ext.id,
      purpose: "prompt-enhance",
      system: "only this system",
      permissions: [TIER, AI_GRANT],
    });
    expect(got).toEqual([{ ok: true, text: "enhanced", modelKey: "openai/gpt" }]);
    expect(runner.getDiagnostics()).toEqual([]);
  });

  it("forwards every caller field and adds only the plugin identity", async () => {
    const got = answers();
    const { bridge, log } = fakeBridge();
    const { spec: ext } = await loadExtension(
      `export default function (pi: any) {
  pi.on("session_start", async () => {
    (globalThis as any).__ai.push(await pi.ai.complete({
      messages: [{ role: "user", content: "hello" }],
      system: "only this system",
      modelKey: "openai/gpt-5",
      purpose: "prompt-enhance",
      maxTokens: 64,
    }));
  });
}`,
      [TIER, AI_GRANT],
      bridge,
    );

    expect(got).toEqual([{ ok: true, text: "enhanced", modelKey: "openai/gpt" }]);
    // Exact equality is the assertion: the runner adds `pluginId` and
    // `permissions` and nothing else, so no session, turn or transcript field
    // rides along with the call.
    expect(log.aiCompletes).toEqual([
      {
        messages: [{ role: "user", content: "hello" }],
        system: "only this system",
        modelKey: "openai/gpt-5",
        purpose: "prompt-enhance",
        maxTokens: 64,
        pluginId: ext.id,
        permissions: [TIER, AI_GRANT],
      },
    ]);
  });

  it("does not let a caller's own pluginId or permissions override the runner's", async () => {
    const got = answers();
    const { bridge, log } = fakeBridge();
    const { spec: ext } = await loadExtension(
      `export default function (pi: any) {
  pi.on("session_start", async () => {
    (globalThis as any).__ai.push(await pi.ai.complete({
      messages: [{ role: "user", content: "x" }],
      pluginId: "some-other-plugin",
      permissions: ["runtime.turn.abort"],
    }));
  });
}`,
      [TIER, AI_GRANT],
      bridge,
    );

    expect(got).toEqual([{ ok: true, text: "enhanced", modelKey: "openai/gpt" }]);
    expect(log.aiCompletes).toEqual([
      {
        messages: [{ role: "user", content: "x" }],
        pluginId: ext.id,
        permissions: [TIER, AI_GRANT],
      },
    ]);
  });

  it("refuses an empty or missing message list without asking the host", async () => {
    const got = answers();
    const { bridge, log } = fakeBridge();
    const { runner } = await loadExtension(
      `export default function (pi: any) {
  pi.on("session_start", async () => {
    const g = globalThis as any;
    g.__ai.push(await pi.ai.complete({}));
    g.__ai.push(await pi.ai.complete({ messages: [] }));
  });
}`,
      [TIER, AI_GRANT],
      bridge,
    );

    expect(log.aiCompletes).toEqual([]);
    expect(got).toEqual([
      { ok: false, code: "INVALID_INPUT" },
      { ok: false, code: "INVALID_INPUT" },
    ]);
    expect(runner.getDiagnostics()).toEqual([
      expect.objectContaining({
        kind: "handler_error",
        member: "ai.complete",
        message: "ai.complete needs messages",
        count: 2,
      }),
    ]);
  });

  it("answers PROVIDER_ERROR with the host's message when the completion throws", async () => {
    const got = answers();
    const { bridge } = fakeBridge({
      aiComplete: async () => {
        throw Object.assign(new Error("boom"), { code: "NO_MODEL" });
      },
    });
    const { runner } = await loadExtension(
      `export default function (pi: any) {
  pi.on("session_start", async () => {
    (globalThis as any).__ai.push(await pi.ai.complete({ messages: [{ role: "user", content: "x" }] }));
  });
}`,
      [TIER, AI_GRANT],
      bridge,
    );

    // `detail` is the thrown error's own message, and the plugin call resolves
    // rather than rejecting: a provider failure is an answer, not a throw.
    expect(got).toEqual([{ ok: false, code: "PROVIDER_ERROR", detail: "boom" }]);
    expect(runner.getDiagnostics()).toEqual([
      expect.objectContaining({
        kind: "handler_error",
        member: "ai.complete",
        message: "boom",
        count: 1,
      }),
    ]);
  });

  it("answers completeStream once with the whole text and the same result as complete", async () => {
    const got = answers();
    const answer = { ok: true as const, text: "enhanced twice", modelKey: "p/m" };
    const { bridge } = fakeBridge({ aiComplete: async () => answer });
    await loadExtension(
      `export default function (pi: any) {
  pi.on("session_start", async () => {
    const g = globalThis as any;
    const messages = [{ role: "user", content: "x" }];
    const deltas: string[] = [];
    const complete = await pi.ai.complete({ messages });
    const streamed = await pi.ai.completeStream({ messages }, (text: string) => deltas.push(text));
    g.__ai.push({ complete, streamed, same: streamed === complete, deltas });
  });
}`,
      [TIER, AI_GRANT],
      bridge,
    );

    // `completeStream` is not a token stream: the host answers with the whole
    // text, so `onDelta` fires once with all of it and the resolved value is
    // the completion result itself, unwrapped.
    expect(got).toEqual([
      {
        complete: { ok: true, text: "enhanced twice", modelKey: "p/m" },
        streamed: { ok: true, text: "enhanced twice", modelKey: "p/m" },
        same: true,
        deltas: ["enhanced twice"],
      },
    ]);
  });

  it("answers completeStream with onDelta omitted", async () => {
    const got = answers();
    const { bridge, log } = fakeBridge();
    const { runner } = await loadExtension(
      `export default function (pi: any) {
  pi.on("session_start", async () => {
    (globalThis as any).__ai.push(await pi.ai.completeStream({ messages: [{ role: "user", content: "x" }] }));
  });
}`,
      [TIER, AI_GRANT],
      bridge,
    );

    expect(got).toEqual([{ ok: true, text: "enhanced", modelKey: "openai/gpt" }]);
    expect(log.aiCompletes).toHaveLength(1);
    expect(runner.getDiagnostics()).toEqual([]);
  });

  it("does not call onDelta when the answer is a refusal", async () => {
    const got = answers();
    const { bridge, log } = fakeBridge();
    await loadExtension(
      `export default function (pi: any) {
  pi.on("session_start", async () => {
    const g = globalThis as any;
    const deltas: string[] = [];
    const answer = await pi.ai.completeStream(
      { messages: [{ role: "user", content: "x" }] },
      (text: string) => deltas.push(text),
    );
    g.__ai.push({ answer, deltas });
  });
}`,
      [TIER],
      bridge,
    );

    expect(got).toEqual([
      { answer: { ok: false, code: "PERMISSION_DENIED" }, deltas: [] },
    ]);
    expect(log.aiCompletes).toEqual([]);
  });
});

describe("withdrawn slot-6 events", () => {
  /** One handler per withdrawn event, so every name is really registered. */
  function slot6Source(): string {
    return [
      `export default function (pi: any) {`,
      ...WITHDRAWN_RUNTIME_EVENTS.map(
        (event) =>
          `  pi.on("${event}", () => { (globalThis as any).__slot6 = ((globalThis as any).__slot6 ?? 0) + 1; return { messages: [] }; });`,
      ),
      `}`,
    ].join("\n");
  }

  it("accepts a slot-6 registration without a load-time diagnostic", async () => {
    const { bridge } = fakeBridge();
    const { runner } = await loadExtension(slot6Source(), [TIER], bridge);

    // The six names are known events — only a typo reports `unsupported_api` —
    // so registration succeeds and load says nothing about it.
    for (const event of WITHDRAWN_RUNTIME_EVENTS) {
      expect(TRUSTED_EXTENSION_EVENTS as readonly string[], event).toContain(event);
      expect(isWithdrawnRuntimeEvent(event), event).toBe(true);
    }
    expect(runner.getLoadReports()).toEqual([
      expect.objectContaining({
        state: "loaded",
        eventNames: [...WITHDRAWN_RUNTIME_EVENTS],
      }),
    ]);
    expect(runner.getDiagnostics()).toEqual([]);
    for (const event of WITHDRAWN_RUNTIME_EVENTS) {
      expect(runner.hasHandlers(event), event).toBe(false);
    }
  });

  it("answers undefined and reports slot 6 for every withdrawn event", async () => {
    const { bridge } = fakeBridge();
    const { runner } = await loadExtension(slot6Source(), [TIER], bridge);

    for (const event of WITHDRAWN_RUNTIME_EVENTS) {
      // A direct emit is the shortest path to a withdrawn hook, and it is
      // already dead: no handler runs, nothing is folded, nothing is answered.
      expect(await runner.emit(event, { type: event }), event).toBeUndefined();
      expect(runner.hasHandlers(event), event).toBe(false);
    }
    expect((globalThis as Record<string, unknown>).__slot6).toBeUndefined();
    expect(runner.getDiagnostics()).toEqual(
      WITHDRAWN_RUNTIME_EVENTS.map((event) =>
        expect.objectContaining({
          kind: "rejected_registration",
          member: event,
          message: expect.stringContaining("runtime.request.before"),
          count: 1,
        }),
      ),
    );
  });
});
