import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/*
 * Plugin-owned composer triggers (`docs/plugin-plan/ui/composer/`): where a
 * trigger is active in the draft, what of a plugin's answer the host keeps,
 * and that a failing provider only ever collapses its own group.
 */
const {
  PLUGIN_MARK_LABEL_MAX_CHARS,
  PLUGIN_MARK_SEND_MAX_BYTES,
  PLUGIN_TRIGGER_DETAIL_MAX_CHARS,
  PLUGIN_TRIGGER_MAX_ITEMS,
} = await import("@pi-desktop/plugin-sdk");
const { askPluginTrigger, detectPluginTrigger, pluginTriggerScope, sanitizeTriggerItems } = await import(
  "../src/features/chat/composer/plugins/plugin-triggers.ts"
);

const OWNED = new Set(["#"]);
const CHIP = String.fromCharCode(0xe000);

test("a trigger opens on an owned symbol at a line start or after whitespace", () => {
  assert.deepEqual(detectPluginTrigger("#12", 3, OWNED), {
    trigger: "#",
    query: "12",
    tokenStart: 0,
    tokenEnd: 3,
  });
  assert.deepEqual(detectPluginTrigger("fix #", 5, OWNED), {
    trigger: "#",
    query: "",
    tokenStart: 4,
    tokenEnd: 5,
  });
  assert.equal(detectPluginTrigger("line\n#ab", 8, OWNED)?.tokenStart, 5);
  // The query runs to the caret, not to the end of the word.
  assert.equal(detectPluginTrigger("#abcdef", 3, OWNED)?.query, "ab");
});

test("a full-width symbol counts as its ASCII trigger", () => {
  const match = detectPluginTrigger("\uFF03bug", 4, OWNED);
  assert.equal(match?.trigger, "#");
  assert.equal(match?.query, "bug");
});

test("no trigger inside a word, for an unowned symbol, or across a chip", () => {
  assert.equal(detectPluginTrigger("issue#12", 8, OWNED), null);
  assert.equal(detectPluginTrigger("@me", 3, OWNED), null);
  assert.equal(detectPluginTrigger("#12", 3, new Set()), null);
  assert.equal(detectPluginTrigger(`#a${CHIP}b`, 4, OWNED), null);
  assert.equal(detectPluginTrigger("#a\uFFFC", 3, OWNED), null);
  assert.equal(detectPluginTrigger(`${CHIP}#a`, 3, OWNED), null);
  assert.equal(detectPluginTrigger("# a", 3, OWNED), null);
  assert.equal(detectPluginTrigger("#a", 0, OWNED), null);
  assert.equal(detectPluginTrigger("#a", 9, OWNED), null);
});

test("an answer keeps its good items and drops each one breaking a limit", () => {
  const rows = sanitizeTriggerItems([
    { label: "Plain" },
    { label: "Sent", send: "Issue 7", detail: "open" },
    { label: "" },
    { label: "   " },
    { label: 42 },
    null,
    "text",
    { label: "x".repeat(PLUGIN_MARK_LABEL_MAX_CHARS + 1) },
    { label: "two\nlines" },
    { label: "sep\u2028arator" },
    { label: `chip${CHIP}` },
    { label: "mark\uFFFC" },
    { label: "empty send", send: "  " },
    { label: "bad send", send: 7 },
    { label: "chip send", send: `a${CHIP}` },
    { label: "huge send", send: "\u00E9".repeat(PLUGIN_MARK_SEND_MAX_BYTES / 2 + 1) },
    { label: "bad detail", detail: 3 },
    { label: "long detail", detail: "d".repeat(PLUGIN_TRIGGER_DETAIL_MAX_CHARS + 1) },
    { label: "x".repeat(PLUGIN_MARK_LABEL_MAX_CHARS), send: "a\nb" },
  ]);
  assert.deepEqual(rows, [
    { label: "Plain", send: "Plain" },
    { label: "Sent", send: "Issue 7", detail: "open" },
    { label: "x".repeat(PLUGIN_MARK_LABEL_MAX_CHARS), send: "a\nb" },
  ]);
});

test("an answer is cut at the item cap, and no array is no answer", () => {
  const many = Array.from({ length: PLUGIN_TRIGGER_MAX_ITEMS + 5 }, (_, i) => ({ label: `#${i}` }));
  const rows = sanitizeTriggerItems([{ label: "" }, ...many]);
  assert.equal(rows.length, PLUGIN_TRIGGER_MAX_ITEMS);
  assert.equal(rows[0].label, "#0");
  assert.equal(sanitizeTriggerItems(undefined), null);
  assert.equal(sanitizeTriggerItems({ length: 1, 0: { label: "a" } }), null);
  assert.deepEqual(sanitizeTriggerItems([]), []);
});

function quietly(run) {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  return run().finally(() => {
    console.warn = warn;
  }).then((value) => ({ value, warnings }));
}

test("a provider is asked with the trigger and query, sync or async", async () => {
  const asked = [];
  const sync = await askPluginTrigger(
    (query) => {
      asked.push(query);
      return [{ label: "a" }];
    },
    { trigger: "#", query: "q", tokenStart: 0, tokenEnd: 2 },
    "demo.lab",
  );
  assert.deepEqual(asked, [{ trigger: "#", query: "q" }]);
  assert.deepEqual(sync, [{ label: "a", send: "a" }]);
  const later = await askPluginTrigger(
    async () => [{ label: "b", send: "B" }],
    { trigger: "#", query: "" },
    "demo.lab",
  );
  assert.deepEqual(later, [{ label: "b", send: "B" }]);
});

test("a throwing, rejecting, silent or malformed provider collapses to null and is logged", async () => {
  const match = { trigger: "#", query: "" };
  const cases = [
    () => {
      throw new Error("boom");
    },
    () => Promise.reject(new Error("nope")),
    () => new Promise(() => {}),
    () => ({ label: "not a list" }),
  ];
  for (const provider of cases) {
    const { value, warnings } = await quietly(() => askPluginTrigger(provider, match, "demo.lab", 20));
    assert.equal(value, null);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /demo\.lab composerTrigger failed/);
  }
});

test("an answer after the timeout is ignored", async () => {
  let answer;
  const { value } = await quietly(() =>
    askPluginTrigger(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      { trigger: "#", query: "" },
      "demo.lab",
      10,
    ),
  );
  assert.equal(value, null);
  answer([{ label: "late" }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("a trigger is told the draft's session and context use, when the host knows them", async () => {
  assert.deepEqual(pluginTriggerScope("s-1", { usedTokens: 1200.4, contextWindow: 200000 }), {
    sessionId: "s-1",
    context: { usedTokens: 1200, contextWindow: 200000 },
  });
  // A draft without a session, or before its first answered turn, says less.
  assert.deepEqual(pluginTriggerScope("", null), {});
  assert.deepEqual(pluginTriggerScope(null, { usedTokens: 5, contextWindow: 100 }), {
    context: { usedTokens: 5, contextWindow: 100 },
  });
  // Figures the ring could not show are not reported.
  for (const bad of [
    { usedTokens: 5, contextWindow: 0 },
    { usedTokens: -1, contextWindow: 100 },
    { usedTokens: Number.NaN, contextWindow: 100 },
  ]) {
    assert.deepEqual(pluginTriggerScope("s-1", bad), { sessionId: "s-1" });
  }

  const asked = [];
  await askPluginTrigger(
    (query) => {
      asked.push(query);
      return [];
    },
    { trigger: "@", query: "al", tokenStart: 0, tokenEnd: 3 },
    "demo.lab",
    undefined,
    pluginTriggerScope("s-1", { usedTokens: 10, contextWindow: 100 }),
  );
  assert.deepEqual(asked, [
    { trigger: "@", query: "al", sessionId: "s-1", context: { usedTokens: 10, contextWindow: 100 } },
  ]);
});

test("the composer tells triggers its session and the context ring's figures", async () => {
  const { readComposerSource } = await import("./helpers/composer-source.mjs");
  const source = await readComposerSource();
  assert.match(source, /usedTokens: contextOccupancyTokens\(composerContextUsage\.usage\)/);
  assert.match(source, /contextWindow: composerContextUsage\.contextWindow/);
  assert.match(source, /triggerContext: composerTriggerContext/);
  assert.match(source, /pluginTriggerScope\(referenceSessionId, triggerContext\)/);
  assert.match(source, /askPluginTrigger\(entry\.items, match, entry\.pluginId, undefined, scopeRef\.current\)/);
});
