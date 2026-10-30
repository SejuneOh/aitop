import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAttention, updateAttention, markSeen, nextAttention } from '../src/attention.mjs';

const s = (id, status, live = true) => ({ id, status, live });

test('작업 중에서 대기로 바뀐 세션만 확인 전이 된다', () => {
  const st = createAttention();
  updateAttention(st, [s('a', 'busy'), s('b', 'idle'), s('c', 'waiting')], 'x');
  updateAttention(st, [s('a', 'idle'), s('b', 'idle'), s('c', 'idle')], 'x');
  assert.deepEqual([...st.unseen], ['a']);
});

test('선택돼 있던 세션은 끝나도 확인 전이 되지 않고, 선택하면 표시가 사라진다', () => {
  const st = createAttention();
  updateAttention(st, [s('a', 'busy'), s('b', 'shell')], 'a');
  updateAttention(st, [s('a', 'idle'), s('b', 'idle')], 'a');
  assert.deepEqual([...st.unseen], ['b']);
  markSeen(st, 'b');
  assert.equal(st.unseen.size, 0);
});

test('다시 작업을 시작하거나 목록에서 빠지면 확인 전 표시가 사라진다', () => {
  const st = createAttention();
  updateAttention(st, [s('a', 'busy'), s('b', 'busy')], 'x');
  updateAttention(st, [s('a', 'idle'), s('b', 'idle')], 'x');
  updateAttention(st, [s('a', 'busy')], 'x');
  assert.equal(st.unseen.size, 0);
});

test('n 은 응답 대기 세션을 먼저, 그다음 확인 전 세션으로 이동한다', () => {
  const st = createAttention();
  const list = [s('a', 'idle'), s('b', 'idle'), s('c', 'waiting'), s('d', 'idle')];
  st.unseen.add('d');
  assert.equal(nextAttention(st, list, 'a').id, 'c');
  const noWaiting = list.map((x) => (x.id === 'c' ? s('c', 'idle') : x));
  assert.equal(nextAttention(st, noWaiting, 'a').id, 'd');
  assert.equal(nextAttention(createAttention(), noWaiting, 'a'), null);
});
