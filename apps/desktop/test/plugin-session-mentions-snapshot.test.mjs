import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionSnapshot, contextBytesFromTokens, CONTEXT_RESERVE_TOKENS, MARK_SEND_MAX_BYTES, DEFAULT_MAX_TURNS,
} from './helpers/session-mentions.mjs';
import { A, source, user, assistant } from './helpers/session-mentions.mjs';

const bytes = (text) => Buffer.byteLength(text, 'utf8');
const pairs = (n, size = 10) => Array.from({ length: n }, (_, i) => [`Q${i}`, `A${i} ${'x'.repeat(size)}`]);

test('the newest 10 complete turns are kept, in chronological order', () => {
  const snapshot = buildSessionSnapshot(source(A, pairs(14)));
  assert.equal(DEFAULT_MAX_TURNS, 10);
  assert.equal(snapshot.includedTurns, 10);
  assert.equal(snapshot.omittedKnown, 4);
  assert.equal(snapshot.clipped, false);
  const questions = [...snapshot.send.matchAll(/^Q: (Q\d+)$/gm)].map((match) => match[1]);
  assert.deepEqual(questions, ['Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10', 'Q11', 'Q12', 'Q13']);
  assert.match(snapshot.send, /^\n<referenced-chat id="aaaaaaaa-[^"]+" title="Alpha" turns="10" omitted="4"/);
  assert.match(snapshot.send, /<\/referenced-chat>\n$/);
});

test('whole turns are budget-selected newest-first within the mark limit', () => {
  const snapshot = buildSessionSnapshot(source(A, pairs(10, 6000)));
  assert.ok(bytes(snapshot.send) <= MARK_SEND_MAX_BYTES);
  assert.equal(snapshot.includedTurns, 5);
  assert.equal(snapshot.omittedKnown, 5);
  assert.match(snapshot.send, /Q: Q9\n/);
  assert.doesNotMatch(snapshot.send, /Q: Q4\n/);
  assert.equal(snapshot.clipped, false);
});

test('every parent answer of a turn is kept together', () => {
  const snapshot = buildSessionSnapshot({ id: A, title: 'Alpha', messages: [
    user('Q'), assistant('first'), { role: 'tool', content: 'SECRET_TOOL' }, assistant('second'),
  ] });
  assert.match(snapshot.send, /A: first\n\nsecond\n/);
  assert.doesNotMatch(snapshot.send, /SECRET/);
});

test('a newest turn larger than the limit is clipped, and says so', () => {
  const snapshot = buildSessionSnapshot(source(A, [['small', 'old'], ['Q'.repeat(5000), '中'.repeat(20000)]]));
  assert.ok(bytes(snapshot.send) <= MARK_SEND_MAX_BYTES, `${bytes(snapshot.send)} bytes`);
  assert.ok(bytes(snapshot.send) > MARK_SEND_MAX_BYTES - 200, 'the room is used');
  assert.equal(snapshot.includedTurns, 1);
  assert.equal(snapshot.omittedKnown, 1);
  assert.equal(snapshot.clipped, true);
  assert.match(snapshot.send, /clipped to fit the reference size limit/);
  assert.match(snapshot.send, /some text was clipped to fit/);
});

test('text the host shortened is marked in the block', () => {
  const snapshot = buildSessionSnapshot({ id: A, title: 'Alpha', messages: [user('Q'), assistant('part', { contentTruncated: true })] });
  assert.equal(snapshot.clipped, true);
  assert.match(snapshot.send, /A: part\n\[… the host shortened this text\]/);
});

test('a session without a complete turn still makes a block that says so', () => {
  const snapshot = buildSessionSnapshot({ id: A, title: 'Alpha', messages: [user('Unanswered')], hasMoreBefore: true });
  assert.equal(snapshot.includedTurns, 0);
  assert.equal(snapshot.olderUnread, true);
  assert.match(snapshot.send, /\(No completed question-and-answer turns\.\)/);
  assert.match(snapshot.send, /older-unread="true"/);
});

test('custom limits are validated', () => {
  assert.throws(() => buildSessionSnapshot(source(A, pairs(1)), { maxBytes: 10 }), /maxBytes/);
  assert.throws(() => buildSessionSnapshot(source(A, pairs(1)), { maxTurns: 0 }), /maxTurns/);
  const small = buildSessionSnapshot(source(A, pairs(3, 2000)), { maxBytes: 4096 });
  assert.ok(bytes(small.send) <= 4096);
});

test('remaining context tokens become a byte budget after the reserve', () => {
  assert.equal(contextBytesFromTokens(undefined), undefined);
  assert.equal(contextBytesFromTokens(NaN), undefined);
  assert.equal(contextBytesFromTokens(CONTEXT_RESERVE_TOKENS - 1), 0);
  assert.equal(contextBytesFromTokens(CONTEXT_RESERVE_TOKENS + 1000), 3000);
});

test('a tighter context budget keeps fewer whole turns, without clipping', () => {
  const full = buildSessionSnapshot(source(A, pairs(10, 1000)));
  const tight = buildSessionSnapshot(source(A, pairs(10, 1000)), { contextBytes: 4000 });
  assert.equal(full.status, 'ready');
  assert.equal(tight.status, 'ready');
  assert.ok(bytes(tight.send) <= 4000);
  assert.ok(tight.includedTurns >= 1 && tight.includedTurns < full.includedTurns);
  assert.equal(tight.clipped, false);
  assert.match(tight.send, /Q: Q9\n/);
});

test('when not even the newest turn fits the context, nothing is clipped or sent', () => {
  const snapshot = buildSessionSnapshot(source(A, [['Q', 'small'], ['Q2', 'w'.repeat(5000)]]), { contextBytes: 3000 });
  assert.equal(snapshot.status, 'context-full');
  assert.equal(snapshot.contextBytes, 3000);
  assert.ok(snapshot.neededBytes > 5000);
  assert.equal(snapshot.send, undefined);
  const none = buildSessionSnapshot(source(A, pairs(1)), { contextBytes: 0 });
  assert.equal(none.status, 'context-full');
});

test('a context budget above the mark limit changes nothing', () => {
  const plain = buildSessionSnapshot(source(A, pairs(10, 6000)));
  const roomy = buildSessionSnapshot(source(A, pairs(10, 6000)), { contextBytes: 10 * MARK_SEND_MAX_BYTES });
  assert.deepEqual(roomy, plain);
  assert.throws(() => buildSessionSnapshot(source(A, pairs(1)), { contextBytes: -1 }), /contextBytes/);
});
