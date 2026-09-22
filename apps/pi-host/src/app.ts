import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { AgentHost, type ApprovalPort } from "@pi-desktop/agent-host";
import {
  AgentSidecar,
  HostProcess,
  PlanExecutionDispatcher,
  RuntimeService,
  RuntimeSupervisor,
  createHeadlessLaunchResolver,
  createHostQueueStore,
  createHostSessionPort,
  listPendingToolRequests,
} from "@pi-desktop/host-runtime";
import { DeviceTokenAuthenticator, RacpServer, bindRacpWebSocket, type RacpHostOperations, type WsBinding } from "@pi-desktop/racp";
import { APP_VERSION, type AgentEventEnvelope } from "@pi-desktop/shared";

import type { PiHostConfig } from "./config.js";
import { FileCredentialStore, loadOrCreateHostId } from "./credentials.js";
import { createHostOperations } from "./host-operations.js";
import { createLogger, type HostLogger } from "./logger.js";
import { TerminalService, loadPty } from "./terminal.js";

export type PiHostApp = {
  hostId: string;
  address: { host: string; port: number };
  agentHost: AgentHost;
  runtime: RuntimeService;
  authenticator: DeviceTokenAuthenticator;
  server: RacpServer;
  log: HostLogger;
  /** Mint a single-use pairing token for the bootstrap channel. */
  issuePairingToken(lifetimeMs: number): Promise<{ token: string; expiresAt: string }>;
  stop(): Promise<void>;
};

const APPROVAL_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Compose the headless Host: host-core and the sidecar under the shared
 * supervisor, the runtime service as the module's runtime port, the Agent
 * Host module, and the RACP server on loopback. Everything the desktop
 * would own for a local session — transcript, queue, approvals, tools,
 * workspace — lives here on this machine.
 */
export async function startPiHost(config: PiHostConfig, options: { log?: HostLogger } = {}): Promise<PiHostApp> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const log = options.log ?? createLogger({ dataDir: config.dataDir, minLevel: config.logLevel });
  const hostId = await loadOrCreateHostId(config.dataDir);
  const store = new FileCredentialStore(config.dataDir);
  const authenticator = new DeviceTokenAuthenticator(store);

  const state: { host: HostProcess | null; sidecar: AgentSidecar | null; stopping: boolean } = { host: null, sidecar: null, stopping: false };
  const getHost = () => state.host;
  const getSidecar = () => state.sidecar;

  const launch = createHeadlessLaunchResolver({ getHost, dataDir: config.dataDir, log: (level, message, data) => log(level, message, data) });
  const runtime = new RuntimeService({ getHost, getSidecar, launch, log });

  const approvals: ApprovalPort = {
    async resolveTool(requestId, decision) {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      await host.call("permissions.resolve", { requestId, decision });
    },
    async resolveContract(input) {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      const pending = await host.call<{ plans?: Array<{ id: string; turnId?: string; toolCallId?: string }> }>("plans.pending", { sessionId: input.sessionId });
      const proposal = (pending.plans ?? []).find((candidate) => candidate.id === input.proposalId);
      if (!proposal) throw Object.assign(new Error(`proposal ${input.proposalId} is not pending`), { errorCode: "NOT_FOUND" });
      const result = await host.call("plans.resolve", {
        proposalId: input.proposalId,
        sessionId: input.sessionId,
        turnId: proposal.turnId ?? "",
        toolCallId: proposal.toolCallId ?? "",
        action: input.action,
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.permissionMode ? { targetPermissionMode: input.permissionMode } : {}),
      });
      if (input.action === "approve") void plans.dispatchExecutionForProposal(input.proposalId);
      return void result;
    },
    listPendingTools: (sessionId) => listPendingToolRequests(getHost, sessionId),
  };
  const agentHost = new AgentHost({
    runtime,
    sessions: createHostSessionPort(getHost),
    approvals,
    queueStore: createHostQueueStore(getHost),
    localApprovalLifetimeMs: APPROVAL_REQUEST_TIMEOUT_MS,
  });
  const plans = new PlanExecutionDispatcher({ getHost, getSidecar, launch, runtime, log });

  // Every runtime event feeds the module; a settled turn closes it there too.
  const abortingSessions = new Set<string>();
  runtime.onEvent((envelope: AgentEventEnvelope) => {
    const interrupted = envelope.event.type === "agent_end" && abortingSessions.has(envelope.sessionId);
    if (envelope.event.type === "agent_end" || envelope.event.type === "error") abortingSessions.delete(envelope.sessionId);
    try {
      agentHost.ingest(envelope, { interrupted });
    } catch (error) {
      log("warn", "agent host ingest failed", { sessionId: envelope.sessionId, type: envelope.event.type, error: String(error) });
    }
  });
  runtime.onTurnEnded((info) => {
    abortingSessions.delete(info.sessionId);
    const status = info.reason === "aborted" ? "interrupted" : info.reason === "error" ? "failed" : "completed";
    try {
      agentHost.endTurn(info.sessionId, info.turnId, status, info.errorCode ? { error: { code: info.errorCode, message: info.errorCode, retriable: false, traceId: "" } } : {});
      agentHost.kick(info.sessionId);
    } catch (error) {
      log("warn", "agent host end turn failed", { sessionId: info.sessionId, turnId: info.turnId, error: String(error) });
    }
  });
  const originalAbort = runtime.abort.bind(runtime);
  runtime.abort = async (sessionId, turnId) => {
    abortingSessions.add(sessionId);
    try {
      await originalAbort(sessionId, turnId);
    } catch (error) {
      abortingSessions.delete(sessionId);
      throw error;
    }
  };

  const startHost = async () => {
    const host = new HostProcess({ binaryPath: config.hostCoreBinary, dataDir: config.dataDir, onStderr: log.child("host") });
    host.onExit(({ intentional }) => {
      if (state.host !== host) return;
      state.host = null;
      if (intentional || state.stopping) return;
      log("error", "host-core exited unexpectedly");
      void supervisor.superviseRestart("host");
    });
    state.host = host;
    try {
      await host.handshake();
      await host.call("session.recoverInflightMessages").catch((error: unknown) => log("warn", "in-flight recovery failed", { error: String(error) }));
    } catch (error) {
      if (state.host === host) state.host = null;
      await host.dispose();
      throw error;
    }
    runtime.attachHost(host);
    state.sidecar?.setHost(host);
    log("info", "host-core handshake ok", { generation: host.generation });
  };
  const startSidecar = async () => {
    const sidecar = new AgentSidecar({
      launch: { command: config.nodeBinary, args: [config.sidecarEntry], env: { ...process.env, PI_DESKTOP_DATA_DIR: config.dataDir } },
      onStderr: log.child("agent"),
    });
    sidecar.onExit(({ intentional, code, signal, stderrTail }) => {
      if (state.sidecar !== sidecar) return;
      state.sidecar = null;
      if (intentional || state.stopping) return;
      log("error", "agent sidecar exited unexpectedly", { exitCode: code, signal, stderrTail });
      void supervisor.superviseRestart("sidecar");
    });
    sidecar.setProjectInstructionResolver(async ({ projectPath, path }) => {
      const { loadInstructionChain } = await import("@pi-desktop/agent-runtime");
      return loadInstructionChain(projectPath, path);
    });
    sidecar.setLocalTool("Skill", async ({ args, sessionId }) => {
      const id = String((args as { id?: unknown })?.id ?? "").trim();
      const host = getHost();
      if (!id || !host) return { ok: false, isError: true, content: "Skill: `id` is required." };
      const session = await host.call<{ session?: { projectPath?: string } | null }>("session.get", { id: sessionId, messageLimit: 1 }).catch(() => null);
      const result = await host.call<{ skill: { id: string; name: string } | null; body: string | null }>("skills.read", { id, projectPath: session?.session?.projectPath ?? null }).catch(() => null);
      if (!result?.skill || typeof result.body !== "string") return { ok: false, isError: true, content: `Skill: "${id}" is not available on this Host.` };
      return { ok: true, content: `# Skill: ${result.skill.name} (${result.skill.id})\n\n${result.body}` };
    });
    sidecar.setTrustedExtensionBridge({
      publishCommands: () => undefined,
      publishDiagnostics: () => undefined,
      requestUi: async (params) => {
        // One reverse-proxy call is not a UI request: slot #1's audit write
        // (`extensions.rewrites.record`) rides the same channel, and a headless
        // Host still owns a `plugin_rewrites` store (ADR 0295 rule 5). A
        // malformed record is refused by host-core with a coded error rather
        // than dropped; everything else has no window to prompt in.
        if (isRewriteRecordPayload(params)) {
          const host = getHost();
          if (!host) throw new Error("host unavailable");
          return host.call("plugin.rewrites.record", params as Record<string, unknown>);
        }
        throw new Error("extension UI is not available on a headless host");
      },
      configureModel: async () => {
        throw new Error("extension model configuration is not available on a headless host");
      },
      queuePush: async (params) =>
        agentHost.startTurn({ subject: "extension", roles: ["controller"] }, {
          sessionId: String(params.sessionId ?? ""),
          admission: "queue",
          input: { text: String(params.content ?? "") },
          context: { requestId: `ext-${Date.now().toString(36)}`, ...(typeof params.idempotencyKey === "string" ? { idempotencyKey: params.idempotencyKey } : {}) },
        }),
      queuePrioritize: async (params) => agentHost.prioritizeTurn({ subject: "extension", roles: ["controller"] }, String(params.id ?? "")),
      // Plugin-level AI needs the desktop/plugin host complete path; headless fails closed.
      aiComplete: async () => {
        throw new Error("agent.model.complete is not available on a headless host");
      },
      // Slot 3: a plugin asked to stop the turn. A headless host runs no
      // plugin host process, so it holds no plugin tool invocations to cancel;
      // the sidecar asks anyway because the desktop host does.
      turnAbort: () => undefined,
    });
    state.sidecar = sidecar;
    runtime.attachSidecar(sidecar);
    if (state.host) sidecar.setHost(state.host);
    await sidecar.call("sidecar.configure", { hostBinary: config.hostCoreBinary, dataDir: config.dataDir });
    log("info", "agent sidecar configured");
  };
  const supervisor = new RuntimeSupervisor({
    start: { host: startHost, sidecar: startSidecar },
    afterRestart: () => plans.drainApprovedPlanExecutions(),
    isShuttingDown: () => state.stopping,
    onEvent: (event) => {
      if (event.phase === "fatal") log("error", `${event.kind} restart gave up`, { reason: event.reason, error: event.error ? String(event.error) : undefined });
      else if (event.phase === "restarted") log("warn", `${event.kind} restarted after crash`, { attempt: event.attempt });
      else if (event.phase === "restart_failed") log("error", `${event.kind} restart failed`, { attempt: event.attempt, error: String(event.error) });
    },
  });

  await startHost();
  await startSidecar();
  await agentHost.start();
  await plans.drainApprovedPlanExecutions().catch((error: unknown) => log("warn", "queued approved plan drain failed", { error: String(error) }));

  const pty = loadPty();
  const terminal = pty
    ? new TerminalService({
        pty,
        log,
        sessionRoot: async (sessionId) => {
          const host = getHost();
          if (!host) throw new Error("host unavailable");
          const result = await host.call<{ session?: { projectPath?: string } | null }>("session.get", { id: sessionId, messageLimit: 1 });
          const root = result.session?.projectPath?.trim();
          if (!root) throw Object.assign(new Error("the session has no project root"), { errorCode: "CONFLICT" });
          return root;
        },
      })
    : undefined;
  if (!pty) log("warn", "node-pty is not installed; terminals are disabled");

  const operations: RacpHostOperations = {
    ...createHostOperations({
      getHost,
      runtime,
      browseRoot: config.browseRoot,
      // Slot 11 (ADR 0295 rule 11): announce the moment when it happens. The
      // notice is fire-and-forget — a session operation never waits on a
      // plugin — and a failed delivery is logged, not thrown.
      notifyLifecycle: (notice) => {
        const sidecar = getSidecar();
        if (!sidecar) return;
        const failed = (error: unknown) => {
          log("warn", "session lifecycle notice failed", {
            sessionId: notice.sessionId,
            error: String(error),
          });
        };
        try {
          void sidecar.call("agent.notifyLifecycle", notice).catch(failed);
        } catch (error) {
          failed(error);
        }
      },
      disposeSession: async (sessionId) => {
        const sidecar = getSidecar();
        if (!sidecar) return;
        sidecar.clearProjectInstructionRoot(sessionId);
        await sidecar.call("agent.disposeSession", { sessionId }).catch(() => undefined);
      },
      revokeDevice: (deviceId) => store.revokeDevice(deviceId, new Date().toISOString()),
    }),
    ...(terminal ? { terminal } : {}),
  };
  const server = new RacpServer({ agentHost, operations, authenticator, hostId, serverVersion: APP_VERSION, log });
  let binding: WsBinding;
  try {
    binding = await bindRacpWebSocket({ server: server, authenticator, host: config.host, port: config.port, log });
  } catch (error) {
    state.stopping = true;
    await state.sidecar?.dispose();
    await state.host?.dispose();
    throw error;
  }
  log("info", "pi-host ready", { hostId, host: binding.address.host, port: binding.address.port, version: APP_VERSION, terminal: Boolean(terminal) });

  return {
    hostId,
    address: binding.address,
    agentHost,
    runtime,
    authenticator,
    server,
    log,
    issuePairingToken: (lifetimeMs) => authenticator.issuePairingToken(lifetimeMs),
    async stop() {
      if (state.stopping) return;
      state.stopping = true;
      log("info", "pi-host stopping");
      server.close();
      await binding.close();
      await terminal?.closeAll();
      plans.dispose();
      await runtime.dispose();
      await state.sidecar?.dispose();
      await state.host?.dispose();
      state.sidecar = null;
      state.host = null;
    },
  };
}

/**
 * Slot #1's record as the runtime hands it over (`extensions.rewrites.record`).
 * A plain shape check: host-core owns the real validation and answers a
 * malformed record with a coded error, so this only decides whether the call is
 * a rewrite write or a UI request.
 */
function isRewriteRecordPayload(params: unknown): boolean {
  if (!params || typeof params !== "object") return false;
  const candidate = params as Record<string, unknown>;
  return (
    candidate.kind === "outgoing_message" ||
    typeof candidate.targetMessageId === "string" ||
    (typeof candidate.before === "string" && typeof candidate.after === "string")
  );
}
