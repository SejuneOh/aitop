import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClaudeHome, assistant, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { collectLedger, dayKey, _test } = await import('../src/sources/claude-ledger.mjs');
const { createBudget } = await import('../src/tail.mjs');

const NOW = Date.parse('2026-10-30T12:00:00');
const at = (iso, row) => ({ ...row, timestamp: new Date(iso).toISOString() });

test('최근 7일 날짜 키는 오늘부터 거꾸로 7개', () => {
  const keys = _test.lastDays(7, NOW);
  assert.equal(keys.length, 7);
  assert.equal(keys[0], dayKey(NOW));
  assert.equal(keys[6], '2026-10-24');
});

test('같은 메시지가 여러 줄이어도 한 번만, 날짜별로 나눠 더한다', () => {
  // 어제 밤에 시작해 자정을 넘긴 세션 + 서브에이전트
  fx.transcript('llllllll-1', [
    at('2026-10-29T23:59:00', assistant('m1', [{ type: 'text', text: 'a' }], usage(1_000_000, 0))),
    at('2026-10-29T23:59:01', assistant('m1', [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }], usage(1_000_000, 0))),
    at('2026-10-30T00:01:00', assistant('m2', [], usage(0, 1_000_000))),
  ]);
  fx.subagent('llllllll-1', 'a', { agentType: 'Explore' }, [at('2026-10-30T09:00:00', assistant('s1', [], usage(500_000, 0)))]);

  const r = collectLedger({ budget: createBudget(), now: NOW });
  // 오늘: 출력 1M ($20) + 서브 입력 0.5M ($2)
  assert.equal(r.today.tokens, 1_500_000);
  assert.equal(r.today.cost, 22);
  // 7일: 어제 입력 1M ($4, 한 번만) 포함
  assert.equal(r.week.tokens, 2_500_000);
  assert.equal(r.week.cost, 26);
  assert.equal(r.loading, null);
});

test('일주일 넘은 날짜는 7일 합계에 들어가지 않는다', () => {
  fx.transcript('llllllll-2', [at('2026-10-20T10:00:00', assistant('m9', [], usage(1_000_000, 0)))]);
  const r = collectLedger({ budget: createBudget(), now: NOW });
  assert.equal(r.week.tokens, 2_500_000);
});

test('days7: 오래된 날부터 오늘까지 날짜별 비용 7개, 합은 7일 합계', () => {
  const r = collectLedger({ budget: createBudget(), now: NOW });
  assert.deepEqual(r.days7.map((d) => d.date), ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']);
  assert.equal(r.days7.at(-1).cost, r.today.cost);
  assert.equal(r.days7.at(-2).cost, 4);
  assert.equal(r.days7.reduce((a, d) => a + d.cost, 0), r.week.cost);
});
