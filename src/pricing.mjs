// Claude API 정가 기준 환산 비용 (USD / 100만 토큰). 구독 요금제 사용분도 "API 로 썼다면" 기준으로 계산한다.
// 출처: Anthropic 공식 가격표 https://platform.claude.com/docs/en/about-claude/pricing (2026-11-27 확인).
// 캐시 읽기는 기본 입력가의 0.1배이고 표에 cacheRead 가 있는 모델만 다르다 (Fable·Mythos 5.1/5.2 는 0.025배, Opus·Sonnet 5.5 는 0.05배).
// 캐시 쓰기는 5분 1.25배·1시간 2배.
// long: 프롬프트가 over 토큰을 넘는 요청 전체에 쓰는 단가 (Haiku 5.5 는 10만 토큰 초과면 입력·출력·캐시 모두 5배).
// 프롬프트 길이는 그 요청(usage 한 건)의 입력 + 캐시 읽기 + 캐시 쓰기 합이고, 요청마다 따로 판정한다.
// 보관 벡터(monthly.mjs)에는 요청별 크기가 남지 않으므로, 긴 요청의 벡터는 장부에서 l 로 따로 모은다.
import { createHash } from 'node:crypto';

const PRICES = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, fast: 2 },
  'claude-mythos-5-2': { input: 8, output: 40, cacheRead: 0.2, fast: 2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, fast: 2 },
  'claude-opus-5': { input: 5, output: 25, fast: 2 },
  'claude-opus-4-8': { input: 5, output: 25, fast: 2 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, long: { over: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

// Gemini API 정가 (USD / 100만 토큰, 유료 등급 standard). Antigravity CLI(agy) 사용분을 "API 로 썼다면" 기준으로 계산한다.
// 출처: Google 공식 가격표 https://ai.google.dev/gemini-api/docs/pricing (2026-11-27 확인). 긴 컨텍스트 구간은 따로 없다.
// 출력에는 생각 토큰이 들어 있고, cacheRead 는 context caching 가격이다. 가격이 바뀌는 모델은 날짜순 목록이며,
// from 은 그 가격이 시작되는 날(UTC 0시)이다.
const GEMINI_PRICES = {
  'gemini-4-hydrogen': [{ input: 1.5, output: 7.5, cacheRead: 0.075 }],
  'gemini-4-argon': [
    { input: 2, output: 10, cacheRead: 0.1 },
    { from: '2026-12-01', input: 4, output: 20, cacheRead: 0.2 },
  ],
  'gemini-4-carbon': [
    { input: 2, output: 10, cacheRead: 0.1 },
    { from: '2026-12-01', input: 4, output: 20, cacheRead: 0.2 },
  ],
  'gemini-4-neon': [{ input: 3, output: 15, cacheRead: 0.15 }],
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

// 모델별 컨텍스트 창 크기(토큰). 출처: Anthropic 모델 표 https://platform.claude.com/docs/en/about-claude/models/overview (2026-11-18 확인). 표에 없는 모델은 contextWindow 가 추측한다.
// 가격과 달리 창 크기는 틀려도 비용이 바뀌지 않고, 같은 계열이면 거의 같다. 그래서 표와 똑같은 이름이 없으면
// 앞부분이 같은 가장 긴 키(계열)의 값을 쓴다 (contextWindow 참고).
const WINDOWS = {
  // Gemini 계열의 입력 한도(1,048,576 토큰). Antigravity 의 내부 모델 이름(gemini-4-argon 등)도 같다고 본다.
  'gemini-': 1_048_576,
  'claude-fable-5-2': 1_000_000,
  'claude-mythos-5-2': 1_000_000,
  'claude-fable-5-1': 1_000_000,
  'claude-mythos-5-1': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-mythos-5': 1_000_000,
  'claude-opus-5-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4-5': 200_000,
  'claude-opus-4-1': 200_000,
  'claude-opus-4': 200_000,
  'claude-sonnet-5-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-4-5': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-haiku-5-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
};

// Claude 모델 이름을 가격표 키 모양으로 맞춘다. 떼는 것은 클라우드·도구가 같은 모델에 붙이는 모양뿐이다:
// - 앞의 Bedrock 접두사: anthropic., global.anthropic., us.anthropic., us-gov.anthropic. 등 (모델 표의 Amazon Bedrock ID)
// - 끝의 Bedrock 판 번호: -v1:0 (bedrock-runtime 의 예전 ID 모양. 콜론까지 있을 때만 뗀다)
// - 끝의 [1m]: Claude Code 의 1M 창 모델 지정 (claude-opus-4-6[1m])
// - 끝의 -latest (Codex 와 같은 규칙)
// - 끝의 날짜: claude-opus-4-20250514 (4.6 이전 Claude API 의 날짜판 ID), claude-opus-4@20250514 (Vertex AI)
// - 끝의 -0: claude-opus-4-0, claude-sonnet-4-0 은 claude-opus-4, claude-sonnet-4 의 공식 별칭이다 (계열-주판-0 모양만)
// 그 밖의 꼬리(-preview, -v2, -9 등)는 다른 모델일 수 있어서 떼지 않는다.
const claudeKey = (model) =>
  model
    .replace(/^(?:[a-z][a-z0-9-]*\.)?anthropic\./, '')
    .replace(/\[\d+[km]\]$/i, '')
    .replace(/-v\d+:\d+$/, '')
    .replace(/-latest$/, '')
    .replace(/[-@]\d{8}$/, '')
    .replace(/^(claude-[a-z]+-\d+)-0$/, '$1');

// 표에서 모델을 찾는다. 이름이 표와 똑같을 때, 또는 claudeKey 로 다듬은 이름이 표와 똑같을 때만 찾는다.
// 앞부분만 같은 다른 모델(claude-opus-4-9 와 claude-opus-4 등)에 엉뚱한 가격·창 크기를 매기지 않기 위해서다 (#255, #266).
function lookup(table, model) {
  if (!model) return null;
  return table[model] ?? table[claudeKey(model)] ?? null;
}

// 창 크기 표 찾기. 정확히 맞는 키(claudeKey 로 다듬은 이름 포함)가 먼저이고, 없으면 다듬은 이름과 앞부분이 같은
// 가장 긴 키(계열 값)를 쓴다. 표에 없는 새 모델(claude-sonnet-5-6 등)이 200K 추측으로 떨어져 게이지가 부풀지 않게 하려는 것이다.
function windowOf(model) {
  const exact = lookup(WINDOWS, model);
  if (exact || !model) return exact;
  const name = claudeKey(model);
  const key = Object.keys(WINDOWS)
    .sort((a, b) => b.length - a.length)
    .find((k) => name.startsWith(k));
  return key ? WINDOWS[key] : null;
}

// 모르는 모델은 사용량으로 추측한다: 200k 를 넘었으면 1M 창, 아니면 200k 창.
// 표에 있어도 사용량이 표 값을 넘으면 추측 값을 쓴다: Sonnet 4/4.5 는 1M 베타로 200K 를 넘을 수 있는데, 기록의 모델 이름으로는 구분되지 않는다.
export function contextWindow(model, used = 0) {
  const guess = used > 200_000 ? 1_000_000 : 200_000;
  const w = windowOf(model);
  return w ? Math.max(w, guess) : guess;
}

function priceOf(model) {
  return lookup(PRICES, model);
}

// 사용량 벡터: [입력(캐시 제외), 출력, 캐시 읽기, 캐시 쓰기 5분, 캐시 쓰기 1시간]. 월별 보관함(monthly.mjs)이
// 이 벡터를 남겨 두었다가 가격표가 바뀌면 지금 가격으로 다시 계산한다.
// 벡터는 세 갈래다: u(보통), f(fast 모드), l(긴 프롬프트 요청: 표에 long 이 있는 모델만).
export const VEC = 5;
export const zeroVec = () => [0, 0, 0, 0, 0];

// Claude usage 한 건의 벡터.
export function claudeVec(u) {
  if (!u) return zeroVec();
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0);
  return [u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, write5m, write1h];
}

// 요청 하나(usage 한 건)가 긴 프롬프트 단가를 받는지. 입력 + 캐시 읽기 + 캐시 쓰기 합이 long.over 를 넘을 때만이다 (같으면 기본 단가).
// 장부(claude-ledger.mjs)가 이 값으로 벡터를 l 에 모은다. 표에 long 이 없는 모델은 늘 false.
export function claudeLong(model, u) {
  const over = priceOf(model)?.long?.over;
  if (!over || !u) return false;
  const v = claudeVec(u);
  return v[0] + v[2] + v[3] + v[4] > over;
}

// Claude 벡터 하나의 비용 (m: fast 배수). 긴 요청은 p 대신 p.long 을 넘긴다 (캐시 읽기가 없으면 입력의 0.1배, 쓰기는 1.25배·2배로 같다).
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
  return claudeVecCost(claudeLong(model, u) ? p.long : p, claudeVec(u), u.speed === 'fast' && p.fast ? p.fast : 1);
}

// 보관된 벡터(v: 보통, f: fast 모드, l: 긴 프롬프트 요청)를 지금 가격표로 환산한 비용(USD). 가격표에 없는 모델이면 null.
// agy(Gemini)는 날짜별 가격이라 at(그 달 가운데) 시각의 가격을 쓴다.
// l 은 long 단가로 계산한다. 지금 표에서 long 이 있는 모델(Haiku 5.5)은 fast 가 없어 배수는 1 이다.
// 표에서 long 이 사라졌으면 l 도 기본 단가로 계산한다.
export function vecCost(tool, model, v, f, at = Date.now(), l = null) {
  const u = v ?? zeroVec();
  if (tool === 'claude') {
    const p = priceOf(model);
    if (!p) return null;
    return claudeVecCost(p, u, 1).total + (f ? claudeVecCost(p, f, p.fast ?? 1).total : 0) + (l ? claudeVecCost(p.long ?? p, l, 1).total : 0);
  }
  const p = tool === 'codex' ? openaiPrice(model) : tool === 'agy' ? geminiPrice(model, at) : null;
  if (!p) return null;
  return (u[0] * p.input + u[1] * p.output + u[2] * (p.cacheRead ?? 0)) / 1e6;
}

// Codex(OpenAI) API 정가 기준 환산 비용 (USD / 100만 토큰). Claude 와 같이 "API 로 썼다면" 기준이다.
// 출처: OpenAI 공식 가격표 https://developers.openai.com/api/docs/pricing 와 모델별 문서
// https://developers.openai.com/api/docs/models/<모델 이름> (2026-11-18 확인, 표의 모든 모델이 공식 값과 같다).
// cacheRead 는 cached input 가격이다. gpt-5.1-codex, gpt-5.1-codex-max, gpt-5-codex 는 가격표에는 없고 모델별 문서에만 있다
// (세 모델 모두 지원 종료). gpt-5.6-sol 값은 2026-11-30 까지의 프로모션 가격이며, 그 뒤 가격은 2026-11-18 에도 공식 가격표에 없다.
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

// 가격표가 바뀌면 이 값이 바뀌고, 캐시 폴더도 바뀌어 예전 비용이 다시 계산된다 (월별 보관함도 다시 계산한다).
// 세 표(Claude, Gemini, Codex)와 찾는 규칙의 판 번호(LOOKUP_REV)를 함께 넣는다.
// 표의 값은 그대로여도 모델 이름으로 가격을 찾는 규칙(lookup, claudeKey, openaiPrice 등)이 바뀌면 LOOKUP_REV 를 올린다.
// lookup-2: Claude 가격을 앞부분 일치가 아니라 정규화 후 정확 일치로 찾는다 (#266).
export const PRICE_TABLES = [PRICES, GEMINI_PRICES, OPENAI_PRICES];
export const LOOKUP_REV = 'lookup-2';
export const PRICE_TAG = priceTag([...PRICE_TABLES, LOOKUP_REV]);

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
