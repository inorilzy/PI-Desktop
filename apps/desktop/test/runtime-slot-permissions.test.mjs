// Slot 6 (`runtime.request.before`) is withdrawn. Remaining `runtime.*`
// registry names must stay mirrored in shared and risk-table aligned.
// Plugin-level completion uses `agent.model.complete` (not a runtime.* slot).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PLUGIN_PERMISSIONS } from "@pi-desktop/plugin-sdk";
import {
  isRegisteredSlotPermission,
  isWithdrawnRuntimeEvent,
  REGISTERED_SLOT_PERMISSIONS,
  TRUSTED_EXTENSION_EVENT_PERMISSIONS,
  trustedExtensionEventPermission,
  WITHDRAWN_RUNTIME_EVENTS,
} from "@pi-desktop/shared";

const registryRuntimeNames = PLUGIN_PERMISSIONS.filter((name) => name.startsWith("runtime."));

/** Slot names still offered after withdrawing request.before. */
const ADR_SLOT_NAMES = [
  "runtime.send.before",
  "runtime.session.lifecycle",
  "runtime.session.read",
  "runtime.tool.extend",
  "runtime.tool.gate",
  "runtime.turn.abort",
  "runtime.turn.closing",
  "runtime.turn.continue",
  "runtime.turn.facts",
  "runtime.turn.recap",
  "runtime.turn.watch",
];

const UNBUILT_SLOT_NAME = "runtime.approval.before";
const WITHDRAWN_SLOT_NAME = "runtime.request.before";

const EXPECTED_RISK = {
  "agent.model.complete": "high",
  "runtime.send.before": "high",
  "runtime.session.lifecycle": "high",
  "runtime.session.read": "high",
  "runtime.tool.extend": "high",
  "runtime.tool.gate": "high",
  "runtime.turn.abort": "high",
  "runtime.turn.closing": "high",
  "runtime.turn.continue": "high",
  "runtime.turn.facts": "low",
  "runtime.turn.recap": "high",
  "runtime.turn.watch": "medium",
};

test("the shared mirror lists exactly the runtime names the registry holds", () => {
  assert.deepEqual([...REGISTERED_SLOT_PERMISSIONS].sort(), [...registryRuntimeNames].sort());
  for (const name of registryRuntimeNames) {
    assert.equal(isRegisteredSlotPermission(name), true, name);
  }
  assert.equal(PLUGIN_PERMISSIONS.includes(WITHDRAWN_SLOT_NAME), false);
  assert.equal(REGISTERED_SLOT_PERMISSIONS.includes(WITHDRAWN_SLOT_NAME), false);
  assert.equal(PLUGIN_PERMISSIONS.includes("agent.model.complete"), true);
});

test("slot 6 is withdrawn: no event maps to request.before", () => {
  const mapped = new Set(Object.values(TRUSTED_EXTENSION_EVENT_PERMISSIONS));
  assert.equal(mapped.has(WITHDRAWN_SLOT_NAME), false);
  assert.equal(mapped.has(UNBUILT_SLOT_NAME), false);
  for (const name of mapped) {
    assert.equal(registryRuntimeNames.includes(name), true, name);
    assert.equal(isRegisteredSlotPermission(name), true, name);
  }
});

test("the registry holds the remaining offered runtime slot names", () => {
  assert.deepEqual([...registryRuntimeNames].sort(), [...ADR_SLOT_NAMES].sort());
  for (const name of ADR_SLOT_NAMES) {
    assert.equal(isRegisteredSlotPermission(name), true, name);
  }
});

test("the runner does not consult withdrawn slot-6 events", () => {
  const runnerSource = readFileSync(
    new URL("../../../packages/agent-runtime/src/extensions/runner.ts", import.meta.url),
    "utf8",
  );
  assert.equal(runnerSource.includes("isRegisteredSlotPermission"), false);
  assert.match(runnerSource, /isWithdrawnRuntimeEvent/);
  for (const event of WITHDRAWN_RUNTIME_EVENTS) {
    assert.equal(isWithdrawnRuntimeEvent(event), true, event);
    assert.equal(trustedExtensionEventPermission(event), undefined, event);
    assert.equal(runnerSource.includes(`hasHandlers("${event}")`), false);
  }
});

test("the contract names one slot per wired event and leaves the rest alone", () => {
  assert.equal(trustedExtensionEventPermission("turn_closing"), "runtime.turn.closing");
  assert.equal(trustedExtensionEventPermission("tool_call"), "runtime.tool.gate");
  assert.equal(trustedExtensionEventPermission("tool_result"), "runtime.tool.gate");
  assert.equal(trustedExtensionEventPermission("context"), undefined);
  assert.equal(trustedExtensionEventPermission("before_agent_start"), undefined);
  assert.equal(trustedExtensionEventPermission("before_provider_headers"), undefined);
  assert.equal(trustedExtensionEventPermission("model_select"), undefined);
  assert.equal(trustedExtensionEventPermission("turn_end"), "runtime.turn.watch");
  assert.equal(trustedExtensionEventPermission("session_before_compact"), "runtime.session.lifecycle");
  assert.equal(trustedExtensionEventPermission("input"), "runtime.send.before");
  assert.equal(trustedExtensionEventPermission("session_start"), undefined);
});

test("every offered name carries a risk tier, and every high one is in the devkit mirror", () => {
  const modelSource = readFileSync(
    new URL("../src/features/plugins/model.ts", import.meta.url),
    "utf8",
  );
  const devkitSource = readFileSync(
    new URL("../../../packages/plugin-devkit/src/check.ts", import.meta.url),
    "utf8",
  );
  for (const [name, tier] of Object.entries(EXPECTED_RISK)) {
    assert.match(modelSource, new RegExp(`"${name.replace(/\./g, "\\.")}": "${tier}"`), name);
  }
  assert.doesNotMatch(modelSource, new RegExp(`"${WITHDRAWN_SLOT_NAME.replace(/\./g, "\\.")}"`));
  assert.match(devkitSource, /"agent\.model\.complete"/);
  assert.doesNotMatch(devkitSource, new RegExp(`"${WITHDRAWN_SLOT_NAME.replace(/\./g, "\\.")}"`));
});
