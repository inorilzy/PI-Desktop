/**
 * `turn_closing` hook (issue #561 item 7, spec 07-plugins/16 section 6).
 *
 * The kernel entry point is pi-agent-core's `shouldStopAfterTurn`: the loop
 * calls it once per completed turn, right after `turn_end` is emitted and the
 * assistant message and its tool results are in the context. Answering `true`
 * ends the run there; answering `false` lets the loop deliver queued steering
 * and follow-up messages, and it exits on its own when none are queued. A
 * trusted agent extension registers the hook like every other event -
 * `pi.on("turn_closing", handler)` - and may answer with a request to continue.
 *
 * The kernel resumes a run at that boundary only through its steering queue, so
 * a granted request means "queue this message"; the message is then delivered
 * to the next provider request exactly like a renderer steering message. The
 * hook is therefore consulted on the trusted tier only: sandboxed plugins have
 * no hook registration path (G14).
 *
 * The kernel has no turn cap (ADR 0253 removed `maxTurns`), so this path brings
 * its own continuation budget with it.
 */

/** Event name a trusted agent extension registers for. */
export const TRUSTED_EXTENSION_TURN_CLOSING_EVENT = "turn_closing";

/**
 * Continuations one run may grant, counted per run.
 *
 * Every granted request costs a full provider request the user did not ask for,
 * so the budget is small on purpose: 4 covers the short "keep going until X"
 * chains this hook exists for (finish the step you announced, then confirm it)
 * and keeps the worst case at 5 provider requests per run. It sits between the
 * framework's own per-run autonomies - the silent-turn and progress recoveries
 * get one attempt per run, while provider retries (up to 10) resend the same
 * request rather than put another turn's tool work on the table. A plugin
 * therefore cannot loop the agent forever: the fifth ask is refused and the run
 * ends there.
 */
export const TRUSTED_EXTENSION_TURN_CLOSING_LIMIT = 4;

/** Injected when a handler asks to continue without saying what to say. */
export const TRUSTED_EXTENSION_TURN_CLOSING_DEFAULT_MESSAGE =
  "A trusted extension asked for another turn. Continue the current task from where you left off.";

/** Payload handed to a `turn_closing` handler; the honest minimum at that point. */
export type TrustedExtensionTurnClosingPayload = {
  type: "turn_closing";
  sessionId: string;
  /** Same counter `turn_start`/`turn_end` payloads use. */
  turnIndex: number;
  /** Why the model stopped: the completed assistant message's `stopReason`. */
  stopReason?: string;
};

/** What a handler may answer. Anything else, including no return, means "stop". */
export type TrustedExtensionTurnClosingResult = {
  /** Ask the run to continue with another provider request. */
  continue?: boolean;
  /** Text of the message injected before that request. */
  message?: string;
};

/**
 * Fold several handlers into one answer: the first handler that asks to
 * continue wins, in load order, and a handler that stays silent or declines
 * does not veto a later one. Same convention as `tool_call` ("keep going until
 * one handler changes the outcome"), not the replace/merge conventions used by
 * value-shaped events.
 */
export function foldTurnClosingResults(
  acc: TrustedExtensionTurnClosingResult | undefined,
  next: TrustedExtensionTurnClosingResult,
): TrustedExtensionTurnClosingResult {
  if (acc?.continue === true) return acc;
  return next;
}

/**
 * Validate a folded answer. Only an explicit `continue: true` counts, so a
 * handler returning junk cannot continue a run by accident.
 */
export function turnClosingRequest(
  result: TrustedExtensionTurnClosingResult | undefined,
): { message: string } | undefined {
  if (!result || result.continue !== true) return undefined;
  const text = typeof result.message === "string" ? result.message.trim() : "";
  return { message: text || TRUSTED_EXTENSION_TURN_CLOSING_DEFAULT_MESSAGE };
}
