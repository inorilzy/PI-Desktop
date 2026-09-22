//! One turn's conversation: the host read behind ADR 0295 slot #8
//! (`runtime.turn.recap`, rule 7).
//!
//! `session.get` answers "the session's messages"; nothing until now answered
//! "the messages of *this* turn", which is why a plugin recap of one turn could
//! only report that no host read existed. The rows carry `turn_id` in the
//! SQLite index (schema v21 wrote it for audit attribution, and every append
//! since has stored it), so "this turn's conversation" is an indexed question
//! with one answer:
//!
//! | what | source |
//! |---|---|
//! | which rows the turn owns, in order | `messages` where `turn_id = ?`, ordered by `seq` (via `idx_messages_turn`) |
//! | what each row says | the session transcript file, the same source `session.get` reads |
//!
//! The order is transcript order — `seq` ascending, oldest first, which is the
//! order the conversation happened in and the order the model saw it. The read
//! is windowed like the other host reads: a positive `limit` (default 200,
//! ceiling [`MAX_MESSAGE_LIMIT`]) and an exact `truncated` flag, so a caller can
//! always tell a short turn from a capped read. A turn that does not exist is
//! [`None`] — an error at the RPC layer, never an empty conversation.

use anyhow::Result;
use rusqlite::params;
use serde::Serialize;

use crate::db::Database;
use crate::sessions::{self, UiMessage};

/// Most rows one per-turn read returns. The same ceiling `session.get` clamps
/// its renderer window to, so no read is the one that hands a caller an
/// unbounded conversation.
pub const MAX_MESSAGE_LIMIT: i64 = 500;

/// Rows a per-turn read returns when the caller does not ask for a window.
pub const DEFAULT_MESSAGE_LIMIT: i64 = 200;

/// One turn's conversation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnMessages {
    pub session_id: String,
    pub turn_id: String,
    /// The turn's rows, oldest first.
    pub messages: Vec<UiMessage>,
    /// `messages` holds the turn's first rows and more exist behind them.
    pub truncated: bool,
    /// Rows the turn owns in the index, capped or not.
    pub message_count: i64,
}

/// Read one turn's messages.
///
/// `None` means there is no such turn in that session — an unknown turn, or a
/// turn that belongs to another session — and is the caller's signal to answer
/// with an error instead of an empty list, so "the turn said nothing" is never
/// confused with "there is no such turn".
pub fn for_turn(
    db: &Database,
    session_id: &str,
    turn_id: &str,
    limit: i64,
    content_limit: Option<usize>,
) -> Result<Option<TurnMessages>> {
    let limit = limit.clamp(1, MAX_MESSAGE_LIMIT);
    let conn = db.conn();
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM turns WHERE id = ?1 AND session_id = ?2)",
        params![turn_id, session_id],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(None);
    }
    let message_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE session_id = ?1 AND turn_id = ?2",
        params![session_id, turn_id],
        |row| row.get(0),
    )?;
    let ids: Vec<String> = conn
        .prepare_cached(
            "SELECT id FROM messages
              WHERE session_id = ?1 AND turn_id = ?2
              ORDER BY seq ASC
              LIMIT ?3",
        )?
        .query_map(params![session_id, turn_id, limit], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Bodies live in the transcript, so one pass materializes them; only the
    // rows this turn owns are kept, which is also what keeps a duplicate line
    // from a retried append from showing up twice (last write wins, exactly as
    // the session read deduplicates).
    let records = sessions::dedupe_records(crate::transcripts::read_transcript(
        db.data_dir(),
        session_id,
    )?);
    let mut by_id: std::collections::HashMap<String, crate::transcripts::MessageRecord> = records
        .into_iter()
        .map(|record| (record.id.clone(), record))
        .collect();
    // A row whose transcript line is gone is skipped: the index is the
    // authority for which rows the turn owns, the file only supplies content.
    let messages: Vec<UiMessage> = ids
        .iter()
        .filter_map(|id| by_id.remove(id))
        .map(|record| match content_limit {
            Some(limit) => sessions::record_to_ui_for_display(record, limit),
            None => sessions::record_to_ui(record),
        })
        .collect();

    Ok(Some(TurnMessages {
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        truncated: (ids.len() as i64) < message_count,
        message_count,
        messages,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions;
    use crate::sessions::UiMessage;

    fn test_db() -> Database {
        let dir = std::env::temp_dir().join(format!("pi-desktop-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Database::open(&dir.join("test.sqlite")).unwrap()
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

    #[test]
    fn a_turn_reads_back_its_own_messages_oldest_first() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let first = sessions::begin_turn(&db, &session.id, None, None).unwrap();
        sessions::end_turn(&db, &first, "completed", None, None, false).unwrap();
        let second = sessions::begin_turn(&db, &session.id, None, None).unwrap();

        sessions::append_message(
            &db,
            &session.id,
            &user_message("m1", "the first turn's prompt"),
            Some(&first),
        )
        .unwrap();
        sessions::append_message(
            &db,
            &session.id,
            &user_message("m2", "the second turn's prompt"),
            Some(&second),
        )
        .unwrap();
        sessions::append_message(
            &db,
            &session.id,
            &user_message("m3", "and its follow-up"),
            Some(&second),
        )
        .unwrap();
        // A row with no turn never joins one.
        sessions::append_message(&db, &session.id, &user_message("m4", "loose"), None).unwrap();

        let read = for_turn(&db, &session.id, &second, 200, None)
            .unwrap()
            .unwrap();
        assert_eq!(read.turn_id, second);
        assert_eq!(read.message_count, 2);
        assert!(!read.truncated);
        assert_eq!(
            read.messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            ["m2", "m3"]
        );
        assert_eq!(read.messages[1].content, "and its follow-up");

        let other = for_turn(&db, &session.id, &first, 200, None)
            .unwrap()
            .unwrap();
        assert_eq!(
            other
                .messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            ["m1"]
        );
    }

    #[test]
    fn a_capped_turn_read_says_so_and_a_content_cap_bounds_one_row() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
        for index in 0..3 {
            sessions::append_message(
                &db,
                &session.id,
                &user_message(&format!("m{index}"), "a prompt"),
                Some(&turn),
            )
            .unwrap();
        }
        sessions::append_message(
            &db,
            &session.id,
            &user_message("long", &"x".repeat(4096)),
            Some(&turn),
        )
        .unwrap();

        let capped = for_turn(&db, &session.id, &turn, 2, None).unwrap().unwrap();
        assert!(capped.truncated);
        assert_eq!(capped.message_count, 4);
        assert_eq!(
            capped
                .messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            ["m0", "m1"]
        );

        let display = for_turn(&db, &session.id, &turn, 200, Some(64))
            .unwrap()
            .unwrap();
        assert!(!display.truncated);
        assert_eq!(display.messages.len(), 4);
        let clipped = &display.messages[3];
        assert!(clipped.content.chars().count() <= 64);
        assert!(clipped.content.contains("[truncated for display"));
    }

    #[test]
    fn an_unknown_turn_is_not_an_empty_conversation() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let other = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();

        assert!(for_turn(&db, &session.id, "turn-that-never-was", 200, None)
            .unwrap()
            .is_none());
        assert!(for_turn(&db, &other.id, &turn, 200, None)
            .unwrap()
            .is_none());
        assert!(for_turn(&db, "session-that-never-was", &turn, 200, None)
            .unwrap()
            .is_none());
        // A turn with no rows at all is a real answer: this turn said nothing.
        let empty = for_turn(&db, &session.id, &turn, 200, None)
            .unwrap()
            .unwrap();
        assert!(empty.messages.is_empty());
        assert!(!empty.truncated);
        assert_eq!(empty.message_count, 0);
    }
}
