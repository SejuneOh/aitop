// 가격표 갱신 (#331): gemini-4-carbon 12-01 인상, gemini-4-neon, Haiku 5.5 긴 프롬프트(10만 토큰 초과) 단가.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'aitop-331-'));
const { claudeCost, claudeLong, claudeVec, vecCost, geminiPrice, geminiCost, PRICE_TAG } = await import('../src/pricing.mjs');
const { UsageTracker } = await import('../src/sources/claude-ledger.mjs');
const { dayKey } = await import('../src/sources/common.mjs');

const M = 1_000_000;
const at = (iso) => Date.parse(iso);
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const HAIKU = 'claude-haiku-5-5';
const cost = (u) => r6(claudeCost(HAIKU, u).total);

test('gemini-4-carbon: 11-30 까지 $2/$10(캐시 $0.10), 12-01 UTC 0시부터 $4/$20(캐시 $0.20)', () => {
  assert.deepEqual(geminiPrice('gemini-4-carbon', at('2026-11-30T23:59:59.999Z')), { input: 2, output: 10, cacheRead: 0.1 });
  assert.deepEqual(geminiPrice('gemini-4-carbon', at('2026-12-01T00:00:00Z')), { from: '2026-12-01', input: 4, output: 20, cacheRead: 0.2 });
  const t = { input: M, cacheRead: M, output: M };
  assert.equal(r6(geminiCost('gemini-4-carbon', t, at('2026-11-30T12:00:00Z')).total), 2 + 0.1 + 10);
  assert.equal(r6(geminiCost('gemini-4-carbon', t, at('2026-12-01T00:00:00Z')).total), 4 + 0.2 + 20);
});

test('gemini-4-neon: $3/$15(캐시 $0.15), 날짜와 무관', () => {
  for (const iso of ['2026-11-27T00:00:00Z', '2027-06-01T00:00:00Z']) assert.deepEqual(geminiPrice('gemini-4-neon', at(iso)), { input: 3, output: 15, cacheRead: 0.15 });
  // agy 의 보관 벡터도 같은 가격으로 다시 계산한다.
  assert.equal(r6(vecCost('agy', 'gemini-4-neon', [M, M, M, 0, 0], null, at('2026-11-15T12:00:00Z'))), 3 + 15 + 0.15);
});

test('새 Gemini 모델도 정확 일치로만 찾는다 (앞부분만 같은 이름은 null)', () => {
  for (const m of ['gemini-4-carbon-high', 'gemini-4-neon-preview', 'gemini-4-carb', 'gemini-4']) assert.equal(geminiPrice(m), null, m);
});

test('Haiku 5.5 프롬프트 10만 토큰 이하: $0.10/$0.50, 캐시 읽기 $0.01, 쓰기 5분 $0.125·1시간 $0.20', () => {
  assert.equal(cost({ input_tokens: 100_000 }), r6(0.1 * 0.1));
  assert.equal(cost({ output_tokens: M }), 0.5);
  // 단가 확인용: 프롬프트가 10만을 넘지 않게 나눠서 본다.
  assert.equal(cost({ cache_read_input_tokens: 100_000 }), r6(0.01 * 0.1));
  assert.equal(cost({ cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 0 } }), r6(0.125 * 0.1));
  assert.equal(cost({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100_000 } }), r6(0.2 * 0.1));
});

test('Haiku 5.5 프롬프트 10만 토큰 초과: 그 요청 전체가 $0.50/$2.50, 캐시 읽기 $0.05, 쓰기 $0.625·$1', () => {
  assert.equal(cost({ input_tokens: M, output_tokens: M }), 0.5 + 2.5);
  assert.equal(cost({ cache_read_input_tokens: M }), 0.05);
  assert.equal(cost({ cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: 0 } }), 0.625);
  assert.equal(cost({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: M } }), 1);
  // 출력은 프롬프트 길이에 들지 않는다.
  assert.equal(claudeLong(HAIKU, { input_tokens: 10, output_tokens: M }), false);
});

test('Haiku 5.5 경계: 프롬프트가 정확히 100000 이면 기본 단가, 100001 이면 긴 단가 (캐시 읽기·쓰기 포함)', () => {
  const exact = { input_tokens: 40_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 10_000, output_tokens: 1000 };
  assert.equal(claudeLong(HAIKU, exact), false);
  assert.equal(cost(exact), r6((40_000 * 0.1 + 50_000 * 0.01 + 10_000 * 0.125 + 1000 * 0.5) / M));
  const over = { ...exact, input_tokens: 40_001 };
  assert.equal(claudeLong(HAIKU, over), true);
  assert.equal(cost(over), r6((40_001 * 0.5 + 50_000 * 0.05 + 10_000 * 0.625 + 1000 * 2.5) / M));
  // 캐시 1시간 쓰기만으로 넘는 경우도 긴 요청이다.
  assert.equal(claudeLong(HAIKU, { input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100_000 } }), true);
});

test('다른 모델은 프롬프트가 길어도 기본 단가 그대로', () => {
  assert.equal(claudeLong('claude-haiku-4-5', { input_tokens: 500_000 }), false);
  assert.equal(r6(claudeCost('claude-haiku-4-5', { input_tokens: M }).total), 1);
  assert.equal(r6(claudeCost('claude-opus-5-5', { input_tokens: M, cache_read_input_tokens: M }).total), 4 + 0.2);
});

test('장부는 긴 요청의 벡터를 l 로 따로 모으고, 다시 계산해도 원래 비용과 같다', () => {
  const t = new UsageTracker(join(process.env.XDG_CACHE_HOME, 'none.jsonl'));
  const ts = '2026-11-20T10:00:00Z';
  const short = { input_tokens: 50_000, output_tokens: 1000 };
  const long = { input_tokens: 150_000, cache_read_input_tokens: 20_000, output_tokens: 2000 };
  t.apply({ type: 'assistant', timestamp: ts, message: { id: 'a', model: HAIKU, usage: short } });
  t.apply({ type: 'assistant', timestamp: ts, message: { id: 'b', model: HAIKU, usage: long } });
  const m = t.days[dayKey(at(ts))].models[HAIKU];
  assert.deepEqual(m.u, claudeVec(short));
  assert.deepEqual(m.l, claudeVec(long));
  assert.equal(r6(vecCost('claude', HAIKU, m.u, m.f, at(ts), m.l)), r6(m.cost));
  assert.equal(r6(m.cost), r6(claudeCost(HAIKU, short).total + claudeCost(HAIKU, long).total));
});

test('같은 응답의 줄이 10만 경계를 넘어가면 앞 몫을 보통 갈래에서 빼고 긴 갈래로 옮긴다', () => {
  const t = new UsageTracker(join(process.env.XDG_CACHE_HOME, 'none2.jsonl'));
  const ts = '2026-11-20T10:00:00Z';
  const first = { input_tokens: 100_000, output_tokens: 10 };
  const second = { input_tokens: 100_001, output_tokens: 500 };
  t.apply({ type: 'assistant', timestamp: ts, message: { id: 'c', model: HAIKU, usage: first } });
  t.apply({ type: 'assistant', timestamp: ts, message: { id: 'c', model: HAIKU, usage: second } });
  const m = t.days[dayKey(at(ts))].models[HAIKU];
  assert.deepEqual(m.u, [0, 0, 0, 0, 0]);
  assert.deepEqual(m.l, claudeVec(second));
  assert.equal(r6(m.cost), r6(claudeCost(HAIKU, second).total));
});

test('가격 지문이 바뀌어 업그레이드 뒤 캐시·월별 보관함 비용을 다시 계산한다', () => {
  // origin/dev(v0.41.1) 의 지문. 표가 바뀌었으니 달라야 한다.
  assert.notEqual(PRICE_TAG, '4fcc6ec5');
  assert.match(PRICE_TAG, /^[0-9a-f]{8}$/);
});

test('월별 보관함: 긴 요청 벡터(l)를 접어 두고, 가격표가 바뀌면 긴 단가로 다시 계산한다', async () => {
  const m = await import('../src/monthly.mjs');
  const a = m.emptyArchive();
  const day = { tokens: 2 * M, cost: 1, models: { [HAIKU]: { tokens: 2 * M, cost: 1, u: [M, 0, 0, 0, 0], l: [M, 0, 0, 0, 0] } } };
  m.foldInto(a, [{ tool: 'claude', project: null, days: { '2026-10-05': day } }], { lo: '2026-10-01', hi: '2026-10-31', complete: '2026-10-01', now: at('2026-11-20T00:00:00Z') });
  const e = a.months['2026-10'].find((x) => x.m === HAIKU);
  assert.deepEqual(e.l, [M, 0, 0, 0, 0]);
  const file = join(process.env.XDG_CACHE_HOME, 'monthly-331.json');
  writeFileSync(file, JSON.stringify({ ...a, price: 'oldtag00' }));
  const back = m.readArchive(file).archive.months['2026-10'].find((x) => x.m === HAIKU);
  assert.equal(r6(back.c), 0.1 + 0.5);
});
