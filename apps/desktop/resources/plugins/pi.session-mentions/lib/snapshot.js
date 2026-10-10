import { clipUtf8, formatReferenceBlock, utf8Bytes } from "./prompt.js";
import { pairCompletedQaTurns } from "./qa.js";

/** `PLUGIN_MARK_SEND_MAX_BYTES`: the host drops a trigger row whose `send` is larger. */
export const MARK_SEND_MAX_BYTES = 32 * 1024;
/** At most this many of the newest complete turns, as in PR #447. */
export const DEFAULT_MAX_TURNS = 10;
/** A clipped newest question keeps at most this much, leaving the rest to its answer. */
const CLIPPED_QUESTION_MAX_BYTES = 2 * 1024;
const CLIP_MARKER = "\n[… clipped to fit the reference size limit]";
const HOST_CLIP_MARKER = "\n[… the host shortened this text]";

/** Model tokens held back for the reply and the user's own text (#447's default output reserve). */
export const CONTEXT_RESERVE_TOKENS = 8192;

/**
 * Bytes of reference the current session can still take, from its remaining
 * context tokens: the reserve comes off first, then #447's UTF-8/3 estimate
 * (a heuristic, not a tokenizer). `undefined` when the host did not say.
 */
export function contextBytesFromTokens(remainingTokens) {
  if (remainingTokens === undefined || !Number.isFinite(remainingTokens)) return undefined;
  return Math.max(0, Math.floor(remainingTokens) - CONTEXT_RESERVE_TOKENS) * 3;
}

/**
 * What `buildSessionSnapshot` returns.
 *
 * @typedef {{ status: "ready", send: string, includedTurns: number,
 *   omittedKnown: number, olderUnread: boolean, clipped: boolean }} SessionSnapshot
 *   `send` is the mark's text: a newline-framed `<referenced-chat>` block.
 * @typedef {{ status: "context-full", neededBytes: number, contextBytes: number }} SessionSnapshotContextFull
 *   Not even the newest complete turn fits in the current session's remaining
 *   context; `neededBytes` is what that turn needs as a block.
 */

function frame(block) {
  return `\n${block}\n`;
}

function marked(turn) {
  return turn.truncated ? { question: turn.question, answer: `${turn.answer}${HOST_CLIP_MARKER}` } : turn;
}

/**
 * The referenced session as one mark text within `maxBytes`: the newest
 * complete turns, at most `maxTurns`, whole turns selected newest-first and
 * kept in chronological order. #447 refused a send whose newest turn did not
 * fit; a mark has a hard size limit and no later chance to refuse, so the
 * newest turn is clipped instead (question first capped, then the answer),
 * and the block says so.
 *
 * `contextBytes` is what the current session's context can still take. When
 * it is the tighter limit, the budget is min(maxBytes, contextBytes); when not
 * even the newest complete turn fits it, nothing is clipped: the result is
 * `context-full`, so the user can compact first and pick the session again.
 */
export function buildSessionSnapshot(
  source,
  options = {},
) {
  let maxBytes = options.maxBytes ?? MARK_SEND_MAX_BYTES;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new Error("maxBytes must be an integer of at least 1024");
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error("maxTurns must be a positive integer");
  const contextBytes = options.contextBytes;
  if (contextBytes !== undefined && (!Number.isFinite(contextBytes) || contextBytes < 0)) {
    throw new Error("contextBytes must be a non-negative number");
  }
  const raw = pairCompletedQaTurns(source.messages);
  const all = raw.map(marked);
  const hostCut = (index) => Boolean(raw[index]?.truncated);
  const olderUnread = Boolean(source.hasMoreBefore);
  const render = (turns, clipped) => frame(formatReferenceBlock({
    sessionId: source.id, title: source.title, turns,
    omittedKnown: all.length - turns.length, olderUnread, clipped,
  }));
  const result = (turns, clipped) => ({
    status: "ready", send: render(turns, clipped), includedTurns: turns.length,
    omittedKnown: all.length - turns.length, olderUnread, clipped,
  });
  if (contextBytes !== undefined && contextBytes < maxBytes) {
    const smallest = all.length === 0 ? render([], false)
      : render([all[all.length - 1] ], hostCut(all.length - 1));
    const neededBytes = utf8Bytes(smallest);
    if (neededBytes > contextBytes) {
      return { status: "context-full", neededBytes, contextBytes: Math.floor(contextBytes) };
    }
    maxBytes = Math.floor(contextBytes);
  }
  if (all.length === 0) {
    const empty = render([], false);
    if (utf8Bytes(empty) > maxBytes) throw new Error("The session title does not fit in a reference");
    return result([], false);
  }

  const newest = all[all.length - 1] ;
  let included = [newest];
  let clipped = hostCut(all.length - 1);
  if (utf8Bytes(render(included, clipped)) > maxBytes) {
    clipped = true;
    const question = utf8Bytes(newest.question) > CLIPPED_QUESTION_MAX_BYTES
      ? `${clipUtf8(newest.question, CLIPPED_QUESTION_MAX_BYTES)}${CLIP_MARKER}` : newest.question;
    const skeleton = utf8Bytes(render([{ question, answer: CLIP_MARKER }], true));
    const room = maxBytes - skeleton;
    if (room < 0) throw new Error("The session title does not fit in a reference");
    // Escaping can only grow closing tags; trim until the rendered block fits.
    let answerBytes = room;
    for (;;) {
      const answer = `${clipUtf8(newest.answer, answerBytes)}${CLIP_MARKER}`;
      included = [{ question, answer }];
      if (utf8Bytes(render(included, true)) <= maxBytes || answerBytes === 0) break;
      answerBytes = Math.max(0, answerBytes - 64);
    }
    return result(included, true);
  }

  for (let index = all.length - 2; index >= 0 && included.length < maxTurns; index--) {
    const candidate = [all[index], ...included];
    const candidateClipped = clipped || hostCut(index);
    if (utf8Bytes(render(candidate, candidateClipped)) > maxBytes) break;
    included = candidate;
    clipped = candidateClipped;
  }
  return result(included, clipped);
}
