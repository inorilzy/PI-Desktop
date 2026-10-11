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
 * fetched with the list and kept here by `id@updatedAt#budget/turns`; only rows
 * whose snapshot is ready are offered. Plain ES module, no build step of its own.
 *
 * The mark sends its `<referenced-chat>` block inside a fence tagged
 * `pi.session-mentions:chat`; this plugin's `blockRenderer` draws that fence
 * in the transcript as a collapsed card (`card.js`). The model reads the same
 * text either way.
 */
import { REFERENCE_FENCE_LANGUAGE } from './lib/prompt.js';
import { REFERENCE_CARD_CSS, ReferenceCard } from './card.js';

/** The host waits 2s for a trigger answer; keep a margin for the relay. */
export const TRIGGER_BUDGET_MS = 1_700;
/** Typing settles before the plugin is asked, keeping under the call rate limit. */
export const DEBOUNCE_MS = 120;
const CACHE_MAX = 64;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shown before a session that does not fit the current context. */
export const CONTEXT_FULL_PREFIX = '⚠ ';

/**
 * The trigger query's context figures, passed on to the headless entry,
 * which turns them into the reference budget; `undefined` when the host gave
 * none (no usage yet, an older host): the 32 KB mark limit is the budget then.
 */
export function triggerContext(context) {
  const usedTokens = Number(context?.usedTokens);
  const contextWindow = Number(context?.contextWindow);
  if (context?.usedTokens == null || context?.contextWindow == null) return undefined;
  return Number.isFinite(usedTokens) && Number.isFinite(contextWindow) && contextWindow > 0
    ? { usedTokens, contextWindow } : undefined;
}

/**
 * The host's Session references preferences from the trigger query
 * (`query.sessionReferences`, Settings › AI), passed on to the headless
 * entry; `undefined` from a host that predates them (the plugin's defaults,
 * 25 % and 10 turns, apply then).
 */
export function triggerReferences(references) {
  if (!references || typeof references !== 'object') return undefined;
  const { budgetPercent, maxTurns } = references;
  return Number.isFinite(budgetPercent) && Number.isFinite(maxTurns) ? { budgetPercent, maxTurns } : undefined;
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

  async function items({ query, sessionId, context: usage, sessionReferences }) {
    const started = Date.now();
    const turn = ++latest;
    if (debounceMs > 0) await sleep(debounceMs);
    // A newer keystroke owns the list; the host drops this answer anyway.
    if (turn !== latest) return [];
    const left = () => budgetMs - (Date.now() - started);
    // Snapshot keys name the budget they were built for, so the cache stays
    // valid across context changes: a new budget is a new key.
    const context = triggerContext(usage);
    const references = triggerReferences(sessionReferences);
    const extra = { ...(context ? { context } : {}), ...(references ? { references } : {}) };
    const exclude = typeof sessionId === 'string' && sessionId ? { exclude: sessionId } : {};
    const listed = await call('sessions.items', {
      query, cached: [...cache.keys()], deadlineMs: left() - 250, ...exclude, ...extra,
    });
    let pending = store(listed, cache);
    while (pending.length && turn === latest && left() > 400) {
      pending = store(await call('sessions.snapshots', { keys: pending, deadlineMs: left() - 250, ...extra }), cache);
    }
    return (listed?.rows ?? []).flatMap((row) => {
      const ready = cache.get(row.key);
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
  // A sent reference is a fenced block; the transcript draws it as a collapsed card.
  pi.slots.register({ slot: 'blockRenderer', language: REFERENCE_FENCE_LANGUAGE, component: ReferenceCard });
  pi.ui?.injectStyle?.(REFERENCE_CARD_CSS);
  // Warm the cache for the most recent sessions, so the first `@` has rows.
  void pi.dispatch('plugin.call', { method: 'sessions.items', args: { query: '', cached: [] } })
    .then((answer) => {
      for (const entry of answer?.snapshots ?? []) {
        trigger.cache.set(entry.key, { send: entry.send, detail: entry.detail, contextFull: entry.contextFull === true });
      }
    })
    .catch(() => {});
}
