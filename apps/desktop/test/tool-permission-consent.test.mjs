import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";

// The behavior this file pins: a resolution that arrives from the renderer must
// not decide anything by itself. Plugin code shares the renderer realm with the
// host UI, so a decision sent on `toolResolvePermission` carries no user
// gesture — the only answer the main process can trust is the user's click in
// the native dialog it owns.
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const {
  ALLOW_ONCE_BUTTON_INDEX,
  AUTO_CONSENT_MARKER_FILE,
  MAX_ARGS_PREVIEW,
  autoConsentDecision,
  autoConsentMarkerPath,
  createToolPermissionConsentService,
  toolPermissionConsentAnswerFromResponse,
  toolPermissionConsentDialogOptions,
} = await import("../electron/main/tool-permission-consent.ts");

const PENDING = {
  requestId: "request-1",
  sessionId: "session-1",
  toolCallId: "call-1",
  toolName: "Bash",
  argsPreview: '{"command":"rm -rf build"}',
  risk: "high",
  reason: "Runs a shell command that deletes files",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:02:00.000Z",
};

/**
 * The real handler wiring, with fakes only at the real edges: the host RPC
 * boundary and the main-owned dialog. `confirm` stands in for the user's answer
 * to `dialog.showMessageBox`.
 */
function harness({ pending = [PENDING], confirm } = {}) {
  const handlers = new Map();
  const resolves = [];
  const prompts = [];
  const host = {
    async call(method, params) {
      if (method === "permissions.pending") return { requests: pending };
      if (method === "permissions.resolve") {
        if (!pending.some((entry) => entry.requestId === params.requestId)) {
          throw Object.assign(new Error("NOT_FOUND"), { errorCode: "NOT_FOUND" });
        }
        resolves.push(params);
        return { ok: true };
      }
      assert.fail(`unexpected RPC ${method}`);
    },
  };
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => null,
    getAgentHostBridge: () => null,
    logger: { app() {} },
    confirmToolPermission: async (request) => {
      prompts.push(request);
      return confirm(request);
    },
  });
  return {
    resolve: (resolution) =>
      handlers.get(IPC.invoke.toolResolvePermission)(resolution),
    resolves,
    prompts,
  };
}

test("a repeated call for the same request joins the one open prompt", async () => {
  let answer;
  const dialog = new Promise((resolve) => {
    answer = resolve;
  });
  const { resolve: submit, resolves, prompts } = harness({ confirm: () => dialog });

  // A renderer that repeats the call — or a plugin looping it — must not stack
  // modal dialogs the user has to dismiss.
  const first = submit({ requestId: PENDING.requestId, decision: "allow-once" });
  const second = submit({ requestId: PENDING.requestId, decision: "allow-session" });
  answer("allow-once");
  await Promise.all([first, second]);

  assert.equal(prompts.length, 1);
  assert.deepEqual(resolves, [
    { requestId: PENDING.requestId, decision: "allow-once" },
    { requestId: PENDING.requestId, decision: "allow-once" },
  ]);
});

test("a renderer-originated allow cannot approve; the main-owned answer decides", async () => {
  const { resolve, resolves, prompts } = harness({ confirm: async () => "deny" });
  // A forged resolution carries junk the renderer made up; none of it may reach
  // the host or the prompt.
  await resolve({
    requestId: PENDING.requestId,
    decision: "allow-once",
    toolName: "NotARealTool",
    sessionId: "not-the-session",
  });

  assert.deepEqual(resolves, [{ requestId: PENDING.requestId, decision: "deny" }]);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].toolName, PENDING.toolName);
  assert.equal(prompts[0].reason, PENDING.reason);
});

test("the dialog answer is what reaches the host, not the renderer's wording", async () => {
  const { resolve, resolves, prompts } = harness({ confirm: async () => "allow-session" });
  await resolve({ requestId: PENDING.requestId, decision: "allow-once" });

  assert.deepEqual(resolves, [
    { requestId: PENDING.requestId, decision: "allow-session" },
  ]);
  assert.equal(prompts.length, 1);
});

test("a denial from the renderer is honored without a dialog", async () => {
  const { resolve, resolves, prompts } = harness({
    confirm: async () => assert.fail("a denial must not prompt the user"),
  });
  // The card's Deny button and its countdown auto-deny both come through here.
  await resolve({ requestId: PENDING.requestId, decision: "deny" });
  // An unrecognized decision reads as a refusal too.
  await resolve({ requestId: PENDING.requestId, decision: "yes-please" });

  assert.deepEqual(resolves, [
    { requestId: PENDING.requestId, decision: "deny" },
    { requestId: PENDING.requestId, decision: "deny" },
  ]);
  assert.deepEqual(prompts, []);
});

test("a forged request id neither approves nor pops a dialog", async () => {
  const { resolve, prompts } = harness({
    pending: [],
    confirm: async () => assert.fail("only a pending request may prompt"),
  });

  await assert.rejects(
    resolve({ requestId: "request-forged", decision: "allow-once" }),
    { errorCode: "NOT_FOUND" },
  );
  assert.deepEqual(prompts, []);
});

test("the native prompt names the tool and dismisses as a denial", () => {
  const options = toolPermissionConsentDialogOptions(
    {
      toolName: "Bash",
      argsPreview: "x".repeat(MAX_ARGS_PREVIEW + 50),
      risk: "high",
      reason: "Runs a shell command that deletes files",
    },
    "en",
  );

  assert.match(options.message, /Bash/);
  assert.match(options.detail, /Runs a shell command that deletes files/);
  assert.match(options.detail, /…/, "the argument preview must be elided");
  assert.ok(
    !options.detail.includes("x".repeat(MAX_ARGS_PREVIEW + 1)),
    "the argument preview must stop at the limit",
  );
  assert.deepEqual(options.buttons, ["Deny", "Allow once", "Allow for this chat"]);
  // Escape and the red-X land on Deny.
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);

  assert.equal(toolPermissionConsentAnswerFromResponse(0), "deny");
  assert.equal(toolPermissionConsentAnswerFromResponse(1), "allow-once");
  assert.equal(toolPermissionConsentAnswerFromResponse(2), "allow-session");
  assert.equal(toolPermissionConsentAnswerFromResponse(7), "deny");
});

/* ---------- the test-only auto consent switch ---------- */

/** The service under test, with fakes only where the app has real edges. */
function consentService(dataDir, { isPackaged, logged = [] } = {}) {
  const asked = { packaged: 0 };
  return {
    logged,
    asked,
    confirm: createToolPermissionConsentService({
      getWindow: () => null,
      getLocale: () => "en",
      dataDir,
      isPackaged: () => {
        asked.packaged += 1;
        return isPackaged;
      },
      logAutoConsent: (fields) => logged.push(fields),
    }),
  };
}

test("the switch answers with the index a click on Allow once produces", () => {
  const options = toolPermissionConsentDialogOptions({ toolName: "Bash" }, "en");
  // The switch has no answer of its own: its index is the dialog's own button,
  // so it can grant exactly what one click grants — no more.
  assert.equal(options.buttons[ALLOW_ONCE_BUTTON_INDEX], "Allow once");
  assert.equal(
    autoConsentDecision({ packaged: false, markerPresent: true }),
    toolPermissionConsentAnswerFromResponse(ALLOW_ONCE_BUTTON_INDEX),
  );
  assert.equal(autoConsentDecision({ packaged: false, markerPresent: true }), "allow-once");
  // Without the opt-in, or in a packaged build, there is no answer at all.
  assert.equal(autoConsentDecision({ packaged: false, markerPresent: false }), null);
  assert.equal(autoConsentDecision({ packaged: true, markerPresent: true }), null);
  assert.equal(autoConsentDecision({ packaged: true, markerPresent: false }), null);
});

test("the opt-in marker lives inside the run's own data directory", () => {
  assert.equal(AUTO_CONSENT_MARKER_FILE, "e2e-auto-consent");
  assert.equal(
    autoConsentMarkerPath(join("C:", "run-data")),
    join("C:", "run-data", "e2e-auto-consent"),
  );
});

test("an unpackaged run that opted in answers allow-once and logs the answer", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-consent-optin-"));
  try {
    writeFileSync(autoConsentMarkerPath(dataDir), "");
    const { confirm, logged, asked } = consentService(dataDir, { isPackaged: false });

    assert.equal(await confirm({ toolName: "Bash", risk: "high" }), "allow-once");
    assert.equal(asked.packaged, 1, "the packaged guard is consulted, not skipped");
    // Exactly one trace per auto-answer, naming the tool it approved.
    assert.deepEqual(logged, [
      {
        toolName: "Bash",
        decision: "allow-once",
        marker: autoConsentMarkerPath(dataDir),
      },
    ]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a packaged build ignores the switch even when its marker is present", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-consent-packaged-"));
  try {
    writeFileSync(autoConsentMarkerPath(dataDir), "");
    const { confirm, logged } = consentService(dataDir, { isPackaged: true });

    // Ignored means the request goes to the native prompt, where the user is the
    // one who answers. A headless run has no Electron dialog, and that failure is
    // the proof that the marker did not answer for them: a resolved
    // "allow-once" here would be the bug this case exists for.
    const resolved = await confirm({ toolName: "Bash", risk: "high" }).then(
      (decision) => decision,
      () => "rejected",
    );
    assert.equal(resolved, "rejected", "a packaged build must not auto-approve");
    assert.deepEqual(logged, []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("with no marker at all the switch is off and nothing is logged", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-consent-off-"));
  try {
    const { confirm, logged } = consentService(dataDir, { isPackaged: false });
    const resolved = await confirm({ toolName: "Bash", risk: "high" }).then(
      (decision) => decision,
      () => "rejected",
    );
    assert.equal(resolved, "rejected", "a run without the marker still asks the user");
    assert.deepEqual(logged, []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
