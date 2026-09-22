//! Diff-level audit of what a plugin changed in what the model receives
//! (ADR 0295 rule 5; 04-data-storage §4.15).
//!
//! Slot #1 (`runtime.send.before`) is the producer: the agent runtime hands a
//! rewrite it performed to the host, and `plugin.rewrites.record` stores it
//! here — the one write boundary. Slot #6 (`runtime.request.before`) was
//! withdrawn before shipping (ADR 0295), so its `system_prompt`, `message_list`,
//! and `request_payload` kinds keep their shape but nothing writes them; the
//! storage, the caps, and the reads are in place because the ADR makes the audit
//! a prerequisite of the rewrite capability, not a follow-up.
//!
//! A record is a fact, like an `artifacts` touch: which characters, which
//! messages, or which payload fields changed, who changed them, and in which
//! turn. The caps below are the write boundary's contract; everything this
//! table stores goes through [`record`].
//!
//! The `diff_json` shape is machine-readable by design — a reader must not
//! have to parse prose to learn what changed. `kind` is the tag, and the other
//! keys follow it:
//!
//! ```json
//! { "kind": "outgoing_message", "targetMessageId": "m-7",
//!   "characterEdits": [ { "start": 6, "end": 6, "beforeChars": 0,
//!     "afterChars": 6, "before": "", "after": "brave ", "truncated": false } ] }
//! { "kind": "system_prompt",
//!   "characterEdits": [ { "start": 0, "end": 12, "beforeChars": 12,
//!     "afterChars": 8, "before": "You are help", "after": "Be terse",
//!     "truncated": false } ] }
//! { "kind": "message_list",
//!   "messageEdits": [ { "index": 2, "change": "replace", "beforeId": "m-2",
//!     "afterId": "m-9" } ] }
//! { "kind": "request_payload",
//!   "fieldEdits": [ { "path": "$.temperature", "change": "replace" } ],
//!   "summary": { "beforeBytes": 812345, "afterBytes": 812999 },
//!   "body": "{\"model\":\"…\"}", "bodyTruncated": true }
//! ```
//!
//! Entries are dropped rather than clipped when a diff exceeds the caps, and
//! the row carries `truncated` plus `dropped_edits` so a capped record is
//! never mistaken for a full one.

use anyhow::{anyhow, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::{ms_to_ts, now_ms, Database};

/// Table DDL, executed for a fresh database (`Database::open`) and by the
/// v19 → v20 migration, so the two cannot drift.
///
/// `turn_id` is nullable and deliberately has no foreign key, exactly like
/// `artifacts.turn_id`: slot #1 runs after send but before queueing, so a
/// rewrite can be recorded before the `turns` row exists, and a foreign key
/// would reject an honest record. `kind` carries no SQL `CHECK` either — the
/// vocabulary is closed by [`RewriteKind`] at this boundary, so a row written
/// by a build with a wider vocabulary still reads back verbatim.
pub(crate) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS plugin_rewrites (
  id            INTEGER PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id       TEXT,
  plugin_id     TEXT NOT NULL,
  kind          TEXT NOT NULL,
  truncated     INTEGER NOT NULL DEFAULT 0,
  dropped_edits INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  diff_json     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_rewrites_session
  ON plugin_rewrites(session_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_plugin_rewrites_turn
  ON plugin_rewrites(session_id, turn_id, created_at, id)
  WHERE turn_id IS NOT NULL;
"#;

/// Longest identifier (session, turn, plugin) stored on a record.
///
/// An oversized identifier is **rejected**, not clipped: a record nobody can
/// attribute is worse than a failed write, and every identifier here comes
/// from the host or the plugin registry rather than from plugin content.
const MAX_IDENTIFIER_BYTES: usize = 256;

/// Change entries kept in one record. Entries past this are dropped and
/// counted in `dropped_edits`.
pub const MAX_DIFF_ENTRIES: usize = 512;

/// Longest text fragment kept inside one entry — a changed span of text, or a
/// message id. The `beforeChars` / `afterChars` counts stay exact, so a
/// clipped fragment never hides the size of the change.
pub const MAX_FRAGMENT_BYTES: usize = 2048;

/// Longest request-payload body kept. The body stands in for the payload the
/// model received; `summary.afterBytes` still reports the full size and
/// `bodyTruncated` marks the clip.
pub const MAX_BODY_BYTES: usize = 16 * 1024;

/// Hard ceiling for one record's stored diff. Entries that do not fit are
/// dropped and counted, so this is an invariant, not a hope: with the
/// identifier cap above, one row stays under ~67 KiB.
pub const MAX_DIFF_BYTES: usize = 64 * 1024;

/// Deepest payload path the field walk describes. A change below it is
/// recorded as a replacement of the deepest described node instead of being
/// walked to its leaf, which keeps a pathologically nested payload from
/// unbounded recursion.
const MAX_FIELD_PATH_DEPTH: usize = 32;

/// Most records one read returns, whatever the caller asks for.
const MAX_LIST_LIMIT: i64 = 500;

/// What a plugin rewrote (ADR 0295 rule 5). One variant per rewrite slot
/// capability: the outgoing message (slot #1), or the system prompt, the
/// message list, and the request payload (slot #6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RewriteKind {
    /// Slot #1: the message the user sends.
    OutgoingMessage,
    /// Slot #6: the system prompt the model receives.
    SystemPrompt,
    /// Slot #6: the message list — delete, replace, or reorder history.
    MessageList,
    /// Slot #6: the assembled request payload.
    RequestPayload,
}

impl RewriteKind {
    /// Stored and exposed spelling of the kind.
    pub const fn as_str(self) -> &'static str {
        match self {
            RewriteKind::OutgoingMessage => "outgoing_message",
            RewriteKind::SystemPrompt => "system_prompt",
            RewriteKind::MessageList => "message_list",
            RewriteKind::RequestPayload => "request_payload",
        }
    }

    /// Parse a stored/exposed kind; `None` for a spelling this build does not
    /// know, so an RPC filter can reject it instead of matching nothing.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "outgoing_message" => Some(RewriteKind::OutgoingMessage),
            "system_prompt" => Some(RewriteKind::SystemPrompt),
            "message_list" => Some(RewriteKind::MessageList),
            "request_payload" => Some(RewriteKind::RequestPayload),
            _ => None,
        }
    }
}

/// One changed span of text: the characters `[start, end)` of the original
/// were replaced by `after`.
///
/// `start` and `end` are Unicode scalar-value offsets into the original text,
/// so a reader can locate the change exactly; `after` being empty is a
/// deletion and `start == end` is an insertion.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CharacterEdit {
    /// Inclusive start offset in the original text.
    pub start: usize,
    /// Exclusive end offset in the original text.
    pub end: usize,
    /// Exact number of characters the span held before the rewrite.
    pub before_chars: usize,
    /// Exact number of characters that replaced it.
    pub after_chars: usize,
    /// The span itself, capped at [`MAX_FRAGMENT_BYTES`].
    pub before: String,
    /// What replaced it, capped at [`MAX_FRAGMENT_BYTES`].
    pub after: String,
    /// A fragment was clipped; the offsets and the counts are still exact.
    pub truncated: bool,
}

/// What a message-list rewrite did to one position.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageChange {
    /// A message the model did not have before.
    Insert,
    /// A different message now sits at this index.
    Replace,
    /// The message at this index is gone.
    Delete,
    /// The message moved (`to_index` names where it went).
    Reorder,
}

/// One changed message-list position.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageEdit {
    /// Zero-based index in the list as the plugin received it.
    pub index: usize,
    /// What happened at that index.
    pub change: MessageChange,
    /// Message id that was there before, when there was one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_id: Option<String>,
    /// Message id that is there afterwards, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_id: Option<String>,
    /// Destination index of a `reorder`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_index: Option<usize>,
}

/// What a payload rewrite did to one field.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FieldChange {
    /// A field the model did not receive before.
    Add,
    /// A field the model no longer receives.
    Remove,
    /// The field's value changed.
    Replace,
}

/// One changed payload field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FieldEdit {
    /// Dotted path from the payload root (`$.messages.0.content`), with
    /// zero-based array indexes.
    pub path: String,
    /// What happened to that field.
    pub change: FieldChange,
}

/// Exact sizes of the payload, measured on the full objects the plugin saw
/// and produced — never on the capped body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PayloadSummary {
    /// Serialized size the model would have received without the rewrite.
    pub before_bytes: usize,
    /// Serialized size it received instead.
    pub after_bytes: usize,
}

/// The diff of one rewrite, tagged by kind.
///
/// The constructors do the reasoning a producer should not have to repeat:
/// `outgoing_message` and `system_prompt` locate the changed characters by
/// trimming the shared prefix and suffix, and `request_payload` walks two
/// payloads to the paths that actually differ.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RewriteDiff {
    /// Slot #1: what changed in the outgoing message.
    OutgoingMessage {
        /// Id of the message the user sent, before the rewrite.
        target_message_id: String,
        /// The changed span of the message text.
        character_edits: Vec<CharacterEdit>,
    },
    /// Slot #6: what changed in the system prompt.
    SystemPrompt {
        /// The changed span of the prompt text.
        character_edits: Vec<CharacterEdit>,
    },
    /// Slot #6: what changed in the message list.
    MessageList {
        /// One entry per changed position, in list order.
        message_edits: Vec<MessageEdit>,
    },
    /// Slot #6: what changed in the request payload.
    RequestPayload {
        /// One entry per changed field, in walk order.
        field_edits: Vec<FieldEdit>,
        /// Exact before/after sizes of the whole payload.
        summary: PayloadSummary,
        /// The payload the model received, capped at [`MAX_BODY_BYTES`].
        body: String,
        /// The body is a prefix of a payload larger than the cap.
        body_truncated: bool,
    },
}

impl RewriteDiff {
    /// The kind of rewrite this diff describes; it is the record's `kind`
    /// column, so a producer cannot store a diff under the wrong kind.
    pub fn kind(&self) -> RewriteKind {
        match self {
            RewriteDiff::OutgoingMessage { .. } => RewriteKind::OutgoingMessage,
            RewriteDiff::SystemPrompt { .. } => RewriteKind::SystemPrompt,
            RewriteDiff::MessageList { .. } => RewriteKind::MessageList,
            RewriteDiff::RequestPayload { .. } => RewriteKind::RequestPayload,
        }
    }

    /// Slot #1: locate the span of `original` that `rewritten` replaced.
    ///
    /// Trimming the shared prefix and suffix makes the answer exact for the
    /// common case — a plugin edits part of the message — and cheap for the
    /// common non-case — a plugin returns the text unchanged, which yields no
    /// edits at all.
    /// The one constructor the current producer uses: the runtime's send hook
    /// hands over both texts, and the changed span is computed here so the
    /// algorithm stays in one place.
    pub fn outgoing_message(target_message_id: &str, original: &str, rewritten: &str) -> Self {
        RewriteDiff::OutgoingMessage {
            target_message_id: target_message_id.to_string(),
            character_edits: character_edits(original, rewritten),
        }
    }

    /// Slot #6: locate the span of the system prompt that changed.
    #[allow(dead_code)] // No producer yet: slot #6 is not built.
    pub fn system_prompt(original: &str, rewritten: &str) -> Self {
        RewriteDiff::SystemPrompt {
            character_edits: character_edits(original, rewritten),
        }
    }

    /// Slot #6: the message-list changes the plugin reports. A reorder cannot
    /// be derived from two lists, so the producer names each change.
    #[allow(dead_code)] // No producer yet: slot #6 is not built.
    pub fn message_list(message_edits: Vec<MessageEdit>) -> Self {
        RewriteDiff::MessageList { message_edits }
    }

    /// Slot #6: walk the payload the plugin was handed and the payload it
    /// returned into the field paths that differ, and keep the exact sizes of
    /// both plus a capped copy of what the model will receive.
    #[allow(dead_code)] // No producer yet: slot #6 is not built.
    pub fn request_payload(before: &Value, after: &Value) -> Self {
        let mut field_edits = Vec::new();
        collect_field_edits(before, after, "$", 0, &mut field_edits);
        let before_bytes = serialized_len(before);
        let after_bytes = serialized_len(after);
        let serialized_after = serde_json::to_string(after).unwrap_or_default();
        let (body, body_truncated) = clip_bytes(&serialized_after, MAX_BODY_BYTES);
        RewriteDiff::RequestPayload {
            field_edits,
            summary: PayloadSummary {
                before_bytes,
                after_bytes,
            },
            body,
            body_truncated,
        }
    }
}

/// A stored rewrite record: what a plugin changed, and where it happened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteRecord {
    pub id: i64,
    pub session_id: String,
    /// The turn the rewrite happened in; `None` when it happened outside one.
    pub turn_id: Option<String>,
    pub plugin_id: String,
    /// `outgoing_message | system_prompt | message_list | request_payload`;
    /// a kind this build does not know is exposed verbatim.
    pub kind: String,
    /// A cap clipped or dropped part of this record; `dropped_edits` says how
    /// much. `false` means the diff is complete.
    pub truncated: bool,
    /// Change entries the caps dropped.
    pub dropped_edits: i64,
    pub created_at: String,
    /// The machine-readable diff described in the module header.
    pub diff: Value,
}

/// Record one rewrite and return the new row's id.
///
/// This is the write boundary for the caps above: the diff is normalized
/// (fragments clipped at a character boundary, entries kept within
/// [`MAX_DIFF_ENTRIES`] and [`MAX_DIFF_BYTES`]) before anything is stored, so
/// one record cannot blow up the database. What was clipped or dropped is
/// stored with the record as `truncated` / `dropped_edits`.
///
/// Callers reach this through the host-core RPC writer `plugin.rewrites.record`,
/// which slot #1's handler (`extensions.rewrites.record`) calls; slot #6 was
/// withdrawn, so it is never wired. Nothing else writes this table.
pub fn record(
    db: &Database,
    session_id: &str,
    turn_id: Option<&str>,
    plugin_id: &str,
    diff: RewriteDiff,
) -> Result<i64> {
    check_identifier("sessionId", session_id)?;
    if let Some(turn_id) = turn_id {
        check_identifier("turnId", turn_id)?;
    }
    check_identifier("pluginId", plugin_id)?;

    let normalized = diff.normalize()?;
    let conn = db.conn();
    let mut stmt = conn.prepare_cached(
        "INSERT INTO plugin_rewrites
           (session_id, turn_id, plugin_id, kind, truncated, dropped_edits,
            created_at, diff_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;
    stmt.execute(params![
        session_id,
        turn_id,
        plugin_id,
        normalized.kind.as_str(),
        normalized.truncated as i64,
        normalized.dropped_edits as i64,
        now_ms(),
        normalized.diff.to_string(),
    ])?;
    Ok(conn.last_insert_rowid())
}

/// Newest records first for one session — the audit view's session read.
///
/// `created_at DESC, id DESC` keeps the order deterministic when two rewrites
/// share a millisecond. `kind` filters to one kind of rewrite when given.
pub fn list_for_session(
    db: &Database,
    session_id: &str,
    kind: Option<RewriteKind>,
    limit: i64,
) -> Result<Vec<RewriteRecord>> {
    let limit = limit.clamp(1, MAX_LIST_LIMIT);
    let mut stmt = db.conn().prepare_cached(
        "SELECT id, session_id, turn_id, plugin_id, kind, truncated, dropped_edits,
                created_at, diff_json
         FROM plugin_rewrites
         WHERE session_id = ?1 AND (?2 IS NULL OR kind = ?2)
         ORDER BY created_at DESC, id DESC
         LIMIT ?3",
    )?;
    let rows = stmt.query_map(
        params![session_id, kind.map(RewriteKind::as_str), limit],
        rewrite_from_row,
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// The records of one turn, oldest first — the order the rewrites happened in
/// the turn, which is what slot #1's rewrite surface reads (ADR 0295 rule 5).
///
/// A record written outside a turn has no `turn_id` and never appears here;
/// the `id` tiebreak keeps the order stable within a millisecond.
pub fn list_for_turn(
    db: &Database,
    session_id: &str,
    turn_id: &str,
    kind: Option<RewriteKind>,
    limit: i64,
) -> Result<Vec<RewriteRecord>> {
    let limit = limit.clamp(1, MAX_LIST_LIMIT);
    let mut stmt = db.conn().prepare_cached(
        "SELECT id, session_id, turn_id, plugin_id, kind, truncated, dropped_edits,
                created_at, diff_json
         FROM plugin_rewrites
         WHERE session_id = ?1 AND turn_id = ?2 AND (?3 IS NULL OR kind = ?3)
         ORDER BY created_at ASC, id ASC
         LIMIT ?4",
    )?;
    let rows = stmt.query_map(
        params![session_id, turn_id, kind.map(RewriteKind::as_str), limit],
        rewrite_from_row,
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn rewrite_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RewriteRecord> {
    let diff_json: String = row.get(8)?;
    let diff = serde_json::from_str(&diff_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(RewriteRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        turn_id: row.get(2)?,
        plugin_id: row.get(3)?,
        kind: row.get(4)?,
        truncated: row.get::<_, i64>(5)? != 0,
        dropped_edits: row.get(6)?,
        created_at: ms_to_ts(row.get(7)?),
        diff,
    })
}

fn check_identifier(field: &str, value: &str) -> Result<()> {
    if value.len() > MAX_IDENTIFIER_BYTES {
        return Err(anyhow!(
            "LIMIT_EXCEEDED: {field} is {} bytes; a rewrite record identifier is capped at \
             {MAX_IDENTIFIER_BYTES}",
            value.len()
        ));
    }
    Ok(())
}

/// A diff that has been through the caps: the JSON to store, whether anything
/// was clipped or dropped, and how many entries were dropped.
struct NormalizedDiff {
    kind: RewriteKind,
    diff: Value,
    truncated: bool,
    dropped_edits: usize,
}

impl RewriteDiff {
    fn normalize(self) -> Result<NormalizedDiff> {
        let kind = self.kind();
        match self {
            RewriteDiff::OutgoingMessage {
                target_message_id,
                character_edits,
            } => {
                let (edits, clipped) = clip_character_edits(character_edits);
                let template = RewriteDiff::OutgoingMessage {
                    target_message_id: target_message_id.clone(),
                    character_edits: Vec::new(),
                };
                let (edits, dropped) = keep_within_budget(edits, &template);
                let diff = RewriteDiff::OutgoingMessage {
                    target_message_id,
                    character_edits: edits,
                };
                NormalizedDiff::new(kind, diff, clipped, dropped)
            }
            RewriteDiff::SystemPrompt { character_edits } => {
                let (edits, clipped) = clip_character_edits(character_edits);
                let template = RewriteDiff::SystemPrompt {
                    character_edits: Vec::new(),
                };
                let (edits, dropped) = keep_within_budget(edits, &template);
                NormalizedDiff::new(
                    kind,
                    RewriteDiff::SystemPrompt {
                        character_edits: edits,
                    },
                    clipped,
                    dropped,
                )
            }
            RewriteDiff::MessageList { message_edits } => {
                let template = RewriteDiff::MessageList {
                    message_edits: Vec::new(),
                };
                let (edits, dropped) = keep_within_budget(message_edits, &template);
                NormalizedDiff::new(
                    kind,
                    RewriteDiff::MessageList {
                        message_edits: edits,
                    },
                    false,
                    dropped,
                )
            }
            RewriteDiff::RequestPayload {
                field_edits,
                summary,
                body,
                body_truncated,
            } => {
                let (body, body_clipped) = clip_bytes(&body, MAX_BODY_BYTES);
                // A body the caller already capped is capped all the same: the
                // record must not claim to be complete because the second clip
                // had nothing left to do.
                let body_truncated = body_truncated || body_clipped;
                let template = RewriteDiff::RequestPayload {
                    field_edits: Vec::new(),
                    summary: summary.clone(),
                    body: String::new(),
                    body_truncated: false,
                };
                let (edits, dropped) = keep_within_budget(field_edits, &template);
                NormalizedDiff::new(
                    kind,
                    RewriteDiff::RequestPayload {
                        field_edits: edits,
                        summary,
                        body,
                        body_truncated,
                    },
                    body_truncated,
                    dropped,
                )
            }
        }
    }
}

impl NormalizedDiff {
    fn new(
        kind: RewriteKind,
        diff: RewriteDiff,
        clipped: bool,
        dropped_edits: usize,
    ) -> Result<Self> {
        Ok(NormalizedDiff {
            kind,
            diff: serde_json::to_value(&diff)?,
            truncated: clipped || dropped_edits > 0,
            dropped_edits,
        })
    }
}

/// Keep entries in order while the serialized diff stays inside
/// [`MAX_DIFF_BYTES`], and never more than [`MAX_DIFF_ENTRIES`].
///
/// An entry that does not fit is dropped and counted; later entries are still
/// considered, so one oversized entry cannot hide the rest of the diff.
/// `template` is the same diff with its entry list empty — measuring it is how
/// the fixed part of the record is accounted for without hand-copying key
/// names that could drift from the serialized shape.
fn keep_within_budget<T: Serialize>(entries: Vec<T>, template: &RewriteDiff) -> (Vec<T>, usize) {
    let fixed = serde_json::to_string(template)
        .map(|text| text.len())
        .unwrap_or(MAX_DIFF_BYTES);
    let budget = MAX_DIFF_BYTES.saturating_sub(fixed);
    let mut accepted = Vec::new();
    let mut dropped = 0usize;
    let mut used = 0usize;
    for (index, entry) in entries.into_iter().enumerate() {
        // One byte over the entry covers its array separator; the accounting
        // is conservative, never optimistic.
        let size = serde_json::to_string(&entry)
            .map(|text| text.len() + 1)
            .unwrap_or(usize::MAX);
        if index >= MAX_DIFF_ENTRIES || used.saturating_add(size) > budget {
            dropped += 1;
            continue;
        }
        used += size;
        accepted.push(entry);
    }
    (accepted, dropped)
}

fn clip_character_edits(edits: Vec<CharacterEdit>) -> (Vec<CharacterEdit>, bool) {
    let mut clipped = false;
    let edits = edits
        .into_iter()
        .map(|edit| {
            let (before, before_clipped) = clip_bytes(&edit.before, MAX_FRAGMENT_BYTES);
            let (after, after_clipped) = clip_bytes(&edit.after, MAX_FRAGMENT_BYTES);
            clipped |= before_clipped || after_clipped;
            CharacterEdit {
                before,
                after,
                truncated: edit.truncated || before_clipped || after_clipped,
                ..edit
            }
        })
        .collect();
    (edits, clipped)
}

/// Clip to at most `limit` bytes without splitting a character.
fn clip_bytes(text: &str, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text.to_string(), false);
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

fn serialized_len(value: &Value) -> usize {
    serde_json::to_string(value)
        .map(|text| text.len())
        .unwrap_or(0)
}

/// One changed span, from the shared prefix to the shared suffix.
fn character_edits(original: &str, rewritten: &str) -> Vec<CharacterEdit> {
    let before: Vec<char> = original.chars().collect();
    let after: Vec<char> = rewritten.chars().collect();
    let mut prefix = 0;
    while prefix < before.len() && prefix < after.len() && before[prefix] == after[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < before.len() - prefix
        && suffix < after.len() - prefix
        && before[before.len() - 1 - suffix] == after[after.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let span: String = before[prefix..before.len() - suffix].iter().collect();
    let replacement: String = after[prefix..after.len() - suffix].iter().collect();
    if span.is_empty() && replacement.is_empty() {
        return Vec::new();
    }
    vec![CharacterEdit {
        start: prefix,
        end: before.len() - suffix,
        before_chars: span.chars().count(),
        after_chars: replacement.chars().count(),
        before: span,
        after: replacement,
        truncated: false,
    }]
}

/// Walk two payloads into the dotted paths that differ.
///
/// Objects recurse per key (a key only one side has is an add or a remove),
/// equal-length arrays recurse per index, and everything else that differs is
/// one replacement at the deepest described path.
fn collect_field_edits(
    before: &Value,
    after: &Value,
    path: &str,
    depth: usize,
    out: &mut Vec<FieldEdit>,
) {
    if out.len() >= MAX_DIFF_ENTRIES {
        return;
    }
    if before == after {
        return;
    }
    if depth >= MAX_FIELD_PATH_DEPTH {
        out.push(FieldEdit {
            path: path.to_string(),
            change: FieldChange::Replace,
        });
        return;
    }
    match (before, after) {
        (Value::Object(before), Value::Object(after)) => {
            for (key, value) in after {
                let child = format!("{path}.{key}");
                match before.get(key) {
                    Some(previous) => collect_field_edits(previous, value, &child, depth + 1, out),
                    None => out.push(FieldEdit {
                        path: child,
                        change: FieldChange::Add,
                    }),
                }
            }
            for key in before.keys().filter(|key| !after.contains_key(*key)) {
                out.push(FieldEdit {
                    path: format!("{path}.{key}"),
                    change: FieldChange::Remove,
                });
            }
        }
        (Value::Array(before), Value::Array(after)) if before.len() == after.len() => {
            for (index, (previous, value)) in before.iter().zip(after).enumerate() {
                collect_field_edits(previous, value, &format!("{path}.{index}"), depth + 1, out);
            }
        }
        _ => out.push(FieldEdit {
            path: path.to_string(),
            change: FieldChange::Replace,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions;
    use serde_json::json;

    fn test_db() -> Database {
        let dir = std::env::temp_dir().join(format!("pi-desktop-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Database::open(&dir.join("test.sqlite")).unwrap()
    }

    #[test]
    fn every_rewrite_kind_round_trips_through_the_store() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();

        record(
            &db,
            &session.id,
            Some("turn-1"),
            "acme.sender",
            RewriteDiff::outgoing_message("m-1", "hello world", "hello brave world"),
        )
        .unwrap();
        record(
            &db,
            &session.id,
            Some("turn-1"),
            "acme.prompt",
            RewriteDiff::system_prompt("You are help", "Be terse"),
        )
        .unwrap();
        record(
            &db,
            &session.id,
            Some("turn-1"),
            "acme.history",
            RewriteDiff::message_list(vec![
                MessageEdit {
                    index: 2,
                    change: MessageChange::Replace,
                    before_id: Some("m-2".into()),
                    after_id: Some("m-9".into()),
                    to_index: None,
                },
                MessageEdit {
                    index: 4,
                    change: MessageChange::Reorder,
                    before_id: Some("m-4".into()),
                    after_id: None,
                    to_index: Some(0),
                },
            ]),
        )
        .unwrap();
        record(
            &db,
            &session.id,
            Some("turn-1"),
            "acme.payload",
            RewriteDiff::request_payload(
                &json!({ "model": "a", "temperature": 0.2 }),
                &json!({ "model": "a", "temperature": 0.9, "topP": 1 }),
            ),
        )
        .unwrap();

        let listed = list_for_turn(&db, &session.id, "turn-1", None, 50).unwrap();
        assert_eq!(listed.len(), 4);
        assert_eq!(
            listed
                .iter()
                .map(|record| record.kind.as_str())
                .collect::<Vec<_>>(),
            [
                "outgoing_message",
                "system_prompt",
                "message_list",
                "request_payload"
            ]
        );
        assert!(listed.iter().all(|record| !record.truncated));
        assert!(listed.iter().all(|record| record.dropped_edits == 0));
        assert!(listed
            .iter()
            .all(|record| record.turn_id.as_deref() == Some("turn-1")));

        // The character diff locates the insertion exactly: "hello " shared,
        // " world" shared, so six characters were inserted at offset 6.
        assert_eq!(
            listed[0].diff["characterEdits"][0],
            json!({
                "start": 6, "end": 6, "beforeChars": 0, "afterChars": 6,
                "before": "", "after": "brave ", "truncated": false
            })
        );
        assert_eq!(
            listed[1].diff["characterEdits"][0]["before"],
            json!("You are help")
        );
        assert_eq!(listed[2].diff["messageEdits"][1]["toIndex"], json!(0));
        assert_eq!(
            listed[3].diff["fieldEdits"],
            json!([
                { "path": "$.temperature", "change": "replace" },
                { "path": "$.topP", "change": "add" }
            ])
        );
        assert_eq!(
            listed[3].diff["summary"]["afterBytes"],
            json!(
                serde_json::to_string(&json!({ "model": "a", "temperature": 0.9, "topP": 1 }))
                    .unwrap()
                    .len()
            )
        );
    }

    #[test]
    fn a_short_before_and_after_pair_describes_the_changed_span() {
        let diff = RewriteDiff::system_prompt("keep this", "keep that");
        let RewriteDiff::SystemPrompt { character_edits } = &diff else {
            panic!("a prompt rewrite must keep its kind");
        };
        assert_eq!(
            character_edits,
            &vec![CharacterEdit {
                start: 7,
                end: 9,
                before_chars: 2,
                after_chars: 2,
                before: "is".into(),
                after: "at".into(),
                truncated: false,
            }]
        );
        // A rewrite that changed nothing records nothing.
        assert!(matches!(
            RewriteDiff::system_prompt("same", "same"),
            RewriteDiff::SystemPrompt { ref character_edits } if character_edits.is_empty()
        ));
    }

    #[test]
    fn a_capped_body_is_marked_and_the_summary_stays_exact() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let filler = "x".repeat(MAX_BODY_BYTES * 2);
        let before = json!({ "model": "a", "messages": [] });
        let after = json!({ "model": "a", "messages": [], "padding": filler });
        let full_after_bytes =
            serde_json::to_string(&json!({ "model": "a", "messages": [], "padding": filler }))
                .unwrap()
                .len();

        record(
            &db,
            &session.id,
            Some("turn-1"),
            "acme.payload",
            RewriteDiff::request_payload(&before, &after),
        )
        .unwrap();

        let stored = list_for_turn(&db, &session.id, "turn-1", None, 50)
            .unwrap()
            .remove(0);
        // The body was capped, and the record says so.
        assert!(stored.truncated);
        assert_eq!(stored.diff["bodyTruncated"], json!(true));
        assert_eq!(stored.diff["body"].as_str().unwrap().len(), MAX_BODY_BYTES);
        // The summary and the field list are still exact.
        assert_eq!(
            stored.diff["summary"]["afterBytes"],
            json!(full_after_bytes)
        );
        assert_eq!(
            stored.diff["summary"]["beforeBytes"],
            json!(serde_json::to_string(&before).unwrap().len())
        );
        assert_eq!(
            stored.diff["fieldEdits"],
            json!([{ "path": "$.padding", "change": "add" }])
        );
    }

    #[test]
    fn an_oversized_diff_is_stored_capped_and_counted() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let huge_id = "m".repeat(MAX_FRAGMENT_BYTES * 2);
        let message_edits: Vec<MessageEdit> = (0..MAX_DIFF_ENTRIES * 4)
            .map(|index| MessageEdit {
                index,
                change: MessageChange::Replace,
                before_id: Some(huge_id.clone()),
                after_id: Some(huge_id.clone()),
                to_index: None,
            })
            .collect();

        record(
            &db,
            &session.id,
            Some("turn-1"),
            "acme.history",
            RewriteDiff::message_list(message_edits),
        )
        .unwrap();

        let (diff_bytes, truncated, dropped, kept): (i64, i64, i64, i64) = db
            .conn()
            .query_row(
                "SELECT LENGTH(diff_json), truncated, dropped_edits,
                        JSON_ARRAY_LENGTH(diff_json, '$.messageEdits')
                 FROM plugin_rewrites",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert!(
            diff_bytes <= MAX_DIFF_BYTES as i64,
            "a record must never exceed the diff ceiling, got {diff_bytes}"
        );
        assert_eq!(truncated, 1);
        assert!(dropped > 0);
        assert!(kept > 0 && kept <= MAX_DIFF_ENTRIES as i64);
        // The record is still readable, and says what it lost.
        let stored = list_for_turn(&db, &session.id, "turn-1", None, 50)
            .unwrap()
            .remove(0);
        assert!(stored.truncated);
        assert_eq!(stored.dropped_edits, dropped);
    }

    #[test]
    fn identifiers_above_the_cap_are_rejected_instead_of_stored() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let error = record(
            &db,
            &session.id,
            Some("turn-1"),
            &"p".repeat(MAX_IDENTIFIER_BYTES + 1),
            RewriteDiff::system_prompt("a", "b"),
        )
        .unwrap_err();
        assert!(error.to_string().starts_with("LIMIT_EXCEEDED"));
        assert!(list_for_turn(&db, &session.id, "turn-1", None, 50)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn the_per_turn_query_returns_only_that_turn_in_order() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        record(
            &db,
            &session.id,
            Some("turn-1"),
            "acme.first",
            RewriteDiff::system_prompt("one", "two"),
        )
        .unwrap();
        record(
            &db,
            &session.id,
            Some("turn-1"),
            "acme.second",
            RewriteDiff::message_list(vec![MessageEdit {
                index: 0,
                change: MessageChange::Delete,
                before_id: Some("m-0".into()),
                after_id: None,
                to_index: None,
            }]),
        )
        .unwrap();
        record(
            &db,
            &session.id,
            Some("turn-2"),
            "acme.other",
            RewriteDiff::system_prompt("one", "three"),
        )
        .unwrap();
        // A rewrite outside any turn must not leak into a turn's list.
        record(
            &db,
            &session.id,
            None,
            "acme.nightly",
            RewriteDiff::system_prompt("one", "four"),
        )
        .unwrap();

        let turn_one = list_for_turn(&db, &session.id, "turn-1", None, 50).unwrap();
        assert_eq!(
            turn_one
                .iter()
                .map(|record| record.plugin_id.as_str())
                .collect::<Vec<_>>(),
            ["acme.first", "acme.second"]
        );
        assert!(turn_one.iter().all(|record| record.turn_id.is_some()));
        assert_eq!(
            list_for_turn(&db, &session.id, "turn-2", None, 50)
                .unwrap()
                .len(),
            1
        );
        assert!(list_for_turn(&db, &session.id, "turn-9", None, 50)
            .unwrap()
            .is_empty());

        // The kind filter is applied by the query, not after the fact.
        assert_eq!(
            list_for_turn(
                &db,
                &session.id,
                "turn-1",
                Some(RewriteKind::MessageList),
                50
            )
            .unwrap()
            .len(),
            1
        );
        assert_eq!(
            list_for_turn(
                &db,
                &session.id,
                "turn-1",
                Some(RewriteKind::SystemPrompt),
                50
            )
            .unwrap()
            .len(),
            1
        );
        assert!(list_for_turn(
            &db,
            &session.id,
            "turn-1",
            Some(RewriteKind::OutgoingMessage),
            50
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn the_session_query_is_newest_first_and_keeps_records_without_a_turn() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        for (index, turn_id) in [(1, Some("turn-1")), (2, Some("turn-2")), (3, None)] {
            record(
                &db,
                &session.id,
                turn_id,
                &format!("acme.{index}"),
                RewriteDiff::system_prompt("one", &format!("prompt {index}")),
            )
            .unwrap();
        }

        let listed = list_for_session(&db, &session.id, None, 50).unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|record| record.plugin_id.as_str())
                .collect::<Vec<_>>(),
            ["acme.3", "acme.2", "acme.1"]
        );
        assert!(listed[0].turn_id.is_none());
        assert!(listed.iter().all(|record| record.session_id == session.id));
        assert!(listed[0].created_at.ends_with('Z'));

        // Deleting the session takes its records with it.
        sessions::delete_session(&db, &session.id).unwrap();
        assert!(list_for_session(&db, &session.id, None, 50)
            .unwrap()
            .is_empty());
    }
}
