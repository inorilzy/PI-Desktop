import { describe, expect, it } from "vitest";
import { PLUGIN_PERMISSIONS } from "./index.js";

const WITHDRAWN_EVENTS = [
  "before_agent_start",
  "context",
  "before_provider_request",
  "before_provider_headers",
  "model_select",
  "thinking_level_select",
];

describe("agent.model.complete and withdrawn slot 6", () => {
  it("registers plugin AI completion and drops runtime.request.before", () => {
    expect(PLUGIN_PERMISSIONS).toContain("agent.model.complete");
    expect(PLUGIN_PERMISSIONS).toContain("agent.complete");
    expect(PLUGIN_PERMISSIONS).not.toContain("runtime.request.before");
    expect(PLUGIN_PERMISSIONS).toContain("runtime.send.before");
  });

  it("documents withdrawn slot-6 events for the runner gate", () => {
    // Names stay reserved in docs/tests; they are not PLUGIN_PERMISSIONS.
    expect(WITHDRAWN_EVENTS).toContain("context");
    expect(PLUGIN_PERMISSIONS.filter((name) => name.startsWith("runtime."))).not.toContain(
      "runtime.request.before",
    );
  });
});
