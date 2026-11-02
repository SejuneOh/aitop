import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexCost } from '../src/pricing.mjs';

test('Codex 비용은 입력(캐시 제외)·캐시 읽기·출력을 OpenAI 정가로 환산한다', () => {
  const c = codexCost('gpt-5.3-codex', { input: 1_000_000, cacheRead: 2_000_000, output: 100_000 });
  assert.equal(Math.round(c.total * 1e4) / 1e4, 1.75 + 0.35 + 1.4);
  assert.equal(Math.round(c.noCache * 1e4) / 1e4, 1.75 + 1.4);
});

test('모델 이름은 가장 긴 접두어로 찾는다', () => {
  assert.equal(codexCost('gpt-5.1-codex-mini', { output: 1e6 }).total, 2);
  assert.equal(codexCost('gpt-5.1-codex', { output: 1e6 }).total, 10);
  assert.equal(codexCost('codex-mini-latest', { output: 1e6 }).total, 6);
});

test('가격표에 없는 모델은 null', () => {
  assert.equal(codexCost('o9-future', { output: 1e6 }), null);
  assert.equal(codexCost(null, { output: 1 }), null);
});
