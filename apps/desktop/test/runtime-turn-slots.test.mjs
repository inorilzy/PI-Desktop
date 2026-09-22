// The three turn slots whose host data already exists and which a plugin could
// not reach yet (ADR 0295 slots 8, 9 and 10): `runtime.turn.facts`,
// `runtime.turn.recap` (+ `runtime.session.read`) and `runtime.turn.continue`.
//
// Each half of the wiring is asserted here because a missing half fails only in
// the real app, not in a package test: the runtime calls the host through the
// sidecar's proxy allowlist, so a method that is not allowlisted is refused at
// that boundary even though host-core answers it. These are source-shape checks
// because the desktop test runner has no Electron and no agent sidecar; the
// behaviour itself is covered by the agent-runtime suite (`runner.test.ts` for
// the gate, `runtime.test.ts` for the host method each call uses).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  REGISTERED_SLOT_PERMISSIONS,
  TRUSTED_EXTENSION_API_PERMISSIONS,
  TRUSTED_EXTENSION_SESSION_READ_PERMISSION,
  trustedExtensionApiScopePermission,
} from "@pi-desktop/shared";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const runnerSource = read("../../../packages/agent-runtime/src/extensions/runner.ts");
const runtimeSource = read("../../../packages/agent-runtime/src/runtime.ts");
const sidecarSource = read("../../../packages/host-runtime/src/agent-sidecar.ts");
const sdkSource = read("../../../packages/plugin-sdk/src/index.ts");
const sharedSource = read("../../../packages/shared/src/trusted-extensions.ts");

test("names the three calls, their slot permissions, and the extra session right", () => {
  assert.equal(TRUSTED_EXTENSION_API_PERMISSIONS.turnFacts, "runtime.turn.facts");
  assert.equal(TRUSTED_EXTENSION_API_PERMISSIONS.recap, "runtime.turn.recap");
  assert.equal(TRUSTED_EXTENSION_API_PERMISSIONS.continueTurn, "runtime.turn.continue");
  for (const name of ["runtime.turn.facts", "runtime.turn.recap", "runtime.turn.continue"]) {
    assert.equal(REGISTERED_SLOT_PERMISSIONS.includes(name), true, name);
  }
  // Rule 7: a whole-session read needs its own permission on top of the slot's.
  assert.equal(TRUSTED_EXTENSION_SESSION_READ_PERMISSION, "runtime.session.read");
  assert.equal(REGISTERED_SLOT_PERMISSIONS.includes(TRUSTED_EXTENSION_SESSION_READ_PERMISSION), true);
  assert.equal(
    trustedExtensionApiScopePermission("recap", "session"),
    TRUSTED_EXTENSION_SESSION_READ_PERMISSION,
  );
  assert.equal(trustedExtensionApiScopePermission("recap", "turn"), undefined);
});

test("gates all three calls in the runner, session scope included", () => {
  for (const member of ["extensionTurnFacts", "extensionRecap", "extensionContinueTurn"]) {
    assert.match(runnerSource, new RegExp(`${member}\\(`), member);
  }
  // The scope gate is a real refusal, not a comment: it resolves the second
  // permission through the shared contract and reports it.
  assert.match(runnerSource, /trustedExtensionApiScopePermission\(/);
  assert.match(runnerSource, /refuseApi\(extension, "turnFacts"/);
  assert.match(runnerSource, /refuseApi\(extension, "recap"/);
  assert.match(runnerSource, /refuseApi\(extension, "continueTurn"/);
});

test("reaches host-core through the calls the sidecar proxy already allows", () => {
  // Slot 9 asks host-core for the facts; the proxy allowlist is the boundary
  // that decides whether the request leaves the sidecar at all.
  assert.match(runtimeSource, /host\.call<\{ facts\?: TrustedExtensionTurnFacts \}>\("turn\.facts"/);
  assert.match(runtimeSource, /"turn\.facts",/);
  assert.match(sidecarSource, /"turn\.facts",/);
  // Slot 8's content read and slot 10's durable turn use the existing paths.
  assert.match(runtimeSource, /"session\.get", \{ id: runtime\.sessionId, messageLimit/);
  assert.match(runtimeSource, /"session\.queuePush", \{/);
  assert.match(sidecarSource, /"session\.get",/);
  assert.match(sidecarSource, /"session\.queuePush",/);
});

test("the plugin author reads each call's permission and what it returns", () => {
  // The SDK is the plugin author's contract and cannot import `shared`, so the
  // permission names are stated in the call docs; a rename here without one
  // there would ship a doc that lies.
  for (const permission of [
    "runtime.turn.facts",
    "runtime.turn.recap",
    "runtime.session.read",
    "runtime.turn.continue",
  ]) {
    assert.equal(sdkSource.includes(`\`${permission}\``), true, permission);
  }
  assert.match(sdkSource, /export type PluginTurnApi = \{/);
  for (const member of ["turnFacts(", "recap(", "continueTurn("]) {
    assert.equal(sdkSource.includes(member), true, member);
  }
  // The honest gaps are stated where an author reads them, not only in code.
  assert.equal(sdkSource.includes("no-host-turn-read"), true);
  // The continuation's provenance gap is closed: the doc says the queued row
  // names the plugin (ADR 0293, schema v22), not that the host cannot name it.
  assert.equal(sdkSource.includes("does not yet **name** the plugin"), false);
  assert.equal(sdkSource.includes("it always carries the plugin id and display label"), true);
});

test("the SDK's facts shape and the wire shape do not drift apart", () => {
  // `packages/shared` carries the shape the sidecar receives; `plugin-sdk`
  // restates it for authors (it has no dependency on shared). Both are
  // hand-maintained, so the field lists are compared mechanically.
  const fieldsOf = (source, name) => {
    const start = source.indexOf(`export type ${name} = {`);
    assert.notEqual(start, -1, `${name} is missing`);
    const body = source.slice(source.indexOf("{", start) + 1, source.indexOf("\n};", start));
    return body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("*") && !line.startsWith("/"))
      .map((line) => line.match(/^(\w+)\??:/)?.[1])
      .filter(Boolean)
      .sort();
  };
  const pairs = [
    ["PluginTurnFacts", "TrustedExtensionTurnFacts"],
    ["PluginTurnTokens", "TrustedExtensionTurnTokens"],
    ["PluginToolCallFacts", "TrustedExtensionToolCallFacts"],
    ["PluginToolCallSummary", "TrustedExtensionToolCallSummary"],
    ["PluginTurnFile", "TrustedExtensionTurnFile"],
  ];
  for (const [sdkName, wireName] of pairs) {
    assert.deepEqual(
      fieldsOf(sdkSource, sdkName),
      fieldsOf(sharedSource, wireName),
      `${sdkName} must carry the same fields as ${wireName}`,
    );
  }
  // The recap's turn scope says why it has no text in both copies.
  for (const source of [sdkSource, sharedSource]) {
    assert.equal(source.includes('"no-host-turn-read"'), true);
  }
});
