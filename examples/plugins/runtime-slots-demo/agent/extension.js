/**
 * Agent-side half of the runtime-slots demo (spec 07-plugins/16 §6, ADR 0295).
 *
 * This module runs inside the agent sidecar, which is the only plugin host that
 * sees a running turn. It uses two runtime slots, and declares exactly the two
 * permissions behind them:
 *
 *   runtime.tool.gate  (slot 4) — `tool_call` is consulted before a tool runs.
 *     Returning `{ block: true, reason }` refuses the call; the reason is what
 *     the user and the model are shown, so it has to be readable prose.
 *   runtime.turn.abort (slot 3) — `pi.requestTurnAbort()` asks the host to stop
 *     the running turn. It is the same path the Stop button takes, it returns
 *     whether the request was accepted, and the plugin's own long-running work
 *     learns about the stop through the turn's cancellation signal (`ctx.signal`
 *     here, `signal` in a plugin tool's execution context).
 *
 * `agent.extension` is what lets this module run at all, and it grants neither
 * slot: ADR 0295 rule 2 says a tier permission never implies a slot grant, which
 * is why the manifest lists all three names. A missing slot grant is not silent
 * either — the handler is skipped and the plugin row reports a
 * `permission_denied` diagnostic naming the permission.
 *
 * The patterns below are a demonstration of the slot, not a security control:
 * they are shallow, command-line-literal, and easy to evade. Do not ship them
 * as a safety feature.
 */

/** How many refusals in this session before the plugin asks to stop the turn. */
const REFUSALS_BEFORE_ABORT = 3;

/** Shell commands this demo refuses before they run. */
const DANGEROUS_COMMANDS = [
  {
    pattern: /\brm\s+-[^\s]*r[^\s]*f[^\s]*\s+\/(?:\s|$)/i,
    reason: "a recursive force-delete of the filesystem root",
  },
  {
    pattern: /\bgit\s+push\b[^\n]*\s--force(?:\s|$)/i,
    reason: "a force-push that can discard what someone else already pushed",
  },
  {
    pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/i,
    reason: "formatting a filesystem",
  },
];

/** The first rule the command matches, if any. */
function matchDangerousCommand(command) {
  return DANGEROUS_COMMANDS.find((rule) => rule.pattern.test(command));
}

export default function (pi) {
  /**
   * Refusals in this session, since the last abort request.
   *
   * The factory runs once per session's extension runner, so this counter is
   * per session: another window's session starts its own.
   */
  let refusals = 0;

  pi.on("tool_call", (event, ctx) => {
    // Only the shell tool is judged here; every other tool call is left alone.
    if (event?.toolName !== "Bash") return undefined;
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    if (!command) return undefined;
    const rule = matchDangerousCommand(command);
    if (!rule) return undefined;

    refusals += 1;
    let stopTurn = false;
    let abortAccepted = false;
    if (refusals >= REFUSALS_BEFORE_ABORT) {
      stopTurn = true;
      // Slot 3: an accepted request stops the running turn. A refusal — the
      // plugin does not hold `runtime.turn.abort`, so there is nothing to stop —
      // is reported as a diagnostic and answered with `false`, never thrown. The
      // window starts over, so a turn that keeps trying is stopped again if the
      // session keeps going.
      abortAccepted = pi.requestTurnAbort();
      refusals = 0;
    }

    // The user sees the plugin's own line, and the transcript shows the block
    // reason, so who refused the call and why is not a guess.
    ctx.ui.notify(`Runtime Slots Demo refused a shell command: ${rule.reason}`, "warning");

    return {
      block: true,
      reason: stopTurn
        ? `Runtime Slots Demo refused this command (${rule.reason}) and asked the host to stop the turn ` +
          `after ${REFUSALS_BEFORE_ABORT} refusals: ${abortAccepted ? "accepted" : "refused"}.`
        : `Runtime Slots Demo refused this command: ${rule.reason}. Ask the user how to proceed instead of retrying.`,
    };
  });
}
