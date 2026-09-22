/**
 * The renderer's view of the diff-level rewrite records host-core stores
 * (ADR 0295 rule 5). The records are written by the runtime's send hook and
 * read back through `plugin.rewrites.list`; a row badge shows who rewrote an
 * outgoing message, and the record carries enough to show what the model
 * received instead.
 *
 * Everything here is pure: shape validation for the IPC payload, the
 * message-id lookup the transcript row needs, the reconstruction of the text
 * the model received, and the name to show. No fetching and no state.
 */

/** One changed span, exactly as `plugin_rewrites.rs` serializes it. */
export type PluginRewriteCharacterEdit = {
  /** Inclusive start offset in the original text (Unicode scalars). */
  start: number;
  /** Exclusive end offset in the original text. */
  end: number;
  beforeChars: number;
  afterChars: number;
  before: string;
  after: string;
  /** The fragment was clipped; the offsets and counts are still exact. */
  truncated: boolean;
};

/** One stored rewrite record as `plugin.rewrites.list` returns it. */
export type PluginRewriteRecord = {
  id: number;
  sessionId: string;
  turnId?: string | null;
  pluginId: string;
  /** `outgoing_message` for slot #1; a wider vocabulary is exposed verbatim. */
  kind: string;
  truncated: boolean;
  droppedEdits: number;
  createdAt: string;
  diff: {
    kind?: string;
    targetMessageId?: string;
    characterEdits?: PluginRewriteCharacterEdit[];
  };
};

function isCharacterEdit(value: unknown): value is PluginRewriteCharacterEdit {
  if (!value || typeof value !== "object") return false;
  const edit = value as Record<string, unknown>;
  return (
    typeof edit.start === "number" &&
    typeof edit.end === "number" &&
    typeof edit.before === "string" &&
    typeof edit.after === "string"
  );
}

function isRewriteRecord(value: unknown): value is PluginRewriteRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const diff = record.diff;
  return (
    typeof record.id === "number" &&
    typeof record.sessionId === "string" &&
    typeof record.pluginId === "string" &&
    typeof record.kind === "string" &&
    typeof record.truncated === "boolean" &&
    Boolean(diff) &&
    typeof diff === "object" &&
    !Array.isArray(diff)
  );
}

/**
 * The records one session read carried. A payload that is not a list of
 * records is treated as "nothing to show": a badge is presentation, and a
 * host that answers with a different shape must not break the transcript.
 */
export function asPluginRewriteRecords(value: unknown): PluginRewriteRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRewriteRecord);
}

/**
 * The rewrite of one transcript row, if a plugin rewrote it on the way to the
 * model. Rows are keyed by the message id the runtime recorded, so a row with
 * no record simply has no badge.
 */
export function outgoingRewriteForMessage(
  records: readonly PluginRewriteRecord[] | undefined,
  messageId: string | undefined,
): PluginRewriteRecord | undefined {
  if (!records?.length || !messageId) return undefined;
  return records.find(
    (record) =>
      record.kind === "outgoing_message" &&
      record.diff.kind === "outgoing_message" &&
      record.diff.targetMessageId === messageId,
  );
}

/**
 * The text the model received, rebuilt from the row's own text plus the
 * recorded character edits. Returns `null` when the record cannot reproduce it
 * exactly (a clipped fragment, or offsets that do not fit the row), so the
 * caller shows the changed spans instead of a wrong sentence.
 */
export function rewrittenMessageText(
  original: string,
  record: PluginRewriteRecord | undefined,
): string | null {
  const edits = record?.diff.characterEdits;
  if (!Array.isArray(edits) || edits.length === 0) return null;
  if (!edits.every(isCharacterEdit)) return null;
  const ordered = [...edits].sort((left, right) => right.start - left.start);
  let text = Array.from(original);
  for (const edit of ordered) {
    if (edit.truncated) return null;
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end)) return null;
    if (edit.start < 0 || edit.end < edit.start || edit.end > text.length) return null;
    text = [
      ...text.slice(0, edit.start),
      ...Array.from(edit.after),
      ...text.slice(edit.end),
    ];
  }
  return text.join("");
}

/**
 * The name a badge shows: the loaded plugin's own display name when it is
 * known, the plugin id otherwise (an uninstalled plugin still has an audit
 * record, and an id the user can act on beats a blank badge).
 */
export function rewritePluginName(
  record: PluginRewriteRecord,
  plugins: ReadonlyArray<{ id?: unknown; name?: unknown }> | undefined,
): string {
  for (const plugin of plugins ?? []) {
    if (
      plugin?.id === record.pluginId &&
      typeof plugin.name === "string" &&
      plugin.name.trim()
    ) {
      return plugin.name;
    }
  }
  return record.pluginId;
}
