use anyhow::Result;
use rusqlite::params;
use serde::Serialize;

use crate::db::{ms_to_ts, now_ms, Database};

/// What one recorded touch did to a file (ADR 0295 rule 8).
///
/// The vocabulary is closed at this boundary — `record` / `record_tx` accept
/// nothing else — rather than by a SQL `CHECK`, so a stored row this build does
/// not know still reads back verbatim and the set can grow without rebuilding
/// the table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactOp {
    /// The turn brought the file into existence.
    Create,
    /// The turn replaced the file's content.
    Write,
    /// The turn changed part of the file.
    Edit,
    /// The turn produced the file by downloading or generating it. No host tool
    /// reports this shape yet, so only a caller that knows it can record it;
    /// the vocabulary is what ADR 0295 rule 8 asks for and the store keeps it
    /// valid until the producer lands.
    #[allow(dead_code)]
    Download,
    /// The turn removed the file.
    Delete,
}

impl ArtifactOp {
    /// Stored and exposed spelling of the op.
    pub const fn as_str(self) -> &'static str {
        match self {
            ArtifactOp::Create => "create",
            ArtifactOp::Write => "write",
            ArtifactOp::Edit => "edit",
            ArtifactOp::Download => "download",
            ArtifactOp::Delete => "delete",
        }
    }
}

/// One recorded touch: the effect `op` had on `path` (04-data-storage §4.10).
///
/// A touch is the unit of the table, so the same file appears once per turn
/// that changed it. `op` stays a string on the way out: a row written by a
/// build with a wider vocabulary is exposed verbatim instead of being dropped
/// or coerced.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub session_id: String,
    pub session_title: Option<String>,
    pub path: String,
    pub op: String,
    /// The turn that touched the file; `None` when the host recorded the touch
    /// outside a turn (for example a Plan checkpoint submitted by an RPC).
    pub turn_id: Option<String>,
    /// Time of this touch, not of the file's first appearance.
    pub updated_at: String,
}

/// Record one touch. Rows are facts: a file changed in three turns gets three
/// rows, so every one of those turns stays attributable (ADR 0295 rule 8).
pub fn record(
    db: &Database,
    session_id: &str,
    path: &str,
    op: ArtifactOp,
    turn_id: Option<&str>,
) -> Result<()> {
    record_on(db.conn(), session_id, path, op, turn_id)
}

/// Register a touch as part of the plan submission transaction.
pub fn record_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    path: &str,
    op: ArtifactOp,
    turn_id: Option<&str>,
) -> Result<()> {
    record_on(tx, session_id, path, op, turn_id)
}

fn record_on(
    conn: &rusqlite::Connection,
    session_id: &str,
    path: &str,
    op: ArtifactOp,
    turn_id: Option<&str>,
) -> Result<()> {
    conn.prepare_cached(
        "INSERT INTO artifacts (session_id, path, op, turn_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
    )?
    .execute(params![session_id, path, op.as_str(), turn_id, now_ms()])?;
    Ok(())
}

fn artifact_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Artifact> {
    Ok(Artifact {
        session_id: row.get(0)?,
        session_title: row.get(1)?,
        path: row.get(2)?,
        op: row.get(3)?,
        turn_id: row.get(4)?,
        updated_at: ms_to_ts(row.get(5)?),
    })
}

/// Newest recorded touches first, for one session or for all of them. A path
/// touched in several turns appears once per touch; deduplicating here would
/// hide the history this table exists to keep.
pub fn list(db: &Database, session_id: Option<&str>, limit: i64) -> Result<Vec<Artifact>> {
    let limit = limit.clamp(1, 500);
    let mut out = Vec::new();
    if let Some(session_id) = session_id {
        let mut stmt = db.conn().prepare_cached(
            "SELECT a.session_id, s.title, a.path, a.op, a.turn_id, a.updated_at
             FROM artifacts a JOIN sessions s ON s.id = a.session_id
             WHERE a.session_id = ?1
             ORDER BY a.updated_at DESC, a.id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![session_id, limit], artifact_from_row)?;
        out.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
    } else {
        let mut stmt = db.conn().prepare_cached(
            "SELECT a.session_id, s.title, a.path, a.op, a.turn_id, a.updated_at
             FROM artifacts a JOIN sessions s ON s.id = a.session_id
             ORDER BY a.updated_at DESC, a.id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], artifact_from_row)?;
        out.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
    }
    Ok(out)
}

/// The artifacts one turn touched, oldest touch first — the host-owned answer
/// to "which files did this turn change?" (ADR 0295 rule 8, slot
/// `runtime.turn.facts`). The `id` tiebreak keeps the order stable when two
/// touches share a millisecond.
pub fn list_for_turn(
    db: &Database,
    session_id: &str,
    turn_id: &str,
    limit: i64,
) -> Result<Vec<Artifact>> {
    let limit = limit.clamp(1, 500);
    let mut stmt = db.conn().prepare_cached(
        "SELECT a.session_id, s.title, a.path, a.op, a.turn_id, a.updated_at
         FROM artifacts a JOIN sessions s ON s.id = a.session_id
         WHERE a.session_id = ?1 AND a.turn_id = ?2
         ORDER BY a.updated_at ASC, a.id ASC LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![session_id, turn_id, limit], artifact_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions;

    fn test_db() -> Database {
        let dir = std::env::temp_dir().join(format!("pi-desktop-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Database::open(&dir.join("test.sqlite")).unwrap()
    }

    #[test]
    fn every_artifact_op_round_trips_through_the_store() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        for op in [
            ArtifactOp::Create,
            ArtifactOp::Write,
            ArtifactOp::Edit,
            ArtifactOp::Download,
            ArtifactOp::Delete,
        ] {
            let path = format!("/tmp/{}", op.as_str());
            record(&db, &session.id, &path, op, Some("turn-1")).unwrap();
        }
        let listed = list_for_turn(&db, &session.id, "turn-1", 50).unwrap();
        let mut ops: Vec<String> = listed.iter().map(|a| a.op.clone()).collect();
        ops.sort();
        assert_eq!(
            ops,
            ["create", "delete", "download", "edit", "write"]
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        );
        for artifact in &listed {
            assert_eq!(artifact.turn_id.as_deref(), Some("turn-1"));
            assert_eq!(artifact.session_id, session.id);
        }
    }

    #[test]
    fn a_file_changed_in_three_turns_is_attributable_to_each() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        for path in ["/tmp/a.txt", "/tmp/b.txt"] {
            record(&db, &session.id, path, ArtifactOp::Write, Some("turn-1")).unwrap();
        }
        record(
            &db,
            &session.id,
            "/tmp/a.txt",
            ArtifactOp::Edit,
            Some("turn-2"),
        )
        .unwrap();
        record(
            &db,
            &session.id,
            "/tmp/a.txt",
            ArtifactOp::Delete,
            Some("turn-3"),
        )
        .unwrap();

        let first = list_for_turn(&db, &session.id, "turn-1", 50).unwrap();
        assert_eq!(first.len(), 2);
        let second = list_for_turn(&db, &session.id, "turn-2", 50).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].path, "/tmp/a.txt");
        assert_eq!(second[0].op, "edit");
        let third = list_for_turn(&db, &session.id, "turn-3", 50).unwrap();
        assert_eq!(third.len(), 1);
        assert_eq!(third[0].path, "/tmp/a.txt");
        assert_eq!(third[0].op, "delete");

        // One session list keeps all three touches of the same file.
        let all = list(&db, Some(&session.id), 50).unwrap();
        assert_eq!(all.len(), 4);
        assert_eq!(
            all.iter()
                .filter(|artifact| artifact.path == "/tmp/a.txt")
                .count(),
            3
        );
    }

    #[test]
    fn the_per_turn_query_returns_only_that_turn_in_order() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        record(
            &db,
            &session.id,
            "/tmp/first.txt",
            ArtifactOp::Write,
            Some("turn-1"),
        )
        .unwrap();
        record(
            &db,
            &session.id,
            "/tmp/second.txt",
            ArtifactOp::Create,
            Some("turn-1"),
        )
        .unwrap();
        record(
            &db,
            &session.id,
            "/tmp/other.txt",
            ArtifactOp::Write,
            Some("turn-2"),
        )
        .unwrap();
        // A touch outside any turn must not leak into a turn's list.
        record(&db, &session.id, "/tmp/plan.md", ArtifactOp::Create, None).unwrap();

        let turn_one = list_for_turn(&db, &session.id, "turn-1", 50).unwrap();
        assert_eq!(
            turn_one
                .iter()
                .map(|artifact| artifact.path.as_str())
                .collect::<Vec<_>>(),
            ["/tmp/first.txt", "/tmp/second.txt"]
        );
        // Same call, same order: the id tiebreak decides when `updated_at` ties.
        assert_eq!(
            list_for_turn(&db, &session.id, "turn-1", 50)
                .unwrap()
                .iter()
                .map(|artifact| artifact.path.clone())
                .collect::<Vec<_>>(),
            ["/tmp/first.txt", "/tmp/second.txt"]
        );
        let turn_two = list_for_turn(&db, &session.id, "turn-2", 50).unwrap();
        assert_eq!(turn_two.len(), 1);
        assert_eq!(turn_two[0].path, "/tmp/other.txt");
        assert!(list_for_turn(&db, &session.id, "turn-9", 50)
            .unwrap()
            .is_empty());
        assert!(!turn_one
            .iter()
            .any(|artifact| artifact.turn_id.as_deref().is_none()));
    }

    #[test]
    fn touches_outside_a_turn_are_exposed_without_a_turn() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        record(&db, &session.id, "/tmp/plan.md", ArtifactOp::Create, None).unwrap();
        let all = list(&db, Some(&session.id), 50).unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].turn_id.is_none());
        // Session delete cascades.
        sessions::delete_session(&db, &session.id).unwrap();
        assert!(list(&db, None, 50).unwrap().is_empty());
    }
}
