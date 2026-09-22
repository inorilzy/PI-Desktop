import { describe, expect, it } from "vitest";
import {
  isWithdrawnRuntimeEvent,
  trustedExtensionApiPermission,
  trustedExtensionEventPermission,
  PLUGIN_MODEL_COMPLETE_PERMISSION,
  REGISTERED_SLOT_PERMISSIONS,
  TRUSTED_EXTENSION_API_PERMISSIONS,
  TRUSTED_EXTENSION_EVENT_PERMISSIONS,
  WITHDRAWN_RUNTIME_EVENTS,
} from "./trusted-extensions.js";

const LIVE_EVENTS = ["tool_call", "agent_start", "session_start"];

describe("withdrawn runtime events (slot 6)", () => {
  it("lists exactly the events withdrawn with runtime.request.before", () => {
    expect(WITHDRAWN_RUNTIME_EVENTS).toEqual([
      "before_agent_start",
      "context",
      "before_provider_request",
      "before_provider_headers",
      "model_select",
      "thinking_level_select",
    ]);
  });

  it("answers the withdrawn-event predicate for withdrawn and live events", () => {
    for (const event of WITHDRAWN_RUNTIME_EVENTS) {
      expect(isWithdrawnRuntimeEvent(event), event).toBe(true);
    }
    for (const event of LIVE_EVENTS) {
      expect(isWithdrawnRuntimeEvent(event), event).toBe(false);
    }
  });

  it("maps no event to the withdrawn runtime.request.before permission", () => {
    expect(Object.values(TRUSTED_EXTENSION_EVENT_PERMISSIONS)).not.toContain(
      "runtime.request.before",
    );
    for (const event of WITHDRAWN_RUNTIME_EVENTS) {
      expect(trustedExtensionEventPermission(event), event).toBeUndefined();
    }
    // A live event still resolves to its registered slot.
    expect(trustedExtensionEventPermission("tool_call")).toBe("runtime.tool.gate");
    expect(trustedExtensionEventPermission("session_start")).toBeUndefined();
  });

  it("registers every slot permission the event map holds, with no gaps", () => {
    for (const permission of Object.values(TRUSTED_EXTENSION_EVENT_PERMISSIONS)) {
      expect(REGISTERED_SLOT_PERMISSIONS).toContain(permission);
    }
  });
});

describe("REGISTERED_SLOT_PERMISSIONS", () => {
  it("holds the runtime slots it names today, without runtime.request.before", () => {
    expect(REGISTERED_SLOT_PERMISSIONS).toEqual([
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
    ]);
    expect(REGISTERED_SLOT_PERMISSIONS as readonly string[]).not.toContain(
      "runtime.request.before",
    );
  });
});

describe("plugin model completion", () => {
  it("pins the plugin model completion permission name", () => {
    expect(PLUGIN_MODEL_COMPLETE_PERMISSION).toBe("agent.model.complete");
  });

  it("keeps aiComplete and drops sendUserMessage from the api permission map", () => {
    expect(TRUSTED_EXTENSION_API_PERMISSIONS.aiComplete).toBe("agent.model.complete");
    expect("sendUserMessage" in TRUSTED_EXTENSION_API_PERMISSIONS).toBe(false);
  });

  it("resolves an api permission by name and returns undefined for a dropped one", () => {
    expect(trustedExtensionApiPermission("aiComplete")).toBe("agent.model.complete");
    expect(trustedExtensionApiPermission("sendUserMessage")).toBeUndefined();
  });
});
