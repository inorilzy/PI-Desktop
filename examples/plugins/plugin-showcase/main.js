/**
 * Headless half of the plugin showcase.
 *
 * This is the plugin's own process, the third place plugin code can run next to
 * the app window (`renderer/index.mjs`) and the agent sidecar
 * (`agent/extension.js`). It exists for four reasons:
 *
 * 1. A manifest must declare an entry. `main`, `renderer`, or a plugin page is
 *    what makes a plugin runnable; `contributes.agentExtensions` is a
 *    contribution, not an entry, so a manifest that declares only an agent
 *    extension is refused at install (spec 07-plugins/02 §7 rule 19; host-core
 *    says `one of main/renderer/panel/view/destination required`).
 * 2. The command below is this plugin's visible presence in the app: it
 *    registers in the command palette and says what the other halves do.
 * 3. The tool below is what the renderer half's `toolCard` demonstration needs:
 *    that position is offered only to the owner of the tool row, and ownership
 *    is the forced `plugin_<id>_<tool>` prefix, so a plugin with no tool of its
 *    own can never see that slot. The tool is small on purpose — it formats a
 *    note — because the point is the card the renderer draws for it, not the
 *    tool.
 * 4. It answers the self-check console (`views/console.html`). A channel the
 *    host does not implement itself is forwarded to `onPanelInvoke`
 *    (spec 07-plugins/03 §6), so the console's buttons are real round trips
 *    into this process; `onRendererCall` receives the renderer half's own
 *    reports through the `plugin.call` action. Everything the console shows
 *    about this realm is produced here, and every refusal it shows is the code
 *    the host really returned — this file never invents one.
 *
 * What this process can and cannot reach, stated once because the console page
 * repeats it to the user:
 *
 * - It can call the host API (`pi.ai.complete`, `pi.models.list`, `pi.ui.*`,
 *   `pi.session.*`, `log` is written through `console.log`, see below).
 * - It cannot register a UI slot, dispatch a renderer action, call a registered
 *   renderer function, or reach the agent extension. Those live in the app
 *   window and the agent sidecar; there is no host channel from here to either.
 * - There is no `pi.log`: the plugin-process API has no log member
 *   (`plugin-host-process.mjs`), and the host log is written by `ctx.log`
 *   inside a tool execution or a service start. A plugin process that wants a
 *   line in the host's plugin log writes it with `console.log`, which the host
 *   records as `plugin.stdio`.
 */

/** Command id, declared in `contributes.commands`. */
const COMMAND_ID = "acme.plugin-showcase.about";

/** Tool name as declared in `contributes.agentTools`; the host prefixes it. */
const TOOL_NAME = "showcase_note";

/**
 * Channels the console page asks for. Each one is the plugin's own: the host
 * forwards anything it does not implement to `onPanelInvoke`.
 */
const CONSOLE_CHANNELS = {
  status: "showcase.console.status",
  ai: "showcase.console.ai",
  models: "showcase.console.models",
  log: "showcase.console.log",
  session: "showcase.console.session",
  panel: "showcase.console.panel",
  runtime: "showcase.console.runtime",
};

/** The model key the console deliberately asks for and the host cannot resolve. */
const UNRESOLVABLE_MODEL_KEY = "pi-showcase-missing/none";

/** Receipts kept for surfaces other than the console page itself. */
const MAX_RECEIPTS = 40;

/** Runtime receipts kept for the console's runtime group (bounded, newest last). */
const MAX_RUNTIME_RECEIPTS = 20;

/**
 * The plugin process's own state, per loaded lifetime. The console reads it
 * through `showcase.console.status`; `renderer` is filled from what the
 * renderer half reports through `plugin.call`, and `runtime` from what this
 * process itself observed about the agent half.
 */
const state = {
  loadedAt: Date.now(),
  panelCalls: 0,
  panelRefusals: 0,
  lastShape: "unknown",
  turnEnded: 0,
  lastTurn: null,
  receipts: [],
  receiptSeq: 0,
  renderer: {
    reports: 0,
    lastAt: 0,
    slots: [],
    functions: { served: 0, overBudget: 0 },
    functionsBy: {},
    lastSlotChange: null,
  },
  /**
   * What this process really witnessed about the plugin's agent half: one entry
   * per host-pushed `session:turnEnded` and one per execution of this plugin's
   * own agent tool. Both are produced here, in this process, so the console can
   * show them as receipts instead of a number nobody can read back.
   */
  runtime: {
    receipts: [],
    lastAt: 0,
    toolCalls: 0,
  },
};

/** Short, human-readable render of one host answer for a receipt line. */
function describeComplete(result) {
  const text = typeof result?.text === "string" ? result.text.replace(/\s+/g, " ").trim() : "";
  const tokens = result?.usage?.totalTokens;
  return (
    `modelKey=${result?.modelKey ?? "?"} · ` +
    `text=${JSON.stringify(text.slice(0, 60))}${text.length > 60 ? "…" : ""}` +
    (typeof tokens === "number" ? ` · tokens=${tokens}` : "")
  );
}

/**
 * One receipt from a non-console surface. The app window's renderer half has no
 * channel of its own into this process, so `plugin.call` reports land here; the
 * agent sidecar half has no channel at all and therefore never appears in this
 * list (the console page says so instead of inventing an entry).
 */
function recordReceipt(surface, action, code, detail) {
  state.receiptSeq += 1;
  const entry = {
    id: `main-${state.receiptSeq}`,
    at: Date.now(),
    surface,
    action,
    code,
    detail,
  };
  state.receipts.push(entry);
  while (state.receipts.length > MAX_RECEIPTS) state.receipts.shift();
  return entry;
}

/**
 * One runtime receipt: something this process really observed about the
 * plugin's agent half. Kept in both lists on purpose — the console's runtime
 * group reads `state.runtime.receipts` explicitly, and a status refresh merges
 * `state.receipts` into the same log, so a receipt is never counted twice (the
 * page de-duplicates by id).
 */
function recordRuntimeReceipt(action, code, detail) {
  state.runtime.lastAt = Date.now();
  const entry = recordReceipt("运行时", action, code, detail);
  state.runtime.receipts.push(entry);
  while (state.runtime.receipts.length > MAX_RUNTIME_RECEIPTS) {
    state.runtime.receipts.shift();
  }
  return entry;
}

/** Never throws: a refusal is an answer, and the console shows it as one. */
function refusal(error, fallback) {
  return {
    ok: false,
    code: String(error?.code ?? fallback),
    detail: String(error?.message ?? error ?? fallback),
  };
}

async function completeFor(variant) {
  if (variant === "own") {
    return pi.ai.complete({
      // The plugin's own prompt: it is this process's text, not the session's.
      system: "You are the plugin showcase's own model call. Answer in one short sentence.",
      messages: [{ role: "user", content: "Say one sentence naming this plugin's own realm." }],
      purpose: "showcase.console.own",
    });
  }
  if (variant === "unknown") {
    // An explicit model key the host cannot resolve. The honest receipt is
    // whatever the host does with it — see the host's own resolution order.
    return pi.ai.complete({
      modelKey: UNRESOLVABLE_MODEL_KEY,
      messages: [{ role: "user", content: "Reply with one word." }],
      purpose: "showcase.console.unknown-model",
    });
  }
  // `default` and `no-model` are the same call on purpose: the host resolves an
  // omitted model key from its ready catalog, and answers NO_MODEL only when
  // that catalog has nothing usable.
  return pi.ai.complete({
    messages: [{ role: "user", content: "Reply with one word." }],
    purpose: `showcase.console.${variant}`,
  });
}

async function handlePanelChannel(channel, payload) {
  if (channel === CONSOLE_CHANNELS.status) {
    if (typeof payload?.shape === "string") state.lastShape = payload.shape;
    return {
      ok: true,
      code: "ok",
      detail:
        `插件进程回答：面板调用 ${state.panelCalls} 次（被拒 ${state.panelRefusals} 次），` +
        `槽位侧上报 ${state.renderer.reports} 次，宿主推送 turn ended ${state.turnEnded} 次。`,
      status: {
        pluginId: typeof pi.plugin?.getId === "function" ? pi.plugin.getId() : "acme.plugin-showcase",
        version: pi.plugin?.getManifest?.()?.version ?? "0.0.0",
        loadedAt: state.loadedAt,
        shape: state.lastShape,
        panelCalls: state.panelCalls,
        panelRefusals: state.panelRefusals,
        turnEnded: state.turnEnded,
        lastTurn: state.lastTurn,
        renderer: state.renderer,
        runtime: {
          receipts: state.runtime.receipts.length,
          turnEnded: state.turnEnded,
          toolCalls: state.runtime.toolCalls,
          lastAt: state.runtime.lastAt,
        },
        receipts: state.receipts,
      },
    };
  }

  if (channel === CONSOLE_CHANNELS.runtime) {
    // What this process really holds about the agent half — no number is
    // invented here. The sidecar's own slot verdicts (the tool gate's block or
    // allow) reach the window and the plugin row's diagnostics; there is no
    // host channel from the sidecar to this process or to the console page, so
    // the page shows the receipts below and names that missing channel instead
    // of pretending to have counted the verdicts.
    const receipts = state.runtime.receipts;
    return {
      ok: true,
      code: "ok",
      detail:
        `${receipts.length} 条运行时回执：宿主推送 turn ended ${state.turnEnded} 次、` +
        `本插件自己的 agent 工具执行 ${state.runtime.toolCalls} 次。` +
        "扩展侧自己的槽位判定（tool gate 的 block/allow）只到窗口与插件行诊断，" +
        "agent sidecar 没有到插件进程或本页的通道，所以这里不编造 gate 命中数。",
      receipts,
      runtime: {
        receipts: receipts.length,
        turnEnded: state.turnEnded,
        toolCalls: state.runtime.toolCalls,
        lastAt: state.runtime.lastAt,
        lastTurn: state.lastTurn,
      },
    };
  }

  if (channel === CONSOLE_CHANNELS.ai) {
    const variant = String(payload?.variant ?? "default");
    try {
      const result = await completeFor(variant);
      const detail = describeComplete(result);
      if (variant === "unknown") {
        return {
          ok: true,
          code: "ok",
          detail:
            `${detail} — the host did not answer NO_MODEL for an explicit key: ` +
            `it fell back to a usable provider/model.`,
        };
      }
      return { ok: true, code: "ok", detail };
    } catch (error) {
      return refusal(error, "PLUGIN_API_FAILED");
    }
  }

  if (channel === CONSOLE_CHANNELS.models) {
    try {
      const rows = await pi.models.list();
      const list = Array.isArray(rows) ? rows : [];
      const keys = list.map((row) => String(row?.key ?? "?")).slice(0, 4);
      return {
        ok: true,
        code: "ok",
        detail:
          `${list.length} 个就绪模型（无密钥）` +
          (keys.length ? `：${keys.join(", ")}${list.length > keys.length ? ", …" : ""}` : ""),
      };
    } catch (error) {
      return refusal(error, "PLUGIN_API_FAILED");
    }
  }

  if (channel === CONSOLE_CHANNELS.log) {
    // No `pi.log` exists on this API; `console.log` is the real route into the
    // host's plugin log (recorded as `plugin.stdio` by `plugin-runtime.ts`).
    const line = `[plugin-showcase] console line written at ${new Date().toISOString()}`;
    console.log(line);
    return {
      ok: true,
      code: "ok",
      detail:
        "console.log 已写出（宿主把子进程 stdout 记为 plugin.stdio）；" +
        "插件进程 API 没有 pi.log —— 日志的另一个入口是工具/服务执行期的 ctx.log。",
    };
  }

  if (channel === CONSOLE_CHANNELS.session) {
    try {
      const context = await pi.session.getLlmContext();
      return {
        ok: true,
        code: "ok",
        detail:
          `session ${context?.sessionId ?? "?"} · ${context?.messages?.length ?? 0} message(s) · ` +
          `truncated=${context?.truncated === true}`,
      };
    } catch (error) {
      return refusal(error, "PLUGIN_API_FAILED");
    }
  }

  if (channel === CONSOLE_CHANNELS.panel) {
    const action = String(payload?.action ?? "open");
    try {
      if (action === "close") {
        await pi.ui.closePanel();
        return { ok: true, code: "ok", detail: "ui.closePanel() 已调用（独立面板窗口关闭）" };
      }
      await pi.ui.openPanel();
      return { ok: true, code: "ok", detail: "ui.openPanel() 已调用（宿主打开同一页面的独立窗口）" };
    } catch (error) {
      return refusal(error, "PLUGIN_API_FAILED");
    }
  }

  const error = new Error(`plugin does not expose panel channel: ${channel}`);
  error.code = "PLUGIN_PANEL_CHANNEL_UNKNOWN";
  throw error;
}

/**
 * The renderer half's reports. `plugin.call` is the one renderer action that
 * reaches this process, and the renderer module declares it in
 * `rendererActions` for exactly this purpose.
 */
async function handleRendererCall(method, args) {
  if (method === "renderer.report") {
    const slots = Array.isArray(args?.slots) ? args.slots.map(String) : [];
    const functions = args?.functions ?? {};
    state.renderer.reports += 1;
    state.renderer.lastAt = Date.now();
    state.renderer.slots = slots;
    state.renderer.functions = {
      served: Number(functions.served ?? 0),
      overBudget: Number(functions.overBudget ?? 0),
    };
    state.renderer.functionsBy = functions.by ?? {};
    recordReceipt(
      "槽位",
      "renderer.report",
      "ok",
      `${slots.length} 个槽位：${slots.join(", ") || "无"} · 函数调用 ${state.renderer.functions.served} 次`,
    );
    return { ok: true, code: "ok", acceptedAt: Date.now(), slots };
  }

  if (method === "renderer.slot") {
    const name = String(args?.slot ?? "");
    const registered = args?.registered === true;
    state.renderer.reports += 1;
    state.renderer.lastAt = Date.now();
    state.renderer.lastSlotChange = { name, registered, at: Date.now() };
    if (registered) {
      if (name && !state.renderer.slots.includes(name)) state.renderer.slots.push(name);
    } else {
      state.renderer.slots = state.renderer.slots.filter((slot) => slot !== name);
    }
    recordReceipt(
      "槽位",
      `slot ${name}`,
      "ok",
      registered ? "已注册（渲染模块自己的 register 调用）" : "已注销（registration.remove()）",
    );
    return { ok: true, code: "ok", slot: name, registered, slots: state.renderer.slots };
  }

  if (method === "renderer.refusal") {
    // The renderer half's own refusal report: it caught a coded refusal from a
    // dispatched action and sends the code here, so the console shows the same
    // code the window shows. The host's own plugin row keeps its diagnostic
    // too — this is the second place to read one refusal, not a replacement.
    const action = String(args?.action ?? "");
    const code = String(args?.code ?? "UNKNOWN");
    state.renderer.reports += 1;
    state.renderer.lastAt = Date.now();
    recordReceipt("槽位", `refusal ${action}`, code, `渲染模块捕获的动作拒绝：${action}`);
    return { ok: true, code: "ok", action, refusal: code };
  }

  const error = new Error(`plugin does not expose renderer method: ${method}`);
  error.code = "PLUGIN_CALL_NO_HANDLER";
  throw error;
}

async function onLoad() {
  await pi.commands.register({
    id: COMMAND_ID,
    title: "Plugin Showcase: What this plugin adds",
    keywords: ["showcase", "slots", "runtime", "renderer", "agent", "demo"],
    run: async () => {
      await pi.ui.showToast(
        "Plugin Showcase: its renderer half draws all ten UI slots (three of them only " +
          "when you open them from the composer), its headless half registers the " +
          "showcase_note tool and answers the self-check console view, and its agent half " +
          "gates shell commands, watches the turn, reports turn facts, and notices session " +
          "lifecycle changes.",
      );
    },
  });

  // `execute` runs in this process, never in the window or the sidecar. The
  // model sees the forced name `plugin_acme_plugin_showcase_showcase_note`.
  await pi.agent.registerTool({
    name: TOOL_NAME,
    description: "Format a short note in the plugin showcase's own tool card",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "the note to format" },
      },
      required: ["text"],
    },
    execute: async (args, context) => {
      const text = typeof args?.text === "string" ? args.text : "";
      // This function runs in the plugin's own process, and the model calls it
      // during a turn, so the call is a runtime receipt this process really
      // produced: the session and turn come from the host's execution context,
      // never from anything guessed here.
      state.runtime.toolCalls += 1;
      recordRuntimeReceipt(
        `agent tool ${TOOL_NAME}`,
        "ok",
        `session ${typeof context?.sessionId === "string" ? context.sessionId : "?"} · ` +
          `turn ${typeof context?.turnId === "string" ? context.turnId : "?"} · ` +
          `${text.length} 字符`,
      );
      return {
        ok: true,
        note: `Plugin Showcase note: ${text}`,
        characters: text.length,
      };
    },
  });

  // The one host-pushed fact this process really receives: a turn reached a
  // terminal state. Delivery is best-effort (no replay), which is why the
  // console prints "宿主推送" for it and never calls it an extension report.
  // It is also the runtime receipt the console can honestly show: this process
  // witnessed the turn the plugin's agent half took part in.
  pi.events?.on?.("session:turnEnded", (payload) => {
    state.turnEnded += 1;
    state.lastTurn = {
      sessionId: typeof payload?.sessionId === "string" ? payload.sessionId : null,
      status: typeof payload?.status === "string" ? payload.status : null,
      turnId: typeof payload?.turnId === "string" ? payload.turnId : null,
      at: Date.now(),
    };
    recordRuntimeReceipt(
      "session:turnEnded（宿主推送）",
      "ok",
      `session ${state.lastTurn.sessionId ?? "?"} · turn ${state.lastTurn.turnId ?? "?"} · ` +
        `${state.lastTurn.status ?? "?"}`,
    );
  });
}

async function onUnload() {
  await pi.commands.unregister(COMMAND_ID);
  await pi.agent.unregisterTool(TOOL_NAME);
}

module.exports = {
  onLoad,
  onUnload,
  // The panel bridge sends every channel the host does not implement itself to
  // the plugin page's own handler (spec 07-plugins/03 §6).
  onPanelInvoke: async (channel, payload) => {
    const name = String(channel ?? "");
    state.panelCalls += 1;
    const answer = await handlePanelChannel(name, payload);
    if (answer?.ok !== true) state.panelRefusals += 1;
    return answer;
  },
  // The relayed renderer action: the app window's renderer half reports its own
  // live state through `plugin.call`.
  onRendererCall: async (method, args) => handleRendererCall(String(method ?? ""), args),
};
