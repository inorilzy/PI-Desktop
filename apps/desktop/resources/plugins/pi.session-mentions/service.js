import { normalizeSessionId } from './lib/references.js';
import { ownTypedText } from './lib/prompt.js';
import { pairCompletedQaTurns } from './lib/qa.js';
import { readSessionReferenceSource } from './lib/reader.js';
import {
  buildSessionSnapshot, contextBytesFromTokens, DEFAULT_MAX_TURNS, MARK_SEND_MAX_BYTES,
} from './lib/snapshot.js';

/** Rows one `@` list offers; also the host's mark limit per draft. */
export const MAX_ROWS = 8;
/** `plugin.call` answers are capped at 64KB by the host; stay well under it. */
export const ANSWER_MAX_BYTES = 56 * 1024;
/** The host gives a trigger 2s and a `plugin.call` 2s; one answer never takes longer. */
export const MAX_CALL_DEADLINE_MS = 1_500;
export const PAGE_LIMIT = 400;
/** Longest single message read; anything longer cannot fit in a mark anyway. */
export const CONTENT_LIMIT = 40_000;
export const MAX_PAGES = 4;
const LIST_TTL_MS = 3_000;
const SNAPSHOT_CACHE_MAX = 64;
const LABEL_MAX_CHARS = 64;
const DETAIL_MAX_CHARS = 256;
/** Characters of the first question shown on a row. */
export const SNIPPET_MAX_CHARS = 40;
/** Rows read from the start of a long session to find its first question. */
const FIRST_PAGE_LIMIT = 8;

const now = () => Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

const oneLine = (text) => String(text ?? '').replace(/[\uE000-\uF8FF\uFFFC]/g, '')
  .replace(/[\r\n\u2028\u2029\s]+/g, ' ').trim();

function clip(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/** A mark label: one line, no chip tokens, at most 64 characters; `suffix` is never cut. */
export function markLabel(title, id, suffix = '') {
  const text = oneLine(title) || `Session ${id.slice(0, 8)}`;
  return suffix ? `${clip(text, LABEL_MAX_CHARS - Array.from(suffix).length)}${suffix}` : clip(text, LABEL_MAX_CHARS);
}

const pad = (n) => String(n).padStart(2, '0');

/** `MM-DD HH:mm` in the machine's local time, or '' for an unreadable time. */
export function shortStamp(updatedAt) {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Labels for the rows of one list. Sessions sharing a title (e.g. several
 * "new task") get their short update time, and the id's first four
 * characters if that still collides; a unique title stays as it is, so the
 * chip in the draft is just the title.
 */
export function rowLabels(rows) {
  const base = rows.map((row) => markLabel(row.title, row.id));
  const count = (labels) => labels.reduce((map, label) => map.set(label, (map.get(label) ?? 0) + 1), new Map());
  const firstPass = count(base);
  const stamped = rows.map((row, i) => {
    if (firstPass.get(base[i]) === 1) return base[i];
    const stamp = shortStamp(row.updatedAt);
    return stamp ? markLabel(row.title, row.id, ` · ${stamp}`) : base[i];
  });
  const secondPass = count(stamped);
  return rows.map((row, i) => secondPass.get(stamped[i]) === 1 ? stamped[i]
    : markLabel(row.title, row.id, `${stamped[i] === base[i] ? '' : ` · ${shortStamp(row.updatedAt)}`} #${row.id.slice(0, 4)}`));
}

/** How long ago a session was updated, short and localized. */
export function relativeTime(updatedAt, locale, nowMs = Date.now()) {
  const at = new Date(updatedAt).getTime();
  if (Number.isNaN(at)) return '';
  const zh = String(locale ?? '').toLowerCase().startsWith('zh');
  const minutes = Math.max(0, Math.floor((nowMs - at) / 60_000));
  if (minutes < 1) return zh ? '刚刚' : 'just now';
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return zh ? `${days} 天前` : `${days} d ago`;
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The user's own words of a question, one line, quoted and short; '' when there are none. */
export function questionSnippet(text) {
  const line = oneLine(ownTypedText(String(text ?? '')));
  return line ? `“${clip(line, SNIPPET_MAX_CHARS)}”` : '';
}

function words(locale) {
  return String(locale ?? '').toLowerCase().startsWith('zh') ? {
    turns: (n) => `${n} 轮问答`, omitted: (n) => `省略 ${n} 轮更早的`, unread: '更早的未读取', clipped: '已截断',
    contextFull: '上下文快满了，先 /compact 压缩再引用',
  } : {
    turns: (n) => `${n} Q&A turn${n === 1 ? '' : 's'}`, omitted: (n) => `${n} older omitted`,
    unread: 'older history not read', clipped: 'clipped',
    contextFull: 'Context is nearly full: run /compact first, then reference this session again',
  };
}

/**
 * What a row sends when not even one complete turn fits the current context:
 * a one-line note, never a clipped snapshot, so a pick made anyway is harmless.
 */
export function contextFullNote(title) {
  const name = String(title ?? '').replace(/[\uE000-\uF8FF\uFFFC]/g, '').replace(/[\r\n"]+/g, ' ').trim();
  return `[Session "${name}" was not attached: the current context is nearly full. Run /compact, then reference it again.]`;
}

export function contextFullDetail(locale) {
  return words(locale).contextFull;
}

export function snapshotDetail(snapshot, locale, snippet = '') {
  const w = words(locale);
  const parts = [...(snippet ? [snippet] : []), w.turns(snapshot.includedTurns)];
  if (snapshot.omittedKnown > 0) parts.push(w.omitted(snapshot.omittedKnown));
  if (snapshot.olderUnread) parts.push(w.unread);
  if (snapshot.clipped) parts.push(w.clipped);
  return Array.from(parts.join(' · ')).slice(0, DETAIL_MAX_CHARS).join('');
}

/** Whitelist Q&A fields at the host boundary; never forward thinking or tool payloads. */
export function referencePage(value, expectedId) {
  const id = normalizeSessionId(value?.id ?? value?.sessionId);
  if (!id || id !== expectedId || !Array.isArray(value?.messages)) {
    throw new Error('The referenced session returned an invalid transcript page.');
  }
  const messages = [];
  for (const row of value.messages) {
    if (!row || typeof row !== 'object') throw new Error('Invalid transcript row.');
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    if (row.parentToolCallId) continue;
    if (row.content !== undefined && typeof row.content !== 'string') {
      throw new Error('The host did not provide plain-text message content.');
    }
    messages.push({
      ...(typeof row.id === 'string' ? { id: row.id } : {}),
      role: row.role, content: row.content ?? '',
      ...(typeof row.status === 'string' ? { status: row.status } : {}),
      ...(row.contentTruncated ? { contentTruncated: true } : {}),
      ...(Array.isArray(row.attachments) && row.attachments.length ? { attachments: [{}] } : {}),
    });
  }
  return { id, title: typeof value.title === 'string' ? value.title : id, messages,
    messageStart: value.messageStart, messageEnd: value.messageEnd,
    hasMoreBefore: value.hasMoreBefore ?? false };
}

/**
 * The plugin process side of the `@` trigger. All I/O goes through the
 * reviewed `pi.desktop.invoke` read operations `session/list` and
 * `session/get`; no file-system, database or renderer-store access.
 *
 * A trigger row has to carry its mark text up front, so snapshots are built
 * ahead of the pick and cached by `id@updatedAt`. An answer holds as many
 * snapshots as fit its size and time budget; the rest are reported pending
 * and keep building, so the renderer can ask again.
 */
export function createSessionMentionService(host, options = {}) {
  const maxBytes = options.maxBytes ?? MARK_SEND_MAX_BYTES;
  const answerMaxBytes = options.answerMaxBytes ?? ANSWER_MAX_BYTES;
  let disposed = false;
  let list = null;
  let locale;
  const sources = new Map();
  const building = new Map();
  const controller = new AbortController();
  const check = () => { if (disposed) throw new Error('Session Mentions was unloaded.'); };
  const invoke = async (operation, args = []) => {
    check();
    const value = await host.desktop.invoke({ operation, args });
    check();
    return value;
  };

  const summaries = async () => {
    if (list && now() - list.at < LIST_TTL_MS) return list.rows;
    const result = await invoke('session/list');
    if (!Array.isArray(result?.sessions)) throw new Error('Session list is unavailable.');
    const rows = [];
    for (const row of result.sessions) {
      const id = normalizeSessionId(row?.id);
      if (!id || row.scheduledRun || (row.source && row.source !== 'desktop')) continue;
      const updatedAt = String(row.updatedAt ?? '');
      rows.push({ id, title: typeof row.title === 'string' ? row.title : '', updatedAt, key: `${id}@${updatedAt}` });
    }
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    list = { at: now(), rows };
    return rows;
  };

  const currentLocale = async () => {
    if (locale === undefined) locale = await Promise.resolve(host.app?.getLocale?.()).catch(() => '') ?? '';
    return locale;
  };

  const loadPage = async (id, before, signal) => {
    signal.throwIfAborted();
    const answer = await invoke('session/get', [{ id, messageLimit: PAGE_LIMIT, contentLimit: CONTENT_LIMIT,
      ...(before === undefined ? {} : { messageBefore: before }) }]);
    signal.throwIfAborted();
    if (!answer?.session) return null;
    return referencePage(answer.session, id);
  };

  const remember = (key, value) => {
    sources.delete(key);
    sources.set(key, value);
    while (sources.size > SNAPSHOT_CACHE_MAX) sources.delete(sources.keys().next().value);
  };

  /**
   * The session's first parent question with words the user typed (a message
   * that only carried referenced chats falls through to the next one): from
   * the rows already read when they reach the start, else from one short read
   * of the first rows, else the oldest rows read. Best effort; '' omits it.
   */
  const firstQuestion = async (id, source) => {
    const fromRows = (messages) => messages.find((message) => message.role === 'user' &&
      !message.parentToolCallId && questionSnippet(message.content))?.content;
    if (!source.hasMoreBefore) return fromRows(source.messages) ?? '';
    try {
      const answer = await invoke('session/get', [{ id, messageBefore: FIRST_PAGE_LIMIT,
        messageLimit: FIRST_PAGE_LIMIT, contentLimit: 400 }]);
      const first = fromRows(Array.isArray(answer?.session?.messages) ? answer.session.messages : []);
      if (first) return first;
    } catch {
      // fall back to what was read
    }
    return fromRows(source.messages) ?? '';
  };

  /** Read (once) the transcript of one row; failures are cached as `null` until the session changes. */
  const read = (row) => {
    if (sources.has(row.key)) return Promise.resolve(sources.get(row.key));
    const running = building.get(row.key);
    if (running) return running;
    const work = (async () => {
      try {
        const source = await readSessionReferenceSource(row.id, loadPage, {
          budgetTokens: Math.ceil(maxBytes / 3), enoughTurns: DEFAULT_MAX_TURNS + 1,
          maxPages: MAX_PAGES, signal: controller.signal,
        });
        if (!source) return null;
        return { ...source, title: source.title || row.title, firstQuestion: await firstQuestion(row.id, source) };
      } catch (error) {
        if (disposed) throw error;
        return null;
      }
    })().then((source) => {
      if (!disposed) remember(row.key, source);
      return source;
    }).finally(() => building.delete(row.key));
    building.set(row.key, work);
    return work;
  };

  /** The row's mark text for this answer's context budget; pure, from the cached transcript. */
  const snapshotOf = (source, contextBytes) => {
    let snapshot = buildSessionSnapshot(source, { maxBytes, contextBytes });
    // JSON escaping must not push one snapshot past the answer budget.
    for (let limit = maxBytes; snapshot.status === 'ready' && jsonBytes(snapshot.send) > answerMaxBytes - 1024 && limit > 2048;) {
      limit = Math.floor(limit * 0.75);
      snapshot = buildSessionSnapshot(source, { maxBytes: limit, contextBytes });
    }
    return snapshot;
  };

  /** No complete Q&A turn to reference (a new or unanswered session, often the current one). */
  const empty = (source) => pairCompletedQaTurns(source.messages).length === 0;
  /** Known to have nothing to reference: unreadable, or no complete turn. */
  const hidden = (row) => sources.has(row.key) && (!sources.get(row.key) || empty(sources.get(row.key)));

  /** As many ready snapshots of `rows` as fit; the rest pending. */
  const pack = async (rows, deadlineMs, contextBytes) => {
    const until = now() + deadlineMs;
    const lang = await currentLocale();
    const all = Promise.all(rows.map((row) => read(row).catch(() => null)));
    await Promise.race([all, sleep(Math.max(0, until - now()))]);
    const ready = [];
    const pending = [];
    let used = 1024;
    for (const row of rows) {
      if (!sources.has(row.key)) { pending.push(row.key); continue; }
      const source = sources.get(row.key);
      if (!source || empty(source)) continue;
      let snapshot;
      try { snapshot = snapshotOf(source, contextBytes); } catch { continue; }
      const entry = snapshot.status === 'context-full'
        ? { key: row.key, send: contextFullNote(source.title), detail: contextFullDetail(lang), contextFull: true }
        : { key: row.key, send: snapshot.send, detail: snapshotDetail(snapshot, lang, questionSnippet(source.firstQuestion)) };
      const size = jsonBytes(entry);
      if (used + size > answerMaxBytes) { pending.push(row.key); continue; }
      used += size;
      ready.push(entry);
    }
    return { snapshots: ready, pending };
  };

  const deadlineOf = (args) => {
    const value = Number(args.deadlineMs);
    return Number.isFinite(value) ? Math.min(MAX_CALL_DEADLINE_MS, Math.max(0, value)) : MAX_CALL_DEADLINE_MS;
  };
  /**
   * The current session's remaining context tokens, when the renderer passes
   * them: only while they bound a snapshot more tightly than the 32 KB mark
   * limit (see `bindingContextTokens` in renderer.js).
   */
  const contextOf = (args) => {
    const tokens = Number(args.contextRemainingTokens);
    return args.contextRemainingTokens === undefined || !Number.isFinite(tokens) ? undefined
      : contextBytesFromTokens(Math.max(0, tokens));
  };
  const keysOf = (value) => new Set(Array.isArray(value)
    ? value.filter((key) => typeof key === 'string' && key.length <= 128).slice(0, 64) : []);

  return {
    dispose() {
      disposed = true;
      controller.abort(new Error('Session Mentions was unloaded.'));
      sources.clear();
      building.clear();
    },
    async call(method, args = {}) {
      check();
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments.');
      if (method === 'sessions.items') {
        const query = typeof args.query === 'string' ? args.query.trim().toLowerCase().slice(0, 256) : '';
        const cached = keysOf(args.cached);
        // The session being typed in, when the host told the renderer: it cannot reference itself.
        const exclude = normalizeSessionId(args.exclude);
        const rows = (await summaries())
          .filter((row) => row.id !== exclude && !hidden(row) && `${row.title}\n${row.id}`.toLowerCase().includes(query))
          .slice(0, MAX_ROWS);
        const context = contextOf(args);
        // A context budget changes every snapshot, so the renderer's copies do not apply.
        const packed = await pack(context === undefined ? rows.filter((row) => !cached.has(row.key)) : rows,
          deadlineOf(args), context);
        const lang = await currentLocale();
        // Sessions found empty while packing leave the list before labels are disambiguated.
        const visible = rows.filter((row) => !hidden(row));
        const labels = rowLabels(visible);
        return {
          rows: visible.map((row, i) => ({ key: row.key, label: labels[i], when: relativeTime(row.updatedAt, lang) })),
          ...packed,
        };
      }
      if (method === 'sessions.snapshots') {
        const wanted = keysOf(args.keys);
        const rows = (await summaries()).filter((row) => wanted.has(row.key));
        return pack(rows, deadlineOf(args), contextOf(args));
      }
      throw new Error(`Unknown Session Mentions method: ${method}`);
    },
  };
}
