import { bridgePlatform } from "../../lib/bridge";
import { Button, cx } from "../../components/ui";
import { IconCheck, IconShield, IconSparkles, IconTriangleAlert } from "../../components/icons";
import { PluginInstallDialog } from "../../components/plugins/PluginInstallDialog";
import { PluginSettingsSheet } from "../../components/plugins/PluginSettingsSheet";
import { useAppStore } from "../../stores/app-store";
import {
  RISK_LABEL_KEYS,
  RISK_TIERS,
  TEMPLATE_IDS,
  declarationLabel,
  permissionLabel,
  permissionRisk,
  rendererDeclaration,
} from "./model";
import type { PluginsPageModel } from "./usePluginsPage";
import type { PluginManifestEntries, PluginPermissionReview } from "@pi-desktop/shared";

export function PluginDialogs({
  t,
  pendingInstall,
  setPendingInstall,
  pendingReview,
  setPendingReview,
  confirmReview,
  autoUpdate,
  setAutoUpdate,
  busyId,
  confirmInstall,
  installJob,
  cancelInstallDownload,
  retryInstall,
  closeInstallDialog,
  settingsPlugin,
  setSettingsPlugin,
  refreshPlugins,
  templatePick,
  creating,
  setTemplatePick,
  createFromTemplate,
}: PluginsPageModel) {
  return (
    <>
    {pendingReview ? (
        <div className="plugins-modal-backdrop" role="presentation">
          <div
            className="plugins-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("plugins.permissionReview")}
          >
            <header className="plugins-modal-head">
              <span className="plugins-modal-icon" aria-hidden>
                <IconShield size={17} />
              </span>
              <div>
                <h2 className="plugins-modal-title">
                  {t(
                    pendingReview.kind === "reload"
                      ? "plugins.devReviewNewTitle"
                      : "plugins.devReviewTitle",
                    { name: pendingReview.name },
                  )}
                </h2>
                {pendingReview.version ? (
                  <p className="plugins-modal-subtitle">
                    {t("plugins.installingVersion", { version: pendingReview.version })}
                  </p>
                ) : null}
              </div>
            </header>

            <div className="plugins-modal-body">
              <p className="plugins-modal-lede">{t("plugins.devReviewBody")}</p>
              <RendererDeclaration t={t} plugin={pendingReview} />
              <TrustTierNotice t={t} entries={pendingReview.entries} />
              <PermissionGroups
                t={t}
                permissions={pendingReview.permissions}
                newPermissions={pendingReview.addedPermissions}
              />
            </div>

            <div className="plugins-modal-actions">
              <Button variant="secondary" onClick={() => setPendingReview(null)}>
                {t("plugins.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={busyId === pendingReview.id}
                onClick={() => void confirmReview()}
              >
                {busyId === pendingReview.id
                  ? t("plugins.devReviewLoading")
                  : t("plugins.devReviewAccept")}
              </Button>
            </div>
          </div>
        </div>
    ) : null}
    {pendingInstall ? (
        <div className="plugins-modal-backdrop" role="presentation">
          <div
            className="plugins-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("plugins.permissionReview")}
          >
            <header className="plugins-modal-head">
              <span className="plugins-modal-icon" aria-hidden>
                <IconShield size={17} />
              </span>
              <div>
                <h2 className="plugins-modal-title">
                  {t("plugins.permissionReviewTitle", { name: pendingInstall.name })}
                </h2>
                {pendingInstall.version ? (
                  <p className="plugins-modal-subtitle">
                    {t("plugins.installingVersion", { version: pendingInstall.version })}
                  </p>
                ) : null}
              </div>
            </header>

            <div className="plugins-modal-body">
              <p className="plugins-modal-lede">{t("plugins.permissionReviewBody")}</p>
              <PermissionGroups
                t={t}
                permissions={pendingInstall.permissions}
                newPermissions={pendingInstall.newPermissions}
              />
            </div>

            <div className="plugins-switch-row">
              <span className="plugins-switch-label">
                {t("plugins.enableAutoUpdateOnInstall")}
              </span>
              <button
                type="button"
                className={cx("settings-toggle", autoUpdate && "on")}
                role="switch"
                aria-checked={autoUpdate}
                aria-label={t("plugins.enableAutoUpdateOnInstall")}
                onClick={() => setAutoUpdate((on) => !on)}
              >
                <span className="settings-toggle-thumb" />
              </button>
            </div>

            <div className="plugins-modal-actions">
              <Button variant="secondary" onClick={() => setPendingInstall(null)}>
                {t("plugins.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={busyId === pendingInstall.id}
                onClick={() => void confirmInstall()}
              >
                {busyId === pendingInstall.id
                  ? t("plugins.installing")
                  : t("plugins.acceptInstall")}
              </Button>
            </div>
          </div>
        </div>
    ) : null}
      {installJob ? (
        <PluginInstallDialog
          job={installJob}
          onCancel={cancelInstallDownload}
          onRetry={retryInstall}
          onClose={closeInstallDialog}
        />
      ) : null}
      {settingsPlugin ? (
        <PluginSettingsSheet
          plugin={settingsPlugin}
          platform={(bridgePlatform()) as "darwin" | "win32" | "linux"}
          onClose={() => setSettingsPlugin(null)}
          onSaved={async () => {
            await refreshPlugins();
            const updated = useAppStore
              .getState()
              .plugins.find((plugin) => plugin.id === settingsPlugin.id);
            if (updated) setSettingsPlugin(updated);
          }}
        />
      ) : null}
      {templatePick ? (
        <div className="plugins-modal-backdrop" role="presentation">
          <div
            className="plugins-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("plugins.newFromTemplateTitle")}
          >
            <header className="plugins-modal-head">
              <span className="plugins-modal-icon" aria-hidden>
                <IconSparkles size={17} />
              </span>
              <div>
                <h2 className="plugins-modal-title">
                  {t("plugins.newFromTemplateTitle")}
                </h2>
              </div>
            </header>

            <div className="plugins-modal-body">
              <div
                className="plugins-template-list"
                role="radiogroup"
                aria-label={t("plugins.newFromTemplateTitle")}
              >
                {TEMPLATE_IDS.map((template) => {
                  const active = templatePick === template;
                  return (
                    <button
                      key={template}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={cx("plugins-template", active && "active")}
                      onClick={() => setTemplatePick(template)}
                    >
                      <span className="plugins-template-mark" aria-hidden>
                        {active ? <IconCheck size={13} /> : null}
                      </span>
                      <span className="plugins-template-copy">
                        <strong className="plugins-template-name">
                          {t(`plugins.templateName.${template}`)}
                        </strong>
                        <span className="plugins-template-body">
                          {t(`plugins.templateBody.${template}`)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="plugins-modal-actions">
              <Button
                variant="secondary"
                data-action="cancel"
                disabled={creating}
                onClick={() => setTemplatePick(null)}
              >
                {t("plugins.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={creating}
                onClick={() => void createFromTemplate(templatePick)}
              >
                {creating
                  ? t("plugins.newFromTemplateCreating")
                  : t("plugins.newFromTemplateCreate")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
/**
 * One permission list, shared by the install review and the development review:
 * both answer the same question, so they must not drift into two renderings of
 * the same risk data.
 */
function PermissionGroups({
  t,
  permissions,
  newPermissions,
}: {
  t: PluginsPageModel["t"];
  permissions: string[];
  newPermissions: string[];
}) {
  if (!permissions.length) {
    return <p className="plugins-modal-lede">{t("plugins.noPermissions")}</p>;
  }
  return (
    <>
      {RISK_TIERS.map((tier) => {
        const scoped = permissions.filter(
          (permission) => permissionRisk(permission) === tier,
        );
        if (!scoped.length) return null;
        return (
          <div key={tier} className={cx("plugins-risk-group", `risk-${tier}`)}>
            <div className="plugins-risk-head">
              {tier === "high" ? (
                <IconTriangleAlert size={13} />
              ) : (
                <IconShield size={13} />
              )}
              {t(RISK_LABEL_KEYS[tier])}
              <span className="plugins-risk-count">{scoped.length}</span>
            </div>
            <ul className="plugins-perm-list is-plain">
              {scoped.map((permission) => (
                <li key={permission}>
                  <span className="plugins-perm-copy">
                    <strong>
                      {permissionLabel(permission, t)}
                      {newPermissions.includes(permission) ? (
                        <span className="plugins-tag is-update">
                          {t("plugins.newPermission")}
                        </span>
                      ) : null}
                    </strong>
                    <span>
                      {t(`plugins.permissionHelp.${permission}`, {
                        defaultValue: permission,
                      })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}

/**
 * The trust tier an install is asking for (spec 07-plugins/16 §2A.1).
 *
 * Only entries that run outside a sandbox are listed, and they are listed
 * before the permissions because this is the part a permission name cannot
 * carry on its own: `renderer.extension` says "code in the app window", and
 * what that means for the user is what this line is for. A base-tier plugin
 * shows nothing here.
 */
function TrustTierNotice({
  t,
  entries,
}: {
  t: PluginsPageModel["t"];
  entries?: PluginManifestEntries;
}) {
  const rows: Array<{ key: string; label: string; help: string }> = [];
  if (entries?.renderer) {
    rows.push({ key: "renderer", label: "renderer", help: "rendererHelp" });
  }
  if (entries?.agent) {
    rows.push({ key: "agent", label: "agent", help: "agentHelp" });
  }
  if (!rows.length) return null;
  return (
    <div className="plugins-trust-tier" role="note">
      {rows.map((row) => (
        <p className="plugins-trust-tier-row" data-tier={row.key} key={row.key}>
          <IconShield size={14} aria-hidden />
          <strong>{t(`plugins.trustTier.${row.label}`)}</strong>
          <span>{t(`plugins.trustTier.${row.help}`)}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * What the manifest being reviewed declares the plugin's own UI code will read
 * and call (issue #528).
 *
 * An informational list, not a decision: the values the host understands are
 * named, anything else is shown exactly as the author wrote it, and the block
 * itself stays away when nothing was declared. It sits above the access list so
 * "what it declared" and "what it may do" stay two separate questions.
 *
 * The prop is the review that carried the declarations, never an installed
 * plugin's row: a review may only state what the manifest it is asking about
 * declares, and the install and update reviews do not hold that manifest yet.
 */
function RendererDeclaration({
  t,
  plugin,
}: {
  t: PluginsPageModel["t"];
  plugin?: PluginPermissionReview | null;
}) {
  const declaration = rendererDeclaration(plugin);
  if (!declaration) return null;
  return (
    <div className="plugins-declaration" role="note">
      <p className="plugins-declaration-title">{t("plugins.declaration.title")}</p>
      {declaration.data.length ? (
        <div className="plugins-declaration-group" data-kind="data">
          <p className="plugins-declaration-label">
            {t("plugins.declaration.dataLabel")}
          </p>
          <ul className="plugins-declaration-list">
            {declaration.data.map((value) => (
              <li key={value}>{declarationLabel("data", value, t)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {declaration.actions.length ? (
        <div className="plugins-declaration-group" data-kind="actions">
          <p className="plugins-declaration-label">
            {t("plugins.declaration.actionsLabel")}
          </p>
          <ul className="plugins-declaration-list">
            {declaration.actions.map((value) => (
              <li key={value}>{declarationLabel("actions", value, t)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
