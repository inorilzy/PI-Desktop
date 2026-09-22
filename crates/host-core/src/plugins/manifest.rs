use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    /// Headless entry. Optional since the renderer host landed; `has_entry`
    /// holds the rule that one of the three entries still exists.
    #[serde(default)]
    pub main: String,
    /// Trusted renderer entry (spec 07-plugins/16): a plugin-relative ES module
    /// the host renderer evaluates lazily. Requires `renderer.extension`.
    #[serde(default)]
    pub renderer: Option<String>,
    /// `manifest.rendererData`: the host data keys a trusted renderer module
    /// wants handed to its slot components. A declaration, not a permission
    /// (ADR 0294): naming a key grants nothing, and declaring one without
    /// `renderer` still validates.
    #[serde(default, rename = "rendererData")]
    pub renderer_data: Vec<String>,
    /// `manifest.rendererActions`: the host actions a trusted renderer module
    /// may dispatch, from the host-owned vocabulary. Also a declaration, not a
    /// permission (ADR 0294).
    #[serde(default, rename = "rendererActions")]
    pub renderer_actions: Vec<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Display strings per locale — `{ "en": { name, description, safetyNotes },
    /// "zh-CN": { … } }` — resolved against the application locale whenever a
    /// row is read. The flat `name`/`description` above stay the author's own
    /// language and are the last-resort fallback.
    #[serde(default)]
    pub i18n: Option<PluginI18nMap>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub contributes: Option<Value>,
    #[serde(default)]
    pub ui: Option<PluginUiMeta>,
    #[serde(default)]
    pub fs: Option<Value>,
    /// First-registration default for bundled plugins. Marketplace/dev
    /// installs still enable after the user grants permissions.
    #[serde(default, rename = "enabledByDefault")]
    pub enabled_by_default: Option<bool>,
}

impl PluginManager {
    pub(crate) fn read_manifest(path: &Path) -> Result<PluginManifest> {
        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            bail!("PLUGIN_INVALID: manifest.json missing");
        }
        let raw = fs::read_to_string(&manifest_path)
            .with_context(|| format!("read manifest {}", manifest_path.display()))?;
        let manifest: PluginManifest =
            serde_json::from_str(&raw).map_err(|e| anyhow!("PLUGIN_INVALID: {e}"))?;
        if manifest.id.trim().is_empty() {
            bail!("PLUGIN_INVALID: id required");
        }
        if manifest.name.trim().is_empty() || manifest.version.trim().is_empty() {
            bail!("PLUGIN_INVALID: name/version required");
        }
        // Relaxing `main` must not produce a plugin that cannot run at all.
        if !manifest.has_entry() {
            bail!("PLUGIN_INVALID: one of main/renderer/panel/view/destination required");
        }
        if !manifest.main.trim().is_empty() {
            let main_path = path.join(&manifest.main);
            if !main_path.exists() {
                bail!("PLUGIN_LOAD_FAILED: main entry missing");
            }
        }
        if let Some(renderer) = manifest
            .renderer
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !manifest
                .permissions
                .iter()
                .any(|p| p == "renderer.extension")
            {
                bail!("PLUGIN_INVALID: renderer requires the renderer.extension permission");
            }
            if !path.join(renderer).exists() {
                bail!("PLUGIN_LOAD_FAILED: renderer entry missing");
            }
        }
        if let Some(ui) = &manifest.ui {
            if let Some(panel) = &ui.panel {
                let panel_path = path.join(panel);
                if !panel_path.exists() {
                    bail!("PLUGIN_INVALID: ui.panel missing");
                }
            }
        }
        validate_renderer_declarations(&manifest)?;
        validate_contributions(path, &manifest)?;
        Ok(manifest)
    }
}

impl PluginManifest {
    /// A plugin must be reachable through one of three entries: the headless
    /// module (`main`), the trusted renderer module (`renderer`), or a
    /// plugin-owned page. Contributions that are not entries — agent
    /// extensions, services, providers, themes — do not make a plugin runnable.
    pub fn has_entry(&self) -> bool {
        if !self.main.trim().is_empty() {
            return true;
        }
        if self
            .renderer
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        {
            return true;
        }
        if self
            .ui
            .as_ref()
            .and_then(|ui| ui.panel.as_deref())
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        {
            return true;
        }
        self.contributes.as_ref().is_some_and(contributes_has_entry)
    }
}

/// `contributes.views[].entry` / `contributes.settingsDestinations[].entry` are
/// entries too, which is why `contributes` has to be read structurally here.
fn contributes_has_entry(contributes: &Value) -> bool {
    ["views", "settingsDestinations"].iter().any(|key| {
        contributes
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(|entries| !entries.is_empty())
    })
}
