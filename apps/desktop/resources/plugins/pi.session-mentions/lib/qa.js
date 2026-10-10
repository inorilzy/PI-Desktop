import { stripEmbeddedReferences } from "./prompt.js";

/**
 * The parent-Q&A reduction from PR #447: concatenate eligible parent assistant
 * rows until the next parent user row. Thinking, tools, delegated (child)
 * rows and incomplete/error/aborted answers never contribute. Text the host
 * cut at its read limit is kept and the turn is flagged, so the snapshot can
 * say it was clipped instead of presenting it as complete.
 */
export function pairCompletedQaTurns(messages) {
  const turns = [];
  let question = null;
  let truncated = false;
  const answers = [];
  const commit = () => {
    if (question && answers.length) {
      turns.push({ question, answer: answers.join("\n\n"), ...(truncated ? { truncated: true } : {}) });
    }
    question = null;
    truncated = false;
    answers.length = 0;
  };
  for (const message of messages) {
    if (message.parentToolCallId?.trim()) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.role === "user") {
      commit();
      const text = stripEmbeddedReferences(message.content ?? "").trim();
      question = text || (message.attachments?.length
        ? "[User message with attachments; attachment contents are not included.]" : null);
      truncated = Boolean(message.contentTruncated) && Boolean(question);
    } else if (question && !["aborted", "error", "streaming"].includes(message.status ?? "")) {
      const text = stripEmbeddedReferences(message.content ?? "").trim();
      if (text) {
        answers.push(text);
        if (message.contentTruncated) truncated = true;
      }
    }
  }
  commit();
  return turns;
}
