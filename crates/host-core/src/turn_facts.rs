//! One turn's facts: the authoritative structured numbers a plugin may read
//! for a single turn (ADR 0295 rule 8, slot #9 `runtime.turn.facts`).
//!
//! Facts are host-owned. "This turn" means exactly one thing here — the rows in
//! host tables that carry the turn's id — so nothing is reconstructed from what
//! a plugin observed, and no answer is assembled from conversation text. Each
//! number has one source:
//!
//! | fact | source |
//! |---|---|
//! | executed tool calls, outcomes, error codes | `audit_log` (`kind = 'tool_execute'`, `turn_id`) |
//! | model tokens, start/end, status, error, provider/model | `turns` |
//! | provider usage record and plugin-tool spend | `turns.usage_json` / its `pluginToolUsage` member |
//! | files touched, with their ops | `artifacts` |
//!
//! A turn that does not exist is not answered with zeroes: [`for_turn`] returns
//! `None`, which the RPC layer turns into an error. Zeroes are reserved for a
//! turn that exists and really did nothing — no calls, no usage, no touches.

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use crate::artifacts::{self, Artifact};
use crate::db::{ms_to_ts, Database};

/// Most file touches one call returns below the per-turn artifact read's own
/// 500-row ceiling.
///
/// The facts read probes with `limit + 1` rows to report truncation exactly
/// rather than guessing it, so the ceiling has to leave room for that probe.
pub const MAX_FILE_LIMIT: i64 = 499;

/// Model tokens recorded for the turn.
///
/// `input` / `output` are the promoted `turns` columns, so they are always
/// integers even when no provider usage record was stored; `total` is their
/// sum. The provider's own `totalTokens` (which may account reasoning tokens
/// differently) stays inside [`TurnFacts::usage`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnTokens {
    pub input: i64,
    pub output: i64,
    pub total: i64,
}

/// One tool's share of a turn's executed calls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallSummary {
    /// The tool name the audit record carries; a record without one is grouped
    /// under the empty name rather than dropped.
    pub tool_name: String,
    pub calls: i64,
    pub ok: i64,
    pub failed: i64,
    /// Distinct error codes of this tool's failed calls, sorted; empty when
    /// none failed. A failed call without an error code contributes nothing.
    pub error_codes: Vec<String>,
}

/// The turn's executed tool calls.
///
/// Counts come from the audit log's `tool_execute` records: a call the host
/// refused before running (`tool_denied` / `tool_aborted`) never executed and
/// is not a call this turn made, so it is not counted here. A record whose
/// payload does not say `ok: true` counts as failed, which keeps
/// `ok + failed == total` true for every row the table can hold.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallFacts {
    pub total: i64,
    pub ok: i64,
    pub failed: i64,
    /// One entry per tool, ordered by tool name.
    pub by_tool: Vec<ToolCallSummary>,
}

/// Everything the host knows about one turn, in one answer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnFacts {
    pub session_id: String,
    pub turn_id: String,
    /// `running | completed | aborted | error`; a status this build does not
    /// know is exposed verbatim.
    pub status: String,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    /// The turn's own terminal error, not a tool's.
    pub error_code: Option<String>,
    pub started_at: String,
    /// `None` while the turn is still running.
    pub ended_at: Option<String>,
    /// `ended_at - started_at` in milliseconds; `None` while running.
    pub duration_ms: Option<i64>,
    pub tokens: TurnTokens,
    /// The provider usage record exactly as the host stored it, or `None` when
    /// the turn recorded none.
    pub usage: Option<Value>,
    /// The turn's plugin-tool spend: the `pluginToolUsage` member of the
    /// recorded usage, exposed on its own because it is spend a plugin
    /// reported and never part of the model's tokens (ADR 0295 slot 5).
    pub plugin_tool_usage: Option<Value>,
    pub tool_calls: ToolCallFacts,
    /// The files the turn touched, oldest touch first.
    pub files: Vec<Artifact>,
    /// The file list hit the requested limit and holds only the first touches;
    /// `false` means the list is the turn's complete file history.
    pub files_truncated: bool,
}

/// One `turns` row, read before the facts around it are assembled.
struct TurnRow {
    status: String,
    provider_id: Option<String>,
    model_id: Option<String>,
    error_code: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    usage_json: Option<String>,
    started_at: i64,
    ended_at: Option<i64>,
}

/// Assemble one turn's facts out of host-owned tables.
///
/// `None` means there is no such turn in that session — an unknown turn, or a
/// turn that belongs to another session — and is the caller's signal to answer
/// with an error instead of an empty result. A stored usage record that is not
/// valid JSON fails the read rather than being reported as "no usage": the
/// database is the authority for these numbers, and hiding a broken record
/// would make the facts lie.
pub fn for_turn(
    db: &Database,
    session_id: &str,
    turn_id: &str,
    file_limit: i64,
) -> Result<Option<TurnFacts>> {
    let file_limit = file_limit.clamp(1, MAX_FILE_LIMIT);
    let conn = db.conn();
    let row = conn
        .prepare_cached(
            "SELECT status, provider_id, model_id, error_code, input_tokens,
                    output_tokens, usage_json, started_at, ended_at
               FROM turns WHERE id = ?1 AND session_id = ?2",
        )?
        .query_row(params![turn_id, session_id], |row| {
            Ok(TurnRow {
                status: row.get(0)?,
                provider_id: row.get(1)?,
                model_id: row.get(2)?,
                error_code: row.get(3)?,
                input_tokens: row.get(4)?,
                output_tokens: row.get(5)?,
                usage_json: row.get(6)?,
                started_at: row.get(7)?,
                ended_at: row.get(8)?,
            })
        })
        .optional()?;
    let Some(row) = row else {
        return Ok(None);
    };

    let usage = match row.usage_json.as_deref() {
        Some(raw) => Some(
            serde_json::from_str::<Value>(raw)
                .with_context(|| format!("turn {turn_id} has a malformed usage record"))?,
        ),
        None => None,
    };
    let plugin_tool_usage = usage
        .as_ref()
        .and_then(|usage| usage.get("pluginToolUsage"))
        .filter(|component| !component.is_null())
        .cloned();

    // One extra row is the truncation probe: it is what lets `filesTruncated`
    // be exact instead of a guess.
    let mut files = artifacts::list_for_turn(db, session_id, turn_id, file_limit + 1)?;
    let files_truncated = files.len() as i64 > file_limit;
    files.truncate(file_limit as usize);

    Ok(Some(TurnFacts {
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        status: row.status,
        provider_id: row.provider_id,
        model_id: row.model_id,
        error_code: row.error_code,
        started_at: ms_to_ts(row.started_at),
        ended_at: row.ended_at.map(ms_to_ts),
        duration_ms: row.ended_at.map(|ended| ended - row.started_at),
        tokens: TurnTokens {
            input: row.input_tokens,
            output: row.output_tokens,
            total: row.input_tokens + row.output_tokens,
        },
        usage,
        plugin_tool_usage,
        tool_calls: tool_calls(conn, turn_id)?,
        files,
        files_truncated,
    }))
}

/// Fold one turn's `tool_execute` records into counts.
///
/// The `kind` and `turn_id` filters are applied by the query through
/// `idx_audit_turn`; the payload supplies only the tool's own name, outcome,
/// and error code, which are the fields the audit record already carries.
fn tool_calls(conn: &rusqlite::Connection, turn_id: &str) -> Result<ToolCallFacts> {
    let mut stmt = conn.prepare_cached(
        "SELECT COALESCE(json_extract(payload_json, '$.toolName'), '') AS tool_name,
                json_extract(payload_json, '$.ok') AS ok,
                json_extract(payload_json, '$.errorCode') AS error_code
           FROM audit_log
          WHERE kind = 'tool_execute' AND turn_id = ?1
          ORDER BY ts ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![turn_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<i64>>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;

    let mut facts = ToolCallFacts::default();
    let mut by_tool: std::collections::BTreeMap<String, ToolCallSummary> =
        std::collections::BTreeMap::new();
    for row in rows {
        let (tool_name, ok, error_code) = row?;
        facts.total += 1;
        let summary = by_tool
            .entry(tool_name.clone())
            .or_insert_with(|| ToolCallSummary {
                tool_name,
                calls: 0,
                ok: 0,
                failed: 0,
                error_codes: Vec::new(),
            });
        summary.calls += 1;
        if ok == Some(1) {
            facts.ok += 1;
            summary.ok += 1;
            continue;
        }
        facts.failed += 1;
        summary.failed += 1;
        if let Some(code) = error_code.filter(|code| !code.is_empty()) {
            if !summary.error_codes.contains(&code) {
                summary.error_codes.push(code);
            }
        }
    }
    for summary in by_tool.values_mut() {
        summary.error_codes.sort();
    }
    // A BTreeMap keeps the per-tool order deterministic and independent of the
    // order the rows happened to arrive in.
    facts.by_tool = by_tool.into_values().collect();
    Ok(facts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit;
    use crate::sessions;
    use serde_json::json;

    fn test_db() -> Database {
        let dir = std::env::temp_dir().join(format!("pi-desktop-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Database::open(&dir.join("test.sqlite")).unwrap()
    }

    fn tool_execute(
        db: &Database,
        session_id: &str,
        turn_id: &str,
        name: &str,
        ok: bool,
        code: Option<&str>,
    ) {
        audit::append_turn(
            db,
            "tool_execute",
            Some(session_id),
            Some(turn_id),
            json!({ "toolName": name, "ok": ok, "errorCode": code }),
        )
        .unwrap();
    }

    #[test]
    fn several_tool_calls_are_counted_with_their_outcomes() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();

        tool_execute(&db, &session.id, &turn, "Read", true, None);
        tool_execute(&db, &session.id, &turn, "Read", true, None);
        tool_execute(&db, &session.id, &turn, "Bash", false, Some("TOOL_TIMEOUT"));
        tool_execute(
            &db,
            &session.id,
            &turn,
            "Bash",
            false,
            Some("SHELL_NOT_FOUND"),
        );
        // A call the host refused before running is not a call the turn made.
        audit::append_turn(
            &db,
            "tool_denied",
            Some(&session.id),
            Some(&turn),
            json!({ "toolName": "Write" }),
        )
        .unwrap();
        // A call recorded without a turn never joins one.
        audit::append(
            &db,
            "tool_execute",
            Some(&session.id),
            json!({ "toolName": "Grep", "ok": true }),
        )
        .unwrap();

        let facts = for_turn(&db, &session.id, &turn, 200).unwrap().unwrap();
        assert_eq!(facts.tool_calls.total, 4);
        assert_eq!(facts.tool_calls.ok, 2);
        assert_eq!(facts.tool_calls.failed, 2);
        assert_eq!(
            facts.tool_calls.total,
            facts.tool_calls.ok + facts.tool_calls.failed
        );
        assert_eq!(
            facts.tool_calls.by_tool,
            vec![
                ToolCallSummary {
                    tool_name: "Bash".into(),
                    calls: 2,
                    ok: 0,
                    failed: 2,
                    error_codes: vec!["SHELL_NOT_FOUND".into(), "TOOL_TIMEOUT".into()],
                },
                ToolCallSummary {
                    tool_name: "Read".into(),
                    calls: 2,
                    ok: 2,
                    failed: 0,
                    error_codes: Vec::new(),
                },
            ]
        );
    }

    #[test]
    fn another_turns_records_never_leak_into_this_turn() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let first = sessions::begin_turn(&db, &session.id, None, None).unwrap();
        sessions::end_turn(&db, &first, "completed", None, None, false).unwrap();
        let second = sessions::begin_turn(&db, &session.id, None, None).unwrap();

        tool_execute(&db, &session.id, &first, "Read", true, None);
        tool_execute(&db, &session.id, &second, "Bash", true, None);
        tool_execute(&db, &session.id, &second, "Bash", true, None);
        tool_execute(
            &db,
            &session.id,
            &second,
            "Bash",
            false,
            Some("TOOL_TIMEOUT"),
        );
        artifacts::record(
            &db,
            &session.id,
            "/w/first.txt",
            artifacts::ArtifactOp::Write,
            Some(&first),
        )
        .unwrap();
        for path in ["/w/a.txt", "/w/b.txt"] {
            artifacts::record(
                &db,
                &session.id,
                path,
                artifacts::ArtifactOp::Edit,
                Some(&second),
            )
            .unwrap();
        }

        let facts = for_turn(&db, &session.id, &first, 200).unwrap().unwrap();
        assert_eq!(facts.tool_calls.total, 1);
        assert_eq!(facts.tool_calls.by_tool[0].tool_name, "Read");
        assert_eq!(
            facts
                .files
                .iter()
                .map(|artifact| artifact.path.as_str())
                .collect::<Vec<_>>(),
            ["/w/first.txt"]
        );

        let facts = for_turn(&db, &session.id, &second, 200).unwrap().unwrap();
        assert_eq!(facts.tool_calls.total, 3);
        assert_eq!(facts.tool_calls.failed, 1);
        assert!(facts
            .files
            .iter()
            .all(|artifact| artifact.turn_id.as_deref() == Some(second.as_str())));
    }

    #[test]
    fn a_turn_with_nothing_recorded_answers_with_zeroes() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();

        let facts = for_turn(&db, &session.id, &turn, 200).unwrap().unwrap();
        assert_eq!(facts.session_id, session.id);
        assert_eq!(facts.turn_id, turn);
        assert_eq!(facts.status, "running");
        assert_eq!(
            facts.tokens,
            TurnTokens {
                input: 0,
                output: 0,
                total: 0,
            }
        );
        assert!(facts.usage.is_none());
        assert!(facts.plugin_tool_usage.is_none());
        assert_eq!(facts.tool_calls, ToolCallFacts::default());
        assert!(facts.tool_calls.by_tool.is_empty());
        assert!(facts.files.is_empty());
        assert!(!facts.files_truncated);
        assert!(facts.ended_at.is_none());
        assert!(facts.duration_ms.is_none());
        assert!(facts.error_code.is_none());
        assert!(facts.started_at.ends_with('Z'));
    }

    #[test]
    fn tokens_come_from_the_turn_and_plugin_spend_stays_its_own_component() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
        let usage = json!({
            "inputTokens": 120,
            "outputTokens": 30,
            "totalTokens": 150,
            "cacheReadTokens": 10,
            "pluginToolUsage": { "inputTokens": 5, "outputTokens": 7, "totalTokens": 12 }
        });
        sessions::end_turn(&db, &turn, "completed", None, Some(&usage), false).unwrap();

        let facts = for_turn(&db, &session.id, &turn, 200).unwrap().unwrap();
        assert_eq!(facts.status, "completed");
        assert_eq!(
            facts.tokens,
            TurnTokens {
                input: 120,
                output: 30,
                total: 150,
            }
        );
        assert_eq!(facts.usage.as_ref().unwrap(), &usage);
        assert_eq!(
            facts.plugin_tool_usage.as_ref().unwrap()["totalTokens"],
            json!(12)
        );
        // Spend is beside the model tokens, never inside them.
        assert_eq!(facts.tokens.total, 150);
        assert!(facts.ended_at.as_ref().unwrap().ends_with('Z'));
        assert!(facts.duration_ms.unwrap() >= 0);
    }

    #[test]
    fn the_file_list_carries_the_ops_and_says_when_it_is_capped() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
        artifacts::record(
            &db,
            &session.id,
            "/w/new.txt",
            artifacts::ArtifactOp::Create,
            Some(&turn),
        )
        .unwrap();
        artifacts::record(
            &db,
            &session.id,
            "/w/edited.txt",
            artifacts::ArtifactOp::Edit,
            Some(&turn),
        )
        .unwrap();
        artifacts::record(
            &db,
            &session.id,
            "/w/gone.txt",
            artifacts::ArtifactOp::Delete,
            Some(&turn),
        )
        .unwrap();
        artifacts::record(
            &db,
            &session.id,
            "/w/other-turn.txt",
            artifacts::ArtifactOp::Write,
            Some("turn-elsewhere"),
        )
        .unwrap();

        let complete = for_turn(&db, &session.id, &turn, 200).unwrap().unwrap();
        assert!(!complete.files_truncated);
        assert_eq!(
            complete
                .files
                .iter()
                .map(|artifact| artifact.op.as_str())
                .collect::<Vec<_>>(),
            ["create", "edit", "delete"]
        );

        let capped = for_turn(&db, &session.id, &turn, 2).unwrap().unwrap();
        assert!(capped.files_truncated);
        assert_eq!(
            capped
                .files
                .iter()
                .map(|artifact| artifact.path.as_str())
                .collect::<Vec<_>>(),
            ["/w/new.txt", "/w/edited.txt"]
        );
    }

    #[test]
    fn an_unknown_turn_is_not_an_empty_answer() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let other = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();

        // Never recorded.
        assert!(for_turn(&db, &session.id, "turn-that-never-was", 200)
            .unwrap()
            .is_none());
        // Recorded, but in another session.
        assert!(for_turn(&db, &other.id, &turn, 200).unwrap().is_none());
        // Recorded, asked for under a session that does not exist either.
        assert!(for_turn(&db, "session-that-never-was", &turn, 200)
            .unwrap()
            .is_none());
        // The turn exists in its own session.
        assert!(for_turn(&db, &session.id, &turn, 200).unwrap().is_some());
    }
}
