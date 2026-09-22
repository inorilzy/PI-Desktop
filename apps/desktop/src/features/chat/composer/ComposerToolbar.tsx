import { bridgePlatform } from "../../../lib/bridge";
import { useMemo, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { TFunction } from "i18next";
import {
  keybindingDisplayParts,
  type Mode,
  type PermissionMode,
  type ShortcutPlatform,
  type ThinkingLevel,
} from "@pi-desktop/shared";
import type { AppState } from "../../../stores/app-store";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { ContextUsageInspector } from "../../../components/ContextUsageInspector";
import { TooltipButton } from "../../../components/ui";
import {
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconPlus,
  IconSparkles,
  IconStop,
  IconUndo2,
} from "../../../components/icons";
import { ModeIcon } from "./ComposerModeIcon";
import { ComposerModelPicker } from "./ComposerModelPicker";
import {
  MODE_LABEL_KEYS,
  PERMISSION_MODE_I18N_KEYS,
  nextMode,
} from "./model";
import type { useComposerModelMenu } from "./hooks/useComposerModelMenu";
import { calculateContextUsage } from "../../../lib/context-usage";
import {
  ComposerControlSlot,
  type ComposerControlHandoff,
} from "./ComposerControlSlot";

type ModelMenuController = ReturnType<typeof useComposerModelMenu>;
type ContextUsage = Parameters<typeof ContextUsageInspector>[0];

export type ComposerToolbarProps = {
  t: TFunction;
  mode: Mode;
  planningLive: boolean;
  providerId?: string;
  modelId?: string;
  thinkingLevel: ThinkingLevel;
  composerPermissionMode: Exclude<PermissionMode, "inherit">;
  permissionOpen: boolean;
  setPermissionOpen: Dispatch<SetStateAction<boolean>>;
  controlsBlocked: boolean;
  pasting: boolean;
  pickAndAttach: () => Promise<void>;
  configureActiveSession: AppState["configureActiveSession"];
  showToast: AppState["showToast"];
  modelMenu: ModelMenuController;
  modelLabel: string;
  thinkingLabel: string;
  contextUsage: ContextUsage | null;
  enhancementDraft: string;
  value: string;
  modelReady: boolean;
  sendBlocked: boolean;
  enhancingPrompt: boolean;
  enhancementUndoText: string | null;
  enhancePrompt: () => Promise<void>;
  undoPromptEnhancement: () => void;
  clearEnhancementError: () => void;
  runActive: boolean;
  hasDraftContent: boolean;
  abort: AppState["abort"];
  submit: () => Promise<void>;
};

/** Composer controls: mode, permission, model, enhancement, and send/stop. */
export function ComposerToolbar({
  t,
  mode,
  planningLive,
  providerId,
  modelId,
  thinkingLevel,
  composerPermissionMode,
  permissionOpen,
  setPermissionOpen,
  controlsBlocked,
  pasting,
  pickAndAttach,
  configureActiveSession,
  showToast,
  modelMenu,
  modelLabel,
  thinkingLabel,
  contextUsage,
  enhancementDraft,
  value,
  modelReady,
  sendBlocked,
  enhancingPrompt,
  enhancementUndoText,
  enhancePrompt,
  undoPromptEnhancement,
  clearEnhancementError,
  runActive,
  hasDraftContent,
  abort,
  submit,
}: ComposerToolbarProps) {
  const platform = (bridgePlatform()) as ShortcutPlatform;
  const steeringShortcut = keybindingDisplayParts("Alt+Enter", platform).join("+");
  // The region immediately left of the send control is a plugin position
  // (`composerControl`, `beforeSend`). These are the three pieces the host
  // builds for it: the model picker, the context display, and the prompt
  // enhancement control. They are built exactly once — with nobody holding the
  // position the slot outlet draws them itself, and with a holder the host
  // hands the same elements over, so a piece the plugin renders is never drawn
  // twice (ComposerControlSlot).
  //
  // The one condition the host's enhancement control is disabled by. The region
  // hands it over as data as well (`enhancement.enabled`).
  const enhanceDisabled =
    !enhancementDraft.trim() ||
    enhancementDraft.trim().startsWith("/") ||
    !modelReady ||
    sendBlocked ||
    enhancingPrompt;
  const contextControl = contextUsage ? <ContextUsageInspector {...contextUsage} /> : null;
  const modelControl = (
    <ComposerModelPicker
      t={t}
      controller={modelMenu}
      modelLabel={modelLabel}
      thinkingLabel={thinkingLabel}
      thinkingLevel={thinkingLevel}
      selectedProviderId={providerId}
      selectedModelId={modelId}
      controlsBlocked={controlsBlocked}
      onCloseOtherMenus={() => setPermissionOpen(false)}
    />
  );
  const enhanceControl: ReactNode = (
    <>
      <TooltipButton
        type="button"
        className={`icon-btn icon-btn-square composer-enhance-btn${enhancingPrompt ? " is-loading" : ""}`}
        tooltip={t("chat.enhancePrompt")}
        ariaLabel={enhancingPrompt ? t("chat.enhancingPrompt") : t("chat.enhancePrompt")}
        aria-busy={enhancingPrompt}
        disabled={enhanceDisabled}
        onClick={() => void enhancePrompt()}
      >
        {enhancingPrompt ? (
          <>
            <span className="tool-spinner" aria-hidden="true" />
            <span>{t("chat.enhancingPrompt")}</span>
          </>
        ) : (
          <IconSparkles size={15} aria-hidden="true" />
        )}
      </TooltipButton>
      {enhancementUndoText !== null ? (
        <TooltipButton
          type="button"
          className="icon-btn icon-btn-square composer-enhance-undo"
          tooltip={t("chat.undoEnhancement")}
          ariaLabel={t("chat.undoEnhancement")}
          disabled={controlsBlocked}
          onClick={undoPromptEnhancement}
        >
          <IconUndo2 size={15} aria-hidden="true" />
        </TooltipButton>
      ) : null}
    </>
  );
  // The data behind those pieces, so a plugin handed the region can draw its
  // own version of any of them instead of only embedding the host's node.
  const modelSelection = useMemo(
    () => ({
      ...(providerId === undefined ? {} : { providerId }),
      ...(modelId === undefined ? {} : { modelId }),
      label: modelLabel,
      thinkingLevel,
      thinkingLabel,
      ready: modelReady,
    }),
    [providerId, modelId, modelLabel, thinkingLevel, thinkingLabel, modelReady],
  );
  const contextUsageData = useMemo(
    () =>
      contextUsage
        ? {
            ...calculateContextUsage(contextUsage.usage, contextUsage.contextWindow),
            contextWindow: contextUsage.contextWindow,
          }
        : null,
    [contextUsage],
  );
  const enhancement = useMemo(
    () => ({
      enabled: !enhanceDisabled,
      busy: enhancingPrompt,
      undoText: enhancementUndoText,
    }),
    [enhanceDisabled, enhancingPrompt, enhancementUndoText],
  );
  const regionHandoff: ComposerControlHandoff = {
    modelControl,
    modelSelection,
    contextControl,
    contextUsage: contextUsageData,
    enhanceControl,
    enhancement,
  };
  return (
    <div className="composer-toolbar">
      <div className="composer-left">
        <div className="composer-plus">
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square"
            tooltip={t("chat.addFiles")}
            ariaLabel={t("chat.addFiles")}
            disabled={controlsBlocked || pasting}
            onClick={() => {
              setPermissionOpen(false);
              void pickAndAttach();
            }}
          >
            <IconPlus size={15} aria-hidden="true" />
          </TooltipButton>
        </div>
        <TooltipButton
          type="button"
          className="icon-btn mode-chip composer-mode-chip"
          data-mode={mode}
          data-planning={planningLive ? "true" : undefined}
          tooltip={planningLive ? t(`${mode}.planning`) : t("settings.mode")}
          ariaLabel={planningLive ? t(`${mode}.planning`) : t("settings.mode")}
          disabled={controlsBlocked}
          onClick={async () => {
            modelMenu.setOpen(false);
            setPermissionOpen(false);
            const next: Mode = nextMode(mode);
            try {
              await configureActiveSession({
                mode: next,
                providerId,
                modelId,
                thinkingLevel,
              });
            } catch (error) {
              showToast(error instanceof Error ? error.message : String(error), {
                variant: "error",
              });
            }
          }}
        >
          <span className="composer-mode-chip-face" key={mode}>
            <ModeIcon mode={mode} />
            <span className="composer-mode-chip-label text-sm">
              {t(MODE_LABEL_KEYS[mode])}
            </span>
          </span>
        </TooltipButton>
        <AnchoredMenu
          className="composer-permission"
          open={permissionOpen && mode !== "goal"}
          onClose={() => setPermissionOpen(false)}
          menuClassName="composer-permission-menu"
          label={t("chat.permissionMode")}
          role="menu"
          align="start"
          side="top"
          trigger={(ref) => (
            <TooltipButton
              ref={ref}
              type="button"
              className={`icon-btn mode-chip ${permissionOpen ? "active" : ""}`}
              tooltip={
                mode === "goal"
                  ? `${t("chat.permissionMode")} · ${t("goal.autoWarning")}`
                  : mode === "plan" && composerPermissionMode === "auto"
                    ? `${t("chat.permissionMode")} · ${t("plan.autoWarning")}`
                    : t("chat.permissionMode")
              }
              ariaLabel={
                mode === "goal"
                  ? `${t("chat.permissionMode")} · ${t("goal.autoWarning")}`
                  : mode === "plan" && composerPermissionMode === "auto"
                    ? `${t("chat.permissionMode")} · ${t("plan.autoWarning")}`
                    : t("chat.permissionMode")
              }
              aria-haspopup={mode === "goal" ? undefined : "menu"}
              aria-expanded={mode === "goal" ? false : permissionOpen}
              disabled={controlsBlocked || mode === "goal"}
              onClick={() => {
                modelMenu.setOpen(false);
                setPermissionOpen((open) => !open);
              }}
            >
              <span className="text-sm">
                {t(PERMISSION_MODE_I18N_KEYS[composerPermissionMode])}
              </span>
              <IconChevronDown size={12} />
            </TooltipButton>
          )}
        >
          {(["ask", "accept-edits", "auto"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="menuitemradio"
              aria-checked={composerPermissionMode === candidate}
              disabled={controlsBlocked}
              className={`composer-plus-item ${composerPermissionMode === candidate ? "active" : ""}`}
              onClick={async () => {
                setPermissionOpen(false);
                try {
                  await configureActiveSession({
                    mode,
                    providerId,
                    modelId,
                    thinkingLevel,
                    permissionMode: candidate,
                  });
                } catch (error) {
                  showToast(error instanceof Error ? error.message : String(error), {
                    variant: "error",
                  });
                }
              }}
            >
              <span className="flex-1 text-left">
                {t(PERMISSION_MODE_I18N_KEYS[candidate])}
              </span>
              {composerPermissionMode === candidate ? <IconCheck size={13} /> : null}
            </button>
          ))}
        </AnchoredMenu>
        {/* The `composerControl` left position: the host's own controls above
          * are already drawn, so a plugin control can only follow them. */}
        <ComposerControlSlot position="left" draft={value} />
      </div>

      <div className="composer-right">
        {/* The region immediately left of the send control belongs to plugins
          * (`composerControl`, `beforeSend`). The three pieces above are the
          * host's own drawing of it: with nobody holding the position they are
          * what this mount renders, and with a holder they are handed over
          * instead — the same elements, so a piece the plugin renders is never
          * drawn twice. */}
        <ComposerControlSlot
          position="beforeSend"
          draft={value}
          handoff={regionHandoff}
        >
          {contextControl}
          {modelControl}
          {enhanceControl}
        </ComposerControlSlot>
        {runActive && !hasDraftContent ? (
          <TooltipButton
            type="button"
            className="stop-btn"
            tooltip={t("chat.stopGenerating")}
            ariaLabel={t("chat.stopGenerating")}
            onClick={() => void abort()}
          >
            <IconStop size={14} />
          </TooltipButton>
        ) : (
          <TooltipButton
            type="button"
            className="send-btn"
            ariaLabel={modelReady ? t("chat.send") : t("settings.addProvider")}
            tooltip={
              runActive
                ? t("chat.sendWhileRunning", { shortcut: steeringShortcut })
                : modelReady
                  ? t("chat.send")
                  : t("settings.addProvider")
            }
            disabled={
              !hasDraftContent ||
              sendBlocked ||
              (!modelReady && !value.trim().startsWith("/"))
            }
            onClick={() => void submit()}
          >
            <IconArrowUp size={15} />
          </TooltipButton>
        )}
        {/* The `composerControl` right position: after the host's send/stop
          * slot, so the primary action never moves. */}
        <ComposerControlSlot position="right" draft={value} />
      </div>
    </div>
  );
}
