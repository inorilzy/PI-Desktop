#!/usr/bin/env node
/**
 * Trusted renderer host E2E: the build contract, the single-React import map, the
 * recorded preload exposure, and the action channel a slot component dispatches
 * through, all read out of a real window where they can be.
 * E2E-PLUGIN-renderer-slots-survive-a-packaged-build
 *   The renderer host's contract only breaks where it cannot be debugged: a
 *   packaged renderer loads `plugin-renderer:` module source from a `file://`
 *   origin, and a CSP that does not name the scheme, a scheme registered
 *   without the privileges a module fetch needs, a MIME allowlist that grew an
 *   `html` entry, a revoked permission that still serves a path, or a channel
 *   the preload refuses, all pass in dev and fail only after packaging. The
 *   assertions below run the real modules — the real Vite plugin, the real
 *   protocol handler with a stubbed Electron, the real IPC whitelist — instead
 *   of comparing copies of them.
 *
 * The first seven checks are headless. The main process modules are bundled
 * with esbuild and a stubbed `electron` so their real code runs in Node, and
 * the renderer-side modules are covered by
 * `apps/desktop/test/plugin-renderer-slots.test.mjs`. The last five launch the
 * built app with a throwaway profile, load the example plugin and a hook-using
 * fixture into the real renderer, and read the live window over CDP: one records
 * what a plugin-realm module can actually reach — `window.piDesktop` is exposed,
 * not removed — one checks that the import map hands React out once, and three
 * read the action channel off the fixture's own slot component: the `dispatch`
 * prop it was handed, the refusal an undeclared action answers with, and that
 * the refusal arrives as a rejection instead of a synchronous throw.
 * Neither path touches the network, a user profile, or an installed plugin.
 *
 * Prerequisites: `packages/plugin-sdk/dist` for every check, and the built
 * desktop app plus Electron and a host-core binary (target/debug,
 * target/release, or PI_DESKTOP_HOST_BIN) for the real-window journey.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));

const INDEX_HTML = join(root, "apps/desktop/index.html");
const VITE_CONFIG = join(root, "apps/desktop/electron.vite.config.ts");
const PROTOCOL_MODULE = join(root, "apps/desktop/electron/main/plugin-renderer-protocol.ts");
const STARTUP = join(root, "apps/desktop/electron/main/bootstrap/startup.ts");
const PLUGIN_RUNTIME = join(root, "apps/desktop/electron/main/plugin-runtime.ts");
const SHARED_PROTOCOL = join(root, "packages/shared/src/protocol.ts");
const PRELOAD = join(root, "apps/desktop/electron/preload/index.ts");
const EXAMPLE_PLUGIN = join(root, "examples/plugins/slots-demo");
const SDK_RENDERER = join(root, "packages/plugin-sdk/dist/renderer.js");
const SDK_INDEX = join(root, "packages/plugin-sdk/dist/index.js");

const results = [];
function record(id, ok, detail = "") {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
}

/** Module sources substituted for real ones, so the real code can run in Node. */
function stubModules(contents) {
  const specifiers = new Set(Object.keys(contents));
  return {
    name: "pi-e2e-stubs",
    setup(api) {
      api.onResolve({ filter: /.*/ }, (args) =>
        specifiers.has(args.path) ? { path: args.path, namespace: "pi-stub" } : undefined,
      );
      api.onLoad({ filter: /.*/, namespace: "pi-stub" }, (args) => ({
        contents: contents[args.path],
        loader: "js",
      }));
    },
  };
}

/**
 * Bundle one real TypeScript module to CommonJS and require it. Bundling is how
 * this suite runs the real implementation: `electron` and the Vite plugins are
 * replaced, everything else — including `@pi-desktop/plugin-sdk` — stays real.
 */
async function bundleToCjs(entry, stubs, name) {
  const { build } = require("esbuild");
  const output = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node22",
    logLevel: "silent",
    plugins: stubs ? [stubModules(stubs)] : [],
  });
  const file = join(temp, `${name}.cjs`);
  writeFileSync(file, output.outputFiles[0].text);
  return require(file);
}

/** The CSP a document declares, or null when it carries none. */
function cspOf(html) {
  return (
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html)?.[1] ?? null
  );
}

/** Sources a directive lists, or null when the policy does not declare it. */
function directiveSources(csp, directive) {
  const part = csp
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.toLowerCase().startsWith(directive));
  return part ? part.split(/\s+/).slice(1) : null;
}

/**
 * The source text of one method: from its signature to the brace that closes the
 * body. Used for the two files that cannot be imported without booting the app
 * composition root (`startup.ts`, `plugin-runtime.ts`).
 */
function methodSource(source, signature) {
  const at = source.indexOf(signature);
  if (at < 0) return null;
  const open = source.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return null;
}

/** Source text of a call, from its first `(` to the matching `)`. */
function callSource(source, name) {
  const at = source.indexOf(name);
  if (at < 0) return null;
  const open = source.indexOf("(", at);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return null;
}


/** A loopback port for the CDP connection, so a stray one never collides. */
async function freePort() {
  const server = createServer();
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

/** Poll a predicate until it answers truthy, like the other UI runners. */
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

/** One CDP websocket, request ids, and the page console for failure details. */
class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.console = [];
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.consoleAPICalled" || message.method === "Runtime.exceptionThrown") {
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
        result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails),
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
 * A hook-using fixture plugin, owned by this check rather than by the repo. It
 * records the `react` bindings its own bare import resolved to, records what
 * plugin-realm module code can reach on the window, renders a `useState`
 * counter, and records what the host handed its component as props together
 * with what a refused dispatch answered. The assertions can therefore compare
 * module identity, measure the recorded exposure from inside plugin code, drive
 * a real hook round trip, and read the action channel off the component instead
 * of inferring any of it from a rendered string.
 */
const FIXTURE_RENDERER = `import { createElement, useState } from "react";

globalThis.__PI_E2E_PLUGIN_REACT__ = { createElement, useState };

// Read by the module itself, in the realm it shares with the host: this is the
// exposure the design records, not a control. A plugin module reaches the
// preload bridge and, through it, the whole whitelisted IPC surface.
globalThis.__PI_E2E_PLUGIN_BRIDGE__ = {
  typeofPiDesktop: typeof window.piDesktop,
  piDesktopInWindow: "piDesktop" in window,
  typeofInvoke: typeof window.piDesktop?.invoke,
  invokeChannels: Object.keys(window.piDesktop?.channels?.invoke ?? {}).length,
  eventChannels: Object.keys(window.piDesktop?.channels?.event ?? {}).length,
};

// The action this fixture's manifest declares, and one it deliberately does
// not. The manifest has to declare something, otherwise a refusal would say
// nothing about the declaration the check is about.
const DECLARED_ACTION = "ui.toast";
const UNDECLARED_ACTION = "composer.replaceDraft";
// The forwarded half of the interface: the "plugin.call" action runs a method
// inside this plugin's own headless entry and answers with what it returned,
// which is why the value below cannot be produced by the renderer alone.
// plugin's own headless entry and answers with what it returned, which is why
// the value below cannot be produced by the renderer alone.
const FORWARDED_ACTION = "plugin.call";
const FORWARDED_METHOD = "slots.echo";
const FORWARDED_ARGS = { text: "e2e" };

// Facts the checks read, recorded from inside plugin code the way the bridge
// reading above is. Merged rather than replaced, so an outcome a click recorded
// survives a later re-render of the same component.
function noteDispatch(fields) {
  const bag = globalThis.__PI_E2E_PLUGIN_DISPATCH__ ?? {};
  Object.assign(bag, fields);
  globalThis.__PI_E2E_PLUGIN_DISPATCH__ = bag;
  return bag;
}

// One resolution of a forwarded call, appended rather than overwritten so two
// clicks are two entries: the counter in the answers is what the
// runs-in-the-plugin-entry check reads.
function noteForwarded(entry) {
  const bag = noteDispatch({ forwardedStatus: entry.status });
  const forwardedAnswers = [...(bag.forwardedAnswers ?? []), entry];
  return noteDispatch({ forwardedAnswers });
}

function Counter(props) {
  const [clicks, setClicks] = useState(0);

  // What the host really handed this component, recorded at render time from
  // inside plugin code: the prop and what it is, not what the host says it sent.
  noteDispatch({
    typeofDispatch: typeof props.dispatch,
    propNames: Object.keys(props).sort().join(","),
    declaredAction: DECLARED_ACTION,
    undeclaredAction: UNDECLARED_ACTION,
    forwardedAction: FORWARDED_ACTION,
  });

  // A refusal has to arrive as a rejected promise. A synchronous throw would be
  // caught by the host's slot boundary, which takes the component off screen
  // (D10), so both halves are recorded: what the call returned, and what it said.
  const askUndeclared = () => {
    noteDispatch({
      returnedThenable: false,
      threwSynchronously: false,
      rejected: false,
      resolved: false,
      refusalCode: null,
      refusalMessage: null,
    });
    try {
      const answer = props.dispatch(UNDECLARED_ACTION, { text: "e2e" });
      const thenable = typeof answer?.then === "function";
      noteDispatch({ returnedThenable: thenable });
      if (!thenable) {
        noteDispatch({ refusalMessage: String(answer) });
        return;
      }
      answer.then(
        () => noteDispatch({ resolved: true }),
        (error) => noteDispatch({
          rejected: true,
          refusalTypeof: typeof error,
          refusalCode: error?.code ?? null,
          refusalMessage: error?.message ?? String(error),
        }),
      );
    } catch (error) {
      noteDispatch({
        threwSynchronously: true,
        refusalCode: error?.code ?? null,
        refusalMessage: error?.message ?? String(error),
      });
    }
  };
  // The forwarded call: the "plugin.call" action is declared too, so the host
  // relays { method, args } to this plugin's own headless entry and resolves
  // that entry's answer. Both what was sent and what came back are recorded
  // per call, because the answer is the only evidence the checks can read from
  // inside plugin code.
  const askForwarded = () => {
    noteDispatch({ forwardedStatus: "pending" });
    const sent = { method: FORWARDED_METHOD, args: FORWARDED_ARGS };
    try {
      const answer = props.dispatch(FORWARDED_ACTION, sent);
      if (typeof answer?.then !== "function") {
        noteForwarded({ status: "no-promise", sent, answer: null });
        return;
      }
      answer.then(
        (value) => noteForwarded({ status: "resolved", sent, answer: value }),
        (error) => noteForwarded({
          status: "rejected",
          sent,
          answer: null,
          code: error?.code ?? null,
          message: error?.message ?? String(error),
        }),
      );
    } catch (error) {
      noteForwarded({
        status: "threw",
        sent,
        answer: null,
        code: error?.code ?? null,
        message: error?.message ?? String(error),
      });
    }
  };

  return createElement("span", { className: "pi-e2e-slots__counter" }, [
    createElement("span", { key: "value" }, "clicks=" + clicks),
    createElement(
      "button",
      {
        key: "bump",
        type: "button",
        className: "pi-e2e-slots__bump",
        onClick: () => setClicks((value) => value + 1),
      },
      "bump",
    ),
    createElement(
      "button",
      {
        key: "undeclared",
        type: "button",
        className: "pi-e2e-slots__undeclared",
        onClick: askUndeclared,
      },
      "undeclared",
    ),
    createElement(
      "button",
      {
        key: "forwarded",
        type: "button",
        className: "pi-e2e-slots__forwarded",
        onClick: askForwarded,
      },
      "forwarded",
    ),
  ]);
}

export function onLoad(pi) {
  pi.slots.register("entryExtra", Counter);
}
`;

/**
 * The fixture's headless entry, and the only place a forwarded call can run.
 * `calls` is module state inside this plugin's own process, so two renderer
 * clicks can only read 1 and 2 if the call really re-entered here, and
 * `entryPid` names the process that answered. `marker` is a string that exists
 * nowhere else, so an answer carrying it cannot have been composed by the
 * renderer.
 */
const FIXTURE_MAIN = `
let calls = 0;
module.exports = {
  async onRendererCall(method, args) {
    calls += 1;
    return {
      marker: "acme.e2e-slots/main.js:onRendererCall",
      method,
      args,
      counter: calls,
      entryPid: process.pid,
    };
  },
};
`;

/**
 * Everything the real-window checks are about, read from the live window after a
 * plugin module has rendered: the preload global and what the plugin realm saw
 * of it, the document import map, the React bindings the plugin-facing specifier
 * and the plugin module resolved, two clicks through the fixture's own
 * `useState`, two clicks of its forwarded `plugin.call` button, and what the
 * fixture's slot component recorded about the `dispatch` prop it was handed,
 * the undeclared action it called, and the answers the forwarded call resolved
 * with.
 */
const RUNTIME_PROBE = `(async () => {
  const bridgeDescriptor = Object.getOwnPropertyDescriptor(window, "piDesktop") ?? null;
  const importMap = document.querySelector('script[type="importmap"]');
  const host = globalThis.__PI_RENDERER_HOST__ ?? null;
  const plugin = globalThis.__PI_E2E_PLUGIN_REACT__ ?? null;
  const mapped = await import("react");
  const mappedDom = await import("react-dom");
  const mappedDomClient = await import("react-dom/client");
  const counter = document.querySelector('[data-pi-plugin="acme.e2e-slots"]');
  const button = counter?.querySelector("button.pi-e2e-slots__bump") ?? null;
  const undeclaredButton = counter?.querySelector("button.pi-e2e-slots__undeclared") ?? null;
  const forwardedButton = counter?.querySelector("button.pi-e2e-slots__forwarded") ?? null;
  const read = () => counter?.textContent ?? null;
  const before = read();
  button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const afterFirst = read();
  button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const afterTwo = read();
  // The refusal probe drives the plugin's own handler. What came back is
  // recorded by plugin code; only that record is read, never the host's copy.
  undeclaredButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const survivedRefusal = Boolean(document.querySelector('[data-pi-plugin="acme.e2e-slots"] button.pi-e2e-slots__undeclared'));
  // The forwarded call, twice, each click awaited through the plugin-realm
  // record rather than a fixed sleep: the two answers are the plugin entry's
  // own first and second, which is what the counter check reads.
  const forwardedCount = () =>
    (globalThis.__PI_E2E_PLUGIN_DISPATCH__?.forwardedAnswers ?? []).length;
  const waitForForwarded = async (wanted, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (forwardedCount() >= wanted) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };
  forwardedButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await waitForForwarded(1, 5000);
  forwardedButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await waitForForwarded(2, 5000);
  return {
    bridge: {
      typeofPiDesktop: typeof window.piDesktop,
      piDesktopInWindow: "piDesktop" in window,
      descriptor: bridgeDescriptor
        ? { configurable: bridgeDescriptor.configurable, enumerable: bridgeDescriptor.enumerable }
        : null,
      // What the fixture module itself recorded when it was evaluated, so the
      // assertions measure the exposure from inside plugin code rather than
      // from the host's own copy of the same fact.
      pluginRealm: globalThis.__PI_E2E_PLUGIN_BRIDGE__ ?? null,
    },
    importMap: importMap ? JSON.parse(importMap.textContent) : null,
    hostReactVersion: host?.react?.version ?? null,
    mappedReactVersion: mapped.version ?? null,
    mappedIdentity: {
      useState: Boolean(host) && mapped.useState === host.react.useState,
      createElement: Boolean(host) && mapped.createElement === host.react.createElement,
      createPortal: Boolean(host) && mappedDom.createPortal === host.reactDom.createPortal,
      createRoot: Boolean(host) && mappedDomClient.createRoot === host.reactDomClient.createRoot,
    },
    pluginIdentity: plugin && host
      ? {
          useState: plugin.useState === host.react.useState,
          createElement: plugin.createElement === host.react.createElement,
        }
      : null,
    demoBadge:
      document.querySelector('[data-pi-plugin="acme.slots-demo"] .acme-slots-demo__badge')?.textContent ?? null,
    demoStyleInjected: Array.from(document.querySelectorAll("style")).some((node) =>
      (node.textContent ?? "").includes(".acme-slots-demo__badge"),
    ),
    counter: { before, afterFirst, afterTwo },
    pluginDispatch: globalThis.__PI_E2E_PLUGIN_DISPATCH__ ?? null,
    slotSurvivedRefusal: survivedRefusal,
  };
})()`;

/**
 * Launch the built app with a throwaway profile, install the example plugin and
 * the hook fixture through the host's own `plugins.loadDev`, wait until both
 * have rendered a slot component inside a transcript row, and read the window.
 */
async function inspectRendererWindow() {
  const { Host, resolveHostBinary } = await import("./e2e/host.mjs");
  const { assertDesktopBuild, resolveElectronBinary } = await import("./e2e/boot.mjs");
  const { appDir, electronBinary } = resolveElectronBinary(root);
  assertDesktopBuild(root);
  const hostBinary = resolveHostBinary();
  const runRoot = mkdtempSync(join(tmpdir(), "pi-plugin-slots-window-"));
  const dataDir = join(runRoot, "data");
  const profileDir = join(runRoot, "profile");
  const projectDir = join(runRoot, "project");
  const fixtureDir = join(runRoot, "plugins", "acme.e2e-slots");
  mkdirSync(join(fixtureDir, "renderer"), { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(fixtureDir, "main.js"), FIXTURE_MAIN);
  // The fixture declares two actions and calls a third: that is what makes a
  // refusal attributable to the missing declaration rather than to a plugin
  // that declared nothing at all, and what makes the declared `plugin.call`
  // forwardable to the headless entry above.
  writeFileSync(
    join(fixtureDir, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "acme.e2e-slots",
        name: "E2E slots fixture",
        version: "0.0.1",
        main: "main.js",
        renderer: "renderer/index.mjs",
        rendererActions: ["ui.toast", "plugin.call"],
        permissions: ["renderer.extension"],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(fixtureDir, "renderer", "index.mjs"), FIXTURE_RENDERER);

  const cdpPort = await freePort();
  let child = null;
  let client = null;
  const output = [];
  const capture = (chunk) => output.push(String(chunk));
  const describe = (error) =>
    `${error instanceof Error ? error.message : String(error)}\n` +
    `--- renderer console ---\n${(client?.console ?? []).join("\n")}\n` +
    `--- app output (tail) ---\n${output.join("").slice(-1_500)}`;
  try {
    // Seed first, through the host protocol, and let the seeding host exit: the
    // app starts its own host-core on the same data directory.
    const host = new Host(hostBinary, dataDir);
    let sessionId;
    await host.start();
    try {
      await host.call("workspace.set", { path: projectDir });
      const created = await host.call("session.create", {
        title: "Renderer slot journey",
        mode: "agent",
        projectPath: projectDir,
      });
      sessionId = created.session.id;
      await host.call("session.appendMessage", {
        sessionId,
        message: {
          id: randomUUID(),
          role: "user",
          content: "renderer slot journey",
          status: "complete",
          createdAt: new Date().toISOString(),
        },
      });
      // A development load enables a plugin with the permissions its manifest
      // declares, which is what makes both of them renderer candidates at boot.
      await host.call("plugins.loadDev", { path: EXAMPLE_PLUGIN });
      await host.call("plugins.loadDev", { path: fixtureDir });
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
            // The plugin launcher is a second page on the same document; only
            // the main window renders the shell and the transcript slots.
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
    await client.evaluate(`window.__PI_DESKTOP__.selectSession(${JSON.stringify(sessionId)})`);
    // The recorded exposure belongs to a plugin module that really ran, so the
    // bridge is not read until both slot components are on screen.
    await waitFor(
      () =>
        client.evaluate(
          `!!document.querySelector('[data-pi-plugin="acme.slots-demo"] .acme-slots-demo__badge')`,
        ),
      "the example plugin's slot component",
    );
    // Every button the probe clicks, so a probe click cannot land on a
    // component that is still on its way in.
    await waitFor(
      () =>
        client.evaluate(
          `!!document.querySelector('[data-pi-plugin="acme.e2e-slots"] button.pi-e2e-slots__bump') && !!document.querySelector('[data-pi-plugin="acme.e2e-slots"] button.pi-e2e-slots__undeclared') && !!document.querySelector('[data-pi-plugin="acme.e2e-slots"] button.pi-e2e-slots__forwarded')`,
        ),
      "the fixture plugin's slot component",
    );
    // The probe result plus the app's own process id: the forwarded answer
    // carries the pid of the entry that produced it, and this is what tells the
    // two apart — a pid that matches the app's main process would mean the
    // answer never left it.
    return { ...(await client.evaluate(RUNTIME_PROBE)), appPid: child?.pid ?? null };
  } catch (error) {
    throw new Error(describe(error));
  } finally {
    client?.close();
    if (child) await killTree(child);
    try {
      rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A held profile lock must not turn a completed journey into a failure.
    }
  }
}
const temp = mkdtempSync(join(tmpdir(), "pi-plugin-slots-e2e-"));

try {
  if (!existsSync(SDK_RENDERER)) {
    throw new Error("packages/plugin-sdk/dist is missing; run pnpm build:js first");
  }
  // The scheme name is read from the built SDK, not repeated here, so renaming
  // it can never leave the assertions passing against a stale literal.
  const { PLUGIN_RENDERER_SCHEME } = await import(pathToFileURL(SDK_RENDERER).href);
  const scheme = `${PLUGIN_RENDERER_SCHEME}:`;
  const html = readFileSync(INDEX_HTML, "utf8");

  // ── E2E-PLUGIN-renderer-csp-allows-plugin-modules ───────────────────────
  // Protects: a packaged renderer is a `file://` origin, so without the scheme
  // in `script-src` the plugin module never evaluates, and without it in
  // `connect-src` the fetch that loads it is blocked. Both hold in dev either
  // way, which is why only a build-contract check catches the regression.
  try {
    const csp = cspOf(html);
    assert(csp, "apps/desktop/index.html declares no Content-Security-Policy meta tag");
    const script = directiveSources(csp, "script-src");
    const connect = directiveSources(csp, "connect-src");
    assert(script, "the CSP declares no script-src");
    assert(connect, "the CSP declares no connect-src");
    assert(script.includes(scheme), `script-src does not allow ${scheme}`);
    assert(connect.includes(scheme), `connect-src does not allow ${scheme}`);
    record("E2E-PLUGIN-renderer-csp-allows-plugin-modules", true, `${scheme} in script-src and connect-src`);
  } catch (error) {
    record("E2E-PLUGIN-renderer-csp-allows-plugin-modules", false, error.message);
  }

  // ── E2E-PLUGIN-renderer-csp-rewrite-keeps-the-scheme ────────────────────
  // Protects: the build-time `tightenCsp()` rewrite replaces the whole
  // `connect-src` directive, so the scheme has to be listed in the replacement
  // itself. Running the real plugin over the real index.html is what proves it.
  try {
    const config = await bundleToCjs(VITE_CONFIG, {
      "electron-vite": "export const defineConfig = (config) => config;\nexport default defineConfig;",
      "@vitejs/plugin-react": "export default function react() { return { name: \"react-stub\" }; }",
      "@tailwindcss/vite": "export default function tailwindcss() { return { name: \"tailwind-stub\" }; }",
    }, "vite-config");
    const plugins = config.default.renderer.plugins;
    const plugin = plugins.find((entry) => entry.name === "pi-tighten-csp");
    assert(plugin?.transformIndexHtml, "the renderer config no longer registers pi-tighten-csp");
    const tightened = plugin.transformIndexHtml(html);
    assert(tightened !== html, "tightenCsp() no longer rewrites index.html");
    assert(!tightened.includes("'unsafe-eval'"), "the tightened CSP still ships 'unsafe-eval'");
    const csp = cspOf(tightened);
    assert(csp, "the tightened document declares no CSP");
    for (const directive of ["script-src", "connect-src"]) {
      const sources = directiveSources(csp, directive);
      assert(sources, `the tightened CSP declares no ${directive}`);
      assert(sources.includes(scheme), `${directive} lost ${scheme} in the build rewrite`);
    }
    const connect = directiveSources(csp, "connect-src");
    for (const devHost of ["ws://localhost:*", "http://localhost:*"]) {
      assert(!connect.includes(devHost), `connect-src kept the development host ${devHost}`);
    }
    record("E2E-PLUGIN-renderer-csp-rewrite-keeps-the-scheme", true, "script-src and connect-src survive the packaged rewrite");
  } catch (error) {
    record("E2E-PLUGIN-renderer-csp-rewrite-keeps-the-scheme", false, error.message);
  }

  // ── E2E-PLUGIN-renderer-scheme-privileges-and-mime-allowlist ────────────
  // Protects: the privileges Electron is told about before the app is ready
  // (a module fetch from a `file://` origin needs a standard, secure, fetchable,
  // CORS-enabled scheme), GET-only handling, and the MIME allowlist — `html`
  // staying out of it is what keeps the scheme from serving a navigable page.
  try {
    const files = join(temp, "plugin-files");
    mkdirSync(join(files, "renderer"), { recursive: true });
    writeFileSync(join(files, "renderer", "index.mjs"), "export function onLoad() {}\n");
    writeFileSync(join(files, "renderer", "index.js"), "export const js = true;\n");
    writeFileSync(join(files, "renderer", "panel.css"), ".acme-slots-demo__badge { opacity: 1; }\n");
    writeFileSync(join(files, "renderer", "data.json"), '{ "ok": true }\n');
    writeFileSync(join(files, "renderer", "index.mjs.map"), '{ "version": 3 }\n');
    writeFileSync(join(files, "renderer", "with space.mjs"), "export const spaced = true;\n");
    writeFileSync(join(files, "renderer", "view.html"), "<!doctype html>\n");

    const electron = await bundleToCjs(PROTOCOL_MODULE, {
      electron: `
export const protocol = {
  registerSchemesAsPrivileged(schemes) {
    globalThis.__PI_PROTOCOL_SCHEMES__ = schemes;
  },
  handle(name, handler) {
    globalThis.__PI_PROTOCOL_HANDLERS__ = { ...(globalThis.__PI_PROTOCOL_HANDLERS__ ?? {}), [name]: handler };
  },
};
`,
    }, "plugin-renderer-protocol");

    electron.registerPluginRendererScheme();
    const schemes = globalThis.__PI_PROTOCOL_SCHEMES__;
    assert.equal(schemes?.length, 1, "the scheme is not registered exactly once");
    assert.equal(schemes[0].scheme, PLUGIN_RENDERER_SCHEME, "a different scheme is registered");
    assert.deepEqual(
      schemes[0].privileges,
      { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
      `the privileges a fetched module needs changed: ${JSON.stringify(schemes[0].privileges)}`,
    );

    const pluginId = "acme.slots-demo";
    const resolverCalls = [];
    electron.installPluginRendererProtocol((resolvedId, requestPath) => {
      resolverCalls.push([resolvedId, requestPath]);
      if (resolvedId !== pluginId) return null;
      return join(files, requestPath);
    });
    const handler = globalThis.__PI_PROTOCOL_HANDLERS__?.[PLUGIN_RENDERER_SCHEME];
    assert(handler, `no handler installed for ${PLUGIN_RENDERER_SCHEME}`);

    const request = (path, method = "GET") =>
      handler(new Request(`plugin-renderer://${pluginId}/${path}`, { method }));

    const cases = [
      ["renderer/index.mjs", "text/javascript"],
      ["renderer/index.js", "text/javascript"],
      ["renderer/panel.css", "text/css"],
      ["renderer/data.json", "application/json"],
      ["renderer/index.mjs.map", "application/json"],
    ];
    for (const [path, contentType] of cases) {
      const response = await request(path);
      assert.equal(response.status, 200, `${path} answered ${response.status}, not 200`);
      assert.equal(
        response.headers.get("content-type"),
        contentType,
        `${path} was served as ${response.headers.get("content-type")}`,
      );
      assert.equal(response.headers.get("cache-control"), "no-store", `${path} is cacheable`);
      assert.equal(
        response.headers.get("x-content-type-options"),
        "nosniff",
        `${path} may be sniffed`,
      );
      assert.equal(
        await response.text(),
        readFileSync(join(files, path), "utf8"),
        `${path} was served with different bytes`,
      );
    }

    // A path is percent-decoded once, the way a module URL encodes it.
    assert.equal((await request("renderer/with%20space.mjs")).status, 200, "an encoded path is not decoded");
    assert(
      resolverCalls.some(([, path]) => path === "renderer/with space.mjs"),
      "the resolver saw an undecoded request path",
    );

    // `html` is deliberately not on the allowlist: the scheme serves module
    // graphs, not navigable pages.
    assert.equal((await request("renderer/view.html")).status, 404, "html is served by the scheme");

    // The method is checked before resolution: a POST never reaches a plugin.
    resolverCalls.length = 0;
    assert.equal((await request("renderer/index.mjs", "POST")).status, 404, "POST is served");
    assert.equal((await request("renderer/index.mjs", "HEAD")).status, 404, "HEAD is served");
    assert.equal(resolverCalls.length, 0, "a non-GET request reached the resolver");
    assert.equal((await request("")).status, 404, "an empty path is served");

    // A file the plugin package does not have, and a plugin whose grant was
    // revoked (the resolver answers null), are both plain 404s.
    assert.equal((await request("renderer/missing.mjs")).status, 404, "a missing file is served");
    const revoked = await handler(new Request("plugin-renderer://someone.else/renderer/index.mjs"));
    assert.equal(revoked.status, 404, "another plugin's source is reachable");
    record(
      "E2E-PLUGIN-renderer-scheme-privileges-and-mime-allowlist",
      true,
      "GET-only, 5 MIME types, html and revoked plugins refused",
    );
  } catch (error) {
    record("E2E-PLUGIN-renderer-scheme-privileges-and-mime-allowlist", false, error.message);
  }

  // ── E2E-PLUGIN-renderer-scheme-prepared-before-first-window ─────────────
  // Protects: Electron only accepts scheme privileges before the app is ready
  // and the handler has to be installed with the runtime's own gate, so the
  // call order in the boot sequence is a hard requirement, not style.
  try {
    const startup = readFileSync(STARTUP, "utf8");
    const registerAt = startup.indexOf("registerPluginRendererScheme()");
    const readyAt = startup.indexOf("app.whenReady()");
    const installAt = startup.indexOf("installPluginRendererProtocol(");
    assert(registerAt > -1, "the boot sequence never reserves the renderer scheme");
    assert(readyAt > -1, "the boot sequence no longer starts on app.whenReady()");
    assert(
      registerAt < readyAt,
      "the renderer scheme is reserved after app.whenReady(), which Electron refuses",
    );
    assert(installAt > readyAt, "the renderer protocol handler is installed before the app is ready");
    const wiring = callSource(startup.slice(installAt), "installPluginRendererProtocol");
    assert(wiring, "installPluginRendererProtocol() has no argument list");
    assert(
      /plugins\s*\.\s*resolveRendererSource\s*\(\s*pluginId\s*,\s*requestPath\s*\)/.test(wiring),
      `the handler is not wired to the runtime's gate: ${wiring.replace(/\s+/g, " ")}`,
    );
    record("E2E-PLUGIN-renderer-scheme-prepared-before-first-window", true, "reserved pre-ready, installed through plugins.resolveRendererSource");
  } catch (error) {
    record("E2E-PLUGIN-renderer-scheme-prepared-before-first-window", false, error.message);
  }

  // ── E2E-PLUGIN-renderer-entry-gated-by-declaration-and-grant ────────────
  // Protects: both entry points the renderer has (`rendererEntry` over IPC and
  // `resolveRendererSource` over the scheme) go through one gate that requires
  // BOTH the declared `manifest.renderer` and the live `renderer.extension`
  // grant. Dropping either half would serve plugin code to an unreviewed plugin.
  try {
    const runtime = readFileSync(PLUGIN_RUNTIME, "utf8");
    const gate = methodSource(runtime, "private rendererPlugin(");
    assert(gate, "plugin-runtime.ts no longer has a rendererPlugin() gate");
    assert(/this\.loaded\.get\(pluginId\)/.test(gate), "the gate does not require a loaded plugin");
    assert(/loaded\.disposing/.test(gate), "the gate does not exclude a plugin that is unloading");
    assert(/loaded\.manifest\.renderer/.test(gate), "the gate does not require a declared renderer entry");
    assert(
      /permissions\s*\.\s*has\(\s*"renderer\.extension"\s*\)/.test(gate),
      "the gate does not require the renderer.extension grant",
    );

    const entry = methodSource(runtime, "rendererEntry(pluginId: string)");
    assert(entry, "plugin-runtime.ts no longer has rendererEntry()");
    assert(/this\.rendererPlugin\(pluginId\)/.test(entry), "rendererEntry() does not go through the gate");

    const source = methodSource(runtime, "resolveRendererSource(pluginId: string, requestPath: string)");
    assert(source, "plugin-runtime.ts no longer has resolveRendererSource()");
    assert(/this\.rendererPlugin\(pluginId\)/.test(source), "resolveRendererSource() does not go through the gate");
    assert(/resolveInsidePlugin\(/.test(source), "resolveRendererSource() no longer confines the path to the plugin package");
    record("E2E-PLUGIN-renderer-entry-gated-by-declaration-and-grant", true, "declared entry + renderer.extension, one gate for IPC and scheme");
  } catch (error) {
    record("E2E-PLUGIN-renderer-entry-gated-by-declaration-and-grant", false, error.message);
  }

  // ── E2E-PLUGIN-renderer-entry-channel-whitelisted ───────────────────────
  // Protects: the renderer asks the main process for its entry path over one
  // channel, and the preload refuses every channel outside the derived
  // whitelist. A constant that is not in the set never reaches the main process.
  try {
    const protocol = await import(pathToFileURL(SHARED_PROTOCOL).href);
    const channel = "pi-desktop/plugin/renderer/entry";
    assert.equal(
      protocol.IPC.invoke.pluginRendererEntry,
      channel,
      "the renderer entry channel was renamed; update the preload contract and this check",
    );
    assert(
      protocol.IPC_WHITELIST.has(channel),
      "the renderer entry channel is not in the derived IPC whitelist",
    );
    const shared = readFileSync(SHARED_PROTOCOL, "utf8");
    assert(
      /IPC_WHITELIST\s*=\s*new Set<string>\(\[\s*\.\.\.Object\.values\(IPC\.invoke\)/.test(shared),
      "IPC_WHITELIST is no longer derived from IPC.invoke",
    );
    const preload = readFileSync(PRELOAD, "utf8");
    assert(
      /import\s*\{[^}]*IPC_WHITELIST[^}]*\}\s*from\s*"@pi-desktop\/shared\/protocol"/.test(preload),
      "the preload no longer imports the shared whitelist",
    );
    assert(/IPC_WHITELIST\.has\(channel\)/.test(preload), "the preload no longer enforces the whitelist");
    assert(
      /contextBridge\.exposeInMainWorld\(\s*"piDesktop"/.test(preload),
      "the preload no longer exposes the bridge the renderer host calls",
    );
    record("E2E-PLUGIN-renderer-entry-channel-whitelisted", true, `${channel} derived, enforced, exposed`);
  } catch (error) {
    record("E2E-PLUGIN-renderer-entry-channel-whitelisted", false, error.message);
  }

  // ── E2E-PLUGIN-slots-demo-manifest-and-entries ──────────────────────────
  // Protects: the example a plugin author copies has to pass the same manifest
  // validation an install runs, request the grant its entry needs, and point at
  // files that exist — host-core refuses a missing `main` or `renderer` file.
  try {
    const sdk = await import(pathToFileURL(SDK_INDEX).href);
    const manifest = JSON.parse(readFileSync(join(EXAMPLE_PLUGIN, "manifest.json"), "utf8"));
    const validation = sdk.validateManifest(manifest);
    assert.equal(validation.ok, true, `examples/plugins/slots-demo/manifest.json is invalid: ${validation.error}`);
    assert(
      (manifest.permissions ?? []).includes("renderer.extension"),
      "the example does not request renderer.extension, so its entry would never be served",
    );
    assert(typeof manifest.renderer === "string" && manifest.renderer, "the example declares no renderer entry");
    assert(
      existsSync(join(EXAMPLE_PLUGIN, manifest.renderer)),
      `the declared renderer entry is missing: ${manifest.renderer}`,
    );
    assert(typeof manifest.main === "string" && manifest.main, "the example declares no main entry");
    assert(existsSync(join(EXAMPLE_PLUGIN, manifest.main)), `the declared main entry is missing: ${manifest.main}`);

    const renderer = readFileSync(join(EXAMPLE_PLUGIN, manifest.renderer), "utf8");
    assert(
      (renderer.match(/pi\.slots\.register\(/g) ?? []).length >= 2,
      "the example registers fewer than two slots, so it no longer demonstrates the host",
    );
    for (const slot of ["entryExtra", "modal"]) {
      assert(renderer.includes(`"${slot}"`), `the example no longer registers the ${slot} slot`);
    }
    assert(/pi\.ui\.injectStyle\(/.test(renderer), "the example no longer injects a namespaced stylesheet");
    record("E2E-PLUGIN-slots-demo-manifest-and-entries", true, "manifest valid, renderer.extension granted, both entries present");
  } catch (error) {
    record("E2E-PLUGIN-slots-demo-manifest-and-entries", false, error.message);
  }

  // ── E2E-PLUGIN-renderer-bridge-global-reachable-recorded ────────────────
  // ── E2E-PLUGIN-renderer-one-react-via-import-map ────────────────────────
  // Records what same-realm execution really ships (ADR 0291), and only a real
  // window can answer either half. The import map is the mitigation: the
  // plugin-facing bare specifiers `react`, `react-dom` and `react-dom/client`
  // resolve to the host's single React. The preload global is a recorded
  // exposure, not a control: `contextBridge` defines `window.piDesktop`
  // non-configurable, so the `delete` in `bridge.ts` cannot work and plugin-realm
  // module code reaches the bridge and every channel the preload whitelist
  // carries — 219 invoke plus 23 event today. The journey boots the built app
  // with a throwaway profile, installs `examples/plugins/slots-demo` plus a
  // hook-using fixture through the host's own `plugins.loadDev`, waits until both
  // have rendered a slot component in a transcript row, and then reads the live
  // window — the same realm a plugin module already ran in.
  let journey = null;
  let journeyError = null;
  try {
    journey = await inspectRendererWindow();
  } catch (error) {
    journeyError = error;
  }
  const missingJourney = () =>
    journeyError?.message ?? "the renderer window journey did not run";

  try {
    assert(journey, missingJourney());
    assert.equal(
      journey.bridge.typeofPiDesktop,
      "object",
      `window.piDesktop is not reachable from plugin code: typeof ${journey.bridge.typeofPiDesktop}`,
    );
    assert.equal(
      journey.bridge.piDesktopInWindow,
      true,
      "window.piDesktop is not an own property of the window",
    );
    assert.equal(
      journey.bridge.descriptor?.configurable,
      false,
      `window.piDesktop is configurable, so the delete attempt could have removed it: descriptor=${JSON.stringify(journey.bridge.descriptor)}`,
    );
    const pluginRealm = journey.bridge.pluginRealm;
    assert(pluginRealm, "the fixture module recorded no reading of the preload global");
    assert.equal(
      pluginRealm.typeofPiDesktop,
      "object",
      `a plugin-realm module saw typeof window.piDesktop=${pluginRealm.typeofPiDesktop}`,
    );
    assert.equal(
      pluginRealm.piDesktopInWindow,
      true,
      "a plugin-realm module did not see piDesktop on the window",
    );
    assert.equal(
      pluginRealm.typeofInvoke,
      "function",
      `a plugin-realm module reached typeof piDesktop.invoke=${pluginRealm.typeofInvoke}`,
    );
    // The plugin realm and the shipped constants have to agree on the size of
    // the surface, so this keeps holding when a channel is added instead of
    // pinning today's numbers.
    const protocol = await import(pathToFileURL(SHARED_PROTOCOL).href);
    assert.equal(
      pluginRealm.invokeChannels,
      Object.keys(protocol.IPC.invoke).length,
      "the plugin realm reaches fewer invoke channels than the preload exposes",
    );
    assert.equal(
      pluginRealm.eventChannels,
      Object.keys(protocol.IPC.event).length,
      "the plugin realm reaches fewer event channels than the preload exposes",
    );
    record(
      "E2E-PLUGIN-renderer-bridge-global-reachable-recorded",
      true,
      `typeof window.piDesktop=${journey.bridge.typeofPiDesktop}, "piDesktop" in window=${journey.bridge.piDesktopInWindow}, descriptor=${JSON.stringify(journey.bridge.descriptor)}, plugin realm reached piDesktop.invoke and ${pluginRealm.invokeChannels} invoke + ${pluginRealm.eventChannels} event channels`,
    );
  } catch (error) {
    record(
      "E2E-PLUGIN-renderer-bridge-global-reachable-recorded",
      false,
      `${error.message} — window says ${JSON.stringify(journey?.bridge ?? null)}`,
    );
  }

  try {
    assert(journey, missingJourney());
    const imports = journey.importMap?.imports ?? null;
    assert(imports, "the renderer document declares no import map");
    assert.deepEqual(
      Object.keys(imports).sort(),
      ["react", "react-dom", "react-dom/client"],
      `the import map resolves something else: ${JSON.stringify(imports)}`,
    );
    for (const [specifier, url] of Object.entries(imports)) {
      assert(/^blob:/.test(url), `${specifier} maps to ${url}, not a host-generated module`);
    }
    assert(journey.hostReactVersion, "the host published no React namespace to the window");
    assert.equal(
      journey.mappedReactVersion,
      journey.hostReactVersion,
      "the mapped React is a different version from the host's",
    );
    for (const [name, same] of Object.entries(journey.mappedIdentity)) {
      assert(same, `the mapped ${name} is not the host's own binding`);
    }
    assert(journey.pluginIdentity, "the plugin recorded no react bindings, so it never ran");
    for (const [name, same] of Object.entries(journey.pluginIdentity)) {
      assert(same, `the plugin resolved a different React ${name}`);
    }
    assert(journey.demoBadge, "the example plugin's own component did not render in the host tree");
    assert(journey.demoStyleInjected, "the example plugin's injected stylesheet is missing");
    assert.match(
      journey.counter.before ?? "",
      /clicks=0/,
      `the fixture's first render is ${journey.counter.before}`,
    );
    assert.match(
      journey.counter.afterFirst ?? "",
      /clicks=1/,
      `a click did not re-render through the host's React: ${journey.counter.afterFirst}`,
    );
    assert.match(
      journey.counter.afterTwo ?? "",
      /clicks=2/,
      `the second click did not re-render: ${journey.counter.afterTwo}`,
    );
    record(
      "E2E-PLUGIN-renderer-one-react-via-import-map",
      true,
      `import map resolves react/react-dom/react-dom/client to host blobs; useState/createElement/createPortal/createRoot are the host's own bindings and the plugin's too; hooks round-tripped 0→1→2`,
    );
  } catch (error) {
    record(
      "E2E-PLUGIN-renderer-one-react-via-import-map",
      false,
      `${error.message} — window says ${JSON.stringify(
        journey
          ? {
              importMap: journey.importMap,
              hostReactVersion: journey.hostReactVersion,
              mappedReactVersion: journey.mappedReactVersion,
              mappedIdentity: journey.mappedIdentity,
              pluginIdentity: journey.pluginIdentity,
              demoBadge: journey.demoBadge,
              counter: journey.counter,
            }
          : null,
      )}`,
    );
  }

  // ── E2E-PLUGIN-renderer-slot-component-receives-dispatch ────────────────
  // Protects: the one way out of a slot component (ADR 0294 decision 1). The
  // prop is recorded by the plugin's own component, not read off the host's
  // copy of the same fact, because only the component can say what it was
  // handed — and a data-only `slotProps` object is exactly the shape this
  // interface replaced.
  try {
    assert(journey, missingJourney());
    const recorded = journey.pluginDispatch;
    assert(recorded, "the fixture's slot component recorded no props, so it never rendered");
    assert.equal(
      recorded.typeofDispatch,
      "function",
      `a slot component was handed typeof dispatch=${recorded.typeofDispatch}; the props it saw: ${recorded.propNames}`,
    );
    record(
      "E2E-PLUGIN-renderer-slot-component-receives-dispatch",
      true,
      `the fixture's slot component saw typeof dispatch=function; props: ${recorded.propNames}`,
    );
  } catch (error) {
    record(
      "E2E-PLUGIN-renderer-slot-component-receives-dispatch",
      false,
      `${error.message} — the fixture recorded ${JSON.stringify(journey?.pluginDispatch ?? null)}`,
    );
  }

  // ── E2E-PLUGIN-renderer-undeclared-action-refused ───────────────────────
  // Protects: a renderer module cannot call a verb its manifest does not
  // declare. The fixture declares `ui.toast` and calls `composer.replaceDraft`,
  // so an implementation that routed an action before reading the declaration
  // could not answer with this code, and neither could one that dropped the
  // call silently (ADR 0294 decisions 4 and 5).
  try {
    assert(journey, missingJourney());
    const recorded = journey.pluginDispatch;
    assert(recorded, "the fixture's slot component recorded nothing, so the probe never ran");
    assert.equal(
      recorded.undeclaredAction,
      "composer.replaceDraft",
      `the fixture called ${recorded.undeclaredAction}, not the undeclared action this check is about`,
    );
    assert.equal(
      recorded.refusalCode,
      "PLUGIN_ACTION_UNDECLARED",
      `an action the manifest does not declare was answered with code ${JSON.stringify(recorded.refusalCode)} and message ${JSON.stringify(recorded.refusalMessage)}`,
    );
    assert(
      typeof recorded.refusalMessage === "string" && recorded.refusalMessage.trim().length > 0,
      `the refusal carries no message: ${JSON.stringify(recorded.refusalMessage)}`,
    );
    record(
      "E2E-PLUGIN-renderer-undeclared-action-refused",
      true,
      `${recorded.undeclaredAction} was refused while ${recorded.declaredAction} is declared: ${recorded.refusalCode} — ${recorded.refusalMessage}`,
    );
  } catch (error) {
    record(
      "E2E-PLUGIN-renderer-undeclared-action-refused",
      false,
      `${error.message} — the fixture recorded ${JSON.stringify(journey?.pluginDispatch ?? null)}`,
    );
  }

  // ── E2E-PLUGIN-renderer-refused-dispatch-rejects-rather-than-throws ─────
  // Protects: the refusal travels back through the promise the interface
  // promises. A synchronous throw out of a slot component's handler is caught
  // by the host's slot boundary, which takes the whole component off screen
  // (D10), so this reads what the call returned and whether the plugin's own
  // component is still mounted after the click.
  try {
    assert(journey, missingJourney());
    const recorded = journey.pluginDispatch;
    assert(recorded, "the fixture's slot component recorded nothing, so the probe never ran");
    assert.equal(
      recorded.threwSynchronously,
      false,
      `dispatch() threw synchronously out of the component: code=${JSON.stringify(recorded.refusalCode)} message=${JSON.stringify(recorded.refusalMessage)}`,
    );
    assert.equal(
      recorded.returnedThenable,
      true,
      `dispatch() returned no promise, so a refusal has nowhere to arrive: ${JSON.stringify(recorded)}`,
    );
    assert.equal(
      recorded.rejected,
      true,
      `the refused dispatch did not reject; resolved=${JSON.stringify(recorded.resolved)}: ${JSON.stringify(recorded)}`,
    );
    assert(
      journey.slotSurvivedRefusal,
      "the fixture's component left the screen after the refused dispatch, which is what a synchronous throw under the slot boundary looks like",
    );
    record(
      "E2E-PLUGIN-renderer-refused-dispatch-rejects-rather-than-throws",
      true,
      "dispatch() returned a promise that rejected, nothing threw synchronously, and the slot component stayed mounted",
    );
  } catch (error) {
    record(
      "E2E-PLUGIN-renderer-refused-dispatch-rejects-rather-than-throws",
      false,
      `${error.message} — the fixture recorded ${JSON.stringify(journey?.pluginDispatch ?? null)}, slot survived the refusal: ${JSON.stringify(journey?.slotSurvivedRefusal)}`,
    );
  }

  // ── E2E-PLUGIN-renderer-call-round-trip ─────────────────────────────────
  // Protects: the forwarded half of the interface (ADR 0294 decision 4). A
  // slot component dispatches `plugin.call { method, args }` and the promise
  // resolves with what the plugin's own headless entry returned — a marker that
  // exists nowhere in the renderer, the method it was asked for, and the
  // arguments it was handed. The renderer records what it sent, so the check
  // compares an echo through the process boundary, not two copies of a literal.
  try {
    assert(journey, missingJourney());
    const recorded = journey.pluginDispatch;
    assert(recorded, "the fixture's slot component recorded nothing, so the probe never ran");
    assert.equal(
      recorded.forwardedStatus,
      "resolved",
      `the forwarded ${recorded.forwardedAction} call did not resolve: ${JSON.stringify(recorded.forwardedAnswers ?? null)}`,
    );
    const answers = recorded.forwardedAnswers ?? [];
    assert.equal(
      answers.length,
      2,
      `the probe clicked the forwarded button twice but recorded ${answers.length} resolution(s): ${JSON.stringify(answers)}`,
    );
    const first = answers[0];
    assert.equal(
      first.status,
      "resolved",
      `the forwarded call was answered with ${first.status}: code=${JSON.stringify(first.code)} message=${JSON.stringify(first.message)}`,
    );
    assert.equal(
      first.answer?.marker,
      "acme.e2e-slots/main.js:onRendererCall",
      `the answer carries no marker from the plugin's own entry: ${JSON.stringify(first.answer)}`,
    );
    assert.equal(
      first.answer?.method,
      first.sent?.method,
      `the entry was asked for ${JSON.stringify(first.sent?.method)} but answered for ${JSON.stringify(first.answer?.method)}`,
    );
    assert.deepEqual(
      first.answer?.args,
      first.sent?.args,
      `the entry did not echo the arguments the renderer sent: sent ${JSON.stringify(first.sent?.args)}, answered ${JSON.stringify(first.answer?.args)}`,
    );
    record(
      "E2E-PLUGIN-renderer-call-round-trip",
      true,
      `${recorded.forwardedAction} ${JSON.stringify(first.sent)} resolved with the entry's own answer ${JSON.stringify(first.answer)}`,
    );
  } catch (error) {
    record(
      "E2E-PLUGIN-renderer-call-round-trip",
      false,
      `${error.message} — the fixture recorded ${JSON.stringify(journey?.pluginDispatch ?? null)}`,
    );
  }

  // ── E2E-PLUGIN-renderer-call-runs-in-the-plugin-entry ───────────────────
  // Protects: "its own entry" (ADR 0294 decision 4). The fixture's headless
  // entry answers with a counter it increments per call and with its own pid, so
  // two clicks have to come back 1 then 2 from one and the same process. The
  // counter is state the renderer has no way to advance, and the pid must not be
  // the app's own main process — an answer produced there would be a host-side
  // imitation of the entry, not the entry.
  try {
    assert(journey, missingJourney());
    const answers = journey.pluginDispatch?.forwardedAnswers ?? [];
    assert.equal(
      answers.length,
      2,
      `the counter needs two resolved calls, recorded ${answers.length}: ${JSON.stringify(answers)}`,
    );
    const [first, second] = answers;
    assert.equal(
      first.answer?.counter,
      1,
      `the entry's first answer counted ${JSON.stringify(first.answer?.counter)}, not 1: ${JSON.stringify(first.answer)}`,
    );
    assert.equal(
      second.answer?.counter,
      2,
      `the entry's second answer counted ${JSON.stringify(second.answer?.counter)}, not 2 — the call did not re-enter the same entry: ${JSON.stringify(second.answer)}`,
    );
    assert.equal(
      typeof first.answer?.entryPid,
      "number",
      `the entry named no process: ${JSON.stringify(first.answer)}`,
    );
    assert.equal(
      second.answer?.entryPid,
      first.answer?.entryPid,
      `two calls to one entry were answered by different processes: ${first.answer?.entryPid} then ${second.answer?.entryPid}`,
    );
    assert.equal(
      typeof journey.appPid,
      "number",
      "the journey did not record the app's own process id, so the entry's pid cannot be told apart from it",
    );
    assert.notEqual(
      first.answer.entryPid,
      journey.appPid,
      `the answer came from the app's main process pid ${journey.appPid}, so the call never reached the plugin's own entry`,
    );
    record(
      "E2E-PLUGIN-renderer-call-runs-in-the-plugin-entry",
      true,
      `two clicks answered 1 then 2 by entry pid ${first.answer.entryPid}, which is not the app's pid ${journey.appPid}`,
    );
  } catch (error) {
    record(
      "E2E-PLUGIN-renderer-call-runs-in-the-plugin-entry",
      false,
      `${error.message} — the fixture recorded ${JSON.stringify(journey?.pluginDispatch ?? null)}, app pid ${JSON.stringify(journey?.appPid ?? null)}`,
    );
  }
} catch (error) {
  // A failure before the first check (missing build output, unusable toolchain)
  // still has to be reported as a failed scenario rather than as a crash, and it
  // must not borrow an id from a check that already ran.
  const headline = "E2E-PLUGIN-renderer-slots-survive-a-packaged-build";
  if (!results.some((result) => result.id === headline)) {
    record(headline, false, error instanceof Error ? error.stack ?? error.message : String(error));
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
  try {
    require("esbuild").stop();
  } catch {
    // esbuild was never loaded, so there is no service to stop.
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
