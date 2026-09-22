/**
 * The host-side mounting point for component slots (ADR 0291, contract v4).
 *
 * A plugin registers a component; this is where the host puts it.
 *
 * - `data-pi-plugin="<id>"` wraps every plugin surface; the host auto-scopes
 *   plugin CSS under that container and stamps `data-pi-theme` when known.
 * - Each registration gets its own error boundary (D10).
 * - Loading is lazy: the first real render of a slot.
 * - Every component is handed `dispatch` bound to its plugin (ADR 0294).
 * - Ambient props (`theme` / `locale`) are merged only when the plugin
 *   declared them in `rendererData` (ADR 0294 D7, narrowed — not a push
 *   engine). Replace slots render at most the claim owner; an empty claim
 *   falls back to host `children`.
 */
import { Component, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import {
  PLUGIN_RENDERER_UNSERVED_DATA,
  isPluginRendererReplaceSlot,
  type PiRendererAmbientProps,
  type PluginRendererSlot,
} from "@pi-desktop/plugin-sdk";
import {
  disposeRendererPlugin,
  ensureRendererPlugin,
  loadedRendererPlugins,
  rememberRendererActions,
} from "../renderer-host/loader";
import { slotDispatchFor } from "../renderer-host/relay";
import { pluginSlots, type PluginSlotRegistration } from "./registry";

/** A plugin that may fill slots, as the shell knows it from its own plugin row. */
export type RendererCandidate = {
  id: string;
  version?: string;
  declared: boolean;
  rendererData: string[];
  rendererActions: string[];
};

export type PluginSlotBoundaryProps = {
  registration: PluginSlotRegistration;
  fallback: ReactNode;
  children: ReactNode;
};
type BoundaryState = { failed: boolean };

export class PluginSlotBoundary extends Component<PluginSlotBoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    pluginSlots.report({
      pluginId: this.props.registration.pluginId,
      slot: this.props.registration.slot,
      code: "PLUGIN_SLOT_RENDER_FAILED",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function useSlotRegistrations(slot: PluginRendererSlot): PluginSlotRegistration[] {
  const version = useSyncExternalStore(
    pluginSlots.subscribe,
    pluginSlots.snapshot,
    pluginSlots.snapshot,
  );
  return useMemo(
    () => pluginSlots.list(slot),
    [slot, version],
  );
}

/** Host theme as the document reports it. Defaults to dark. */
export function readHostTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  const el = document.documentElement as
    | (HTMLElement & { dataset?: DOMStringMap })
    | null
    | undefined;
  if (!el) return "dark";
  const raw =
    typeof el.getAttribute === "function"
      ? el.getAttribute("data-theme")
      : el.dataset?.theme;
  return raw === "light" ? "light" : "dark";
}

/** Host UI locale as the document reports it. */
export function readHostLocale(): string {
  if (typeof document === "undefined") return "en";
  const el = document.documentElement as HTMLElement | null | undefined;
  if (!el) return "en";
  const lang =
    (typeof el.getAttribute === "function" ? el.getAttribute("lang") : null) ||
    el.lang ||
    (el as { dataset?: DOMStringMap }).dataset?.lang;
  return lang || "en";
}

function subscribeTheme(listener: () => void): () => void {
  if (
    typeof document === "undefined" ||
    typeof MutationObserver === "undefined" ||
    !document.documentElement ||
    typeof document.documentElement.getAttribute !== "function"
  ) {
    return () => {};
  }
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "lang"],
  });
  return () => observer.disconnect();
}

function themeSnapshot(): string {
  return `${readHostTheme()}|${readHostLocale()}`;
}

/**
 * Ambient props for one plugin, gated by its declared `rendererData`.
 * Slot-contract props are never produced here.
 */
export function ambientPropsFor(
  candidate: RendererCandidate | undefined,
  sources?: { theme?: "light" | "dark"; locale?: string },
): PiRendererAmbientProps {
  if (!candidate) return {};
  const declared = new Set(candidate.rendererData);
  const out: PiRendererAmbientProps = {};
  if (declared.has("theme")) out.theme = sources?.theme ?? readHostTheme();
  if (declared.has("locale")) out.locale = sources?.locale ?? readHostLocale();
  return out;
}

const unservedReported = new Set<string>();

/** Report declarable-but-unserved data keys once per plugin per session. */
export function reportUnservedData(candidate: RendererCandidate | undefined): void {
  if (!candidate) return;
  for (const key of candidate.rendererData) {
    if (!(PLUGIN_RENDERER_UNSERVED_DATA as readonly string[]).includes(key)) continue;
    const token = `${candidate.id}:${key}`;
    if (unservedReported.has(token)) continue;
    unservedReported.add(token);
    pluginSlots.report({
      pluginId: candidate.id,
      code: "PLUGIN_DATA_UNSERVED",
      detail: `rendererData "${key}" is declarable but not served this cycle`,
    });
  }
}

/** Test seam. */
export function resetUnservedDataReports(): void {
  unservedReported.clear();
}

export type PluginSlotProps = {
  slot: PluginRendererSlot;
  /** Slot-contract props from the mount (spec 07-plugins/16). */
  slotProps?: Record<string, unknown>;
  candidates?: readonly RendererCandidate[];
  registrations?: readonly PluginSlotRegistration[];
  containerProps?: Record<string, unknown>;
  children?: ReactNode;
};

/**
 * Render the registrations this mount owns. Replace slots show at most one
 * claim owner; an empty list falls back to host `children`.
 */
export function PluginSlot({
  slot,
  slotProps,
  candidates = [],
  registrations,
  containerProps,
  children,
}: PluginSlotProps) {
  const registered = useSlotRegistrations(slot);
  const themeLocaleKey = useSyncExternalStore(subscribeTheme, themeSnapshot, themeSnapshot);
  const candidateKey = candidates.map((candidate) => candidate.id).join(",");
  const latest = useRef(candidates);
  latest.current = candidates;
  for (const candidate of candidates) {
    rememberRendererActions(candidate.id, candidate.rendererActions);
  }

  useEffect(() => {
    const present = new Set(latest.current.map((candidate) => candidate.id));
    for (const pluginId of loadedRendererPlugins()) {
      if (!present.has(pluginId)) void disposeRendererPlugin(pluginId);
    }
    for (const candidate of latest.current) {
      if (!candidate.declared) continue;
      reportUnservedData(candidate);
      void ensureRendererPlugin(candidate.id, {
        declared: candidate.declared,
        version: candidate.version,
        actions: candidate.rendererActions,
      });
    }
  }, [candidateKey]);

  const owned = registrations ?? registered;
  const shown =
    registrations !== undefined
      ? owned
      : isPluginRendererReplaceSlot(slot)
        ? owned.slice(0, 1)
        : owned;

  if (!shown.length) return <>{children ?? null}</>;

  return (
    <>
      {shown.map((registration, index) => {
        const PluginComponent = registration.component;
        const candidate = candidates.find((item) => item.id === registration.pluginId);
        const ambient = ambientPropsFor(candidate);
        return (
          <PluginSlotBoundary
            key={`${registration.pluginId}:${slot}:${index}`}
            registration={registration}
            fallback={children ?? null}
          >
            <div
              {...containerProps}
              className="pi-plugin-slot"
              data-pi-plugin={registration.pluginId}
              data-pi-plugin-slot={slot}
              data-pi-theme={ambient.theme ?? readHostTheme()}
            >
              <PluginComponent
                {...(slotProps ?? {})}
                {...ambient}
                dispatch={slotDispatchFor(registration.pluginId)}
              />
            </div>
          </PluginSlotBoundary>
        );
      })}
    </>
  );
}
