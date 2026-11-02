import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowTitle, newlyWaiting } from '../src/attention.mjs';

const s = (id, status, extra = {}) => ({ id, status, live: true, ...extra });

test('창 제목은 응답 대기와 확인 전 수를 보인다', () => {
  assert.equal(windowTitle([]), 'aitop');
  assert.equal(windowTitle([s('a', 'idle')]), 'aitop');
  assert.equal(windowTitle([s('a', 'waiting'), s('b', 'waiting')]), '(2◆) aitop');
  assert.equal(windowTitle([s('a', 'waiting'), s('b', 'idle', { unseen: true })]), '(1◆ 1●) aitop');
  assert.equal(windowTitle([s('a', 'waiting', { live: false })]), 'aitop');
});

test('벨은 새로 응답 대기가 된 세션이 있을 때만 울린다', () => {
  const seen = new Set();
  assert.equal(newlyWaiting(seen, [s('a', 'busy')]), false);
  assert.equal(newlyWaiting(seen, [s('a', 'waiting')]), true);
  assert.equal(newlyWaiting(seen, [s('a', 'waiting')]), false, '계속 대기 중이면 다시 울리지 않는다');
  assert.equal(newlyWaiting(seen, [s('a', 'waiting'), s('b', 'waiting')]), true);
  assert.equal(newlyWaiting(seen, [s('a', 'busy'), s('b', 'waiting')]), false);
  assert.equal(newlyWaiting(seen, [s('a', 'waiting'), s('b', 'waiting')]), true, '다시 대기가 되면 울린다');
});
