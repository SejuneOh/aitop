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

test('앞부분만 같은 표에 없는 Claude 모델은 가격을 추측하지 않고(null), 창 크기는 계열 값을 쓴다 (#266)', () => {
  const family = { 'claude-opus-4-9': 200_000, 'claude-opus-4-1-2': 200_000, 'claude-fable-5-3': 1_000_000, 'claude-sonnet-5-6': 1_000_000, 'claude-haiku-4-5-x': 200_000, 'claude-opus-4-20250514-preview': 200_000, 'anthropic.claude-sonnet-5-6': 1_000_000 };
  for (const [m, w] of Object.entries(family)) {
    assert.equal(claudeCost(m, { input_tokens: M }), null, m);
    assert.equal(contextWindow(m), w, m);
    assert.equal(contextWindow(m, 500_000), 1_000_000, m);
  }
  assert.equal(contextWindow('claude-unknown-9'), 200_000);
  assert.equal(contextWindow('claude-unknown-9', 500_000), 1_000_000);
});

test('날짜판·Vertex·Bedrock·[1m] 이름은 다듬은 뒤 표와 똑같으면 가격과 창 크기를 찾는다 (#266)', () => {
  assert.equal(cost('claude-haiku-4-5-20251001', { input_tokens: M }), 1);
  assert.equal(cost('claude-sonnet-4@20250514', { input_tokens: M }), 3);
  assert.equal(cost('claude-opus-4-1@20250805', { output_tokens: M }), 75);
  assert.equal(cost('anthropic.claude-opus-5-5', { input_tokens: M }), 4);
  assert.equal(cost('global.anthropic.claude-fable-5-2', { input_tokens: M }), 8);
  assert.equal(cost('us.anthropic.claude-sonnet-4-20250514-v1:0', { output_tokens: M }), 15);
  assert.equal(cost('claude-opus-4-6[1m]', { input_tokens: M }), 5);
  assert.equal(contextWindow('claude-opus-4-6[1m]'), 1_000_000);
  assert.equal(contextWindow('anthropic.claude-opus-5-5'), 1_000_000);
  assert.equal(contextWindow('claude-opus-4-20250514'), 200_000);
  assert.equal(claudeCost('<synthetic>', { input_tokens: M }), null);
  assert.equal(cost('us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0', { input_tokens: M }), 3);
});

test('공식 별칭 -0 과 -latest 는 같은 모델 가격, -v2 같은 다른 꼬리는 null (#266)', () => {
  assert.equal(cost('claude-opus-4-0', { input_tokens: M }), 15);
  assert.equal(cost('claude-sonnet-4-0', { input_tokens: M }), 3);
  assert.equal(cost('claude-opus-4-5-latest', { input_tokens: M }), 5);
  assert.equal(cost('claude-sonnet-4-latest', { input_tokens: M }), 3);
  assert.equal(contextWindow('claude-opus-4-0'), 200_000);
  assert.equal(claudeCost('claude-sonnet-4-5-v2', { input_tokens: M }), null);
  assert.equal(claudeCost('claude-opus-4-5-0', { input_tokens: M }), null);
});

test('Gemini 는 이름이 표와 똑같을 때만 가격이 있고, 창 크기는 계열(gemini-) 값을 쓴다 (#266)', () => {
  assert.equal(geminiPrice('gemini-3.8-flash-lite'), null);
  assert.equal(geminiPrice('gemini-4-argon-preview'), null);
  assert.equal(geminiPrice('gemini-3.5-flash'), null);
  assert.ok(geminiPrice('gemini-3.8-flash'));
  assert.equal(contextWindow('gemini-4-argon'), 1_048_576);
  assert.equal(contextWindow('gemini-3.5-flash'), 1_048_576);
});
