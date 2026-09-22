#!/usr/bin/env node
/**
 * The plugin showcase, in a real Electron window (spec 07-plugins/16 §2A and
 * §6, ADRs 0291/0294/0295).
 *
 * `scripts/e2e-plugin-slots.mjs` proves the *contract* of the trusted renderer
 * host: the scheme, the import map, the action channel. This suite proves the
 * *slots*: it loads `examples/plugins/plugin-showcase` into the built app with a
 * throwaway profile and walks every position that plugin registers, so "the
 * slots work" stops resting on unit and SSR tests.
 *
 * What each check drives, and where the fact it asserts comes from:
 *
 * - `entry` / `entryExtra` — a seeded user message row carries the plugin's
 *   whole-message card and the badge below it, and both name the entry id the
 *   host handed over. The card is also read for the message the host handed it:
 *   the user's own text has to stay readable in the transcript, drawn by the
 *   plugin's card, with the card's own controls beside that text. That is the
 *   regression check for a replace position that hid the row it replaced.
 * - `codeBlock` — a seeded assistant message contains a closed fence in
 *   `acme.plugin-showcase:kv`; the block is drawn as the plugin's rows.
 * - `toolCard` — a seeded tool row for the plugin's own forced tool name
 *   (`plugin_<id>_showcase_note`) gets the plugin's card, and a seeded host
 *   tool row (`Read`) does not.
 * - `composerControl` / `completionSource` / `composerReference` — the
 *   composer's left and right control rows, the completion popover opened by
 *   typing `/showcase`, and the plugin's chip after a reference is attached
 *   through the host's own `@` completion. The `beforeSend` region is checked
 *   as the handover it is: it is the element immediately before the send
 *   button, the host's own model picker and context display are on screen
 *   *inside* it (each exactly once in the window, so no second host copy is
 *   drawn), the plugin's own controls sit beside them, and the cycle button
 *   really changes the order of the three pieces while keeping all of them.
 * - `inlineConfirm` — a permission request is raised by a *real* agent turn
 *   served by a local OpenAI-compatible SSE stub, and the plugin's card takes
 *   the position while that request is pending; closing it brings the host's
 *   permission card back.
 * - `modal` / `overlay` — the plugin's own composer controls open each layer,
 *   the layer is on screen with its container attributes, Escape dismisses it
 *   (the host's dismissal) and the plugin's own button withdraws it.
 * - the injected sheet and the token surface — the sheet the plugin injected is
 *   read back out of the live document: it carries the scoped marker, every
 *   selector in it is rewritten under the plugin's own container, and the
 *   public `--pi-slot-*` aliases resolve on a mounted container rather than only
 *   being declared in a file.
 * - the replace-slot claim — a second dev plugin, written into this run's temp
 *   root and installed through the same `plugins.loadDev` path, asks for
 *   `modal` while the showcase holds it. The refusal is read off the fixture's
 *   own button while the window still carries one layer with one claim owner.
 * - the draft a plugin is handed — the fixture's own composer control publishes
 *   the `{ draft, sessionId }` a mounted position is given, the suite types into
 *   the composer, and the plugin's copy has to follow; then the fixture writes a
 *   whole draft through `composer.replaceDraft`, which only resolves once the
 *   mounted composer consumed it, and reads the result back through
 *   `composer.readDraft`. Both names are in host-core's `rendererActions`
 *   vocabulary and in the SDK's, so the read's snapshot is asserted, not merely
 *   reported.
 * - the docked console view — the manifest's `views[]` entry is listed by the
 *   host's own work-panel launcher and opened through it, and the page it
 *   renders is read over its own CDP target: the inventory the page publishes as
 *   `data-pi-console-*` (ten slots, ten actions, eight data keys, eleven runtime
 *   slots), the receipt the "omit the model key" control writes (code `ok`), the
 *   one the unresolvable model key writes, and a runtime receipt
 *   (`data-pi-console-surface="运行时"`) once the turn has run.
 * - the agent half — the tool gate refuses the dangerous shell call the model
 *   itself emitted: the call is in the transcript as a failed command row, and
 *   the plugin's reason reaches the model's next request and the user's own
 *   warning. The transcript body of a run row carries stdout/stderr only, so
 *   the reason is deliberately not drawn there (`lib/tool-presentation.ts`,
 *   "run" branch). The turn watch status line counts what the plugin saw while
 *   the turn ran, and the turn facts summary is emitted when the run ends. All
 *   of it comes out of the sidecar running the plugin's `agent/extension.js`
 *   inside the app.
 *
 * Prerequisites: `pnpm build:js` and the built desktop app plus a host-core
 * binary (target/debug, target/release, or PI_DESKTOP_HOST_BIN). The model
 * traffic in the turn is a loopback stub owned by this script; nothing leaves
 * the machine, no user profile is touched, and the temp profile is removed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createConnectionServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOWCASE_PLUGIN = join(root, "examples/plugins/plugin-showcase");
const SDK_INDEX = join(root, "packages/plugin-sdk/dist/index.js");

/** The plugin under test, and the entry points its manifest declares. */
const PLUGIN_ID = "acme.plugin-showcase";
const CODE_LANGUAGE = `${PLUGIN_ID}:kv`;
/** The fenced source the seeded assistant message carries. */
const FENCE = ["```" + CODE_LANGUAGE, "covered = 42", "disk! = 91% used", "```"].join("\n");
const MOCK_MODEL = "showcase-e2e-model";
/**
 * The text of the seeded user message. It is the one string the entry slot's
 * regression check reads back out of the plugin's own card: a replace position
 * that stopped re-drawing the message it was handed would leave the user's own
 * words unreadable, which is the defect this suite pins.
 */
const USER_MESSAGE_TEXT = "Showcase slot journey";
/** The status line the plugin's own `tool_execution_end` handler writes. */
const STATUS_TOOL_COUNT = /Plugin Showcase · turn \d+ · \d+ tool call\(s\) seen/;

/**
 * The second dev plugin this suite installs. `examples/plugins/plugin-showcase`
 * deliberately keeps its layers behind its own controls, so no example plugin
 * can be the second claim on a replace slot; the fixture is written into this
 * run's temp root instead, which also keeps the repository free of a plugin
 * that exists only for this suite.
 */
const RACE_PLUGIN_ID = "acme.slot-race-fixture";
const SHOWCASE_CONTAINER = `[data-pi-plugin="${PLUGIN_ID}"]`;
const RACE_CONTAINER = `[data-pi-plugin="${RACE_PLUGIN_ID}"]`;
/** The draft text the fixture writes through `composer.replaceDraft`. */
const RACE_DRAFT_TEXT = "draft written by the slot-race fixture";
/** The draft the suite types into the composer itself, for the slot-prop read. */
const TYPED_DRAFT_TEXT = "typed by the user: slot race";

const results = [];
function record(id, ok, detail = "") {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
}

/** Poll a predicate until it answers truthy, like the other E2E runners. */
async function waitFor(predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

/** A loopback port, so a stray listener never collides with this run. */
async function freePort() {
  const server = createConnectionServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** The pages a running Electron advertises, or an empty list while it boots. */
async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2_000),
  });
  return response.json();
}

/** One CDP websocket, request ids, and the page console for failure details. */
class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.console = [];
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (
        message.method === "Runtime.consoleAPICalled" ||
        message.method === "Runtime.exceptionThrown"
      ) {
        this.console.push(`[${message.method}] ${JSON.stringify(message.params).slice(0, 300)}`);
        if (this.console.length > 40) this.console.shift();
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onerror = () => reject(new Error(`CDP websocket failed: ${url}`));
      ws.onopen = () => resolve(new CdpClient(ws));
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          JSON.stringify(result.exceptionDetails),
      );
    }
    return result.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // A socket that is already gone needs no closing.
    }
  }
}

/** Stop the app and everything it spawned, including its host-core sidecar. */
async function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The close event below is the authoritative signal either way.
      }
    }
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * A loopback OpenAI-compatible endpoint for one agent turn.
 *
 * The response is chosen from what the request already carries, not from a
 * call counter, so the turn cannot get out of step with the harness:
 *
 * 1. no plugin refusal in the history yet → a `Bash` call for a command the
 *    plugin's tool gate refuses (`git reset --hard`);
 * 2. the refusal is in the history, but the benign command is not → a second
 *    `Bash` call that passes the gate and therefore reaches the host's
 *    approval path, which is what leaves a permission request pending long
 *    enough for the `inlineConfirm` slot to be driven;
 * 3. both are → a plain answer, which ends the run and fires `agent_end`.
 *
 * Every request is recorded, so the checks can also assert that the plugin's
 * own refusal sentence reached the model rather than only the window.
 */
function createModelStub() {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      payload = {};
    }
    requests.push(payload);
    const history = JSON.stringify(payload.messages ?? []);
    const sawRefusal = history.includes("Plugin Showcase refused");
    const sawBenign = history.includes("plugin-showcase-e2e");
    const base = {
      id: `chatcmpl-${requests.length}`,
      object: "chat.completion.chunk",
      created: 1,
      model: payload.model ?? MOCK_MODEL,
    };
    const write = (delta, finish, usage) =>
      res.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage ? { usage } : {}),
        })}\n\n`,
      );
    // The agent's own turn always carries tools; the plugin's own
    // `pi.ai.complete` never does. That is the switch between the scripted turn
    // below and a plain completion, so the console's AI controls get a real
    // answer (streaming or not) instead of the turn's scripted tool call.
    const looksLikeAgentTurn = Array.isArray(payload.tools) && payload.tools.length > 0;
    if (!looksLikeAgentTurn) {
      const reply = "Plugin showcase stub completion.";
      if (payload.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        write({ role: "assistant", content: reply }, null);
        write({}, "stop", { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${requests.length}`,
          object: "chat.completion",
          created: 1,
          model: payload.model ?? MOCK_MODEL,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: reply },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    if (!sawRefusal) {
      write(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${requests.length}_blocked`,
              type: "function",
              function: {
                name: "Bash",
                arguments: JSON.stringify({ command: "git reset --hard HEAD~1" }),
              },
            },
          ],
        },
        null,
      );
      write({}, "tool_calls", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    } else if (!sawBenign) {
      write(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${requests.length}_approval`,
              type: "function",
              function: {
                name: "Bash",
                arguments: JSON.stringify({ command: "echo plugin-showcase-e2e" }),
              },
            },
          ],
        },
        null,
      );
      write({}, "tool_calls", { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
    } else {
      write({ role: "assistant", content: "Showcase turn finished." }, null);
      write({}, "stop", { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 });
    }
    res.end("data: [DONE]\n\n");
  });
  return {
    requests,
    listen: () =>
      new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * The headless half of the fixture. It contributes nothing: the fixture exists
 * for its renderer half, and a `main` entry is only what makes the package an
 * ordinary plugin the host's own manifest reader accepts.
 */
const RACE_MAIN = `/**
 * Headless half of the slot-race fixture: it contributes nothing.
 *
 * The renderer half is the whole point of this fixture, and declaring an entry
 * is what the host requires of a plugin package; this is the cheapest one. The
 * plugin process it starts registers no command, tool, or provider.
 */
async function onLoad() {}

module.exports = { onLoad };
`;

/**
 * The renderer half of the fixture, written into this run's temp root and served
 * over "plugin-renderer://" exactly like the showcase's entry. It is a plain ES
 * module with no build step.
 *
 * It registers one slot, "composerControl", and does the two things the showcase
 * cannot: it asks for the "modal" position while the showcase holds it, and it
 * asks the host to read and write the composer draft. Every answer — the
 * refusal, the draft snapshot, the write receipt — is written onto the button as
 * an attribute, so what the suite asserts is what the plugin really observed.
 *
 * Deliberately no backticks and no template interpolation in this source: it
 * lives inside a template literal.
 */
const RACE_RENDERER = `import { createElement, useState } from "react";

const PLUGIN_ID = ${JSON.stringify(RACE_PLUGIN_ID)};
const DRAFT_TEXT = ${JSON.stringify(RACE_DRAFT_TEXT)};

/** The pi object onLoad was handed: only that object may register a slot. */
let hostApi = null;

/** What the fixture would draw if its claim on the modal position were granted. */
function ModalProbe() {
  return createElement(
    "div",
    { "data-pi-fixture-modal": "modal" },
    PLUGIN_ID + " modal probe: this plugin holds the modal claim",
  );
}

function RaceControl({ position, draft, sessionId, dispatch }) {
  const [claim, setClaim] = useState("");
  const [read, setRead] = useState("");
  const [readOutcome, setReadOutcome] = useState("");
  const [write, setWrite] = useState("");

  const claimModal = () => {
    setClaim("asking");
    try {
      const handle = hostApi ? hostApi.slots.register("modal", ModalProbe) : null;
      setClaim(handle ? "granted" : "refused");
    } catch (error) {
      // The host refuses a registration with a coded error rather than a null
      // handle, so the code itself is the answer this fixture publishes: a
      // replace position somebody else holds is PLUGIN_SLOT_DUPLICATE.
      setClaim((error && error.code) || String(error));
    }
  };

  const readDraft = () => {
    setReadOutcome("asking");
    dispatch("composer.readDraft", {})
      .then((answer) => {
        setRead(JSON.stringify(answer));
        setReadOutcome("ok");
      })
      .catch((error) => {
        setRead("");
        setReadOutcome("refused:" + ((error && error.code) || String(error)));
      });
  };

  const writeDraft = () => {
    dispatch("composer.replaceDraft", { text: DRAFT_TEXT })
      .then((answer) => {
        setWrite(
          JSON.stringify({
            ok: Boolean(answer && answer.ok),
            generation: answer ? answer.generation : null,
            previous: answer && answer.previous ? answer.previous : null,
          }),
        );
      })
      .catch((error) => {
        setWrite(JSON.stringify({ ok: false, code: (error && error.code) || String(error) }));
      });
  };

  if (position === "right") {
    return createElement(
      "button",
      {
        type: "button",
        "data-pi-fixture-trigger": "claimModal",
        "data-pi-fixture-claim": claim,
        onClick: claimModal,
      },
      "Fixture: claim the modal position",
    );
  }
  if (position !== "left") return null;
  // The two slot-contract props are published on the wrapper, so the suite can
  // read the live draft the composer handed this plugin without asking the host
  // for anything: this is what a mounted position really receives.
  const draftProp = typeof draft === "string" ? draft : "";
  return createElement(
    "span",
    {
      className: "pi-slot-chip",
      "data-pi-fixture-draft-prop": draftProp,
      "data-pi-fixture-session": typeof sessionId === "string" ? sessionId : "",
    },
    [
      createElement(
        "button",
        {
          key: "read",
          type: "button",
          "data-pi-fixture-trigger": "readDraft",
          "data-pi-fixture-draft": read,
          "data-pi-fixture-read-outcome": readOutcome,
          onClick: readDraft,
        },
        "Fixture: read the draft",
      ),
      createElement(
        "button",
        {
          key: "write",
          type: "button",
          "data-pi-fixture-trigger": "writeDraft",
          "data-pi-fixture-write": write,
          onClick: writeDraft,
        },
        "Fixture: write a draft",
      ),
    ],
  );
}

export function onLoad(pi) {
  hostApi = pi;
  pi.slots.register("composerControl", RaceControl);
}
`;

/**
 * Write the fixture plugin into this run's temp root.
 *
 * It declares `renderer.extension` — the one permission the whole renderer tier
 * needs — and nothing else, plus the two host actions it dispatches: the relay
 * refuses an undeclared action before the host's own handler is reached, so a
 * missing entry here would look like a broken action channel.
 */
function writeSlotRaceFixture(dir) {
  mkdirSync(join(dir, "renderer"), { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: RACE_PLUGIN_ID,
        name: "Slot race fixture",
        version: "0.0.1",
        description:
          "E2E fixture: claims the modal position against the showcase and reads and writes the composer draft through the host's own actions",
        main: "main.js",
        renderer: "renderer/index.mjs",
        rendererData: ["draft"],
    // The fixture declares both halves of the draft contract it exercises:
    // `composer.replaceDraft` and `composer.readDraft` are both in host-core's
    // `rendererActions` vocabulary and in the SDK's.
    rendererActions: ["composer.replaceDraft", "composer.readDraft"],
        permissions: ["renderer.extension"],
        engines: { piDesktop: ">=0.1.0" },
        activationEvents: ["onStartup"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "main.js"), RACE_MAIN);
  writeFileSync(join(dir, "renderer/index.mjs"), RACE_RENDERER);
}

const RUNTIME_PROBE_TIMEOUT = 30_000;

/**
 * Everything the checks read, gathered from the live window. Each helper is a
 * plain DOM read: nothing here knows a plugin id it was not handed, and every
 * value is read out of the rendered result rather than recomputed in Node.
 */
const PROBE_HELPERS = `
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const text = (node) => (node ? (node.textContent ?? "").trim() : null);
const has = (selector) => Boolean($(selector));
const waitFor = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
};
const pluginSlot = (id, slot) =>
  $( '[data-pi-plugin="' + id + '"][data-pi-plugin-slot="' + slot + '"]');
const showcaseCard = (slot) => $('[data-pi-showcase-slot="' + slot + '"]');
const showcaseTrigger = (name) =>
  $('[data-pi-showcase-trigger="' + name + '"]');
const composerInput = () => $('.composer-input');
// The input surface that owns the editor, so a chip probe never reads a chip
// some other composer painted.
const composerStage = () => composerInput()?.closest('.composer-input-stage') ?? null;
// Type into the composer the way the browser does: select the editable's
// contents and let Chromium replace them, which is what produces a real input
// event the host's own handler reads. Clearing the draft by assigning
// textContent instead leaves the editable with no child node at all, and
// Chromium's insertText then inserts nothing: the next draft never reaches
// the host,
// which is exactly how an "@README" probe can look like "the popover never
// opened". The direct fallback is for a renderer that refuses the command.
const setDraft = (value) => {
  const editor = composerInput();
  if (!editor) return false;
  editor.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  const inserted = document.execCommand('insertText', false, value);
  if (!inserted || (editor.textContent ?? '') !== value) {
    editor.textContent = value;
    if (!editor.firstChild) editor.appendChild(document.createTextNode(''));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
  return (editor.textContent ?? '') === value;
};
const pressKey = (key) => {
  const editor = composerInput();
  if (!editor) return false;
  editor.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
  return true;
};
/** The draft the composer's own editor module reads back. */
const readDraft = () => {
  const editor = composerInput();
  return editor ? editor.textContent : null;
};
/** Everything the completion probes need to explain a popover that never opened. */
const composerState = () => ({
  draft: readDraft(),
  focused: document.activeElement === composerInput(),
  activeElement: document.activeElement?.className ?? null,
  popover: Boolean($('.composer-autocomplete')),
  popoverText: text($('.composer-autocomplete')),
  completionSlot: Boolean(
    $('[data-pi-plugin="${PLUGIN_ID}"][data-pi-plugin-slot="completionSource"]'),
  ),
});
/** Every button in the transcript that can be expanded, expanded. */
const expandTranscript = () => {
  let clicked = 0;
  for (const button of $$('.thread-scroll [aria-expanded="false"]')) {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    clicked += 1;
  }
  return clicked;
};
const transcriptText = () => {
  const scroll = $('.thread-scroll');
  return scroll ? (scroll.innerText ?? '').replace(/\\s+/g, ' ').trim() : null;
};
const toasts = () =>
  $$('.toast').map((toast) => (toast.textContent ?? '').replace(/\\s+/g, ' ').trim());
const statusLine = () =>
  $$('.extension-status-item').map((item) => (item.textContent ?? '').replace(/\\s+/g, ' ').trim());
`;

/**
 * Launch the built app with a throwaway profile, seed one session whose rows
 * exercise every transcript position, load the showcase plugin through the
 * host's own `plugins.loadDev`, and then drive the live window.
 */
async function runJourney() {
  const { Host, resolveHostBinary } = await import("./e2e/host.mjs");
  const { assertDesktopBuild, resolveElectronBinary } = await import("./e2e/boot.mjs");
  const sdk = await import(pathToFileURL(SDK_INDEX).href);
  // The forced tool name is read from the SDK, not repeated here: renaming the
  // prefix can never leave this suite seeding a row the host does not own.
  const PLUGIN_TOOL = sdk.pluginToolName(PLUGIN_ID, "showcase_note");
  const { appDir, electronBinary } = resolveElectronBinary(root);
  assertDesktopBuild(root);
  const hostBinary = resolveHostBinary();

  const runRoot = mkdtempSync(join(tmpdir(), "pi-showcase-slots-"));
  const dataDir = join(runRoot, "data");
  const profileDir = join(runRoot, "profile");
  const projectDir = join(runRoot, "project");
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  // The test-only auto consent marker lives in the data directory this run
  // starts the app with (spec 07-plugins/04 §6.2.1). The benign `echo` call the
  // model makes raises a real permission request; answering it consumes this
  // marker and produces the same "allow once" decision a click does, instead of
  // a native dialog no automated run can click. A run without the marker
  // behaves exactly as before, and a packaged build ignores it.
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "e2e-auto-consent"), `${PLUGIN_ID}\n`);
  // One workspace file, so the composer's own `@` completion has something to
  // attach and the `composerReference` position has a host chip to follow.
  writeFileSync(join(projectDir, "README.md"), "# Showcase e2e project\n");
  // The second dev plugin this suite installs, written here so the run owns
  // every file it loads. It is a real plugin package: manifest, headless entry,
  // renderer entry. Installed below through the same `plugins.loadDev` call the
  // showcase uses.
  const racePluginDir = join(runRoot, "fixtures", RACE_PLUGIN_ID);
  writeSlotRaceFixture(racePluginDir);

  const stub = createModelStub();
  const modelPort = await stub.listen();
  const cdpPort = await freePort();
  let child = null;
  let client = null;
  // The docked console view is a second page in the same app, so the console
  // checks attach their own CDP client to it and close it with the first.
  let consoleClient = null;
  const output = [];
  const capture = (chunk) => output.push(String(chunk));
  const describe = (error) =>
    `${error instanceof Error ? error.message : String(error)}\n` +
    `--- renderer console ---\n${(client?.console ?? []).join("\n")}\n` +
    `--- app output (tail) ---\n${output.join("").slice(-2_000)}`;

/** A compact picture of the window, attached to a failed journey. */
async function windowSnapshot(client) {
  if (!client) return "no CDP client";
  try {
    return await client.evaluate(`JSON.stringify({
      url: location.href,
      mainPane: Boolean(document.querySelector('.main-pane')),
      messageRows: document.querySelectorAll('.message-row').length,
      toolRows: document.querySelectorAll('.tool-row').length,
      composer: Boolean(document.querySelector('.composer-input')),
      pluginContainers: Array.from(document.querySelectorAll('[data-pi-plugin]'))
        .map((node) => node.getAttribute('data-pi-plugin') + ':' + node.getAttribute('data-pi-plugin-slot'))
        .slice(0, 24),
      bodyText: (document.body.innerText || '').slice(0, 600),
    })`);
  } catch (error) {
    return `window snapshot failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

  // Assigned from the host's own `session.create` answer below: the host mints
  // the id, so a locally invented one would point `selectSession` at nothing.
  let sessionId = randomUUID();
  const userMessageId = randomUUID();
  const fenceMessageId = randomUUID();
  const pluginToolMessageId = randomUUID();
  const hostToolMessageId = randomUUID();

  try {
    // ── Seed through the host protocol, then let the seeding host exit ──────
    const host = new Host(hostBinary, dataDir);
    await host.start();
    try {
      await host.call("workspace.set", { path: projectDir });
      const provider = await host.call("providers.create", {
        name: "Showcase E2E Stub",
        vendorKey: "custom",
        type: "openai_compatible",
        protocol: "openai_compatible",
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        authKind: "none",
        apiStyle: "chat_completions",
        defaultModelId: MOCK_MODEL,
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
      });
      const created = await host.call("session.create", {
        title: "Showcase slot journey",
        mode: "agent",
        providerId: provider.provider.id,
        modelId: MOCK_MODEL,
        projectPath: projectDir,
      });
      sessionId = created.session.id;
      const append = (message) =>
        host.call("session.appendMessage", { sessionId, message });
      await append({
        id: userMessageId,
        role: "user",
        content: USER_MESSAGE_TEXT,
        status: "complete",
        createdAt: new Date().toISOString(),
      });
      // The fence the plugin claims, in a closed block: the host hands a
      // component only a closed, in-limit block (code-blocks.ts). It carries
      // usage so the composer's own context display is on screen from the
      // start — that display is one of the pieces the region hands over, so a
      // probe of the region would otherwise be waiting on a turn.
      await append({
        id: fenceMessageId,
        role: "assistant",
        content: `Here is the block:\n\n${FENCE}\n`,
        modelId: MOCK_MODEL,
        status: "complete",
        usage: { inputTokens: 4_000, outputTokens: 200, totalTokens: 4_200 },
        createdAt: new Date().toISOString(),
      });
      // The plugin's own tool row, under the forced name the host derives, and
      // one host tool row that must never be offered the same position.
      await append({
        id: pluginToolMessageId,
        role: "tool",
        content: "",
        toolName: PLUGIN_TOOL,
        toolCallId: `call-${pluginToolMessageId}`,
        toolStatus: "success",
        toolArgs: { text: "hello" },
        toolResult: { ok: true, content: { text: "hello" } },
        createdAt: new Date().toISOString(),
      });
      await append({
        id: hostToolMessageId,
        role: "tool",
        content: "",
        toolName: "Read",
        toolCallId: `call-${hostToolMessageId}`,
        toolStatus: "success",
        toolArgs: { path: "README.md" },
        toolResult: { ok: true, content: "# Showcase e2e project\n" },
        createdAt: new Date().toISOString(),
      });
      // A development load enables the plugin with the permissions its manifest
      // declares, which is what makes it a renderer candidate and an agent
      // extension at once.
      await host.call("plugins.loadDev", { path: SHOWCASE_PLUGIN });
      // The fixture loads the same way. It is installed after the showcase so a
      // reader can see the order; the replace-slot claim it races for is decided
      // at request time, not here.
      await host.call("plugins.loadDev", { path: racePluginDir });
    } finally {
      await host.stop();
    }

    child = spawn(
      electronBinary,
      [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, "."],
      {
        cwd: appDir,
        env: {
          ...process.env,
          PI_DESKTOP_DATA_DIR: dataDir,
          PI_DESKTOP_HOST_BIN: hostBinary,
          PI_DESKTOP_START_MAXIMIZED: "0",
          ELECTRON_RENDERER_URL: "",
        },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    const target = await waitFor(
      async () => {
        const targets = await listTargets(cdpPort).catch(() => []);
        return targets.find(
          (candidate) =>
            candidate.type === "page" &&
            candidate.webSocketDebuggerUrl &&
            candidate.url.includes("out/renderer/index.html") &&
            !candidate.url.includes("surface="),
        );
      },
      "main window CDP target",
      90_000,
    );
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.send("Runtime.enable");
    await waitFor(() => client.evaluate(`!!document.querySelector(".main-pane")`), "app shell");
    await waitFor(
      () => client.evaluate(`!document.querySelector(".startup-splash")`),
      "startup splash cleared",
    );
    // The project is persisted in the shared data dir, but a fresh profile can
    // still come up with no workspace: binding it here is what the sidebar's
    // own "open folder" does, and the `@` completion needs it.
    await client.evaluate(
      `(async () => {
        const bridge = window.piDesktop;
        const current = await bridge.invoke(bridge.channels.invoke.projectGet);
        if (!current?.workspace?.path) {
          await bridge.invoke(bridge.channels.invoke.projectSet, ${JSON.stringify(projectDir)});
        }
        return true;
      })()`,
    );
    await client.evaluate(
      `window.__PI_DESKTOP__.selectSession(${JSON.stringify(sessionId)})`,
    );
    await waitFor(
      () => client.evaluate(`!!document.querySelector('[data-pi-plugin="${PLUGIN_ID}"]')`),
      "the showcase plugin's renderer entry",
    );
    // A slot component of the plugin that really ran is the signal the module
    // is loaded; every later read assumes that, so it is waited for once.
    await waitFor(
      () =>
        client.evaluate(
          `!!document.querySelector('[data-pi-plugin="${PLUGIN_ID}"] .acme-plugin-showcase__badge')`,
        ),
      "the showcase badge in a transcript row",
    );

    // The fixture's own renderer entry is loaded lazily the same way. Its
    // composer control is the observable proof that the module really ran, so
    // every read below is about a second plugin that is in the window, not one
    // that was merely installed.
    await waitFor(
      () =>
        client.evaluate(
          `!!document.querySelector('[data-pi-fixture-trigger="readDraft"]')`,
        ),
      "the slot-race fixture's composer control",
    );

    const facts = { sessionId, pluginToolMessageId, hostToolMessageId, PLUGIN_TOOL };
    const run = async (body) => client.evaluate(`(async () => {${PROBE_HELPERS}${body}})()`);

    // ── the injected sheet, read back out of the live document ─────────────
    // `pi.ui.injectStyle` is the only way a plugin's CSS may reach the window,
    // and the host promises to rewrite it before it serves it: the element is
    // stamped as scoped, and every selector in it sits under the plugin's own
    // container. A sheet served as written would show up here as an unscoped
    // selector, which is exactly what this counts.
    const styleFacts = await run(`
      const container = ${JSON.stringify(SHOWCASE_CONTAINER)};
      const sheet = $('style[data-pi-plugin-style="${PLUGIN_ID}"]');
      const css = sheet ? (sheet.textContent ?? '') : '';
      // Read the sheet the way the host's own refusal scanner reads one: the
      // text between a block end and the next brace is a selector list.
      const selectors = [];
      for (let brace = css.indexOf('{'); brace >= 0; brace = css.indexOf('{', brace + 1)) {
        const start = Math.max(
          css.lastIndexOf('}', brace - 1),
          css.lastIndexOf('{', brace - 1),
          css.lastIndexOf(';', brace),
        );
        const text = css.slice(start + 1, brace).trim();
        if (!text || text.startsWith('@')) continue;
        for (const part of text.split(',')) {
          const trimmed = part.trim();
          if (trimmed) selectors.push(trimmed);
        }
      }
      return {
        sheetFound: Boolean(sheet),
        inHead: Boolean(sheet && document.head.contains(sheet)),
        mode: sheet?.getAttribute('data-pi-plugin-style-mode') ?? null,
        selectorCount: selectors.length,
        scoped: selectors.filter((selector) => selector.startsWith(container)).length,
        unscoped: selectors.filter((selector) => !selector.startsWith(container)),
        rootRefs: selectors.filter((selector) => /^(html|body|\\*)(?![\\w-])/i.test(selector)),
        // One of the plugin's real class names, under its own container.
        badgeScoped: selectors.some(
          (selector) =>
            selector.startsWith(container) &&
            selector.includes('.acme-plugin-showcase__badge'),
        ),
        sheets: $$('style[data-pi-plugin-style]').length,
        sample: selectors.slice(0, 3),
      };
    `);
    record(
      "E2E-PLUGIN-showcase-style-sheet-scoped-in-window",
      styleFacts.sheetFound &&
        styleFacts.inHead &&
        styleFacts.mode === "scoped" &&
        styleFacts.selectorCount > 0 &&
        styleFacts.badgeScoped &&
        styleFacts.unscoped.length === 0 &&
        styleFacts.rootRefs.length === 0,
      `the plugin's sheet is in the head, stamped ${styleFacts.mode}, and all ${styleFacts.selectorCount} of its selectors sit under ${SHOWCASE_CONTAINER}, e.g. ${JSON.stringify(styleFacts.sample)} (its own badge class included: ${styleFacts.badgeScoped}); unscoped: ${JSON.stringify(styleFacts.unscoped)}; top-level html/body/*: ${JSON.stringify(styleFacts.rootRefs)}; plugin sheets in the document: ${styleFacts.sheets}`,
    );

    // ── the public token surface resolves in the app ───────────────────────
    // The `--pi-slot-*` aliases are declared on `.pi-plugin-slot` and map the
    // host's internal `--ds-*` values. Reading them off a mounted container is
    // the difference between a published token surface and a stylesheet nobody
    // shipped: an unimported file, or an alias whose chain does not resolve,
    // reads back empty here.
    const tokenFacts = await run(`
      const container = $('[data-pi-plugin="${PLUGIN_ID}"][data-pi-plugin-slot="entry"]');
      const style = container ? getComputedStyle(container) : null;
      const token = (name) => (style ? style.getPropertyValue(name).trim() : '');
      return {
        containerFound: Boolean(container),
        slotClass: container ? container.classList.contains('pi-plugin-slot') : false,
        theme: container?.getAttribute('data-pi-theme') ?? null,
        bg: token('--pi-slot-bg'),
        text: token('--pi-slot-text'),
        border: token('--pi-slot-border'),
        radius: token('--pi-slot-radius-sm'),
      };
    `);
    record(
      "E2E-PLUGIN-showcase-slot-tokens-resolve-in-window",
      tokenFacts.containerFound &&
        tokenFacts.slotClass &&
        (tokenFacts.theme === "light" || tokenFacts.theme === "dark") &&
        tokenFacts.bg !== "" &&
        tokenFacts.text !== "" &&
        tokenFacts.border !== "" &&
        tokenFacts.radius !== "",
      `on a mounted container (class pi-plugin-slot, data-pi-theme ${tokenFacts.theme}) the aliases resolve to live values: --pi-slot-bg ${JSON.stringify(tokenFacts.bg)}, --pi-slot-text ${JSON.stringify(tokenFacts.text)}, --pi-slot-border ${JSON.stringify(tokenFacts.border)}, --pi-slot-radius-sm ${JSON.stringify(tokenFacts.radius)}`,
    );

    // ── entry / entryExtra ─────────────────────────────────────────────────
    const entryFacts = await run(`
      const row = $('.message-row[data-message-id=${JSON.stringify(userMessageId)}]');
      return {
        rowFound: Boolean(row),
        entryCard: text(row?.querySelector('[data-pi-showcase-slot="entry"]')),
        entryContainer: row?.querySelector('[data-pi-plugin][data-pi-plugin-slot="entry"]')?.getAttribute('data-pi-plugin') ?? null,
        badge: text(row?.querySelector('.acme-plugin-showcase__badge')),
        badgeContainer: row?.querySelector('[data-pi-plugin][data-pi-plugin-slot="entryExtra"]')?.getAttribute('data-pi-plugin') ?? null,
        badgeCount: $$('.acme-plugin-showcase__badge').length,
      };
    `);
    record(
      "E2E-PLUGIN-showcase-entry-card",
      entryFacts.rowFound &&
        entryFacts.entryContainer === PLUGIN_ID &&
        (entryFacts.entryCard ?? "").includes("· entry") &&
        (entryFacts.entryCard ?? "").includes(userMessageId),
      `the whole-message position carries the plugin's card and names the host's entry id: ${JSON.stringify(entryFacts.entryCard)}`,
    );
    record(
      "E2E-PLUGIN-showcase-entry-extra-badge",
      entryFacts.badgeContainer === PLUGIN_ID &&
        (entryFacts.badge ?? "").includes("· entryExtra") &&
        (entryFacts.badge ?? "").includes(userMessageId) &&
        entryFacts.badgeCount >= 1,
      `${entryFacts.badgeCount} badge(s) below transcript rows, first: ${JSON.stringify(entryFacts.badge)}`,
    );

    // ── the entry card re-draws the message it took over ───────────────────
    // The defect this pins: a replace position that announced "this
    // registration replaced the host's own row" while hiding the row's content.
    // The host hands the position the message the row was going to draw, so the
    // plugin's own card has to draw that text — readable in the transcript the
    // user actually sees — with its own controls beside it.
    const replacedFacts = await run(`
      const row = $('.message-row[data-message-id=${JSON.stringify(userMessageId)}]');
      const card = row?.querySelector('[data-pi-showcase-slot="entry"]');
      const textNode = card?.querySelector('[data-pi-showcase-entry-text]');
      const controls = $$('[data-pi-plugin-slot="entry"] [data-pi-showcase-action], [data-pi-plugin-slot="entry"] [data-pi-showcase-release]');
      const toast = card?.querySelector('[data-pi-showcase-action="ui.toast"]');
      const release = card?.querySelector('[data-pi-showcase-release="entry"]');
      const follows = (before, after) =>
        Boolean(before && after) &&
        (before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      return {
        cardFound: Boolean(card),
        container:
          row?.querySelector('[data-pi-plugin="${PLUGIN_ID}"][data-pi-plugin-slot="entry"]')
            ?.getAttribute('data-pi-plugin') ?? null,
        text: text(textNode),
        expected: ${JSON.stringify(USER_MESSAGE_TEXT)},
        // The transcript the user reads, not the DOM: innerText leaves out what
        // is hidden, so this is the "still readable" half of the check.
        rendered: (transcriptText() ?? '').includes(${JSON.stringify(USER_MESSAGE_TEXT)}),
        // The host's own bubble must not sit behind the card: the claim
        // replaces the row rather than stacking a copy on top of it.
        hostBubble: Boolean(row?.querySelector('.message-bubble')),
        controlCount: controls.length,
        toastLabel: text(toast),
        releaseLabel: text(release),
        controlsFollowText: follows(textNode, toast) && follows(textNode, release),
        releaseTarget: release?.getAttribute('data-pi-showcase-release') ?? null,
      };
    `);
    record(
      "E2E-PLUGIN-showcase-entry-card-redraws-the-message",
      replacedFacts.cardFound &&
        replacedFacts.container === PLUGIN_ID &&
        replacedFacts.text === replacedFacts.expected &&
        replacedFacts.rendered &&
        replacedFacts.controlsFollowText &&
        replacedFacts.releaseTarget === "entry" &&
        (replacedFacts.toastLabel ?? "").includes("entry slot") &&
        (replacedFacts.releaseLabel ?? "").includes("Release this claim"),
      `the transcript still reads ${JSON.stringify(replacedFacts.expected)} because the plugin's card draws it (card text: ${JSON.stringify(replacedFacts.text)}, readable in the transcript: ${replacedFacts.rendered}), with ${replacedFacts.controlCount} of the card's own control(s) beside it (toast: ${JSON.stringify(replacedFacts.toastLabel)}, release: ${JSON.stringify(replacedFacts.releaseLabel)}) — host bubble behind the card: ${replacedFacts.hostBubble}`,
    );

    // ── codeBlock ──────────────────────────────────────────────────────────
    const codeFacts = await run(`
      const mount = pluginSlot(${JSON.stringify(PLUGIN_ID)}, 'codeBlock');
      return {
        mountFound: Boolean(mount),
        head: text($('.acme-plugin-showcase__kv-head')),
        rows: $$('.acme-plugin-showcase__kv-row').map((row) => text(row)),
        flagged: $$('.acme-plugin-showcase__kv-row.acme-plugin-showcase__kv-flagged').map((row) => text(row)),
        source: text($$('.prose-chat pre code').find((node) => (node.textContent ?? '').includes('covered = 42'))),
      };
    `);
    record(
      "E2E-PLUGIN-showcase-code-block-rows",
      codeFacts.mountFound &&
        (codeFacts.head ?? "").includes(`draws fenced ${CODE_LANGUAGE}`) &&
        codeFacts.rows.some((row) => row === "covered42") &&
        codeFacts.rows.some((row) => row === "disk91% used") &&
        codeFacts.flagged.some((row) => row === "disk91% used"),
      `the closed ${CODE_LANGUAGE} fence is drawn as the plugin's rows: ${JSON.stringify(codeFacts.rows)} (flagged: ${JSON.stringify(codeFacts.flagged)})`,
    );

    // ── toolCard ───────────────────────────────────────────────────────────
    const toolFacts = await run(`
      const owned = $('.tool-row[data-message-id=${JSON.stringify(pluginToolMessageId)}]');
      const hostRow = $('.tool-row[data-message-id=${JSON.stringify(hostToolMessageId)}]');
      return {
        ownedFound: Boolean(owned),
        hostFound: Boolean(hostRow),
        ownedCard: text(owned?.querySelector('[data-pi-showcase-slot="toolCard"]')),
        ownedContainer: owned?.querySelector('[data-pi-plugin="${PLUGIN_ID}"][data-pi-plugin-slot="toolCard"]')?.getAttribute('data-pi-plugin') ?? null,
        hostCard: Boolean(hostRow?.querySelector('[data-pi-showcase-slot="toolCard"]')),
        hostSlot: Boolean(hostRow?.querySelector('[data-pi-plugin-slot="toolCard"]')),
        toolName: ${JSON.stringify(facts.PLUGIN_TOOL)},
      };
    `);
    record(
      "E2E-PLUGIN-showcase-tool-card-owned-only",
      toolFacts.ownedFound &&
        toolFacts.hostFound &&
        toolFacts.ownedContainer === PLUGIN_ID &&
        (toolFacts.ownedCard ?? "").includes("· toolCard") &&
        (toolFacts.ownedCard ?? "").includes(pluginToolMessageId) &&
        toolFacts.hostCard === false &&
        toolFacts.hostSlot === false,
      `the plugin's own tool row (${toolFacts.toolName}) draws its card; the host's Read row got no card (card=${toolFacts.hostCard}, position=${toolFacts.hostSlot})`,
    );

    // ── composerControl ────────────────────────────────────────────────────
    // The two rows are selected by their own `data-pi-control-position`: the
    // right row also contains the `beforeSend` region (checked next), and an
    // unscoped `.composer-right …` selector would read that one instead.
    const controlFacts = await run(`
      const left = $('.composer-left [data-pi-plugin="${PLUGIN_ID}"][data-pi-plugin-slot="composerControl"][data-pi-control-position="left"]');
      const right = $('.composer-right [data-pi-plugin="${PLUGIN_ID}"][data-pi-plugin-slot="composerControl"][data-pi-control-position="right"]');
      // The title (and every label) lives on the plugin's own control, not on
      // the host's container, so it is read from the button itself.
      const titleOf = () =>
        showcaseTrigger('inlineConfirm')?.getAttribute('title') ??
        showcaseTrigger('modal')?.getAttribute('title') ??
        null;
      return {
        leftFound: Boolean(left),
        rightFound: Boolean(right),
        leftPosition: left?.getAttribute('data-pi-control-position') ?? null,
        rightPosition: right?.getAttribute('data-pi-control-position') ?? null,
        leftLabel: text(left),
        rightLabel: text(right),
        leftTitle: titleOf(),
        inlineTrigger: Boolean(showcaseTrigger('inlineConfirm')),
        modalTrigger: Boolean(showcaseTrigger('modal')),
        overlayTrigger: Boolean(showcaseTrigger('overlay')),
      };
    `);
    record(
      "E2E-PLUGIN-showcase-composer-control-rows",
      controlFacts.leftFound &&
        controlFacts.rightFound &&
        controlFacts.leftPosition === "left" &&
        controlFacts.rightPosition === "right" &&
        (controlFacts.leftLabel ?? "").includes("Showcase: inline card") &&
        (controlFacts.rightLabel ?? "").includes("Showcase: modal") &&
        (controlFacts.rightLabel ?? "").includes("Showcase: overlay") &&
        controlFacts.inlineTrigger &&
        controlFacts.modalTrigger &&
        controlFacts.overlayTrigger &&
        /draft \d+ char\(s\)/.test(controlFacts.leftTitle ?? ""),
      `left row: ${JSON.stringify(controlFacts.leftLabel)} (title ${JSON.stringify(controlFacts.leftTitle)}), right row: ${JSON.stringify(controlFacts.rightLabel)}`,
    );

    // ── the region immediately left of Send belongs to the plugin ──────────
    // The product rule this pins: the host hands that region over whole — its
    // own model picker, context display and prompt-enhancement control, the
    // same elements it would draw itself — and the occupying plugin places
    // them. So every one of those controls has to be *inside* the plugin's own
    // container, immediately before the send button, each exactly once (no
    // second host copy), with the plugin's own buttons beside them.
    const regionFacts = await run(`
      const regionSelector = '[data-pi-plugin="${PLUGIN_ID}"][data-pi-plugin-slot="composerControl"][data-pi-control-position="beforeSend"]';
      const region = $(regionSelector);
      // The send control is read from the region's own row, so a second
      // composer elsewhere in the window can never be mistaken for this one.
      const row = region?.parentElement ?? null;
      const send = row?.querySelector('.send-btn') ?? null;
      const picker = $('.composer-model-thinking-chip');
      const context = $('.context-inspector');
      const contextTrigger = $('.context-inspector-trigger');
      const enhance = $('.composer-enhance-btn');
      const inside = (node) => Boolean(node && region && region.contains(node));
      // A node is on screen when it has a box and is not hidden by CSS; the
      // control can be in the DOM and painted nowhere.
      const visible = (node) => {
        if (!node) return false;
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      // "Immediately left of Send": the very next element in the row is the
      // send control, and the row holds one region and one send control. The
      // strict read and the shape are both reported, so a failure says what the
      // row really looked like.
      const next = region?.nextElementSibling ?? null;
      const sameRow = Boolean(region && send && region.parentElement === send.parentElement);
      return {
        regionFound: Boolean(region),
        inComposerRight: Boolean(region?.closest('.composer-right')),
        sendIsNextSibling: Boolean(region && send && region.nextElementSibling === send),
        sameRow,
        rowShape: next
          ? next.tagName.toLowerCase() + '.' + (next.className || '') + ' then ' +
            (next.nextElementSibling
              ? next.nextElementSibling.tagName.toLowerCase() + '.' + (next.nextElementSibling.className || '')
              : 'end')
          : 'nothing after the region',
        sendLabel: text(send),
        regionCount: $$(regionSelector).length,
        composerRightCount: $$('.composer-right').length,
        sendCount: $$(regionSelector).length === 1 && row ? row.querySelectorAll('.send-btn').length : -1,
        order: $('[data-pi-showcase-region]')?.getAttribute('data-pi-showcase-region-order') ?? null,
        pieces: $$('[data-pi-showcase-region-piece]').map((node) =>
          node.getAttribute('data-pi-showcase-region-piece'),
        ),
        pieceData: $$('[data-pi-showcase-region-piece]').map((node) =>
          node.getAttribute('data-pi-showcase-region-data'),
        ),
        modelInside: inside(picker),
        modelVisible: visible(picker),
        modelText: text(picker),
        contextInside: inside(contextTrigger),
        contextVisible: visible(contextTrigger),
        contextText: text(contextTrigger),
        enhanceInside: inside(enhance),
        enhanceVisible: visible(enhance),
        ownControls: $$('[data-pi-showcase-region] [data-pi-showcase-trigger]').map((node) =>
          node.getAttribute('data-pi-showcase-trigger'),
        ),
        ownReport: Boolean($('[data-pi-showcase-region] [data-pi-showcase-report]')),
        // One of each in the whole window: the host draws no second copy.
        modelCount: $$('.composer-model-thinking-chip').length,
        contextCount: $$('.context-inspector').length,
        enhanceCount: $$('.composer-enhance-btn').length,
      };
    `);
    record(
      "E2E-PLUGIN-showcase-composer-region-handover",
      regionFacts.regionFound &&
        regionFacts.inComposerRight &&
        regionFacts.sameRow &&
        regionFacts.sendIsNextSibling &&
        regionFacts.regionCount === 1 &&
        regionFacts.sendCount === 1 &&
        regionFacts.order === "model,context,enhance" &&
        JSON.stringify(regionFacts.pieces) === JSON.stringify(["model", "context", "enhance"]) &&
        regionFacts.pieceData.every((value) => value === "yes") &&
        regionFacts.modelInside &&
        regionFacts.modelVisible &&
        regionFacts.contextInside &&
        regionFacts.contextVisible &&
        regionFacts.enhanceInside &&
        regionFacts.enhanceVisible &&
        regionFacts.ownControls.includes("composerRegionCycle") &&
        regionFacts.ownControls.includes("modal") &&
        regionFacts.ownControls.includes("overlay") &&
        regionFacts.ownReport &&
        regionFacts.modelCount === 1 &&
        regionFacts.contextCount === 1 &&
        regionFacts.enhanceCount === 1,
      `the plugin's region is the next element after which the send control sits (same row ${regionFacts.sameRow}, next in the row: ${JSON.stringify(regionFacts.rowShape)}, send is the region's next sibling ${regionFacts.sendIsNextSibling}, region/send mounts ${regionFacts.regionCount}/${regionFacts.sendCount} in ${regionFacts.composerRightCount} row(s)); it holds ${JSON.stringify(regionFacts.pieces)} in order ${JSON.stringify(regionFacts.order)} (data handed over: ${JSON.stringify(regionFacts.pieceData)}), with the host's model picker ${JSON.stringify(regionFacts.modelText)} inside=${regionFacts.modelInside} visible=${regionFacts.modelVisible}, the context display ${JSON.stringify(regionFacts.contextText)} inside=${regionFacts.contextInside} visible=${regionFacts.contextVisible}, the enhancement control inside=${regionFacts.enhanceInside} visible=${regionFacts.enhanceVisible}, the plugin's own controls ${JSON.stringify(regionFacts.ownControls)} plus a report button (${regionFacts.ownReport}) — host copies in the window: model ${regionFacts.modelCount}, context ${regionFacts.contextCount}, enhance ${regionFacts.enhanceCount}`,
    );

    // ── the plugin's order is what renders, and cycling it really changes it ─
    // The same three pieces, a different sequence: the attributes and the DOM
    // order have to move together, and no piece may disappear on the way.
    const cycleFacts = await run(`
      const orderOf = () =>
        $$('[data-pi-showcase-region-piece]').map((node) =>
          node.getAttribute('data-pi-showcase-region-piece'),
        );
      const attrOf = () => $('[data-pi-showcase-region]')?.getAttribute('data-pi-showcase-region-order') ?? null;
      const click = () =>
        $('[data-pi-showcase-trigger="composerRegionCycle"]')?.dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        );
      const before = { attr: attrOf(), pieces: orderOf() };
      click();
      const first = await waitFor(
        () => {
          const attr = attrOf();
          if (!attr || attr === before.attr) return null;
          return { attr, pieces: orderOf() };
        },
        ${RUNTIME_PROBE_TIMEOUT},
      );
      click();
      const second = await waitFor(
        () => {
          const attr = attrOf();
          if (!attr || attr === first?.attr) return null;
          return { attr, pieces: orderOf() };
        },
        ${RUNTIME_PROBE_TIMEOUT},
      );
      // One more press must come back round to the order this started in: it
      // cycles, and the sequence is the plugin's own decision, not a toggle.
      click();
      const wrapped = await waitFor(
        () => (attrOf() === before.attr ? { attr: attrOf(), pieces: orderOf() } : null),
        ${RUNTIME_PROBE_TIMEOUT},
      );
      return {
        before,
        first,
        second,
        wrapped,
        modelCount: $$('.composer-model-thinking-chip').length,
        contextCount: $$('.context-inspector').length,
        enhanceCount: $$('.composer-enhance-btn').length,
        regionStillHoldsModel: Boolean(
          $('[data-pi-showcase-region] .composer-model-thinking-chip'),
        ),
        regionStillHoldsContext: Boolean(
          $('[data-pi-showcase-region] .context-inspector-trigger'),
        ),
        regionStillHoldsEnhance: Boolean($('[data-pi-showcase-region] .composer-enhance-btn')),
        regionText: text($('[data-pi-showcase-region]')),
      };
    `);
    record(
      "E2E-PLUGIN-showcase-composer-region-order-cycle",
      cycleFacts.before.attr === "model,context,enhance" &&
        JSON.stringify(cycleFacts.before.pieces) === JSON.stringify(["model", "context", "enhance"]) &&
        cycleFacts.first?.attr === "context,enhance,model" &&
        JSON.stringify(cycleFacts.first?.pieces) === JSON.stringify(["context", "enhance", "model"]) &&
        cycleFacts.second?.attr === "enhance,model,context" &&
        JSON.stringify(cycleFacts.second?.pieces) ===
          JSON.stringify(["enhance", "model", "context"]) &&
        cycleFacts.wrapped?.attr === "model,context,enhance" &&
        JSON.stringify(cycleFacts.wrapped?.pieces) ===
          JSON.stringify(["model", "context", "enhance"]) &&
        cycleFacts.regionStillHoldsModel &&
        cycleFacts.regionStillHoldsContext &&
        cycleFacts.regionStillHoldsEnhance &&
        cycleFacts.modelCount === 1 &&
        cycleFacts.contextCount === 1 &&
        cycleFacts.enhanceCount === 1,
      `the region's order went ${JSON.stringify(cycleFacts.before)} → ${JSON.stringify(cycleFacts.first)} → ${JSON.stringify(cycleFacts.second)} → ${JSON.stringify(cycleFacts.wrapped)} — every piece still inside the region (model ${cycleFacts.regionStillHoldsModel}, context ${cycleFacts.regionStillHoldsContext}, enhance ${cycleFacts.regionStillHoldsEnhance}), and still one of each in the window (${cycleFacts.modelCount}/${cycleFacts.contextCount}/${cycleFacts.enhanceCount}); region reads ${JSON.stringify(cycleFacts.regionText)}`,
    );

    // ── the live draft reaches a mounted plugin through the slot contract ──
    // The composer hands every `composerControl` registration `{ position,
    // draft, sessionId? }`, and a plugin draws its control out of that. The
    // fixture publishes the two values it was mounted with as attributes; the
    // suite then types into the composer the way the rest of this file does and
    // requires the plugin's own copy of the draft to follow. The value is read
    // twice — an untouched composer, then the typed text — so a constant cannot
    // satisfy it.
    const draftPropFacts = await run(`
      const control = () => $('[data-pi-fixture-draft-prop]');
      const mounted = () => ({
        draft: control()?.getAttribute('data-pi-fixture-draft-prop') ?? null,
        session: control()?.getAttribute('data-pi-fixture-session') ?? null,
      });
      const before = mounted();
      const typed = setDraft(${JSON.stringify(TYPED_DRAFT_TEXT)});
      const after = await waitFor(
        () =>
          mounted().draft === ${JSON.stringify(TYPED_DRAFT_TEXT)} ? mounted() : null,
        ${RUNTIME_PROBE_TIMEOUT},
      );
      return {
        before,
        after,
        typed: Boolean(typed),
        typedText: ${JSON.stringify(TYPED_DRAFT_TEXT)},
        editorText: readDraft(),
        container:
          $('[data-pi-plugin="${RACE_PLUGIN_ID}"][data-pi-plugin-slot="composerControl"]')
            ?.getAttribute('data-pi-plugin') ?? null,
      };
    `);
    record(
      "E2E-PLUGIN-showcase-composer-draft-prop-live",
      draftPropFacts.container === RACE_PLUGIN_ID &&
        draftPropFacts.typed &&
        draftPropFacts.before.draft === "" &&
        draftPropFacts.before.session === sessionId &&
        draftPropFacts.after?.draft === draftPropFacts.typedText &&
        draftPropFacts.after?.session === sessionId &&
        draftPropFacts.editorText === draftPropFacts.typedText,
      `a mounted composerControl registration was handed session ${JSON.stringify(draftPropFacts.before.session)} and the draft ${JSON.stringify(draftPropFacts.before.draft)}; typing ${JSON.stringify(draftPropFacts.typedText)} into the composer (editor now ${JSON.stringify(draftPropFacts.editorText)}) reached the plugin as ${JSON.stringify(draftPropFacts.after?.draft)} with session ${JSON.stringify(draftPropFacts.after?.session)} — container ${draftPropFacts.container}`,
    );

    // ── composer.replaceDraft writes into the mounted composer ─────────────
    // The fixture writes a whole draft through the host's own action. The write
    // resolves only once a mounted composer consumed it — the host clears the
    // prefill and refuses with `PLUGIN_ACTION_DRAFT_UNCONSUMED` otherwise — the
    // composer's own editor has to hold the text afterwards, and the receipt
    // carries the previous snapshot in its documented shape.
    //
    // The fixture's second button asks for `composer.readDraft`, the read half
    // of the same contract. It declares the action in its own manifest, so the
    // host answers with the live draft and the snapshot is asserted below.
    const draftFacts = await run(`
      const button = (name) => $('[data-pi-fixture-trigger="' + name + '"]');
      const click = (node) => node?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const parse = (raw) => {
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      };
      click(button('writeDraft'));
      const write = await waitFor(
        () => {
          const receipt = parse(button('writeDraft')?.getAttribute('data-pi-fixture-write'));
          const editor = composerInput();
          const editorText = editor ? (editor.textContent ?? '') : null;
          if (!receipt || editorText !== ${JSON.stringify(RACE_DRAFT_TEXT)}) return null;
          return { receipt, editorText };
        },
        ${RUNTIME_PROBE_TIMEOUT},
      );
      click(button('readDraft'));
      const read = await waitFor(
        () => {
          const outcome = button('readDraft')?.getAttribute('data-pi-fixture-read-outcome');
          if (!outcome || outcome === 'asking') return null;
          return {
            outcome,
            snapshot: parse(button('readDraft')?.getAttribute('data-pi-fixture-draft')),
          };
        },
        ${RUNTIME_PROBE_TIMEOUT},
      );
      return {
        write,
        read,
        written: ${JSON.stringify(RACE_DRAFT_TEXT)},
        container:
          $('[data-pi-plugin="${RACE_PLUGIN_ID}"][data-pi-plugin-slot="composerControl"]')
            ?.getAttribute('data-pi-plugin') ?? null,
        buttons: $$('[data-pi-fixture-trigger]').map((node) =>
          node.getAttribute('data-pi-fixture-trigger'),
        ),
      };
    `);
    const writeReceipt = draftFacts.write?.receipt ?? null;
    const previousDraft = writeReceipt?.previous ?? null;
    record(
      "E2E-PLUGIN-showcase-composer-replace-draft-live",
      draftFacts.container === RACE_PLUGIN_ID &&
        writeReceipt?.ok === true &&
        typeof writeReceipt.generation === "number" &&
        writeReceipt.generation >= 1 &&
        previousDraft?.sessionId === sessionId &&
        typeof previousDraft.generation === "number" &&
        previousDraft.generation + 1 === writeReceipt.generation &&
        previousDraft.text === "" &&
        Array.isArray(previousDraft.fileReferences) &&
        draftFacts.write?.editorText === RACE_DRAFT_TEXT &&
        // The read half: the fixture declares `composer.readDraft`, so the host
        // answers it with the live draft — the session, the generation the write
        // left behind, the text that write put in the composer, no references.
        draftFacts.read?.outcome === "ok" &&
        draftFacts.read.snapshot?.sessionId === sessionId &&
        draftFacts.read.snapshot?.generation === writeReceipt.generation &&
        draftFacts.read.snapshot?.text === RACE_DRAFT_TEXT &&
        Array.isArray(draftFacts.read.snapshot?.fileReferences) &&
        draftFacts.read.snapshot.fileReferences.length === 0,
    );

    // ── completionSource ───────────────────────────────────────────────────
    const completionFacts = await run(`
      const typed = setDraft('/showcase');
      const opened = await waitFor(
        () => $('[data-pi-plugin="${PLUGIN_ID}"][data-pi-plugin-slot="completionSource"]'),
        ${RUNTIME_PROBE_TIMEOUT},
      );
      const slot = $('[data-pi-plugin="${PLUGIN_ID}"][data-pi-plugin-slot="completionSource"]');
      return {
        typed,
        ...composerState(),
        mountFound: Boolean(opened),
        inPopover: Boolean(opened && $('.composer-autocomplete')?.contains(opened)),
        mode: slot?.getAttribute('data-pi-completion-mode') ?? null,
        candidates: $$('[data-pi-showcase-candidate]').map((row) => row.getAttribute('data-pi-showcase-candidate')),
        head: text(slot),
        candidateText: $$('[data-pi-showcase-candidate]').map((row) => text(row)),
      };
    `);
    record(
      "E2E-PLUGIN-showcase-completion-source-rows",
      completionFacts.mountFound &&
        completionFacts.inPopover &&
        completionFacts.mode === "slash" &&
        completionFacts.candidates.includes("showcase-inline") &&
        (completionFacts.candidateText.join(" ") ?? "").includes("/showcase-inline"),
      `typing /showcase opened the popover and its candidate rows are the plugin's: ${JSON.stringify(completionFacts.candidates)} — window: ${JSON.stringify(completionFacts)}`,
    );

    // ── composerReference ──────────────────────────────────────────────────
    // A reference is attached by the host's own `@` completion. The popover
    // mount exists in either mode — `data-pi-completion-mode` is host-owned and
    // the mount is in the list as soon as the popover is up — so the probe waits
    // for *file* mode and for the host's own file rows before it accepts. A
    // single read here would catch the previous, slash-mode popover and press
    // Enter against the wrong candidate list.
    const referenceFacts = await run(`
      setDraft('');
      const typed = setDraft('@README');
      const rows = await waitFor(
        () => {
          const slot = $('[data-pi-plugin="${PLUGIN_ID}"][data-pi-plugin-slot="completionSource"]');
          if (slot?.getAttribute('data-pi-completion-mode') !== 'file') return null;
          const found = $$('.composer-autocomplete .composer-ac-item');
          return found.length ? found : null;
        },
        ${RUNTIME_PROBE_TIMEOUT},
      );
      const editor = composerInput();
      const stage = composerStage();
      // The mode the accept is driven in, read before Enter closes the popover.
      const fileMode = rows
        ? $('[data-pi-plugin="${PLUGIN_ID}"][data-pi-plugin-slot="completionSource"]')
            ?.getAttribute('data-pi-completion-mode') ?? null
        : null;
      pressKey('Enter');
      const attached = await waitFor(
        () => stage?.querySelector('.composer-chip') ?? null,
        ${RUNTIME_PROBE_TIMEOUT},
      );
      const chip = $('[data-pi-plugin="${PLUGIN_ID}"][data-pi-plugin-slot="composerReference"]');
      return {
        typed,
        fileMode,
        hostRows: (rows ?? []).length,
        hostRowText: (rows ?? []).map((row) => text(row)),
        hostChip: text(attached),
        chipFound: Boolean(chip),
        referenceCount: chip?.getAttribute('data-pi-reference-count') ?? null,
        chipText: text(chip),
        afterEditor: Boolean(chip && editor)
          ? (editor.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
          : false,
        ...composerState(),
      };
    `);
    record(
      "E2E-PLUGIN-showcase-composer-reference-chip",
      referenceFacts.chipFound &&
        referenceFacts.referenceCount === "1" &&
        (referenceFacts.chipText ?? "").includes("acme.plugin-showcase chip") &&
        (referenceFacts.chipText ?? "").includes("1 ref") &&
        (referenceFacts.chipText ?? "").includes("README.md") &&
        referenceFacts.afterEditor,
      `after attaching ${JSON.stringify(referenceFacts.hostChip)} from the host's ${referenceFacts.fileMode}-mode rows ${JSON.stringify(referenceFacts.hostRowText)} the plugin chip reads ${JSON.stringify(referenceFacts.chipText)} — window: ${JSON.stringify(referenceFacts)}`,
    );

    // ── The agent turn: gate, watch, facts, and the pending permission ─────
    // Painted one frame at a time so the payload never blocks the compositor.
    // The plugin writes its tool count on `tool_execution_end` and clears the
    // whole line again on `agent_end`, so a single read can only ever catch one
    // of the two (or neither). The status line is watched for the whole length
    // of the turn instead: every distinct value the host really painted is
    // recorded in the window, and the checks read that list afterwards.
    await run(`
      window.__showcaseStatusLog = [];
      window.__showcaseToastLog = [];
      const snapshot = () => {
        const line = statusLine().join(' | ');
        const statusLog = window.__showcaseStatusLog;
        if (statusLog[statusLog.length - 1] !== line) statusLog.push(line);
        // Toasts are transient, and the plugin's own refusal notice is one:
        // it is collected from every mutation instead of read once at the end.
        for (const toast of toasts()) {
          const toastLog = window.__showcaseToastLog;
          if (!toastLog.includes(toast)) toastLog.push(toast);
        }
      };
      snapshot();
      window.__showcaseStatusObserver?.disconnect();
      const observer = new MutationObserver(snapshot);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      window.__showcaseStatusObserver = observer;
      return true;
    `);
    const turn = await run(`
      setDraft('');
      const response = await window.piDesktop.invoke(
        window.piDesktop.channels.invoke.agentPrompt,
        {
          sessionId: ${JSON.stringify(sessionId)},
          content: 'Run the showcase agent turn.',
          messageId: crypto.randomUUID(),
          viewingSessionId: ${JSON.stringify(sessionId)},
          attachments: [],
        },
      );
      return { accepted: response?.accepted ?? null, turnId: response?.turnId ?? null };
    `);
    // The permission request is the host's own approval path, so waiting for
    // the host's card is waiting for the state the slot is defined against.
    const permissionSeen = await waitFor(
      () => run(`return { pending: Boolean($('.permission-card')), toasts: toasts(), status: statusLine() };`),
      "a pending permission request in the transcript",
      120_000,
    );

    // ── inlineConfirm (while the request is pending) ───────────────────────
    // The position facts are read while the card is *mounted*: the plugin's own
    // close button withdraws the registration, and React then removes the card
    // from the document — a read afterwards would be measuring a detached node
    // (it has no panes, no scroller and no transcript above it).
    const inlineFacts = await run(`
      const before = await waitFor(() => $('.permission-card'), ${RUNTIME_PROBE_TIMEOUT});
      const hostCardBefore = Boolean(before);
      showcaseTrigger('inlineConfirm')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const mounted = await waitFor(
        () => showcaseCard('inlineConfirm'),
        ${RUNTIME_PROBE_TIMEOUT},
      );
      const hostCardGone = !$('.permission-card');
      const container = $('[data-pi-plugin="${PLUGIN_ID}"][data-pi-plugin-slot="inlineConfirm"]');
      const cardText = text(mounted);
      const scroll = mounted?.closest('.thread-scroll') ?? null;
      const pane = mounted?.closest('.session-pane') ?? null;
      const rows = scroll ? Array.from(scroll.querySelectorAll('.message-row')) : [];
      const lastRow = rows[rows.length - 1] ?? null;
      const position = {
        inTranscript: Boolean(scroll),
        inContent: Boolean(mounted?.closest('.thread-content')),
        // The host's own confirmation card is the transcript's last block, so
        // the plugin's card has to sit after every message row in the scroller
        // and before the docked composer.
        afterLastRow: Boolean(
          mounted &&
            lastRow &&
            (lastRow.compareDocumentPosition(mounted) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        ),
        pane: pane?.getAttribute('data-session-pane') ?? null,
        paneVisible: pane?.getAttribute('data-visible') ?? null,
        scrollCount: $$('.thread-scroll').length,
      };
      $('[data-pi-showcase-close="inlineConfirm"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const hostCardBack = await waitFor(() => $('.permission-card'), ${RUNTIME_PROBE_TIMEOUT});
      return {
        hostCardBefore,
        mounted: Boolean(mounted),
        container: container?.getAttribute('data-pi-plugin') ?? null,
        ...position,
        cardText,
        hostCardGone,
        hostCardBack: Boolean(hostCardBack),
        triggerLabel: text(showcaseTrigger('inlineConfirm')),
      };
    `);
    record(
      "E2E-PLUGIN-showcase-inline-confirm-pending-permission",
      inlineFacts.hostCardBefore &&
        inlineFacts.mounted &&
        inlineFacts.container === PLUGIN_ID &&
        inlineFacts.inTranscript &&
        inlineFacts.inContent &&
        inlineFacts.afterLastRow &&
        inlineFacts.pane === sessionId &&
        inlineFacts.paneVisible === "true" &&
        (inlineFacts.cardText ?? "").includes("· inlineConfirm") &&
        (inlineFacts.cardText ?? "").includes(sessionId) &&
        inlineFacts.hostCardGone &&
        inlineFacts.hostCardBack,
      `the plugin's card took the confirmation position in the session's own transcript while the request was pending and gave it back on close — window: ${JSON.stringify(inlineFacts)}`,
    );

    // ── modal / overlay layers ─────────────────────────────────────────────
    const layerFacts = await run(`
      const snapshot = async (name) => {
        showcaseTrigger(name).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const layer = await waitFor(
          () => $('[data-pi-plugin-layer="' + name + '"]'),
          ${RUNTIME_PROBE_TIMEOUT},
        );
        return {
          layerFound: Boolean(layer),
          blocking: Boolean(layer?.classList.contains('is-modal')),
          cardText: text(layer?.querySelector('[data-pi-showcase-slot="' + name + '"]')),
          container: layer?.querySelector('[data-pi-plugin="${PLUGIN_ID}"]')?.getAttribute('data-pi-plugin') ?? null,
          triggerLabel: text(showcaseTrigger(name)),
          closeButton: Boolean(layer?.querySelector('[data-pi-showcase-close="' + name + '"]')),
        };
      };
      // The plugin's own button withdraws the registration for good.
      const modal = await snapshot('modal');
      $('[data-pi-showcase-close="modal"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const modalClosed = await waitFor(
        () => !showcaseCard('modal'),
        ${RUNTIME_PROBE_TIMEOUT},
      );
      // Escape is the host's dismissal: the layer goes, the registration stays.
      const reopened = await snapshot('modal');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const dismissed = await waitFor(
        () => !$('[data-pi-plugin-layer="modal"]'),
        ${RUNTIME_PROBE_TIMEOUT},
      );
      const afterEscape = {
        dismissed: Boolean(dismissed),
        cardGone: !showcaseCard('modal'),
        triggerLabel: text(showcaseTrigger('modal')),
      };
      showcaseTrigger('modal').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await waitFor(() => !showcaseCard('modal'), ${RUNTIME_PROBE_TIMEOUT});
      const overlay = await snapshot('overlay');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const overlayDismissed = await waitFor(
        () => !$('[data-pi-plugin-layer="overlay"]'),
        ${RUNTIME_PROBE_TIMEOUT},
      );
      showcaseTrigger('overlay').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await waitFor(() => !showcaseCard('overlay'), ${RUNTIME_PROBE_TIMEOUT});
      return { modal, modalClosed: Boolean(modalClosed), reopened, afterEscape, overlay, overlayDismissed: Boolean(overlayDismissed) };
    `);
    record(
      "E2E-PLUGIN-showcase-modal-layer",
      layerFacts.modal.layerFound &&
        layerFacts.modal.blocking &&
        layerFacts.modal.container === PLUGIN_ID &&
        (layerFacts.modal.cardText ?? "").includes("· modal") &&
        layerFacts.modal.closeButton &&
        layerFacts.modalClosed &&
        layerFacts.reopened.layerFound &&
        layerFacts.afterEscape.dismissed &&
        layerFacts.afterEscape.dismissed &&
        // The card element leaves with the layer; the *registration* is still
        // up, and the trigger's own label is what says so.
        (layerFacts.afterEscape.triggerLabel ?? "").includes("close modal") &&
        (layerFacts.reopened.triggerLabel ?? "").includes("close modal"),
      `the modal layer is on screen with a blocking scrim and its own container; the card's button and Escape both take it away (Escape leaves the registration up): ${JSON.stringify(layerFacts.modal.cardText)}`,
    );
    record(
      "E2E-PLUGIN-showcase-overlay-layer",
      layerFacts.overlay.layerFound &&
        layerFacts.overlay.blocking === false &&
        layerFacts.overlay.container === PLUGIN_ID &&
        (layerFacts.overlay.cardText ?? "").includes("· overlay") &&
        layerFacts.overlayDismissed,
      `the overlay layer is on screen without a scrim and Escape dismisses it: ${JSON.stringify(layerFacts.overlay.cardText)}`,
    );

    // ── a replace slot takes one claim ─────────────────────────────────────
    // `modal` is a replace position: the first claim owns it and a later one is
    // refused with `PLUGIN_SLOT_DUPLICATE` rather than stacked. The showcase
    // holds the claim whenever its own modal registration is up; while it is up,
    // the *second* plugin asks for the same position.
    //
    // Everything asserted below is a real observation: the answer `register`
    // returned is on the fixture's own button, and the window is read for a
    // second layer, a second claim owner, and the fixture's own modal marker.
    // The layer host passes the registrations it renders explicitly, so a host
    // that stopped refusing duplicates would draw both cards here.
    const claimFacts = await run(`
      const click = (node) => node?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const layers = () => $$('[data-pi-plugin-layer="modal"]');
      const claimOwners = () =>
        $$('[data-pi-plugin-layer="modal"] [data-pi-plugin-slot="modal"]').map((node) =>
          node.getAttribute('data-pi-plugin'),
        );
      click(showcaseTrigger('modal'));
      const opened = await waitFor(
        () => showcaseCard('modal') ?? null,
        ${RUNTIME_PROBE_TIMEOUT},
      );
      const before = {
        layers: layers().length,
        blocking: $$('.pi-plugin-layer.is-modal').length,
        claimOwners: claimOwners(),
      };
      click($('[data-pi-fixture-trigger="claimModal"]'));
      const answer = await waitFor(
        () => {
          const value = $('[data-pi-fixture-trigger="claimModal"]')
            ?.getAttribute('data-pi-fixture-claim');
          // 'asking' is the fixture's own transient state; anything else is the
          // host's answer, so it is what the suite reads.
          return value && value !== 'asking' ? value : null;
        },
        ${RUNTIME_PROBE_TIMEOUT},
      );
      // Long enough for React to paint a second container if the host had taken
      // the registration; a single read would race the commit.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const after = {
        layers: layers().length,
        blocking: $$('.pi-plugin-layer.is-modal').length,
        claimOwners: claimOwners(),
        fixtureModalMarkers: $$('[data-pi-fixture-modal]').length,
        fixtureSlots: $$('[data-pi-plugin="${RACE_PLUGIN_ID}"]').map((node) =>
          node.getAttribute('data-pi-plugin-slot'),
        ),
        showcaseCard: text(showcaseCard('modal')),
        claimLabel: text($('[data-pi-fixture-trigger="claimModal"]')),
      };
      click($('[data-pi-showcase-close="modal"]'));
      const closed = await waitFor(
        () => !showcaseCard('modal'),
        ${RUNTIME_PROBE_TIMEOUT},
      );
      return { opened: Boolean(opened), before, answer, after, closed: Boolean(closed) };
    `);
    record(
      "E2E-PLUGIN-showcase-replace-slot-takes-one-claim",
      claimFacts.opened &&
        claimFacts.before.layers === 1 &&
        claimFacts.before.blocking === 1 &&
        claimFacts.before.claimOwners.length === 1 &&
        claimFacts.before.claimOwners[0] === PLUGIN_ID &&
        // The refusal as the second plugin observed it, and as the host's own
        // `pi.slots.register` reports it: the coded error names the reason
        // (`PLUGIN_SLOT_DUPLICATE`, spec 07-plugins/16 2A.5), not "invalid".
        claimFacts.answer === "PLUGIN_SLOT_DUPLICATE" &&
        // Only the showcase is ever an owner: the fixture never takes the
        // position and its own marker never renders. The click lands on the
        // composer, outside the modal, so the host also dismisses the
        // showcase's layer (D8's outside-click rule) — the layer count is
        // evidence in the detail below, not part of the claim this pins.
        claimFacts.after.claimOwners.every((owner) => owner === PLUGIN_ID) &&
        !claimFacts.after.fixtureSlots.includes("modal") &&
        claimFacts.after.fixtureModalMarkers === 0 &&
        claimFacts.after.layers <= claimFacts.before.layers &&
        claimFacts.closed,
      `the showcase held the modal position (layers ${claimFacts.before.layers}, claim owner ${JSON.stringify(claimFacts.before.claimOwners)}) and the fixture's own registration was answered with ${JSON.stringify(claimFacts.answer)} (${JSON.stringify(claimFacts.after.claimLabel)}); afterwards the window still carries ${claimFacts.after.layers} blocking layer(s) with claim owner ${JSON.stringify(claimFacts.after.claimOwners)}, the fixture's modal marker appears ${claimFacts.after.fixtureModalMarkers} time(s), and its mounted slots are ${JSON.stringify(claimFacts.after.fixtureSlots)}`,
    );

    // ── Resolve the permission so the turn can finish ──────────────────────
    const resolved = await run(`
      // The permission card's last action is the affirmative one; its label is
      // localized, so the position is what is clicked, not the text.
      const actions = $$('.permission-card .permission-card-actions button');
      const allow = actions[actions.length - 1] ?? null;
      allow?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { found: Boolean(allow), label: allow ? text(allow) : null };
    `);
    // Wait for the run to end: the plugin clears its status line on `agent_end`.
    const summarySeen = await waitFor(
      async () => {
        const read = await run(`
          return { toasts: toasts(), status: statusLine() };
        `);
        return read.toasts.some((toast) => toast.includes("turn summary")) ? read : null;
      },
      "the plugin's turn-facts summary",
      180_000,
    );

    // Every toast the window really raised during the turn, collected by the
    // watcher installed before the prompt (they are transient by design).
    const toastLog = await run(`return window.__showcaseToastLog ?? [];`);

    // A gated call is answered by the kernel with an error tool *result*, so
    // the host draws the call as a failed command row and nothing of its own:
    // a run row's presentation maps only stdout/stderr, and a bare text result
    // therefore renders no body (apps/desktop/src/lib/tool-presentation.ts,
    // "run" branch → `mapped` short-circuits the fallback). What the user is
    // given is the plugin's own warning, and what the model is given is the
    // result the gate returned; both are checked here, together with the row.
    const gateFacts = await run(`
      setDraft('');
      for (let pass = 0; pass < 6; pass += 1) {
        if (expandTranscript() === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const rendered = transcriptText() ?? '';
      const rowTexts = $$('.tool-row').map((row) => text(row));
      const refused = $$('.tool-row').find((row) => text(row).includes('git reset --hard HEAD~1')) ?? null;
      return {
        refusedRow: Boolean(refused),
        refusedRowFailed: Boolean(
          refused &&
            (refused.classList.contains('status-error') || refused.classList.contains('is-error')),
        ),
        refusedRowText: refused ? text(refused) : null,
        // The transcript the user actually reads: innerText leaves out what
        // the DOM keeps hidden, so this says the row was really drawn.
        refusedRowRendered: rendered.includes('git reset --hard HEAD~1'),
        renderedTail: rendered.slice(-600),
        // The call the model made *after* the refusal reached the host's own
        // approval path — approved or denied is the user's decision, not this
        // check's — which is what shows the gate refused one specific call
        // instead of stalling the turn.
        benignRow: rowTexts.some((row) => row.includes('echo plugin-showcase-e2e')),
        rowTexts,
      };
    `);
    const modelSawRefusal = stub.requests.some((payload) =>
      JSON.stringify(payload.messages ?? []).includes("Plugin Showcase refused"),
    );
    const modelDigest = stub.requests.map((payload) => ({
      model: payload.model ?? null,
      messages: (payload.messages ?? []).map((message) => ({
        role: message.role,
        calls: (message.tool_calls ?? []).map((call) => call.function?.name ?? null),
        args: (message.tool_calls ?? []).map((call) => call.function?.arguments ?? null),
        refused: JSON.stringify(message).includes("Plugin Showcase refused"),
      })),
    }));
    const userSawRefusal = toastLog.some((toast) =>
      toast.includes("Plugin Showcase refused a shell command"),
    );
    record(
      "E2E-PLUGIN-showcase-agent-tool-gate-refusal",
      gateFacts.refusedRow &&
        gateFacts.refusedRowFailed &&
        gateFacts.refusedRowRendered &&
        gateFacts.benignRow &&
        modelSawRefusal &&
        userSawRefusal,
      `the gate refused the model's own dangerous Bash call: the failed row ${JSON.stringify(gateFacts.refusedRowText)} is in the transcript, the plugin's reason reached the model's next request (${modelSawRefusal}) and the user as a warning toast (${userSawRefusal}); the call after it reached the host's approval path (${gateFacts.benignRow}); transcript tool rows: ${JSON.stringify(gateFacts.rowTexts)}; model requests: ${JSON.stringify(modelDigest)}`,
    );

    // ── agent: the turn watch status line ──────────────────────────────────
    // The line the plugin writes on `tool_execution_end` is cleared again on
    // `agent_end`, so the turn's own write is read from the watched log rather
    // than from one snapshot taken while the permission was pending.
    const watchedStatus = await waitFor(
      async () => {
        const log = await run(`return window.__showcaseStatusLog ?? [];`);
        return log.some((line) => STATUS_TOOL_COUNT.test(line)) ? log : null;
      },
      "the plugin's own tool count in the host's status line",
      30_000,
    ).catch(() => run(`return window.__showcaseStatusLog ?? [];`));
    record(
      "E2E-PLUGIN-showcase-agent-turn-status-chip",
      watchedStatus.some((line) => STATUS_TOOL_COUNT.test(line)),
      `the plugin's own count reached the host's status line, which read ${JSON.stringify(permissionSeen.status)} while the request was pending: ${JSON.stringify(watchedStatus)}`,
    );

    // ── agent: the turn facts summary ──────────────────────────────────────
    record(
      "E2E-PLUGIN-showcase-agent-turn-facts-summary",
      summarySeen.toasts.some((toast) => /Plugin Showcase · turn summary — \w+/.test(toast)) &&
        summarySeen.status.length === 0,
      `${JSON.stringify(resolved)}; one summary per run, and the status line is cleared with it: ${JSON.stringify(summarySeen.toasts.filter((toast) => toast.includes("turn summary")))}`,
    );

    // ── the docked console view ────────────────────────────────────────────
/**
 * The helpers a probe inside the console page needs. A docked view is its own
 * document — it shares no globals with the app window — so it carries its own
 * small copy instead of reusing `PROBE_HELPERS`.
 */
const CONSOLE_HELPERS = `
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const text = (node) => (node ? (node.textContent ?? '').trim() : null);
const waitFor = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
};
`;

    // The plugin's own page is declared as a work-panel view (`ui.view`) as
    // well as a panel, and until now nothing in this suite opened it. It is
    const dockView = await run(`
      const click = (node) => node?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const toggle = $('.app-work-panel-toggle');
      if (toggle && toggle.getAttribute('aria-pressed') !== 'true') click(toggle);
      // The panel reopens on the tab it had, and the destination rows only exist
      // in a "new tab" surface: open that first, exactly like the "+" a user
      // presses before picking a view.
      const openedPanel = await waitFor(
        () => $('.work-panel-new-tab') ?? null,
        ${RUNTIME_PROBE_TIMEOUT},
      );
      click(openedPanel);
      const listed = await waitFor(
        () => {
          const rows = $$('[data-work-panel-launcher-item]').map((node) =>
            node.getAttribute('data-work-panel-launcher-item'),
          );
          return rows.includes('${PLUGIN_ID}/console') ? rows : null;
        },
        ${RUNTIME_PROBE_TIMEOUT},
      );
      const seenRows = $$('[data-work-panel-launcher-item]').map((node) =>
        node.getAttribute('data-work-panel-launcher-item'),
      );
      // The host's own answer, so a missing row can be told apart from an
      // empty list: this is the call the store behind the launcher makes.
      const ipcViews = await window.piDesktop
        .invoke(window.piDesktop.channels.invoke.pluginViews)
        .catch((error) => [{ error: String(error?.message ?? error) }]);
      const launcherRows = $$('.work-panel-launcher-row').map((node) => text(node));
      const row = $('[data-work-panel-launcher-item="${PLUGIN_ID}/console"]');
      click(row);
      const tab = await waitFor(
        () =>
          $('.work-panel-tab-button[title="${PLUGIN_ID}/console"]') ??
          [...$$('.work-panel-tab-button')].find((node) =>
            (node.textContent ?? '').includes('Showcase Console'),
          ) ??
          null,
        ${RUNTIME_PROBE_TIMEOUT},
      );
      return {
        listed,
        seenRows,
        ipcViews,
        launcherRows,
        panelOpen: Boolean(openedPanel),
        rowFound: Boolean(row),
        rowLabel: text(row),
        tabFound: Boolean(tab),
        tabTitle: tab?.getAttribute('title') ?? null,
      };
    `);
    const consoleTarget = await waitFor(
      async () => {
        const targets = await listTargets(cdpPort).catch(() => []);
        return targets.find(
          (candidate) =>
            candidate.type === "page" &&
            candidate.webSocketDebuggerUrl &&
            candidate.url.includes("plugin-showcase/views/console.html"),
        );
      },
      "the docked console view target",
      60_000,
    ).catch(async (error) => {
      // A missing target is the interesting failure: print what the panel
      // really showed and which pages the app advertised.
      const targets = await listTargets(cdpPort).catch(() => []);
      throw new Error(
        `${error.message}; dock view: ${JSON.stringify(dockView)}; pages: ${JSON.stringify(
          targets.map((candidate) => candidate.url),
        )}`,
      );
    });
    consoleClient = await CdpClient.connect(consoleTarget.webSocketDebuggerUrl);
    await consoleClient.send("Runtime.enable");
    const runConsole = async (body) =>
      consoleClient.evaluate(`(async () => {${CONSOLE_HELPERS}${body}})()`);

    const consoleFacts = await runConsole(`
      const ready = await waitFor(
        () => (document.body.dataset.piConsoleReady === '1' ? '1' : null),
        ${RUNTIME_PROBE_TIMEOUT},
      );
      const inventory = $('[data-pi-console-inventory]');
      return {
        ready,
        shape: document.documentElement.dataset.piPluginPanelShape ?? null,
        bridge: document.body.dataset.piConsoleBridge ?? null,
        slots: inventory?.getAttribute('data-pi-console-slots') ?? null,
        actions: inventory?.getAttribute('data-pi-console-actions') ?? null,
        data: inventory?.getAttribute('data-pi-console-data') ?? null,
        runtimeSlots: inventory?.getAttribute('data-pi-console-permissions') ?? null,
        groups: $$('[data-pi-console-group]').map((node) =>
          node.getAttribute('data-pi-console-group'),
        ),
        slotItems: $$('[data-pi-console-group="slots"] [data-pi-console-item]').length,
        actionItems: $$('[data-pi-console-group="actions"] [data-pi-console-item]').length,
        dataItems: $$('[data-pi-console-group="data"] [data-pi-console-item]').length,
        runtimeItems: $$('[data-pi-console-group="runtime"] [data-pi-console-item]').length,
        version: text($('[data-pi-console-version]')),
      };
    `);
    record(
      "E2E-PLUGIN-showcase-console-view-inventory",
      dockView.panelOpen &&
        dockView.rowFound &&
        dockView.tabFound &&
        (dockView.listed ?? []).includes(`${PLUGIN_ID}/console`) &&
        consoleFacts.ready === "1" &&
        // A docked view publishes its placement itself; "view" is what keeps it
        // distinct from the plugin's own panel window.
        consoleFacts.shape === "view" &&
        consoleFacts.bridge === "ok" &&
        consoleFacts.slots === "10" &&
        consoleFacts.actions === "10" &&
        consoleFacts.data === "8" &&
        consoleFacts.runtimeSlots === "11" &&
        consoleFacts.slotItems === 10 &&
        consoleFacts.actionItems === 10 &&
        consoleFacts.dataItems === 8 &&
        consoleFacts.runtimeItems === 11,
      `the view is listed as ${JSON.stringify(dockView.listed)} (row ${JSON.stringify(dockView.rowLabel)}) and the page it renders publishes slots=${consoleFacts.slots}, actions=${consoleFacts.actions}, data=${consoleFacts.data}, runtime slots=${consoleFacts.runtimeSlots} with ${consoleFacts.slotItems}/${consoleFacts.actionItems}/${consoleFacts.dataItems}/${consoleFacts.runtimeItems} rendered rows, shape ${consoleFacts.shape}, bridge ${consoleFacts.bridge}, group order ${JSON.stringify(consoleFacts.groups)}`,
    );

    // The console's own buttons are real round trips into the plugin process,
    // which is where the host answer is turned into a receipt line. The two AI
    // controls that show the model-resolution order are the cheapest pair to
    // drive: one omits the model key, the other names a key the host cannot
    // resolve, and each writes the code the host really returned.
    const consoleAi = await runConsole(`
      const clickAction = (action) => {
        const button = $('[data-pi-console-action="' + action + '"]');
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return Boolean(button);
      };
      const receiptFor = (needle) =>
        $$('[data-pi-console-receipt]').find((line) =>
          (line.getAttribute('data-pi-console-action') ?? '').includes(needle),
        ) ?? null;
      const receiptOf = (line) =>
        line
          ? {
              code: line.getAttribute('data-pi-console-code'),
              action: line.getAttribute('data-pi-console-action'),
              surface: line.getAttribute('data-pi-console-surface'),
              detail: (line.getAttribute('data-pi-console-detail') ?? '').slice(0, 240),
            }
          : null;
      const askedDefault = clickAction('ai.default');
      const defaultReceipt = await waitFor(
        () => receiptFor('省略 modelKey'),
        ${RUNTIME_PROBE_TIMEOUT},
      );
      const askedUnknown = clickAction('ai.unknown');
      const unknownReceipt = await waitFor(
        () => receiptFor('不可解析的 modelKey'),
        ${RUNTIME_PROBE_TIMEOUT},
      );
      return {
        askedDefault,
        askedUnknown,
        default: receiptOf(defaultReceipt),
        unknown: receiptOf(unknownReceipt),
        requestCount: document.querySelectorAll('[data-pi-console-receipt]').length,
      };
    `);
    record(
      "E2E-PLUGIN-showcase-console-ai-receipts",
      consoleAi.askedDefault &&
        consoleAi.askedUnknown &&
        // Omitting the model key resolves through the host's ready catalog.
        consoleAi.default?.code === "ok" &&
        // An explicit key the host cannot resolve does NOT answer NO_MODEL in
        // this build: the host falls back to a usable provider/model, and the
        // receipt the console shows is that answer, sentence included. The
        // check pins the documented resolution order instead of the code the
        // page's own copy used to guess.
        consoleAi.unknown?.code === "ok" &&
        (consoleAi.unknown?.detail ?? "").includes("fell back to a usable provider/model"),
      `omitting the model key wrote ${JSON.stringify(consoleAi.default)} and the unresolvable key wrote ${JSON.stringify(consoleAi.unknown)} (${consoleAi.requestCount} receipt lines on the page)`,
    );


    // The runtime group's own button reads back what the plugin process really
    // holds about the agent half: the host's `session:turnEnded` push for the
    // turn this journey ran, and the plugin's own tool executions. A count on
    // its own could be anything; this check requires a receipt line whose
    // surface is 「运行时」.
    const consoleRuntime = await runConsole(`
      const clickAction = (action) => {
        const button = $('[data-pi-console-action="' + action + '"]');
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return Boolean(button);
      };
      // The turn this journey ran already left a runtime receipt on the page
      // (the boot status read merges the plugin process's own list), so the log
      // is cleared first: what is asserted below is what the button's own round
      // trip wrote, not what a refresh had already merged.
      const cleared = clickAction('log.clear');
      const emptyLog = await waitFor(
        () => ($('[data-pi-console-receipt]') ? null : true),
        ${RUNTIME_PROBE_TIMEOUT},
      );
      const asked = clickAction('runtime.receipts');
      const line = await waitFor(
        () =>
          [...$$('[data-pi-console-receipt]')].find(
            (node) => node.getAttribute('data-pi-console-surface') === '运行时',
          ) ?? null,
        ${RUNTIME_PROBE_TIMEOUT},
      );
      const status = await waitFor(
        () => {
          const value = text($('[data-pi-console-status="runtime.tool.gate"]'));
          return value && value.startsWith('回执') ? value : null;
        },
        ${RUNTIME_PROBE_TIMEOUT},
      );
      return {
        cleared,
        emptyLog,
        asked,
        runtimeLine: line
          ? {
              code: line.getAttribute('data-pi-console-code'),
              action: line.getAttribute('data-pi-console-action'),
              detail: (line.getAttribute('data-pi-console-detail') ?? '').slice(0, 240),
            }
          : null,
        status,
      };
    `);
    record(
      "E2E-PLUGIN-showcase-console-runtime-receipts",
      consoleRuntime.cleared &&
        consoleRuntime.emptyLog &&
        consoleRuntime.asked &&
        consoleRuntime.runtimeLine?.code === "ok" &&
        (consoleRuntime.runtimeLine?.action ?? "").includes("turnEnded") &&
        (consoleRuntime.status ?? "").startsWith("回执"),
      `after clearing the log (${consoleRuntime.cleared}/${consoleRuntime.emptyLog}) the runtime group's button read back ${JSON.stringify(consoleRuntime.runtimeLine)} and left ${JSON.stringify(consoleRuntime.status)} on the tool-gate row`,
    );
  } catch (error) {
    throw new Error(`${describe(error)}\n--- window ---\n${await windowSnapshot(client)}`);
  } finally {
    consoleClient?.close();
    client?.close();
    if (child) await killTree(child);
    await stub.close();
    try {
      rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A held profile lock must not turn a completed journey into a failure.
    }
  }
}

try {
  await runJourney();
} catch (error) {
  const headline = "E2E-PLUGIN-showcase-slots-in-a-real-window";
  if (!results.some((result) => result.id === headline)) {
    record(
      headline,
      false,
      error instanceof Error
        ? error.stack ?? error.message
        : String(error),
    );
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
