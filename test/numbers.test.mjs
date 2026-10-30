import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { collectClaude } = await import('../src/sources/claude.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { money } = await import('../src/ui.mjs');
const { CACHE_DIR } = await import('../src/cache.mjs');
const { PRICE_TAG } = await import('../src/pricing.mjs');

const run = () => collectClaude({ showEnded: false, budget: createBudget() });

test('토큰 합계는 메인 + 서브이고, 입력·출력·캐시 합과도 같다', () => {
  fx.session({ sessionId: 'cccccccc-1' });
  fx.transcript('cccccccc-1', [user('시작'), assistant('m1', [{ type: 'text', text: '응답' }], usage(100, 50, 1000, 10))]);
  fx.subagent('cccccccc-1', 'a', { agentType: 'Explore', description: '조사', finished: true }, [assistant('s1', [], usage(1, 2, 30, 4))]);
  fx.subagent('cccccccc-1', 'b', { agentType: 'Plan', description: '설계', finished: true }, [assistant('s2', [], usage(5, 6, 70, 8))]);

  const [s] = run();
  const t = s.tokens;
  assert.equal(t.main, 1160);
  assert.equal(t.sub, 126);
  assert.equal(t.subCount, 2);
  assert.equal(t.total, t.main + t.sub);
  assert.equal(t.total, t.input + t.output + t.cacheRead + t.cacheWrite);
  assert.ok(s.costNoCache > 0 && s.costNoCache < s.cost);
  assert.equal(s.costUnknown, false);
});

test('가격표에 없는 모델이 섞이면 비용에 넣지 않고 ? 로 알린다', () => {
  fx.session({ sessionId: 'dddddddd-2', pid: process.pid });
  fx.transcript('dddddddd-2', [assistant('m1', [], usage(1_000_000, 0), 'claude-unknown-9')]);
  const [s] = run();
  assert.equal(s.costUnknown, true);
  assert.equal(s.cost, 0);
  assert.equal(money(s.cost, s.costUnknown), '?');
  assert.equal(money(1.5, true), '$1.50?');
  assert.equal(money(null), '-');
});

test('토큰 사용이 없는 합성 메시지는 모르는 모델로 치지 않는다', () => {
  fx.session({ sessionId: 'eeeeeeee-3', pid: process.pid });
  fx.transcript('eeeeeeee-3', [assistant('m1', [], usage(0, 0), '<synthetic>')]);
  const [s] = run();
  assert.equal(s.costUnknown, false);
});

test('캐시 폴더 이름에 가격표 지문이 들어가서, 가격표가 바뀌면 새로 계산된다', () => {
  assert.match(PRICE_TAG, /^[0-9a-f]{8}$/);
  assert.ok(CACHE_DIR.endsWith(PRICE_TAG));
});
