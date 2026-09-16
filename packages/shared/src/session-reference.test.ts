import { describe, expect, it } from "vitest";
import type { UiMessage } from "./types/messages.js";
import {
  SESSION_REFERENCE_MAX_CHARS,
  SESSION_REFERENCE_TURN_LIMIT,
  attachSessionReferenceSnapshots,
  collectSessionReferenceIds,
  expandSessionReferences,
  pairCompletedQaTurns,
  stripSessionReferencePrompt,
} from "./session-reference.js";

const THINKING_MARKER = "SECRET_THINKING_MARKER";
const TOOL_MARKER = "SECRET_TOOL_MARKER";
const SUBAGENT_MARKER = "SECRET_SUBAGENT_MARKER";

function message(partial: Partial<UiMessage> & Pick<UiMessage, "role" | "content">): UiMessage {
  return {
    id: partial.id ?? crypto.randomUUID(),
    createdAt: partial.createdAt ?? "2026-09-16T00:00:00.000Z",
    status: "complete",
    ...partial,
  };
}

describe("pairCompletedQaTurns", () => {
  it("keeps user questions and final assistant answers, dropping thinking and tools", () => {
    const turns = pairCompletedQaTurns([
      message({ role: "user", content: "How should the pool work?" }),
      message({
        role: "assistant",
        content: "Use a bounded pool.",
        thinking: THINKING_MARKER,
      }),
      message({
        role: "tool",
        content: "",
        toolName: "Read",
        toolResult: TOOL_MARKER,
      }),
      message({ role: "user", content: "And timeouts?" }),
      message({ role: "assistant", content: "Fail closed after 30s." }),
    ]);
    expect(turns).toEqual([
      { question: "How should the pool work?", answer: "Use a bounded pool." },
      { question: "And timeouts?", answer: "Fail closed after 30s." },
    ]);
    const serialized = JSON.stringify(turns);
    expect(serialized).not.toContain(THINKING_MARKER);
    expect(serialized).not.toContain(TOOL_MARKER);
  });

  it("skips nested subagent rows, aborted answers, and unpaired questions", () => {
    const turns = pairCompletedQaTurns([
      message({ role: "user", content: "Parent question" }),
      message({
        role: "assistant",
        content: SUBAGENT_MARKER,
        parentToolCallId: "call_1",
      }),
      message({ role: "assistant", content: "", status: "aborted", thinking: THINKING_MARKER }),
      message({ role: "user", content: "Still waiting" }),
      message({ role: "assistant", content: "Final parent answer", status: "complete" }),
    ]);
    expect(turns).toEqual([{ question: "Still waiting", answer: "Final parent answer" }]);
    expect(JSON.stringify(turns)).not.toContain(SUBAGENT_MARKER);
    expect(JSON.stringify(turns)).not.toContain(THINKING_MARKER);
  });

  it("uses the last complete assistant before the next user as the answer", () => {
    const turns = pairCompletedQaTurns([
      message({ role: "user", content: "Do the work" }),
      message({ role: "assistant", content: "", status: "streaming" }),
      message({ role: "tool", content: "", toolResult: TOOL_MARKER }),
      message({ role: "assistant", content: "Done." }),
    ]);
    expect(turns).toEqual([{ question: "Do the work", answer: "Done." }]);
  });
});

describe("session reference prompt wrap", () => {
  it("collects session chips and @session tokens without the current session", () => {
    const idA = "11111111-1111-4111-8111-111111111111";
    const idB = "22222222-2222-4222-8222-222222222222";
    const current = "33333333-3333-4333-8333-333333333333";
    expect(
      collectSessionReferenceIds(
        `see @session:${idA} and @session:${idB}`,
        [{ path: idB, kind: "session" }],
        current,
      ),
    ).toEqual([idB, idA]);
  });

  it("attaches a snapshot the model can read and the UI can strip", () => {
    const id = "42cf934f-ba75-46e1-84b5-e44bb76eba83";
    const wrapped = attachSessionReferenceSnapshots("please continue", [
      {
        sessionId: id,
        title: "Pool design",
        turns: [{ question: "How should the pool work?", answer: "Use a bounded pool." }],
      },
    ]);
    expect(wrapped).toContain("# Referenced chats:");
    expect(wrapped).toContain(`id="${id}"`);
    expect(wrapped).toContain("Q: How should the pool work?");
    expect(wrapped).toContain("A: Use a bounded pool.");
    expect(wrapped).toContain("please continue");
    expect(stripSessionReferencePrompt(wrapped)).toBe("please continue");
  });

  it("keeps only the newest complete turns that fit the budget", () => {
    const turns = Array.from({ length: SESSION_REFERENCE_TURN_LIMIT + 2 }, (_, index) => ({
      question: `Q${index + 1} ${"x".repeat(200)}`,
      answer: `A${index + 1} ${"y".repeat(200)}`,
    }));
    const wrapped = attachSessionReferenceSnapshots("go", [
      { sessionId: "42cf934f-ba75-46e1-84b5-e44bb76eba83", title: "Long", turns },
    ]);
    expect(wrapped).toContain(`Q${SESSION_REFERENCE_TURN_LIMIT + 2}`);
    expect(wrapped).not.toContain("Q1 ");
    expect(wrapped.length).toBeLessThanOrEqual(SESSION_REFERENCE_MAX_CHARS + 400);
  });

  it("does not expand nested session mentions inside the sourced Q&A", async () => {
    const nested = "99999999-9999-4999-8999-999999999999";
    const source = "42cf934f-ba75-46e1-84b5-e44bb76eba83";
    const loaded: string[] = [];
    const result = await expandSessionReferences(`use @session:${source}`, {
      loadSession: async (id) => {
        loaded.push(id);
        return {
          id,
          title: "Source",
          messages: [
            message({
              role: "user",
              content: `earlier @session:${nested}`,
            }),
            message({
              role: "assistant",
              content: "answered",
              thinking: THINKING_MARKER,
            }),
          ],
        };
      },
    });
    expect(loaded).toEqual([source]);
    expect(result.missingIds).toEqual([]);
    expect(result.content).toContain("earlier @session:");
    expect(result.content).toContain("answered");
    expect(result.content).not.toContain(THINKING_MARKER);
    expect(stripSessionReferencePrompt(result.content)).toBe(`use @session:${source}`);
  });
});
