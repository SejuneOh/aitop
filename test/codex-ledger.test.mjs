// 헤더 오늘·7일 합계에 Codex 사용량이 들어간다 (#97).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeClaudeHome } from './fixture.mjs';

makeClaudeHome();
const root = mkdtempSync(join(tmpdir(), 'aitop-codex-ledger-'));
process.env.CODEX_HOME = join(root, 'codex');
const SESSIONS = join(process.env.CODEX_HOME, 'sessions');
const { collectLedger, dayKey } = await import('../src/sources/claude-ledger.mjs');
const { collectCodexLedger, _test } = await import('../src/sources/codex-ledger.mjs');
const { collectCodex } = await import('../src/sources/codex.mjs');
const { createBudget } = await import('../src/tail.mjs');

const DAY = 86400_000;
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

const ctx = (model) => ({ type: 'turn_context', payload: { model, cwd: '/work/demo' } });
// 누적 토큰 줄. input 은 캐시 포함 입력이다 (Codex 기록 그대로).
const count = (at, { input = 0, cached = 0, output = 0 }) => ({
  timestamp: new Date(at).toISOString(),
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output }, last_token_usage: { total_tokens: 1 } } },
});

// 시작한 날짜 폴더(YYYY/MM/DD)에 rollout 파일을 만든다. 수정 시각은 지금에서 ageMs 전.
function rollout(name, rows, { startedAgo = 0, ageMs = 0 } = {}) {
  const d = new Date(Date.now() - startedAgo);
  const dir = join(SESSIONS, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${name}.jsonl`);
  writeFileSync(path, [{ type: 'session_meta', payload: { id: name, cwd: '/work/demo' } }, ...rows].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
  return path;
}

const midnight = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime();
const ledger = () => collectLedger({ budget: createBudget() });

beforeEach(() => {
  rmSync(SESSIONS, { recursive: true, force: true });
  _test.reset();
});

test('같은 누적값이 되풀이되면 한 번만, 늘어난 만큼씩 더한다', () => {
  const t = Date.now() - 10 * 60_000;
  rollout('a', [
    ctx('gpt-5.1-codex'),
    count(t, { output: 100_000 }),
    count(t + 1000, { output: 100_000 }),
    count(t + 2000, { input: 2_000_000, cached: 1_000_000, output: 300_000 }),
    count(t + 3000, { input: 2_000_000, cached: 1_000_000, output: 300_000 }),
  ]);
  const r = ledger();
  // 입력 1M($1.25) + 캐시 1M($0.125) + 출력 0.3M($3)
  assert.equal(r.today.tokens, 2_300_000);
  near(r.today.cost, 1.25 + 0.125 + 3);
  near(r.today.costNoCache, 1.25 + 3);
  assert.equal(r.today.unknown, false);
  near(r.lastHour.cost, 1.25 + 0.125 + 3);
});

test('누적값이 줄면 새 카운터로 보고 새 누적값을 그대로 더한다', () => {
  const t = Date.now() - 10 * 60_000;
  rollout('b', [ctx('gpt-5.1-codex'), count(t, { output: 500_000 }), count(t + 1000, { output: 200_000 }), count(t + 2000, { output: 250_000 })]);
  const r = ledger();
  assert.equal(r.today.tokens, 750_000);
  near(r.today.cost, 7.5);
});

test('자정을 넘긴 세션은 줄의 날짜별로 나눠 더한다', () => {
  const m = midnight();
  rollout('c', [ctx('gpt-5.1-codex'), count(m - 60_000, { output: 1_000_000 }), count(m + 60_000, { output: 3_000_000 })], { startedAgo: Date.now() - m + 60_000 });
  const r = ledger();
  assert.equal(r.today.tokens, 2_000_000);
  near(r.today.cost, 20);
  assert.equal(r.week.tokens, 3_000_000);
  near(r.week.cost, 30);
});

test('7일 밖의 줄과 7일 넘게 바뀌지 않은 기록은 세지 않고, 오래전 시작해 오늘 이어 쓴 세션은 오늘 늘어난 만큼만 센다', () => {
  const t = Date.now() - 10 * 60_000;
  rollout('d', [ctx('gpt-5.1-codex'), count(Date.now() - 8 * DAY, { output: 1_000_000 }), count(t, { output: 1_500_000 })]);
  rollout('e', [ctx('gpt-5.1-codex'), count(Date.now() - 8 * DAY, { output: 9_000_000 })], { startedAgo: 6 * DAY, ageMs: 8 * DAY });
  rollout('f', [ctx('gpt-5.1-codex'), count(Date.now() - 8 * DAY, { output: 9_000_000 }), count(t, { output: 9_700_000 })], { startedAgo: 8 * DAY });
  rollout('j', [ctx('gpt-5.1-codex'), count(t, { output: 5_000_000 })], { startedAgo: 31 * DAY });
  const r = ledger();
  assert.equal(r.week.tokens, 1_200_000);
  assert.equal(r.today.tokens, 1_200_000);
});

test('가격표에 없는 모델은 토큰만 세고 ? 표시, 모델이 바뀌면 그 뒤 줄부터 새 가격', () => {
  const t = Date.now() - 10 * 60_000;
  rollout('g', [ctx('o9-future'), count(t, { output: 1_000_000 }), ctx('gpt-5.1-codex-mini'), count(t + 1000, { output: 2_000_000 })]);
  const r = ledger();
  assert.equal(r.today.tokens, 2_000_000);
  near(r.today.cost, 2);
  assert.equal(r.today.unknown, true);
  assert.equal(r.lastHour.unknown, true);
});

test('읽기 한도가 다 되면 남은 크기를 pending 으로 알리고 다음에 이어 읽는다', () => {
  rollout('h', [ctx('gpt-5.1-codex'), count(Date.now() - 60_000, { output: 1_000_000 })]);
  const first = collectCodexLedger({ budget: createBudget(0) });
  assert.ok(first.size > 0);
  assert.equal(first.pending, first.size);
  const next = collectCodexLedger({ budget: createBudget() });
  assert.equal(next.pending, 0);
  assert.equal(next.days[0][dayKey(Date.now() - 60_000)].tokens, 1_000_000);
});

test('오늘 시작한 세션의 장부 비용은 세션 표의 Codex 비용과 같다', () => {
  const t = Date.now() - 10 * 60_000;
  const path = rollout('i', [
    ctx('gpt-5.3-codex'),
    count(t, { input: 40_000, cached: 10_000, output: 2_000 }),
    count(t + 1000, { input: 40_000, cached: 10_000, output: 2_000 }),
    count(t + 2000, { input: 90_000, cached: 60_000, output: 7_000 }),
    count(t + 3000, { input: 150_000, cached: 100_000, output: 9_000 }),
  ]);
  const r = ledger();
  const row = collectCodex({ showEnded: true, budget: undefined }).find((x) => x.id === 'i');
  assert.ok(row, path);
  assert.ok(row.cost > 0);
  near(r.today.cost, row.cost);
  near(r.today.costNoCache, row.costNoCache);
  assert.equal(r.today.tokens, row.tokens.total);
});
