import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexCost, openaiPrice, PRICE_TAG } from '../src/pricing.mjs';

test('Codex 비용은 입력(캐시 제외)·캐시 읽기·출력을 OpenAI 정가로 환산한다', () => {
  const c = codexCost('gpt-5.3-codex', { input: 1_000_000, cacheRead: 2_000_000, output: 100_000 });
  assert.equal(Math.round(c.total * 1e4) / 1e4, 1.75 + 0.35 + 1.4);
  assert.equal(Math.round(c.noCache * 1e4) / 1e4, 1.75 + 1.4);
});

test('모델 이름은 표와 똑같거나 -latest·날짜만 뗐을 때 같아야 찾는다', () => {
  assert.equal(codexCost('gpt-5.1-codex-mini', { output: 1e6 }).total, 2);
  assert.equal(codexCost('gpt-5.1-codex', { output: 1e6 }).total, 10);
  assert.equal(codexCost('codex-mini-latest', { output: 1e6 }).total, 6);
});

test('가격표에 없는 모델은 null', () => {
  assert.equal(codexCost('o9-future', { output: 1e6 }), null);
  assert.equal(codexCost(null, { output: 1 }), null);
});

test('#163 새로 넣은 모델은 공식 가격표 값(입력, 캐시 입력, 출력)이다', () => {
  const want = {
    'gpt-5.6-sol': [4, 0.4, 20],
    'gpt-5.6-terra': [2, 0.2, 12],
    'gpt-5.6-luna': [0.2, 0.02, 1.2],
    'gpt-5.5': [5, 0.5, 30],
    'gpt-5.4': [2.5, 0.25, 15],
    'gpt-5.4-mini': [0.75, 0.075, 4.5],
    'gpt-5.2': [1.75, 0.175, 14],
    'gpt-5.1-codex-max': [1.25, 0.125, 10],
    'gpt-5-codex': [1.25, 0.125, 10],
    'gpt-5-mini': [0.25, 0.025, 2],
    'gpt-5': [1.25, 0.125, 10],
  };
  for (const [m, [input, cacheRead, output]] of Object.entries(want)) {
    assert.deepEqual(openaiPrice(m), { input, cacheRead, output }, m);
  }
});

test('#163 앞부분만 같은 다른 모델에는 가격을 매기지 않는다', () => {
  // 각자 자기 가격: 짧은 이름(gpt-5, gpt-5.1-codex, gpt-5.4)의 가격이 잡히지 않는다
  assert.equal(codexCost('gpt-5-mini', { output: 1e6 }).total, 2);
  assert.equal(codexCost('gpt-5.4-mini', { output: 1e6 }).total, 4.5);
  // 표에 없는 변형은 추측하지 않는다
  for (const m of ['gpt-5.5-pro', 'gpt-5.4-nano', 'gpt-5-codex-mini', 'gpt-5.6-sol-preview', 'gpt-5.1-codex-maxi', 'gpt-5.']) {
    assert.equal(openaiPrice(m), null, m);
    assert.equal(codexCost(m, { output: 1e6 }), null, m);
  }
  // 날짜나 -latest 가 붙은 이름은 같은 모델로 본다
  assert.equal(openaiPrice('gpt-5-2025-08-07'), openaiPrice('gpt-5'));
  assert.equal(openaiPrice('gpt-5-mini-2025-08-07'), openaiPrice('gpt-5-mini'));
  assert.equal(openaiPrice(''), null);
});

test('#163 가격표 지문이 이번 표 기준으로 바뀌었다', () => {
  assert.match(PRICE_TAG, /^[0-9a-f]{8}$/);
  // 3f5ac93a 는 #163 전 지문이다. 바뀌어야 캐시 폴더가 바뀌어 예전 비용(`?`)이 다시 계산된다.
  assert.notEqual(PRICE_TAG, '3f5ac93a');
});
