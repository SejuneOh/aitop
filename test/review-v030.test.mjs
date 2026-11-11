import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { makeClaudeHome, assistant, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { createAttention, updateAttention, nextAttention } = await import('../src/attention.mjs');
const { collectLedger } = await import('../src/sources/claude-ledger.mjs');
const { ClaudeTracker } = await import('../src/sources/claude-tracker.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { render } = await import('../src/ui.mjs');

const s = (id, status, extra = {}) => ({ id, status, live: true, ...extra });

test('응답 대기 세션을 선택한 채 n 을 누르면 확인 전 세션으로 간다', () => {
  const st = createAttention();
  st.unseen.add('b');
  const list = [s('a', 'waiting'), s('b', 'idle'), s('c', 'idle')];
  assert.equal(nextAttention(st, list, 'a').id, 'b');
});

test('선택이 목록에 없으면 맨 위 응답 대기부터 간다', () => {
  const list = [s('w1', 'waiting'), s('w2', 'waiting')];
  assert.equal(nextAttention(createAttention(), list, 'gone').id, 'w1');
});

test('상태를 추측한 세션은 작업 중 → 대기로 바뀌어도 확인 전이 되지 않는다', () => {
  const st = createAttention();
  updateAttention(st, [s('g', 'busy', { statusGuessed: true })], 'x');
  updateAttention(st, [s('g', 'idle', { statusGuessed: true })], 'x');
  assert.equal(st.unseen.size, 0);
});

test('기록 파일이 줄어 처음부터 다시 읽으면 두 번 더하지 않는다', () => {
  const now = Date.now();
  const p = fx.transcript('pppppppp-1', [{ ...assistant('m1', [], usage(100, 0)), timestamp: new Date(now).toISOString() }, { ...assistant('m2', [], usage(100, 0)), timestamp: new Date(now).toISOString() }]);
  assert.equal(collectLedger({ budget: createBudget(), now }).today.tokens, 200);
  const t = new ClaudeTracker(p);
  t.update();
  assert.equal(t.tokens.total, 200);

  writeFileSync(p, JSON.stringify({ ...assistant('m3', [], usage(50, 0)), timestamp: new Date(now).toISOString() }) + '\n');
  assert.equal(collectLedger({ budget: createBudget(), now }).today.tokens, 50);
  t.update();
  assert.equal(t.tokens.total, 50);
});

test('장부가 없으면 헤더에 세션 누적 토큰을 보인다', () => {
  const view = { data: { sessions: [{ tool: 'codex', id: 'x', name: 'c', status: 'idle', live: true, phase: { kind: 'idle' }, updatedAt: Date.now(), tokens: { total: 1_200_000 }, context: {}, events: [], members: [] }], usage: null, errors: [], at: Date.now() }, selectedId: 'x', showDetail: false, frame: 0 };
  const head = render(view, 140, 8)[0].replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(head, /Σ 1\.2M tok/);
});
