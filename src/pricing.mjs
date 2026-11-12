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

// Gemini API 정가 (USD / 100만 토큰, 유료 등급 standard). Antigravity CLI(agy) 사용분을 "API 로 썼다면" 기준으로 계산한다.
// 출처: Google 공식 가격표 https://aistudio.google.com/docs/pricing (2026-11-06 확인). 긴 컨텍스트 구간은 따로 없다.
// 출력에는 생각 토큰이 들어 있고, cacheRead 는 context caching 가격이다. 가격이 바뀌는 모델은 날짜순 목록이며,
// from 은 그 가격이 시작되는 날(UTC 0시)이다.
const GEMINI_PRICES = {
  'gemini-4-argon': [
    { input: 2, output: 10, cacheRead: 0.1 },
    { from: '2026-12-01', input: 4, output: 20, cacheRead: 0.2 },
  ],
  'gemini-3.8-flash': [
    { input: 0.75, output: 3.75, cacheRead: 0.075 },
    { from: '2027-01-01', input: 1.5, output: 7.5, cacheRead: 0.15 },
  ],
  'gemini-3.6-flash': [
    { input: 0.75, output: 3.75, cacheRead: 0.075 },
    { from: '2027-01-01', input: 1.5, output: 7.5, cacheRead: 0.15 },
  ],
  'gemini-3.5-flash-lite': [{ input: 0.3, output: 2.5, cacheRead: 0.03 }],
  'gemini-3.1-flash-lite': [{ input: 0.25, output: 1.5, cacheRead: 0.025 }],
};

// 가격표의 지문(8자리). 표의 값이 하나라도 바뀌면 지문도 바뀐다.
export const priceTag = (tables) => createHash('sha1').update(JSON.stringify(tables)).digest('hex').slice(0, 8);

// 모델별 컨텍스트 창 크기(토큰). 출처: Anthropic 모델 표(2026-10). 표에 없는 모델은 contextWindow 가 추측한다.
const WINDOWS = {
  // Gemini 계열의 입력 한도(1,048,576 토큰). Antigravity 의 내부 모델 이름(gemini-4-argon 등)도 같다고 본다.
  'gemini-': 1_048_576,
  'claude-fable-5-1': 1_000_000,
  'claude-mythos-5-1': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-opus-5-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-5-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
};

function lookup(table, model) {
  if (!model) return null;
  if (table[model]) return table[model];
  const key = Object.keys(table)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k));
  return key ? table[key] : null;
}

// 모르는 모델은 사용량으로 추측한다: 200k 를 넘었으면 1M 창, 아니면 200k 창.
export function contextWindow(model, used = 0) {
  return lookup(WINDOWS, model) ?? (used > 200_000 ? 1_000_000 : 200_000);
}

function priceOf(model) {
  return lookup(PRICES, model);
}

// 사용량 벡터: [입력(캐시 제외), 출력, 캐시 읽기, 캐시 쓰기 5분, 캐시 쓰기 1시간]. 월별 보관함(monthly.mjs)이
// 이 벡터를 남겨 두었다가 가격표가 바뀌면 지금 가격으로 다시 계산한다.
export const VEC = 5;
export const zeroVec = () => [0, 0, 0, 0, 0];

// Claude usage 한 건의 벡터.
export function claudeVec(u) {
  if (!u) return zeroVec();
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0);
  return [u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, write5m, write1h];
}

// Claude 벡터 하나의 비용 (m: fast 배수).
function claudeVecCost(p, v, m) {
  const input = p.input * m;
  const base = v[0] * input + v[1] * p.output * m;
  const cache = v[2] * (p.cacheRead ?? p.input * 0.1) * m + v[3] * input * 1.25 + v[4] * input * 2;
  return { total: (base + cache) / 1e6, noCache: base / 1e6 };
}

// Claude 메시지 usage 한 건의 환산 비용. total 은 캐시 포함, noCache 는 입력·출력만. 가격표에 없는 모델이면 null.
export function claudeCost(model, u) {
  const p = priceOf(model);
  if (!p || !u) return null;
  return claudeVecCost(p, claudeVec(u), u.speed === 'fast' && p.fast ? p.fast : 1);
}

// 보관된 벡터(v: 보통, f: fast 모드)를 지금 가격표로 환산한 비용(USD). 가격표에 없는 모델이면 null.
// agy(Gemini)는 날짜별 가격이라 at(그 달 가운데) 시각의 가격을 쓴다.
export function vecCost(tool, model, v, f, at = Date.now()) {
  const u = v ?? zeroVec();
  if (tool === 'claude') {
    const p = priceOf(model);
    if (!p) return null;
    return claudeVecCost(p, u, 1).total + (f ? claudeVecCost(p, f, p.fast ?? 1).total : 0);
  }
  const p = tool === 'codex' ? openaiPrice(model) : tool === 'agy' ? geminiPrice(model, at) : null;
  if (!p) return null;
  return (u[0] * p.input + u[1] * p.output + u[2] * (p.cacheRead ?? 0)) / 1e6;
}

// Codex(OpenAI) API 정가 기준 환산 비용 (USD / 100만 토큰). Claude 와 같이 "API 로 썼다면" 기준이다.
// 출처: OpenAI 공식 가격표 https://developers.openai.com/api/docs/pricing 와 모델별 문서
// https://developers.openai.com/api/docs/models/<모델 이름> (2026-11-11 확인, 표의 모든 모델이 공식 값과 같다).
// cacheRead 는 cached input 가격이다. gpt-5.1-codex, gpt-5.1-codex-max, gpt-5-codex 는 가격표에는 없고 모델별 문서에만 있다
// (세 모델 모두 지원 종료). gpt-5.6-sol 값은 2026-11-30 까지의 프로모션 가격이며, 그 뒤 가격은 아직 공개되지 않았다.
// 긴 컨텍스트 단가(입력 272K 초과 요청은 입력 2배·출력 1.5배, gpt-5.6-*, gpt-5.5, gpt-5.4)는 반영하지 않는다:
// 세션 누적 토큰만으로는 요청마다 272K 를 넘었는지 알 수 없어서, 모두 기본 단가로 계산한다.
// 컨텍스트 창은 Codex 기록의 model_context_window 를 그대로 쓰므로 WINDOWS 표에 넣지 않는다.
const OPENAI_PRICES = {
  'gpt-5.6-sol': { input: 4, cacheRead: 0.4, output: 20 },
  'gpt-5.6-terra': { input: 2, cacheRead: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cacheRead: 0.02, output: 1.2 },
  'gpt-5.5': { input: 5, cacheRead: 0.5, output: 30 },
  'gpt-5.4': { input: 2.5, cacheRead: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cacheRead: 0.075, output: 4.5 },
  'gpt-5.3-codex': { input: 1.75, cacheRead: 0.175, output: 14 },
  'gpt-5.2': { input: 1.75, cacheRead: 0.175, output: 14 },
  'gpt-5.1-codex-max': { input: 1.25, cacheRead: 0.125, output: 10 },
  'gpt-5.1-codex-mini': { input: 0.25, cacheRead: 0.025, output: 2 },
  'gpt-5.1-codex': { input: 1.25, cacheRead: 0.125, output: 10 },
  'gpt-5-codex': { input: 1.25, cacheRead: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cacheRead: 0.025, output: 2 },
  'gpt-5': { input: 1.25, cacheRead: 0.125, output: 10 },
  'codex-mini': { input: 1.5, cacheRead: 0.375, output: 6 },
  'gpt-4o-mini': { input: 0.15, cacheRead: 0.075, output: 0.6 },
};

// Codex 모델 가격. 이름이 표와 똑같을 때, 또는 끝의 -latest 나 날짜(-2025-08-07)만 뗐을 때 표와 똑같을 때만 찾는다.
// 앞부분만 같은 다른 모델(gpt-5.5-pro 와 gpt-5.5, gpt-5.4-nano 와 gpt-5.4 등)에 엉뚱한 가격을 매기지 않기 위해서다.
export function openaiPrice(model) {
  if (!model) return null;
  return OPENAI_PRICES[model] ?? OPENAI_PRICES[model.replace(/-(latest|\d{4}-\d{2}-\d{2})$/, '')] ?? null;
}

// 가격표가 바뀌면 이 값이 바뀌고, 캐시 폴더도 바뀌어 예전 비용이 다시 계산된다. 세 표(Claude, Gemini, Codex)를 모두 넣는다.
export const PRICE_TABLES = [PRICES, GEMINI_PRICES, OPENAI_PRICES];
export const PRICE_TAG = priceTag(PRICE_TABLES);

// Codex 세션 누적 토큰(tokens: input 은 캐시 제외, cacheRead, output)의 환산 비용. 가격표에 없는 모델이면 null.
export function codexCost(model, t) {
  const p = openaiPrice(model);
  if (!p || !t) return null;
  const base = (t.input ?? 0) * p.input + (t.output ?? 0) * p.output;
  return { total: (base + (t.cacheRead ?? 0) * p.cacheRead) / 1e6, noCache: base / 1e6 };
}

// 시각 at(ms)에 쓰던 Gemini 가격. 모델 이름이 표와 똑같을 때만 찾는다:
// 앞부분만 같은 다른 모델(gemini-3.8-flash-lite 와 gemini-3.8-flash 등)에 엉뚱한 가격을 매기지 않기 위해서다.
export function geminiPrice(model, at = Date.now()) {
  const list = model ? GEMINI_PRICES[model] : null;
  if (!list) return null;
  let p = list[0];
  for (const x of list) if (x.from && at >= Date.parse(x.from)) p = x;
  return p;
}

// agy 호출 한 번(t: input 은 캐시 제외, cacheRead, output 은 생각 포함)을 at 시각의 가격으로 환산한다. 가격표에 없는 모델이면 null.
// agy 는 암시적 캐시만 써서 캐시 쓰기 요금이 없다.
export function geminiCost(model, t, at) {
  const p = geminiPrice(model, at);
  if (!p || !t) return null;
  const base = (t.input ?? 0) * p.input + (t.output ?? 0) * p.output;
  return { total: (base + (t.cacheRead ?? 0) * p.cacheRead) / 1e6, noCache: base / 1e6 };
}
