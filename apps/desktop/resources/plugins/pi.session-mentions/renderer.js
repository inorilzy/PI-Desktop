/**
 * Session Mentions — bundled first-party plugin (`pi.session-mentions`), renderer entry.
 *
 * Owns the composer's `@` trigger with `placement: 'first'`: this plugin's
 * Sessions group leads the list and its first session is the default pick;
 * the host's file rows follow. Picking a session puts a mark in
 * the draft that shows the session title and, on send, is replaced by that
 * session's recent complete Q&A (built by the headless entry).
 *
 * A row has to carry its mark text when the list is drawn, so snapshots are
 * fetched with the list and kept here by `id@updatedAt`; only rows whose
 * snapshot is ready are offered. Plain ES module, no build step of its own.
 */

/** The host waits 2s for a trigger answer; keep a margin for the relay. */
export const TRIGGER_BUDGET_MS = 1_700;
/** Typing settles before the plugin is asked, keeping under the call rate limit. */
export const DEBOUNCE_MS = 120;
const CACHE_MAX = 64;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shown before a session that does not fit the current context. */
export const CONTEXT_FULL_PREFIX = '⚠ ';
/** `lib/snapshot.js`: the mark limit, the reply reserve and UTF-8/3 per token. */
export const MARK_SEND_MAX_BYTES = 32 * 1024;
export const CONTEXT_RESERVE_TOKENS = 8192;

/**
 * The tokens the current session can still take, from what the host tells a
 * trigger (`query.context`: the composer ring's figures), when that bounds a
 * snapshot more tightly than the mark limit; otherwise `undefined`, and the
 * 32 KB mark limit is the only budget (and cached snapshots stay usable).
 */
export function bindingContextTokens(context) {
  const used = Number(context?.usedTokens);
  const window = Number(context?.contextWindow);
  if (!Number.isFinite(used) || !Number.isFinite(window) || window <= 0) return undefined;
  const remaining = Math.max(0, Math.floor(window - used));
  return (remaining - CONTEXT_RESERVE_TOKENS) * 3 < MARK_SEND_MAX_BYTES ? remaining : undefined;
}

/**
 * The host passes the draft's `sessionId` (left out of the list: a session
 * cannot reference itself) and its `context` use on every query; hosts that
 * predate them pass neither, and the list then shows every session with
 * something to reference.
 */
export function createSessionTrigger(dispatch, {
  budgetMs = TRIGGER_BUDGET_MS, debounceMs = DEBOUNCE_MS,
} = {}) {
  const cache = new Map();
  let latest = 0;
  const store = (answer, into) => {
    for (const entry of answer?.snapshots ?? []) {
      const value = { send: entry.send, detail: entry.detail, contextFull: entry.contextFull === true };
      into.delete(entry.key);
      into.set(entry.key, value);
      while (into.size > CACHE_MAX) into.delete(into.keys().next().value);
    }
    return Array.isArray(answer?.pending) ? answer.pending : [];
  };
  const call = (method, args) => dispatch('plugin.call', { method, args });

  async function items({ query, sessionId, context: usage }) {
    const started = Date.now();
    const turn = ++latest;
    if (debounceMs > 0) await sleep(debounceMs);
    // A newer keystroke owns the list; the host drops this answer anyway.
    if (turn !== latest) return [];
    const left = () => budgetMs - (Date.now() - started);
    const context = bindingContextTokens(usage);
    const budgeted = context !== undefined;
    // A context-budgeted snapshot is only good for this answer.
    const held = budgeted ? new Map() : cache;
    const extra = budgeted ? { contextRemainingTokens: context } : {};
    const exclude = typeof sessionId === 'string' && sessionId ? { exclude: sessionId } : {};
    const listed = await call('sessions.items', {
      query, cached: budgeted ? [] : [...cache.keys()], deadlineMs: left() - 250, ...exclude, ...extra,
    });
    let pending = store(listed, held);
    while (pending.length && turn === latest && left() > 400) {
      pending = store(await call('sessions.snapshots', { keys: pending, deadlineMs: left() - 250, ...extra }), held);
    }
    return (listed?.rows ?? []).flatMap((row) => {
      const ready = held.get(row.key);
      if (!ready) return [];
      const label = ready.contextFull
        ? Array.from(`${CONTEXT_FULL_PREFIX}${row.label}`).slice(0, 64).join('') : row.label;
      // The update time is the list's, fresh on every answer; the rest is the snapshot's.
      const detail = Array.from(row.when ? `${row.when} · ${ready.detail}` : ready.detail).slice(0, 256).join('');
      return [{ label, send: ready.send, detail }];
    });
  }

  return { items, cache };
}

export function onLoad(pi) {
  const trigger = createSessionTrigger(pi.dispatch);
  pi.slots.register({ slot: 'composerTrigger', trigger: '@', placement: 'first', items: trigger.items });
  // Warm the cache for the most recent sessions, so the first `@` has rows.
  void pi.dispatch('plugin.call', { method: 'sessions.items', args: { query: '', cached: [] } })
    .then((answer) => {
      for (const entry of answer?.snapshots ?? []) {
        trigger.cache.set(entry.key, { send: entry.send, detail: entry.detail, contextFull: entry.contextFull === true });
      }
    })
    .catch(() => {});
}
