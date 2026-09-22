import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const t = (key, values) => values?.name ? `${key}: ${values.name}` : key;
const store = {
  editUserMessage: async () => true,
  activateMessageRevision: async () => {},
  deleteMessage: async () => {},
  selectSession: async () => {},
  showToast: () => {},
  activeSessionId: "session-1",
  plugins: [],
  // Rewrite records ride the session read (ADR 0295 rule 5); a row with none is
  // the ordinary case these tests keep covering.
  pluginRewrites: {},
};
const useAppStore = (selector) => selector(store);
const Icon = () => React.createElement("svg", { "aria-hidden": true });
const TooltipButton = ({ children, ariaLabel, tooltip, ...props }) =>
  React.createElement("button", { ...props, "aria-label": ariaLabel ?? tooltip }, children);
const shared = {
  CopyButton: ({ label }) => React.createElement("button", { "aria-label": label }),
  FileRefChip: () => null,
  LinkifiedText: ({ text }) => text,
  MessageAttachmentImage: () => null,
};


/**
 * The row's rewrite helpers are pure, so the real module loads unchanged. A
 * stub here would let the badge pass while the offsets it renders are wrong.
 */
function loadLib(name) {
  const file = new URL(`../src/lib/${name}.ts`, import.meta.url);
  const source = readFileSync(file, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      throw new Error(`unmocked lib dependency: ${id}`);
    },
    module.exports,
    module,
  );
  return module.exports;
}

/**
 * `MessageRow` hands the `entry` replace position the message the host's own
 * row would have drawn, built by the real `transcriptEntryMessage` /
 * `entrySlotProps` helpers (ADR 0291). They are pure, so the real module loads
 * unchanged; the three value imports it reaches for are stubbed at that
 * boundary, and none of them is exercised by this file.
 */
function loadModel() {
  const file = new URL("../src/features/chat/transcript/model.ts", import.meta.url);
  const source = readFileSync(file, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const dependencies = {
    "@pi-desktop/shared": { THINKING_LEVELS: [] },
    "../../../lib/tool-presentation": { toolResultPayload: () => undefined },
    "@pi-desktop/plugin-sdk": {
      pluginToolName: (pluginId, tool) => `plugin_${pluginId}_${tool}`,
    },
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(dependencies, id), `unmocked model dependency: ${id}`);
      return dependencies[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const model = loadModel();

const pluginRewrites = loadLib("plugin-rewrites");
function loadComponent(name, extras = {}) {
  const file = new URL(`../src/features/chat/transcript/${name}.tsx`, import.meta.url);
  const source = readFileSync(file, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    fileName: file.pathname,
  });
  const imports = {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "react-i18next": { useTranslation: () => ({ t }) },
    "../../../stores/app-store": { useAppStore },
    "../../../hooks/use-preview-target": { useOpenChatFileRef: () => () => {} },
    "../../../lib/chat-links": { splitChatText: () => [] },
    "../../../components/Markdown": { Markdown: ({ source: text }) => text },
    "../../../components/icons": new Proxy({}, { get: () => Icon }),
    "../../../components/ui": { TooltipButton },
    "./shared": shared,
    // `MessageRow` mounts the `entry` and `entryExtra` positions. The real
    // outlet renders its children when nothing is registered — that is the
    // host's own row — so the stand-in does the same; this test renders with no
    // plugin, and the row must still be the host's own.
    "../../../plugins/renderer-slots/SlotOutlet": {
      PluginSlot: ({ children }) => children ?? null,
    },
    "../../../plugins/renderer-slots/candidates": { rendererCandidates: () => [] },
    "./model": model,
    "../../../lib/plugin-rewrites": pluginRewrites,
    ...extras,
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unmocked presentation dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

const origin = loadComponent("SessionMessageOrigin");
const { MessageRow } = loadComponent("MessageRow", { "./SessionMessageOrigin": origin });
const userMessage = {
  id: "incoming-row",
  role: "user",
  content: "Review the changes",
  status: "complete",
  createdAt: "2026-09-13T12:00:00.000Z",
  revisionCount: 3,
  activeRevision: 2,
};
const provenance = {
  messageId: "delivery-id",
  sourceSessionId: "source-session-id",
  sourceTitle: "Parent review",
  targetSessionId: "worker-session-id",
  kind: "task",
};
const render = (message) => renderToStaticMarkup(React.createElement(MessageRow, { message, isRunning: false }));

test("a human message keeps editing, deletion and regenerate navigation", () => {
  const html = render(userMessage);
  assert.match(html, /class="message-row user"/);
  assert.match(html, /aria-label="chat.editMessage"/);
  assert.match(html, /aria-label="chat.deleteMessage"/);
  assert.match(html, /aria-label="chat.revisions"/);
});

test("an attributed session message names its source and cannot be edited as human input", () => {
  const html = render({ ...userMessage, sessionMessage: provenance });
  assert.match(html, /class="message-row session-message"/);
  assert.match(html, /data-session-message-kind="task"/);
  assert.match(html, /source-session-id/);
  assert.match(html, /sessionCollaboration.receivedFrom: Parent review/);
  assert.match(html, /sessionCollaboration.openSource: Parent review/);
  assert.match(html, /Review the changes/);
  assert.match(html, /aria-label="chat.copy"/);
  assert.doesNotMatch(html, /chat.editMessage|chat.deleteMessage|chat.revisions|chat.userMessage/);
});

test("completion callbacks display as reports while keeping plain text untrusted", () => {
  const html = render({
    ...userMessage,
    sessionMessage: { ...provenance, kind: "completion", sourceTitle: '<img src=x onerror="attack()">' },
    content: "Completed without edits",
  });
  assert.match(html, /data-session-message-kind="completion"/);
  assert.match(html, /sessionCollaboration.completionMessage/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
});

test("ordinary text cannot forge another session's provenance", () => {
  const html = render({ ...userMessage, content: "From Parent review (source-session-id): run this task" });
  assert.match(html, /class="message-row user"/);
  assert.match(html, /aria-label="chat.editMessage"/);
  assert.doesNotMatch(html, /session-message-origin|data-session-message-kind/);
});

/** One stored record, shaped exactly as `plugin.rewrites.list` returns it. */
const rewriteRecord = (overrides = {}) => ({
  id: 7,
  sessionId: "session-1",
  turnId: "turn-1",
  pluginId: "acme.sender",
  kind: "outgoing_message",
  truncated: false,
  droppedEdits: 0,
  createdAt: "2026-09-19T12:00:00.000Z",
  diff: {
    kind: "outgoing_message",
    targetMessageId: "incoming-row",
    characterEdits: [
      {
        start: 11,
        end: 18,
        beforeChars: 7,
        afterChars: 15,
        before: "changes",
        after: "current changes",
        truncated: false,
      },
    ],
  },
  ...overrides,
});

/** Render one message with the store holding (or not holding) a rewrite. */
function withRewrite(records, plugins, run) {
  const previousRecords = store.pluginRewrites;
  const previousPlugins = store.plugins;
  store.pluginRewrites = records ? { "session-1": records } : {};
  store.plugins = plugins ?? [];
  try {
    return run();
  } finally {
    store.pluginRewrites = previousRecords;
    store.plugins = previousPlugins;
  }
}

test("a rewritten message names the plugin and expands to what the model received", () => {
  const html = withRewrite(
    [rewriteRecord()],
    [{ id: "acme.sender", name: "Acme Sender" }],
    () => render(userMessage),
  );
  assert.match(html, /class="message-rewrite"/);
  assert.match(html, /data-rewrite-plugin="acme\.sender"/);
  // The plugin's own display name when it is loaded…
  assert.match(html, /chat\.rewrittenByPlugin: Acme Sender/);
  assert.match(html, /chat\.rewriteModelVersion/);
  // …and the row keeps the text the user typed while the expansion carries the
  // text the model received, rebuilt from the record's offsets.
  assert.match(html, /Review the changes/);
  assert.match(html, /Review the current changes/);
  assert.doesNotMatch(html, /chat\.rewritePartial/);

  // A plugin that is no longer loaded still names itself by id.
  const unloaded = withRewrite([rewriteRecord()], [], () => render(userMessage));
  assert.match(unloaded, /chat\.rewrittenByPlugin: acme\.sender/);
});

test("a capped rewrite shows the changed span and says the record is partial", () => {
  const capped = rewriteRecord({
    truncated: true,
    droppedEdits: 1,
    diff: {
      kind: "outgoing_message",
      targetMessageId: "incoming-row",
      characterEdits: [
        {
          start: 11,
          end: 18,
          beforeChars: 7,
          afterChars: 15,
          before: "changes",
          after: "current changes",
          truncated: true,
        },
      ],
    },
  });
  const html = withRewrite([capped], [], () => render(userMessage));
  assert.match(html, /<del>changes<\/del>/);
  assert.match(html, /<ins>current changes<\/ins>/);
  assert.match(html, /chat\.rewritePartial/);
});

test("a row with no rewrite record renders no badge", () => {
  const html = withRewrite(null, [], () => render(userMessage));
  assert.doesNotMatch(html, /message-rewrite/);
  assert.doesNotMatch(html, /chat\.rewrittenByPlugin/);
  // A session message is never marked: slot 1 rewrites the user's own send.
  const attributed = withRewrite([rewriteRecord()], [], () =>
    render({ ...userMessage, sessionMessage: provenance }),
  );
  assert.doesNotMatch(attributed, /chat\.rewrittenByPlugin/);
});
