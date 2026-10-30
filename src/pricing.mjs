// Claude API 정가 기준 환산 비용 (USD / 100만 토큰). 구독 요금제 사용분도 "API 로 썼다면" 기준으로 계산한다.
// 출처: Anthropic 모델 가격표(2026-10). 캐시 읽기는 입력가의 0.1배, 캐시 쓰기는 5분 1.25배·1시간 2배.
import { createHash } from 'node:crypto';

const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, fast: 2 },
  'claude-opus-5': { input: 5, output: 25, fast: 2 },
  'claude-opus-4-8': { input: 5, output: 25, fast: 2 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

// 가격표가 바뀌면 이 값이 바뀌고, 캐시 폴더도 바뀌어 예전 비용이 다시 계산된다.
export const PRICE_TAG = createHash('sha1').update(JSON.stringify(PRICES)).digest('hex').slice(0, 8);

function priceOf(model) {
  if (!model) return null;
  if (PRICES[model]) return PRICES[model];
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  return key ? PRICES[key] : null;
}

// Claude 메시지 usage 한 건의 환산 비용. total 은 캐시 포함, noCache 는 입력·출력만. 가격표에 없는 모델이면 null.
export function claudeCost(model, u) {
  const p = priceOf(model);
  if (!p || !u) return null;
  const m = u.speed === 'fast' && p.fast ? p.fast : 1;
  const input = p.input * m;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0);
  const base = (u.input_tokens ?? 0) * input + (u.output_tokens ?? 0) * p.output * m;
  const cache = (u.cache_read_input_tokens ?? 0) * (p.cacheRead ?? p.input * 0.1) * m + write5m * input * 1.25 + write1h * input * 2;
  return { total: (base + cache) / 1e6, noCache: base / 1e6 };
}
