import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { collectClaude } = await import('../src/sources/claude.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { contextWindow } = await import('../src/pricing.mjs');
const { render } = await import('../src/ui.mjs');

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');

test('모델별 컨텍스트 창 크기를 쓰고, 모르는 모델만 사용량으로 추측한다', () => {
  assert.equal(contextWindow('claude-opus-5-5', 77_000), 1_000_000);
  assert.equal(contextWindow('claude-opus-5', 10), 1_000_000);
  assert.equal(contextWindow('claude-haiku-4-5', 10), 200_000);
  assert.equal(contextWindow('claude-unknown-9', 77_000), 200_000);
  assert.equal(contextWindow('claude-unknown-9', 300_000), 1_000_000);
  assert.equal(contextWindow(null, 0), 200_000);
});

test('Opus 5.5 세션의 컨텍스트 게이지는 1M 기준이다', () => {
  fx.session({ sessionId: 'jjjjjjjj-1' });
  fx.transcript('jjjjjjjj-1', [user('시작'), assistant('m1', [], usage(1000, 10, 76_000))]);
  const [s] = collectClaude({ showEnded: false, budget: createBudget() });
  assert.equal(s.context.used, 77_000);
  assert.equal(s.context.window, 1_000_000);
});

test('최근 활동은 기록 순서가 어긋나도 시각 순으로 보인다', () => {
  const s = {
    tool: 'claude', id: 'x', name: 'main', project: 'p', status: 'idle', live: true,
    phase: { kind: 'idle', text: '다음 지시 대기' }, updatedAt: Date.now(), tokens: { total: 0 }, cost: 0,
    context: { used: 0, window: 0 }, members: [],
    events: [
      { at: Date.parse('2026-10-30T03:27:46Z'), kind: 'tool', text: '두번째' },
      { at: Date.parse('2026-10-30T03:27:45Z'), kind: 'tool', text: '첫번째' },
      { at: Date.parse('2026-10-30T03:27:47Z'), kind: 'reply', text: '세번째' },
    ],
  };
  const lines = render({ data: { sessions: [s], errors: [], at: Date.now() }, selectedId: 'x', showDetail: true, frame: 0 }, 140, 24).map(strip);
  const order = ['첫번째', '두번째', '세번째'].map((t) => lines.findIndex((l) => l.includes(t)));
  assert.ok(order.every((i) => i >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('화면 어디에도 세션 열기 안내가 없다', () => {
  fx.session({ sessionId: 'kkkkkkkk-2', kind: 'bg' });
  fx.transcript('kkkkkkkk-2', [user('시작'), assistant('m1', [], usage(1, 1))]);
  const sessions = collectClaude({ showEnded: false, budget: createBudget() });
  const lines = render({ data: { sessions, errors: [], at: Date.now() }, selectedId: sessions[0].id, showDetail: true, frame: 0 }, 140, 30).map(strip);
  assert.ok(!lines.some((l) => l.includes('세션 열기') || l.includes('⏎')));
  assert.ok(sessions.every((x) => !('attachId' in x)));
});
