import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiCost, geminiPrice } from '../src/pricing.mjs';

const at = (iso) => Date.parse(iso);
const r4 = (x) => Math.round(x * 1e4) / 1e4;

test('Gemini 가격은 호출 시각에 쓰던 값을 고른다 (UTC 0시에 바뀐다)', () => {
  const argon = (iso) => geminiPrice('gemini-4-argon', at(iso));
  assert.deepEqual(argon('2026-11-30T23:59:59.999Z'), { input: 2, output: 10, cacheRead: 0.1 });
  assert.equal(argon('2026-12-01T00:00:00Z').input, 4);
  assert.equal(argon('2027-06-01T00:00:00Z').output, 20);
  for (const m of ['gemini-3.8-flash', 'gemini-3.6-flash']) {
    assert.equal(geminiPrice(m, at('2026-12-31T23:59:59Z')).input, 0.75, m);
    assert.deepEqual(geminiPrice(m, at('2027-01-01T00:00:00Z')), { from: '2027-01-01', input: 1.5, output: 7.5, cacheRead: 0.15 }, m);
  }
  assert.equal(geminiPrice('gemini-3.5-flash-lite', at('2030-01-01T00:00:00Z')).input, 0.3, '날짜가 없는 가격은 그대로');
  assert.equal(geminiPrice('gemini-3.1-flash-lite', at('2026-11-06T00:00:00Z')).cacheRead, 0.025);
});

test('Gemini 비용: 입력(캐시 제외)·캐시 읽기·출력(생각 포함)', () => {
  const t = { input: 1_000_000, cacheRead: 2_000_000, output: 100_000, cacheWrite: 0 };
  const before = geminiCost('gemini-4-argon', t, at('2026-11-06T02:00:00Z'));
  assert.equal(r4(before.total), 2 + 0.2 + 1);
  assert.equal(r4(before.noCache), 3);
  const after = geminiCost('gemini-4-argon', t, at('2026-12-01T00:00:00Z'));
  assert.equal(r4(after.total), 4 + 0.4 + 2);
  assert.equal(r4(geminiCost('gemini-3.8-flash', t, at('2026-11-06T00:00:00Z')).total), 0.75 + 0.15 + 0.375);
});

test('가격표에 없는 Gemini 모델은 null (앞부분만 같은 이름도 추측하지 않는다)', () => {
  const t = { input: 1, output: 1 };
  for (const m of ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview', 'gemini-3.8-flash-lite', 'gemini-4-argon-high', null]) {
    assert.equal(geminiCost(m, t, at('2026-11-06T00:00:00Z')), null, String(m));
  }
});
