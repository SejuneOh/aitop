// 지출 속도: 5분 칸 장부(쌓기·버리기·재시작)와 헤더의 ($N/h) 표시.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClaudeHome, assistant, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { UsageTracker } = await import('../src/sources/claude-ledger.mjs');
const { addSlot, lastHourOf, SLOT_MS } = await import('../src/sources/common.mjs');
const { flushCache } = await import('../src/cache.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { header } = await import('../src/ui/table.mjs');
const { width } = await import('../src/text.mjs');

const NOW = Date.parse('2026-10-30T12:03:00');
const at = (iso, row) => ({ ...row, timestamp: new Date(iso).toISOString() });
const round = (x) => Math.round(x * 1e4) / 1e4;

test('같은 5분 칸에는 더하고, 가장 새 칸에서 2시간 넘은 칸은 버린다', () => {
  const slots = {};
  addSlot(slots, Date.parse('2026-10-30T09:01:00'), 1, 0.5, false);
  addSlot(slots, Date.parse('2026-10-30T11:56:00'), 2, 1, false);
  addSlot(slots, Date.parse('2026-10-30T11:58:59'), 3, 1, true);
  assert.deepEqual(Object.keys(slots), [String(Date.parse('2026-10-30T11:55:00'))], '09:00 칸은 11:55 칸에서 2시간 넘게 지나 버린다');
  const k = String(Date.parse('2026-10-30T11:55:00'));
  assert.deepEqual(slots[k], { cost: 5, costNoCache: 2, unknown: true });
  // 늦게 도착한 아주 오래된 줄은 칸을 만들지 않는다.
  addSlot(slots, Date.parse('2026-10-30T08:00:00'), 9, 9, false);
  assert.equal(Object.keys(slots).length, 1);
  assert.equal(Number(Object.keys(slots)[0]) % SLOT_MS, 0);
});

test('최근 1시간은 시작 시각이 60분 안인 칸만 센다', () => {
  const slots = {};
  addSlot(slots, Date.parse('2026-10-30T11:00:00'), 100, 10, false); // 63분 전 칸
  addSlot(slots, Date.parse('2026-10-30T11:05:00'), 1, 0.1, false);
  addSlot(slots, Date.parse('2026-10-30T12:02:00'), 2, 0.2, false);
  const h = lastHourOf([slots, {}], NOW);
  assert.equal(round(h.cost), 3);
  assert.equal(round(h.costNoCache), 0.3);
  assert.equal(h.unknown, false);
  assert.deepEqual(lastHourOf([], NOW), { cost: 0, costNoCache: 0, unknown: false });
});

test('같은 message.id 가 칸 경계를 넘어 반복되면 차이만 새 칸에 더하고, 날짜 합계는 그대로', () => {
  const p = fx.transcript('rate-1', [
    at('2026-10-30T11:59:00', assistant('m1', [], usage(1_000_000, 0))),
    at('2026-10-30T12:01:00', assistant('m1', [], usage(1_000_000, 1_000_000))),
  ]);
  const t = new UsageTracker(p);
  t.update(createBudget());
  const slot = (iso) => round(t.slots[Date.parse(iso)]?.cost ?? 0);
  assert.equal(slot('2026-10-30T11:55:00'), 4);
  assert.equal(slot('2026-10-30T12:00:00'), 20, '출력 1M 만 더한다');
  assert.equal(round(lastHourOf([t.slots], NOW).cost), 24);
  assert.equal(round(t.days['2026-10-30'].cost), 24);
});

test('다시 시작해도 캐시에서 최근 칸이 돌아오고, 이어 읽은 줄만 더한다', () => {
  const p = fx.transcript('rate-2', [at('2026-10-30T11:40:00', assistant('r1', [], usage(1_000_000, 0)))]);
  const a = new UsageTracker(p);
  a.update(createBudget());
  flushCache();
  fx.append(p, [at('2026-10-30T12:02:00', assistant('r2', [], usage(0, 1_000_000)))]);
  const b = new UsageTracker(p);
  assert.equal(round(lastHourOf([b.slots], NOW).cost), 4, '캐시에서 읽은 칸');
  b.update(createBudget());
  assert.equal(round(lastHourOf([b.slots], NOW).cost), 24);
});

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const sess = { tool: 'claude', id: 'a', name: 'a', cwd: '/w', status: 'busy', live: true, phase: { kind: 'think' }, updatedAt: NOW, tokens: { total: 1 }, cost: 1, context: {}, members: [], events: [] };
const usageOf = (lastHour, loading = null) => ({ today: { cost: 194.2, costNoCache: 40, tokens: 5.8e8 }, week: { cost: 808, costNoCache: 118, tokens: 2.2e9 }, lastHour, loading });
const head = (u, W, costMode = 'api') => strip(header({ data: { sessions: [sess, { ...sess, id: 'b', status: 'idle' }], usage: u, errors: [], at: NOW }, costMode }, W));

test('헤더는 오늘 금액 뒤에 시간당 지출을 보이고, 0·집계 중이면 숨긴다', () => {
  const u = usageOf({ cost: 31.4, costNoCache: 4.18, unknown: false });
  assert.match(head(u, 160), /오늘 \$194 \(\$31\/h\)/);
  assert.match(head(u, 160, 'net'), /오늘 \$40\.00 \(\$4\.18\/h\)/);
  assert.match(head(usageOf({ cost: 2, costNoCache: 1, unknown: true }), 160), /\(\$2\.00\?\/h\)/);
  for (const hidden of [usageOf({ cost: 0, costNoCache: 0, unknown: false }), usageOf(undefined), usageOf({ cost: 9, costNoCache: 1, unknown: false }, 0.5)]) assert.doesNotMatch(head(hidden, 160), /\/h\)/);
});

test('폭이 모자라면 지출 속도를 가장 먼저 빼고, 40~160 칸 어디서도 넘치지 않는다', () => {
  const u = usageOf({ cost: 31.4, costNoCache: 4.18, unknown: false });
  const plain = usageOf({ cost: 0, costNoCache: 0, unknown: false });
  for (let W = 40; W <= 160; W++) {
    for (const mode of ['api', 'net']) {
      const line = head(u, W, mode);
      assert.ok(width(line) <= W, `W=${W} ${mode}: ${line}`);
      // 속도가 빠진 폭에서는 속도가 없는 헤더와 똑같다 (다른 요소를 먼저 빼지 않는다).
      if (!line.includes('/h)')) assert.equal(line, head(plain, W, mode), `W=${W} ${mode}`);
      else assert.match(line, /API 환산|캐시 제외/);
    }
  }
  assert.doesNotMatch(head(u, 80), /\/h\)/);
});

test('아는 1시간 비용이 0 인데 모르는 모델이 섞였으면 (?/h) 를 보인다', () => {
  for (const cost of [0, 0.001]) {
    const line = head(usageOf({ cost, costNoCache: cost, unknown: true }), 160);
    assert.match(line, /오늘 \$194 \(\?\/h\)/, `cost=${cost}`);
    assert.doesNotMatch(line, /\$0\.00\?/);
  }
  assert.match(head(usageOf({ cost: 2, costNoCache: 1, unknown: true }), 160), /\(\$2\.00\?\/h\)/, '아는 몫이 있으면 금액 뒤에 ?');
  assert.doesNotMatch(head(usageOf({ cost: 0, costNoCache: 0, unknown: true }, 0.5), 160), /\/h\)/, '집계 중이면 숨긴다');
});
