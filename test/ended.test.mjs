import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimesSync } from 'node:fs';
import { makeClaudeHome, assistant, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { collectClaude } = await import('../src/sources/claude.mjs');
const { createBudget } = await import('../src/tail.mjs');

// 실시간 화면처럼 한도가 있는 읽기. 한도가 없으면(--once) 모든 종료 세션을 읽는다.
const run = (opts) => collectClaude({ budget: createBudget(1e9), ...opts });

// sessions/<pid>.json 없이 기록만 남은 세션들
fx.transcript('ffffffff-1', [{ type: 'ai-title', aiTitle: '어제 끝난 작업', sessionId: 'ffffffff-1' }, { ...assistant('m1', [], usage(10, 20)), cwd: '/work/alpha', gitBranch: 'main' }], '-work-alpha');
fx.transcript('ffffffff-2', [{ ...assistant('m1', [], usage(1, 1)), cwd: '/work/beta' }], '-work-beta');
const old = fx.transcript('ffffffff-3', [assistant('m1', [], usage(1, 1))], '-work-old');
const twoDaysAgo = (Date.now() - 48 * 3600_000) / 1000;
utimesSync(old, twoDaysAgo, twoDaysAgo);

test('--all 이 아니면 종료 세션을 찾지 않는다', () => {
  assert.deepEqual(run({ showEnded: false }), []);
});

test('--all 이면 24시간 안에 바뀐 기록을 종료 세션으로 보여 준다', () => {
  const list = run({ showEnded: true });
  assert.deepEqual(list.map((s) => s.id).sort(), ['ffffffff-1', 'ffffffff-2']);
  const a = list.find((s) => s.id === 'ffffffff-1');
  assert.equal(a.name, '어제 끝난 작업');
  assert.equal(a.project, 'alpha');
  assert.equal(a.branch, 'main');
  assert.equal(a.status, 'ended');
  assert.equal(a.lazy, true);
  assert.equal(a.cost, null);
});

test('선택한 종료 세션만 본문을 읽어 토큰을 채운다', () => {
  const list = run({ showEnded: true, selectedId: 'ffffffff-1' });
  const a = list.find((s) => s.id === 'ffffffff-1');
  const b = list.find((s) => s.id === 'ffffffff-2');
  assert.equal(a.lazy, false);
  assert.equal(a.tokens.total, 30);
  assert.ok(a.cost > 0);
  assert.equal(b.lazy, true);
});
