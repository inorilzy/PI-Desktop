pub(crate) const SCHEMA_LATEST: &str = r#"
CREATE TABLE kv (
  ns         TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ns, key)
) WITHOUT ROWID;

CREATE TABLE projects (
  id             INTEGER PRIMARY KEY,
  path           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  pinned         INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);

CREATE TABLE providers (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  vendor_key       TEXT NOT NULL DEFAULT 'custom',
  type             TEXT NOT NULL DEFAULT 'openai_compatible',
  protocol         TEXT NOT NULL DEFAULT 'openai_compatible',
  api_style        TEXT,
  auth_kind        TEXT NOT NULL DEFAULT 'api_key_and_base_url',
  base_url         TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  secret_ref       TEXT,
  default_model_id TEXT,
  config_json      TEXT NOT NULL DEFAULT '{}',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  -- Owning plugin id for a row a plugin declared in `contributes.providers`
  -- (schema v17, ADR 0259). NULL is a user-owned row: the plugin refreshes its
  -- own fields on every load, while the user path may edit or delete only the
  -- rows it owns.
  owner_plugin_id  TEXT
);
CREATE INDEX idx_providers_owner ON providers(owner_plugin_id)
  WHERE owner_plugin_id IS NOT NULL;

CREATE TABLE models (
  provider_id       TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id          TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'user',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  context_window    INTEGER,
  max_output_tokens INTEGER,
  deprecated        INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_id)
) WITHOUT ROWID;

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  provider_id TEXT,
  model_id    TEXT,
  mode        TEXT NOT NULL DEFAULT 'agent',
  thinking_level TEXT NOT NULL DEFAULT 'off'
                CHECK (thinking_level IN ('off', 'minimal', 'low', 'medium',
                                          'high', 'xhigh', 'max')),
  permission_mode TEXT NOT NULL DEFAULT 'inherit'
                CHECK (permission_mode IN ('inherit', 'ask', 'accept-edits', 'auto')),
  source      TEXT,
  deleted_at  INTEGER,
  pinned      INTEGER NOT NULL DEFAULT 0,
  last_seq    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX idx_sessions_project ON sessions(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_sessions_deleted ON sessions(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE session_import_origins (
  plugin_id    TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  session_id   TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  source_label TEXT,
  origin_json  TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE(plugin_id, source_id, external_id)
);
CREATE INDEX idx_session_import_origins_plugin
  ON session_import_origins(plugin_id, source_id, created_at DESC);

CREATE TABLE turns (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'running',
  provider_id   TEXT,
  model_id      TEXT,
  error_code    TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  usage_json    TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER
);
CREATE INDEX idx_turns_session ON turns(session_id, started_at DESC);
CREATE INDEX idx_turns_ended_at ON turns(ended_at DESC);
CREATE UNIQUE INDEX idx_turns_one_running_session
  ON turns(session_id) WHERE status = 'running';

CREATE TABLE turn_queue (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  principal        TEXT NOT NULL,
  idempotency_key  TEXT,
  input_hash       TEXT NOT NULL,
  content          TEXT NOT NULL,
  attachments_json TEXT,
  session_message_id TEXT,
  permission_mode  TEXT NOT NULL,
  position         INTEGER NOT NULL,
  priority         INTEGER,
  created_at       INTEGER NOT NULL,
  -- Provenance of a continuation a plugin asked for (schema v22, ADR 0295
  -- rule 9 / slot #10 `runtime.turn.continue`): the plugin id plus the display
  -- name as of the request, snapshotted for the same reason a transcript row
  -- snapshots it — the queue entry stays readable after the plugin is
  -- uninstalled. NULL is a queue entry the user (or the Host) made: a row
  -- without provenance keeps behaving exactly as before.
  plugin_id        TEXT,
  plugin_label     TEXT
);
CREATE INDEX idx_turn_queue_session ON turn_queue(session_id, position);
CREATE UNIQUE INDEX idx_turn_queue_idempotency
  ON turn_queue(session_id, principal, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('task.completed', 'task.failed')),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_title TEXT NOT NULL,
  turn_id    TEXT NOT NULL UNIQUE,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
CREATE INDEX idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX idx_notifications_unread
  ON notifications(created_at DESC) WHERE read_at IS NULL;

CREATE TABLE messages (
  mid          INTEGER PRIMARY KEY,
  id           TEXT NOT NULL UNIQUE,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id      TEXT REFERENCES turns(id) ON DELETE SET NULL,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  tool_name    TEXT,
  is_error     INTEGER NOT NULL DEFAULT 0,
  text         TEXT,
  created_at   INTEGER NOT NULL,
  -- Per-row plugin provenance (schema v22, ADR 0293/0295 rule 9): the plugin
  -- id and display name a continuation row was written with, snapshotted at
  -- append time. NULL is an ordinary row the user typed, which is why the
  -- transcript draws a badge only for rows that carry it. Appended last so a
  -- migrated file and a fresh one hold the same column order.
  plugin_id    TEXT,
  plugin_label TEXT,
  UNIQUE (session_id, seq)
);
-- The per-turn message read (`turn.messages`, ADR 0295 slot #8) orders one
-- turn's rows through this partial index instead of scanning the session.
CREATE INDEX idx_messages_turn ON messages(turn_id, seq) WHERE turn_id IS NOT NULL;

CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content='messages', content_rowid='mid',
  tokenize='trigram'
);
CREATE TRIGGER messages_ai AFTER INSERT ON messages WHEN new.text IS NOT NULL
  BEGIN INSERT INTO messages_fts(rowid, text) VALUES (new.mid, new.text); END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages WHEN old.text IS NOT NULL
  BEGIN INSERT INTO messages_fts(messages_fts, rowid, text)
        VALUES ('delete', old.mid, old.text); END;
CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages
  BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text)
      SELECT 'delete', old.mid, old.text WHERE old.text IS NOT NULL;
    INSERT INTO messages_fts(rowid, text)
      SELECT new.mid, new.text WHERE new.text IS NOT NULL;
  END;

-- One row per recorded touch, not one row per file (schema v19, ADR 0295
-- rule 8): a file changed in three turns must stay attributable to all three,
-- so `turn_id` is part of the exposed shape and `op` names the effect that
-- turn had (`create | write | edit | download | delete`; the vocabulary is
-- enforced by the typed write path in `artifacts.rs`, so no stored row needs
-- rewriting when it grows).
CREATE TABLE artifacts (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  op         TEXT NOT NULL,
  turn_id    TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_time ON artifacts(updated_at DESC);
CREATE INDEX idx_artifacts_session_turn
  ON artifacts(session_id, turn_id, updated_at);

CREATE TABLE message_revisions (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  root_user_id    TEXT NOT NULL,
  revision_index  INTEGER NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 0,
  message_count   INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  UNIQUE (session_id, root_user_id, revision_index)
);
CREATE INDEX idx_message_revisions_root
  ON message_revisions(session_id, root_user_id, revision_index);

CREATE TABLE scheduled_tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  cadence     TEXT NOT NULL DEFAULT 'manual',
  enabled     INTEGER NOT NULL DEFAULT 1,
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  last_run_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE task_runs (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  status     TEXT NOT NULL DEFAULT 'running',
  error_code TEXT,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE INDEX idx_task_runs ON task_runs(task_id, started_at DESC);

CREATE TABLE secrets_meta (
  secret_ref TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL DEFAULT 'provider',
  owner_id   TEXT,
  kind       TEXT NOT NULL DEFAULT 'api_key',
  backend    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  session_id   TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  -- The turn this record belongs to (schema v21, ADR 0295 rule 8, slot #9
  -- `runtime.turn.facts`): one turn's records are an indexed read instead of
  -- a scan of redacted payloads. NULL when the record is not about a turn —
  -- including every row written before v21 — so a per-turn read sees only
  -- rows the host actually attributed. Appended last because `ALTER TABLE`
  -- appends: a migrated file and a fresh one then hold the same column order.
  turn_id      TEXT
);
CREATE INDEX idx_audit_ts ON audit_log(ts);
CREATE INDEX idx_audit_session ON audit_log(session_id, ts) WHERE session_id IS NOT NULL;
CREATE INDEX idx_audit_turn ON audit_log(turn_id, ts) WHERE turn_id IS NOT NULL;

"#;

/// Approval storage is kept in one batch so fresh databases and migrations
/// cannot drift in table names, checks, or indexes.
pub(crate) const PLAN_APPROVALS_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS plan_approvals (
  request_id             TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id               TEXT NOT NULL,
  tool_call_id          TEXT NOT NULL UNIQUE,
  kind                  TEXT NOT NULL DEFAULT 'plan' CHECK (kind IN ('plan', 'goal')),
  plan_json             TEXT NOT NULL,
  title                 TEXT NOT NULL DEFAULT '',
  question              TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL CHECK (status IN (
    'pending', 'approved', 'changes_requested', 'rejected',
    'expired', 'interrupted'
  )),
  action                TEXT CHECK (action IN ('approve', 'request_changes', 'reject')),
  target_permission_mode TEXT CHECK (target_permission_mode IN ('ask', 'accept-edits', 'auto')),
  feedback              TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  expires_at            INTEGER,
  resolved_at           INTEGER,
  error_code            TEXT,
  artifact_relative_path TEXT,
  artifact_sha256       TEXT,
  artifact_size_bytes   INTEGER,
  version               INTEGER NOT NULL DEFAULT 1,
  execution_id          TEXT UNIQUE,
  execution_state       TEXT CHECK (execution_state IN (
    'queued', 'running', 'completed', 'interrupted'
  ))
);
CREATE INDEX IF NOT EXISTS idx_plan_approvals_session
  ON plan_approvals(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plan_approvals_pending
  ON plan_approvals(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_approvals_one_pending_session
  ON plan_approvals(session_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_plan_approvals_execution_queue
  ON plan_approvals(execution_state, created_at DESC)
  WHERE execution_state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_plan_approvals_execution_id
  ON plan_approvals(execution_id) WHERE execution_id IS NOT NULL;
"#;
