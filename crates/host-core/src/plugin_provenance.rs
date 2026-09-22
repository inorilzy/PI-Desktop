//! Who asked for a row: the plugin provenance a continuation carries.
//!
//! ADR 0293 decided that a plugin-triggered continuation (`runtime.turn.continue`,
//! ADR 0295 slot #10 / rule 9) is a real, visible user row that names the plugin
//! that asked for it, and that the stored provenance is a **snapshot** — the
//! plugin id plus the display name as of the write — so the row stays readable
//! after the plugin is uninstalled. ADR 0295 rule 9 is explicit that there is no
//! quota on continuations: what replaces one is visibility.
//!
//! The provenance is stored where the row is created, not reconstructed later:
//!
//! | hop | table / shape |
//! |---|---|
//! | the plugin's request | `session.queuePush` params (`pluginId`, `pluginLabel`) |
//! | the queued continuation | `turn_queue.plugin_id` / `plugin_label` (schema v22) |
//! | the transcript row it becomes | `messages.plugin_id` / `plugin_label` (schema v22) |
//!
//! A row without provenance is `NULL` and therefore byte-for-byte the row this
//! build wrote before v22: no badge, no marker, nothing to explain. Nothing is
//! backfilled, because guessing which historical row a plugin asked for is not a
//! fact the database holds.

use anyhow::Result;
use rusqlite::params_from_iter;
use serde::Serialize;

use crate::db::Database;

/// The attribution one append carries: which plugin asked for the row.
///
/// `label` is the display name as of the write. It may be empty — an
/// uninstalled or never-loaded plugin has no display name — in which case the
/// surface falls back to the id, the same way the rewrite badge does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginAttribution {
    pub plugin_id: String,
    pub label: String,
}

impl PluginAttribution {
    pub fn new(plugin_id: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            label: label.into(),
        }
    }
}

/// One row's stored provenance, as a session read hands it to the renderer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationAttribution {
    /// The transcript row this attribution belongs to.
    pub message_id: String,
    /// The turn the row was appended under, when it had one.
    pub turn_id: Option<String>,
    pub plugin_id: String,
    /// The display name snapshotted at the write; may be empty.
    pub plugin_label: String,
}

/// Provenance for the rows of one session that carry any, keyed by message id
/// and returned in transcript order (`seq` ascending).
///
/// Only the ids the caller asks about are read: a windowed session read asks
/// about exactly the rows it returns, so the answer is bounded by the window
/// rather than by how many continuations the session ever had. A row without
/// provenance is simply not in the answer — the absence is what makes "a row
/// with provenance looks different, a row without looks exactly as today" true
/// without a per-row flag.
pub fn for_messages(
    db: &Database,
    session_id: &str,
    message_ids: &[String],
) -> Result<Vec<ContinuationAttribution>> {
    if message_ids.is_empty() {
        return Ok(Vec::new());
    }
    // The id list is the window's own shape, so this statement cannot be
    // prepared cached; the turn index keeps the ordering cheap.
    let placeholders = (0..message_ids.len())
        .map(|index| format!("?{}", index + 2))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT id, turn_id, plugin_id, plugin_label
           FROM messages
          WHERE session_id = ?1 AND plugin_id IS NOT NULL AND id IN ({placeholders})
          ORDER BY seq ASC"
    );
    let conn = db.conn();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        params_from_iter(std::iter::once(session_id).chain(message_ids.iter().map(String::as_str))),
        |row| {
            Ok(ContinuationAttribution {
                message_id: row.get(0)?,
                turn_id: row.get(1)?,
                plugin_id: row.get(2)?,
                plugin_label: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            })
        },
    )?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::{self, UiMessage};
    use crate::turn_queue;

    fn test_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        (dir, db)
    }

    fn user_message(id: &str, content: &str) -> UiMessage {
        UiMessage {
            id: id.into(),
            role: "user".into(),
            content: content.into(),
            created_at: crate::db::ms_to_ts(crate::db::now_ms()),
            ..Default::default()
        }
    }

    fn queue_input(
        session_id: &str,
        plugin: Option<PluginAttribution>,
    ) -> turn_queue::QueuedTurnInput {
        turn_queue::QueuedTurnInput {
            id: None,
            session_id: session_id.into(),
            principal: "desktop".into(),
            idempotency_key: None,
            input_hash: "hash".into(),
            content: "carry on".into(),
            session_message_id: None,
            attachments: None,
            permission_mode: "ask".into(),
            plugin_id: plugin.as_ref().map(|plugin| plugin.plugin_id.clone()),
            plugin_label: plugin.as_ref().map(|plugin| plugin.label.clone()),
        }
    }

    #[test]
    fn a_queued_continuation_keeps_the_plugin_that_asked_for_it() {
        let (_dir, db) = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();

        let entry = turn_queue::push(
            &db,
            queue_input(
                &session.id,
                Some(PluginAttribution::new("acme.sender", "Acme Sender")),
            ),
        )
        .unwrap();
        assert_eq!(entry.plugin_id.as_deref(), Some("acme.sender"));
        assert_eq!(entry.plugin_label.as_deref(), Some("Acme Sender"));
        // Stored, not just echoed: a re-read still names the plugin.
        let restored = turn_queue::list(&db, Some(&session.id)).unwrap();
        assert_eq!(restored[0].plugin_id.as_deref(), Some("acme.sender"));
        assert_eq!(restored[0].plugin_label.as_deref(), Some("Acme Sender"));

        // A user-made entry carries nothing, and reads back as it always did.
        let plain = turn_queue::push(&db, queue_input(&session.id, None)).unwrap();
        assert!(plain.plugin_id.is_none());
        assert!(plain.plugin_label.is_none());
    }

    #[test]
    fn the_row_a_continuation_becomes_names_its_plugin() {
        let (_dir, db) = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();

        sessions::append_message_with_origin(
            &db,
            &session.id,
            &user_message("row-1", "carry on"),
            Some(&turn),
            Some(&PluginAttribution::new("acme.sender", "Acme Sender")),
        )
        .unwrap();
        // A row the user typed: no provenance at all.
        sessions::append_message(
            &db,
            &session.id,
            &user_message("row-2", "mine"),
            Some(&turn),
        )
        .unwrap();

        let rows = for_messages(
            &db,
            &session.id,
            &["row-1".to_string(), "row-2".to_string()],
        )
        .unwrap();
        assert_eq!(
            rows.len(),
            1,
            "a row without provenance is not in the answer"
        );
        assert_eq!(rows[0].message_id, "row-1");
        assert_eq!(rows[0].plugin_id, "acme.sender");
        assert_eq!(rows[0].plugin_label, "Acme Sender");
        assert_eq!(rows[0].turn_id.as_deref(), Some(turn.as_str()));

        assert_eq!(
            for_messages(&db, &session.id, &["row-1".to_string()]).unwrap()[0].plugin_id,
            "acme.sender"
        );
        assert!(for_messages(&db, &session.id, &["row-2".to_string()])
            .unwrap()
            .is_empty());
        // Another session's rows are never attributed through this one.
        let other = sessions::create_session(&db, None, None, None, None, None).unwrap();
        assert!(for_messages(&db, &other.id, &["row-1".to_string()])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_v21_file_upgrades_with_its_rows_and_keeps_working() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let session_id: String;
        {
            let db = Database::open(&path).unwrap();
            let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
            session_id = session.id;
            sessions::append_message(
                &db,
                &session_id,
                &user_message("before-upgrade", "typed before v22"),
                None,
            )
            .unwrap();
            // A v21 file has neither provenance column nor the per-turn index.
            db.conn()
                .execute_batch(
                    "DROP INDEX idx_messages_turn;
                     ALTER TABLE messages DROP COLUMN plugin_label;
                     ALTER TABLE messages DROP COLUMN plugin_id;
                     ALTER TABLE turn_queue DROP COLUMN plugin_label;
                     ALTER TABLE turn_queue DROP COLUMN plugin_id;",
                )
                .unwrap();
            db.conn().pragma_update(None, "user_version", 21).unwrap();
        }

        let db = Database::open(&path).unwrap();
        let version: i64 = db
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, crate::db::SCHEMA_VERSION);
        // The pre-migration file is kept, as every other step does.
        assert!(crate::db::migration_backup_path(&path, 21).exists());

        // The old row survived and still carries no provenance: it looks exactly
        // as it did before the upgrade.
        let rows = for_messages(&db, &session_id, &["before-upgrade".to_string()]).unwrap();
        assert!(rows.is_empty());
        assert_eq!(
            sessions::get_session(&db, &session_id)
                .unwrap()
                .unwrap()
                .messages
                .len(),
            1
        );

        // Migrated rows stay usable: attribute a new row and read it back.
        sessions::append_message_with_origin(
            &db,
            &session_id,
            &user_message("after-upgrade", "asked for by a plugin"),
            None,
            Some(&PluginAttribution::new("acme.sender", "Acme Sender")),
        )
        .unwrap();
        let rows = for_messages(&db, &session_id, &["after-upgrade".to_string()]).unwrap();
        assert_eq!(rows[0].plugin_id, "acme.sender");
        let queued = turn_queue::push(
            &db,
            queue_input(
                &session_id,
                Some(PluginAttribution::new("acme.sender", "Acme Sender")),
            ),
        )
        .unwrap();
        assert_eq!(queued.plugin_label.as_deref(), Some("Acme Sender"));
    }
}
