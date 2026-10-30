import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClaudeHome, assistant, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { collectClaude } = await import('../src/sources/claude.mjs');
const { createBudget } = await import('../src/tail.mjs');

const run = (opts) => collectClaude({ showEnded: true, budget: createBudget(), ...opts });

fx.transcript('iiiiiiii-1', [{ ...assistant('m1', [], usage(10, 20)), cwd: '/work/alpha' }], '-work-alpha');
fx.transcript('iiiiiiii-2', [{ ...assistant('m1', [], usage(1, 1)), cwd: '/work/beta' }], '-work-beta');
fx.subagent('iiiiiiii-1', 'z', { agentType: 'Explore', description: '조사', finished: true }, [assistant('s1', [], usage(100, 100))], '-work-alpha');

test('한도 없이 읽을 때(--once)는 선택하지 않은 종료 세션도 모두 읽는다', () => {
  const list = run({ budget: createBudget(Infinity) });
  assert.ok(list.every((s) => s.lazy === false));
  assert.equal(list.find((s) => s.id === 'iiiiiiii-2').tokens.total, 2);
});

test('한 번 읽은 종료 세션은 선택을 옮겨도 서브에이전트 포함 합계가 그대로다', () => {
  const selected = run({ selectedId: 'iiiiiiii-1', budget: createBudget(1e9) }).find((s) => s.id === 'iiiiiiii-1');
  const moved = run({ selectedId: 'iiiiiiii-2', budget: createBudget(1e9) }).find((s) => s.id === 'iiiiiiii-1');
  assert.equal(selected.tokens.total, 230);
  assert.equal(moved.tokens.total, 230);
  assert.equal(moved.cost, selected.cost);
});
