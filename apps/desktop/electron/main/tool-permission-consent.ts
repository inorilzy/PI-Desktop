import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow, MessageBoxOptions } from "electron";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import type { PermissionDecision } from "@pi-desktop/shared";

/**
 * The native confirmation for a tool the Agent wants to run.
 *
 * A tool-permission approval is the one place where the renderer must not be
 * able to decide: plugin code shares the document, the DOM and the JS realm
 * with the host UI, so anything it can read (including the broadcast
 * `tool_permission_request`) it can also forge, and any nonce or hidden field
 * that lives in the renderer is readable by that same code. The only
 * unforgeable answer is one this process owns, which is why the decision that
 * counts is the user's click in a main-process `showMessageBox` (the same
 * pattern as the plugin file/desktop consent dialogs).
 *
 * The prompt names the tool and shows the arguments and reason the host
 * recorded, never text a plugin authored, so a forged resolution cannot
 * relabel the request.
 *
 * `dialog` is imported lazily inside the service so the prompt shape below can
 * be asserted headlessly, without an Electron runtime.
 */

/** Largest argument preview the dialog shows; the rest is elided. */
export const MAX_ARGS_PREVIEW = 400;

/** What the main process needs to name in the prompt. */
export type ToolPermissionConsentRequest = {
  toolName: string;
  argsPreview?: unknown;
  risk?: "low" | "medium" | "high";
  reason?: string;
};

function argsPreviewText(argsPreview: unknown): string {
  if (argsPreview === undefined || argsPreview === null) return "";
  let text: string;
  if (typeof argsPreview === "string") {
    text = argsPreview;
  } else {
    try {
      text = JSON.stringify(argsPreview);
    } catch {
      text = String(argsPreview);
    }
  }
  return text.length > MAX_ARGS_PREVIEW ? `${text.slice(0, MAX_ARGS_PREVIEW)}…` : text;
}

/**
 * Buttons in the order Electron receives them; the index is the answer. Named
 * rather than written as bare numbers, because the test-only auto consent below
 * has to answer with the *same* index a click on "Allow once" produces.
 */
export const DENY_BUTTON_INDEX = 0;
export const ALLOW_ONCE_BUTTON_INDEX = 1;
export const ALLOW_SESSION_BUTTON_INDEX = 2;

/** Buttons in the order Electron receives them; the index is the answer. */
export function toolPermissionConsentDialogOptions(
  request: ToolPermissionConsentRequest,
  locale: string,
): MessageBoxOptions {
  const catalog = catalogs[resolveLocale(locale)];
  const strings = catalog.toolPermissionConsent;
  const preview = argsPreviewText(request.argsPreview);
  return {
    type: "warning",
    message: strings.message.replace("{tool}", request.toolName),
    detail: [
      request.risk ? catalog.permission.risk[request.risk] : "",
      preview ? strings.arguments.replace("{args}", preview) : "",
      request.reason ? strings.reason.replace("{reason}", request.reason) : "",
      strings.detail,
    ]
      .filter(Boolean)
      .join("\n\n"),
    buttons: [strings.deny, strings.allowOnce, strings.allowSession],
    // Escape and the red-X both land on Deny; a dismissed dialog must never
    // read as permission.
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

/** Anything that is not an explicit allow is a refusal. */
export function toolPermissionConsentAnswerFromResponse(
  response: number,
): PermissionDecision {
  if (response === ALLOW_ONCE_BUTTON_INDEX) return "allow-once";
  if (response === ALLOW_SESSION_BUTTON_INDEX) return "allow-session";
  return "deny";
}

/**
 * The test-only auto consent switch (spec 07-plugins/04 §6.2.1).
 *
 * An automated run cannot click a native dialog, so it opts in by dropping this
 * marker file into the data directory the run was started with — the same
 * `PI_DESKTOP_DATA_DIR` a suite already owns, which is why the switch is a file
 * and not a stray environment variable. The marker is honored *only* when the
 * build is not packaged, and only by answering "allow once": a packaged build
 * ignores it even when the file is there, and the user's click stays the only
 * way a tool is approved there.
 */
export const AUTO_CONSENT_MARKER_FILE = "e2e-auto-consent";

/** Where a run's opt-in marker lives: inside that run's own data directory. */
export function autoConsentMarkerPath(dataDir: string): string {
  return join(dataDir, AUTO_CONSENT_MARKER_FILE);
}

/**
 * The decision the test-only switch answers with, or null when it is off.
 * "Allow once" is produced by the *same* mapping a click uses
 * (`toolPermissionConsentAnswerFromResponse` with the "Allow once" index), so
 * the switch cannot grant anything the user could not have granted in one
 * click, and nothing downstream is bypassed.
 */
export function autoConsentDecision(input: {
  packaged: boolean;
  markerPresent: boolean;
}): PermissionDecision | null {
  if (input.packaged) return null;
  if (!input.markerPresent) return null;
  return toolPermissionConsentAnswerFromResponse(ALLOW_ONCE_BUTTON_INDEX);
}

/**
 * @param deps.getWindow the window to attach the dialog to, so the prompt
 *   cannot be lost behind it. A permission request can outlive the window and
 *   then the dialog stands on its own.
 * @param deps.dataDir the active data directory. The test-only auto consent
 *   marker is looked up inside it, so a run that did not start against that
 *   directory cannot be opted in by accident.
 * @param deps.isPackaged `app.isPackaged`, read from the caller so this module
 *   still imports without an Electron runtime. A packaged build never honors
 *   the marker.
 * @param deps.logAutoConsent one line per answer the test-only switch gave, so
 *   an automated run that auto-approved a tool leaves a trace in the log.
 */
export function createToolPermissionConsentService(deps: {
  getWindow: () => BrowserWindow | null;
  getLocale: () => string;
  dataDir: string;
  isPackaged: () => boolean | Promise<boolean>;
  logAutoConsent: (fields: {
    toolName: string;
    decision: PermissionDecision;
    marker: string;
  }) => void;
}): (request: ToolPermissionConsentRequest) => Promise<PermissionDecision> {
  return async (request) => {
    const marker = autoConsentMarkerPath(deps.dataDir);
    // Checked before anything else, and before this build's packagedness is
    // even read: a normal run has no marker, so the switch costs one stat and
    // cannot change what happens to a request. When it is honored, the answer
    // is the one a click on "Allow once" produces, and the request travels the
    // normal path with it — nothing downstream is bypassed.
    if (existsSync(marker)) {
      const decision = autoConsentDecision({
        packaged: await deps.isPackaged(),
        markerPresent: true,
      });
      if (decision) {
        deps.logAutoConsent({ toolName: request.toolName, decision, marker });
        return decision;
      }
    }
    const options = toolPermissionConsentDialogOptions(request, deps.getLocale());
    const { dialog } = await import("electron");
    const window = deps.getWindow();
    const result =
      window && !window.isDestroyed()
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
    return toolPermissionConsentAnswerFromResponse(result.response);
  };
}
