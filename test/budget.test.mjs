import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { JsonlTail, createBudget } = await import('../src/tail.mjs');
const { collect } = await import('../src/collect.mjs');

const big = join(fx.home, 'big.jsonl');
writeFileSync(big, Array.from({ length: 40_000 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(200) })).join('\n') + '\n');

test('시간 한도에 닿으면 멈추고 exhausted 를 남긴다', () => {
  const t = new JsonlTail(big);
  const b = createBudget(Infinity, 0);
  assert.equal(t.read(() => {}, b), 0);
  assert.equal(b.exhausted, true);
  assert.equal(t.offset, 0);
});

test('바이트 한도에 닿아도 exhausted, 다 읽으면 그대로 false', () => {
  const t = new JsonlTail(big);
  const b = createBudget(1 << 20);
  t.read(() => {}, b);
  assert.equal(b.exhausted, true);
  assert.ok(!t.done);
  const all = createBudget();
  let n = 0;
  t.read(() => n++, all);
  assert.ok(t.done);
  assert.equal(all.exhausted, false);
  assert.ok(n > 0);
});

test('collect 는 덜 읽은 기록이 있으면 more, 다 읽으면 more 가 false', () => {
  fx.session({ sessionId: 'mmmm0000-1', name: 'more' });
  fx.transcript('mmmm0000-1', [user('시작'), ...Array.from({ length: 3000 }, (_, i) => assistant(`m${i}`, [{ type: 'text', text: 'y'.repeat(500) }], usage(10, 1)))]);
  const first = collect({ budgetBytes: 64 * 1024 });
  assert.equal(first.more, true);
  let d = first;
  for (let i = 0; i < 200 && d.more; i++) d = collect({ budgetBytes: 64 * 1024 });
  assert.equal(d.more, false);
  assert.equal(collect().more, false);
});
