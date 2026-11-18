import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeCost, contextWindow, geminiPrice } from '../src/pricing.mjs';

const M = 1_000_000;
const cost = (model, u) => Math.round(claudeCost(model, u).total * 1e4) / 1e4;

test('Fable·Mythos 5.2 는 앞부분이 같은 Fable 5 가격이 아니라 자기 가격($8/$40, 캐시 읽기 0.025배)으로 계산한다', () => {
  for (const m of ['claude-fable-5-2', 'claude-mythos-5-2']) {
    assert.equal(cost(m, { input_tokens: M, output_tokens: M, cache_read_input_tokens: M }), 8 + 40 + 0.2, m);
    assert.equal(cost(m, { input_tokens: M, speed: 'fast' }), 16, m);
    assert.equal(contextWindow(m), 1_000_000, m);
  }
});

test('Sonnet 5.5 캐시 읽기는 입력가의 0.05배($0.10)다', () => {
  assert.equal(cost('claude-sonnet-5-5', { cache_read_input_tokens: M }), 0.1);
});

test('Mythos 5 와 4.x 이전 모델도 가격과 창 크기를 찾는다', () => {
  assert.equal(cost('claude-mythos-5', { input_tokens: M, cache_read_input_tokens: M }), 10 + 1);
  assert.equal(cost('claude-opus-4-5-20251101', { output_tokens: M }), 25);
  assert.equal(cost('claude-opus-4-1-20250805', { output_tokens: M }), 75);
  assert.equal(cost('claude-opus-4-20250514', { input_tokens: M }), 15);
  assert.equal(cost('claude-sonnet-4-5-20250929', { input_tokens: M }), 3);
  assert.equal(cost('claude-sonnet-4-20250514', { output_tokens: M }), 15);
  assert.equal(contextWindow('claude-sonnet-4-5-20250929'), 200_000);
  assert.equal(contextWindow('claude-opus-4-6'), 1_000_000);
});

test('표의 창이 200K 여도 그보다 많이 썼으면(Sonnet 4.5 의 1M 베타) 1M 으로 본다', () => {
  assert.equal(contextWindow('claude-sonnet-4-5-20250929', 150_000), 200_000);
  assert.equal(contextWindow('claude-sonnet-4-5-20250929', 500_000), 1_000_000);
});

test('gemini-4-hydrogen 은 $1.50/$7.50, 캐시 $0.075 다', () => {
  assert.deepEqual(geminiPrice('gemini-4-hydrogen'), { input: 1.5, output: 7.5, cacheRead: 0.075 });
});
