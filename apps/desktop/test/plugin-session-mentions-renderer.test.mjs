import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindingContextTokens, createSessionTrigger, onLoad, CONTEXT_FULL_PREFIX, CONTEXT_RESERVE_TOKENS, MARK_SEND_MAX_BYTES,
} from '../resources/plugins/pi.session-mentions/renderer.js';
import * as snapshot from '../resources/plugins/pi.session-mentions/lib/snapshot.js';

const KEY = (n) => `k${n}`;

function fakeDispatch(script) {
  const calls = [];
  const dispatch = async (action, payload) => {
    assert.equal(action, 'plugin.call');
    calls.push(payload);
    return script(payload, calls.length);
  };
  return { dispatch, calls };
}

test('only rows with a ready snapshot are offered, in list order', async () => {
  const { dispatch, calls } = fakeDispatch(({ method }) => method === 'sessions.items'
    ? { rows: [{ key: KEY(1), label: 'One' }, { key: KEY(2), label: 'Two' }, { key: KEY(3), label: 'Three' }],
        snapshots: [{ key: KEY(2), send: 'S2', detail: 'd2' }], pending: [KEY(1)] }
    : { snapshots: [{ key: KEY(1), send: 'S1', detail: 'd1' }], pending: [] });
  const trigger = createSessionTrigger(dispatch, { debounceMs: 0 });
  assert.deepEqual(await trigger.items({ trigger: '@', query: 'o' }), [
    { label: 'One', send: 'S1', detail: 'd1' }, { label: 'Two', send: 'S2', detail: 'd2' },
  ]);
  assert.deepEqual(calls.map((call) => call.method), ['sessions.items', 'sessions.snapshots']);
  assert.equal(calls[0].args.query, 'o');
  assert.deepEqual(calls[1].args.keys, [KEY(1)]);
  assert.ok(calls[0].args.deadlineMs <= 1450);

  await trigger.items({ trigger: '@', query: '' });
  assert.deepEqual(calls[2].args.cached, [KEY(2), KEY(1)], 'held snapshots are not asked for again');
});

test('a superseded keystroke answers empty without calling the plugin', async () => {
  const { dispatch, calls } = fakeDispatch(() => ({ rows: [], snapshots: [], pending: [] }));
  const trigger = createSessionTrigger(dispatch, { debounceMs: 20 });
  const [first, second] = await Promise.all([trigger.items({ query: 'a' }), trigger.items({ query: 'ab' })]);
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  assert.deepEqual(calls.map((call) => call.args.query), ['ab']);
});

test('pending snapshots stop being chased when the budget runs out', async () => {
  const { dispatch, calls } = fakeDispatch(({ method }) => new Promise((resolve) => setTimeout(() => resolve(
    method === 'sessions.items'
      ? { rows: [{ key: KEY(1), label: 'One' }], snapshots: [], pending: [KEY(1)] }
      : { snapshots: [], pending: [KEY(1)] }), 60)));
  const trigger = createSessionTrigger(dispatch, { debounceMs: 0, budgetMs: 600 });
  const started = Date.now();
  assert.deepEqual(await trigger.items({ query: '' }), []);
  assert.ok(Date.now() - started < 700);
  assert.ok(calls.length >= 2);
});

test('onLoad claims @ and warms the cache', async () => {
  const registrations = [];
  const { dispatch, calls } = fakeDispatch(() => ({ rows: [], snapshots: [{ key: KEY(9), send: 'S9', detail: 'd' }], pending: [] }));
  onLoad({ dispatch, slots: { register: (registration) => registrations.push(registration) } });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].slot, 'composerTrigger');
  assert.equal(registrations[0].trigger, '@');
  assert.equal(typeof registrations[0].items, 'function');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[0], { method: 'sessions.items', args: { query: '', cached: [] } });
});

test('a binding remaining context is passed on, and a session that does not fit is flagged', async () => {
  const { dispatch, calls } = fakeDispatch(() => ({
    rows: [{ key: KEY(1), label: 'Big' }, { key: KEY(2), label: 'Small' }],
    snapshots: [
      { key: KEY(1), send: 'note', detail: '上下文快满了，先 /compact 压缩再引用', contextFull: true },
      { key: KEY(2), send: 'S2', detail: 'd2' },
    ],
    pending: [],
  }));
  const trigger = createSessionTrigger(dispatch, { debounceMs: 0 });
  const context = { usedTokens: 191_000, contextWindow: 200_000 };
  assert.deepEqual(await trigger.items({ query: '', context }), [
    { label: `${CONTEXT_FULL_PREFIX}Big`, send: 'note', detail: '上下文快满了，先 /compact 压缩再引用' },
    { label: 'Small', send: 'S2', detail: 'd2' },
  ]);
  assert.equal(calls[0].args.contextRemainingTokens, 9000);
  assert.deepEqual(calls[0].args.cached, []);
  assert.equal(trigger.cache.size, 0, 'budgeted snapshots are not kept');
});

test('the row detail leads with the list\'s fresh update time', async () => {
  const { dispatch } = fakeDispatch(() => ({
    rows: [{ key: KEY(1), label: 'new task · 10-09 21:17', when: '5 min ago' }, { key: KEY(2), label: 'Other' }],
    snapshots: [{ key: KEY(1), send: 'S1', detail: '“Fix it” · 1 Q&A turn' }, { key: KEY(2), send: 'S2', detail: 'd2' }],
    pending: [],
  }));
  const trigger = createSessionTrigger(dispatch, { debounceMs: 0 });
  assert.deepEqual(await trigger.items({ query: '' }), [
    { label: 'new task · 10-09 21:17', send: 'S1', detail: '5 min ago · “Fix it” · 1 Q&A turn' },
    { label: 'Other', send: 'S2', detail: 'd2' },
  ]);
});

test('the host\'s session is left out, and roomy context keeps the cache', async () => {
  const { dispatch, calls } = fakeDispatch(() => ({
    rows: [{ key: KEY(1), label: 'One' }], snapshots: [{ key: KEY(1), send: 'S1', detail: 'd1' }], pending: [],
  }));
  const trigger = createSessionTrigger(dispatch, { debounceMs: 0 });
  const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await trigger.items({ query: '', sessionId, context: { usedTokens: 20_000, contextWindow: 200_000 } });
  assert.equal(calls[0].args.exclude, sessionId);
  assert.equal(calls[0].args.contextRemainingTokens, undefined, 'room for a full mark: no context budget');
  assert.equal(trigger.cache.size, 1);
  await trigger.items({ query: '' });
  assert.equal(calls[1].args.exclude, undefined, 'an older host tells no session');
});

test('the context only binds below a full mark plus the reply reserve', () => {
  assert.equal(MARK_SEND_MAX_BYTES, snapshot.MARK_SEND_MAX_BYTES);
  assert.equal(CONTEXT_RESERVE_TOKENS, snapshot.CONTEXT_RESERVE_TOKENS);
  const roomy = CONTEXT_RESERVE_TOKENS + Math.ceil(MARK_SEND_MAX_BYTES / 3);
  assert.equal(bindingContextTokens({ usedTokens: 100_000 - roomy, contextWindow: 100_000 }), undefined);
  assert.equal(bindingContextTokens({ usedTokens: 100_000 - roomy + 1, contextWindow: 100_000 }), roomy - 1);
  assert.equal(bindingContextTokens({ usedTokens: 120_000, contextWindow: 100_000 }), 0);
  assert.equal(bindingContextTokens(undefined), undefined);
  assert.equal(bindingContextTokens({ usedTokens: 5, contextWindow: 0 }), undefined);
});
