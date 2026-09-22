/**
 * Agent half of the plugin showcase (spec 07-plugins/16 §6, ADR 0295).
 *
 * This module runs inside the agent sidecar — the only plugin host that sees a
 * running turn — and it uses five runtime slots with one visible behaviour each.
 * Each slot is a separate, individually reviewed grant, and this manifest
 * declares exactly the five it uses:
 *
 *   runtime.tool.gate         (slot 4) — `tool_call` is consulted before a tool
 *     runs. Returning `{ block: true, reason }` refuses the call, and the reason
 *     is what the user and the model are shown, so it has to be readable prose.
 *   runtime.turn.watch        (slot 2) — the running turn observed live. The
 *     turn's own counter is kept from the event stream here and shown in the
 *     host's status line for the session. Delivery is best-effort: no receipt,
 *     no redelivery, and a plugin that is loading simply misses events.
 *   runtime.turn.facts        (slot 9) — `pi.turnFacts()` reads the host's own
 *     numbers for one turn. Nothing is counted or derived from what this plugin
 *     observed; the difference between the two numbers is printed side by side.
 *   runtime.session.lifecycle (slot 11) — `session_lifecycle` is the desktop's
 *     notice that a session was created or deleted. It is informed-only: the
 *     plugin is told and can veto nothing.
 *   runtime.turn.abort        (slot 3) — `pi.requestTurnAbort()` asks the host to
 *     stop the running turn. It is the same path the Stop button takes, it
 *     returns whether the request was accepted, and the plugin's own
 *     long-running work would learn about the stop through the turn's
 *     cancellation signal (`ctx.signal` in a handler, `signal` in a plugin
 *     tool's execution context). This module has no long-running work to cancel,
 *     which is why it never reads that signal.
 *
 * `agent.extension` is what lets this module run at all, and it grants none of
 * the five: ADR 0295 rule 2 says a tier permission never implies a slot grant,
 * which is why the manifest lists all six names. A missing slot grant is not
 * silent either — the handler is skipped and the plugin row reports a
 * `permission_denied` diagnostic naming the permission.
 *
 * The command patterns below are a demonstration of the gate, not a security
 * control: they are shallow, shell-text-level, and easy to evade (quoting,
 * variables, another language). Do not ship them as a safety feature.
 */

/** Status-line key. `ui.setStatus` keeps one text per session and key. */
const STATUS_KEY = "plugin-showcase.turn";

/** Blocked calls in one turn before the plugin asks the host to stop it. */
const BLOCKED_BEFORE_ABORT = 3;

/** Shell commands this demo refuses before they run. */
const DANGEROUS_COMMANDS = [
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    reason: "a hard reset that discards uncommitted work",
  },
  {
    pattern: /\brm\s+-[^\s]*r[^\s]*f[^\s]*\s+(?:\/|~|\$HOME)(?:\s|$)/i,
    reason: "a recursive force-delete of the home directory or the filesystem root",
  },
  {
    pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z|fi)?sh\b/i,
    reason: "piping a download straight into a shell",
  },
];

/** The first rule the command matches, if any. */
function matchDangerousCommand(command) {
  return DANGEROUS_COMMANDS.find((rule) => rule.pattern.test(command));
}

/** `1234` ms as `1.2s`, or `…` while the turn has no end yet. */
function formatDuration(durationMs) {
  return typeof durationMs === "number" ? `${(durationMs / 1000).toFixed(1)}s` : "still running";
}

/**
 * The turn's plugin-tool spend as one short phrase.
 *
 * `pluginToolUsage` is the component plugin tools reported through
 * `runtime.tool.extend`, and it is never part of the model's token count; the
 * host leaves it `null` when no plugin tool reported any. Reading it
 * defensively is the point: the field is host data, not a shape this plugin
 * owns.
 */
function spendLabel(pluginToolUsage) {
  const total =
    pluginToolUsage && typeof pluginToolUsage === "object"
      ? pluginToolUsage.totalTokens
      : undefined;
  return typeof total === "number" ? `${total} plugin-tool tokens` : "no plugin-tool spend";
}

/**
 * One line for the host's own facts about the turn that just ran (slot 9).
 *
 * Every number here comes from `turn.facts` — a host table — and `seenToolCalls`
 * is the plugin's own best-effort count from slot 2 events. Printing both is
 * the honest way to show the difference ADR 0295 is built on: the event stream
 * can miss deliveries, so it is never the host's number.
 */
function summarizeFacts(facts, seenToolCalls) {
  const files = Array.isArray(facts.files) ? facts.files.length : 0;
  return (
    `Plugin Showcase · turn summary — ${facts.status}, ${formatDuration(facts.durationMs)}, ` +
    `${facts.tokens?.total ?? 0} tokens, ` +
    `${facts.toolCalls?.total ?? 0} tool call(s) (${facts.toolCalls?.ok ?? 0} ok / ` +
    `${facts.toolCalls?.failed ?? 0} failed) per host vs ${seenToolCalls} seen here, ` +
    `${files} file(s) touched${facts.filesTruncated ? " (list truncated)" : ""}, ` +
    `${spendLabel(facts.pluginToolUsage)}.`
  );
}

export default function (pi) {
  /**
   * Per-turn observation (slot 2), kept in this factory's closure.
   *
   * The factory runs once per session's extension runner, so these counters are
   * per session and are reset on every `turn_start`: they describe the turn
   * running now, not the session.
   */
  let turnIndex = 0;
  let seenToolCalls = 0;
  let seenFailures = 0;
  /** Blocked calls in the turn running now; drives the abort request below. */
  let blockedThisTurn = 0;

  pi.on("turn_start", (event, ctx) => {
    turnIndex = typeof event?.turnIndex === "number" ? event.turnIndex : turnIndex + 1;
    seenToolCalls = 0;
    seenFailures = 0;
    blockedThisTurn = 0;
    ctx.ui.setStatus(STATUS_KEY, `Plugin Showcase · watching turn ${turnIndex}`);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    seenToolCalls += 1;
    if (event?.isError === true) seenFailures += 1;
    ctx.ui.setStatus(
      STATUS_KEY,
      `Plugin Showcase · turn ${turnIndex} · ${seenToolCalls} tool call(s) seen` +
        (seenFailures ? ` (${seenFailures} failed)` : ""),
    );
  });

  pi.on("tool_call", (event, ctx) => {
    // Only the shell tool is judged here; every other tool call is left alone.
    if (event?.toolName !== "Bash") return undefined;
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    if (!command) return undefined;
    const rule = matchDangerousCommand(command);
    if (!rule) return undefined;

    blockedThisTurn += 1;
    let stopTurn = false;
    let abortAccepted = false;
    if (blockedThisTurn >= BLOCKED_BEFORE_ABORT) {
      stopTurn = true;
      // Slot 3: an accepted request stops the running turn. A refusal — the
      // plugin does not hold `runtime.turn.abort`, so there is nothing to stop —
      // is reported as a diagnostic and answered with `false`, never thrown.
      abortAccepted = pi.requestTurnAbort();
      blockedThisTurn = 0;
    }

    // The user sees the plugin's own line, and the transcript shows the block
    // reason, so who refused the call and why is not a guess.
    ctx.ui.notify(`Plugin Showcase refused a shell command: ${rule.reason}`, "warning");

    return {
      block: true,
      reason: stopTurn
        ? `Plugin Showcase refused this command (${rule.reason}) and asked the host to stop the turn ` +
          `after ${BLOCKED_BEFORE_ABORT} blocked calls in it: ${abortAccepted ? "accepted" : "refused"}.`
        : `Plugin Showcase refused this command: ${rule.reason}. Ask the user how to proceed instead of retrying.`,
    };
  });

  /**
   * Slot 9: the host's facts for the turn, read once the run has ended.
   *
   * `pi.turnFacts()` with no argument means the turn that just ran. The answer
   * is the host's own table for that row — status, duration, tokens, tool calls
   * with their outcomes, the files the turn touched, and the plugin-tool spend
   * reported through slot 5. `undefined` is the answer when the plugin holds no
   * `runtime.turn.facts`, when the host has no such turn, or when the read
   * failed; all three are reported on the plugin row, and each one is printed
   * here rather than mistaken for a turn with zero of everything.
   *
   * This is deliberately not a per-message handler: one host read per run is
   * cheap, one per message is not.
   */
  pi.on("agent_end", async (event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    const facts = await pi.turnFacts();
    if (!facts) {
      ctx.ui.notify(
        "Plugin Showcase · the host answered no facts for this turn (see the plugin row).",
        "warning",
      );
      return;
    }
    ctx.ui.notify(summarizeFacts(facts, seenToolCalls));
  });

  /**
   * Slot 11: the desktop created or deleted a session.
   *
   * Informed-only (ADR 0295 rule 11): the notice arrives after the decision and
   * nothing here can veto it. `created` reaches the plugins of the sessions that
   * are live at that moment, because the new session has no runtime yet;
   * `deleted` reaches the plugin of the session being deleted. A handler that
   * stalls is cut off by the runner's budget — a session switch or delete never
   * waits on a plugin — so this one only notifies.
   */
  pi.on("session_lifecycle", (event, ctx) => {
    const change = event?.change === "created" ? "created" : "deleted";
    const sessionId = typeof event?.sessionId === "string" ? event.sessionId : "unknown session";
    ctx.ui.notify(`Plugin Showcase · the host ${change} session ${sessionId}.`);
    if (change === "deleted") ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
