import { IPC, type Result } from "@pi-desktop/shared";

/**
 * The preload bridge, captured once at import time.
 *
 * A trusted plugin's renderer code runs in this same realm (ADR 0291), so the
 * realm is not a boundary and this global is not hidden from it. The module
 * used to attempt `delete globalThis.piDesktop` and export whether it worked;
 * the attempt cannot work, because `contextBridge.exposeInMainWorld` defines the
 * property non-configurable, so `delete` is a silent no-op. A real Electron run
 * measured `typeof window.piDesktop === "object"`, `"piDesktop" in window ===
 * true`, and `piDesktop.invoke` reaching all 243 whitelisted channels (220
 * invoke + 23 event) with no per-caller check.
 *
 * The capture stays because it is the shell's single typed handle on the bridge
 * and every shell module reads it through here — not because the global goes
 * away. Plugins are trusted and broadly permissioned on purpose: the boundary is
 * marketplace review plus install-time consent, not a sandbox (ADR 0291).
 */
export type PiDesktopBridge = {
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<Result<T>>;
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
  channels: typeof IPC;
  platform: NodeJS.Platform;
  locale?: string;
  getDroppedFilePath?: (file: File) => string | null;
};

type BridgeGlobal = { piDesktop?: PiDesktopBridge };

const globalScope = globalThis as BridgeGlobal;

const bridge: PiDesktopBridge | null = globalScope.piDesktop ?? null;

/** The captured bridge, or null in a browser-only context (tests, previews). */
export function getBridge(): PiDesktopBridge | null {
  return bridge;
}

/**
 * The platform string shortcut rendering keys off. Falls back to `darwin` for
 * the contexts that have no bridge at all.
 */
export function bridgePlatform(fallback = "darwin"): string {
  return bridge?.platform ?? fallback;
}

/** The locale the preload resolved, if there was a bridge to ask. */
export function bridgeLocale(): string | undefined {
  return bridge?.locale;
}
