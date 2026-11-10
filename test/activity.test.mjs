// 세션별 시간 활동: 1시간 칸 장부(쌓기·버리기·합치기), 도구별 수집, 상세 패널의 24시간 막대.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClaudeHome, assistant, usage } from './fixture.mjs';
import { at, session } from './detail-fixture.mjs';

makeClaudeHome();
const { ACT_HOURS, ACT_MS, activitySeries, addActivity, mergeActivity } = await import('../src/sources/common.mjs');
const { ClaudeTracker } = await import('../src/sources/claude-tracker.mjs');
const { _test: codex } = await import('../src/sources/codex.mjs');
const { activitySpark, detail } = await import('../src/ui/detail.mjs');
const { PALETTE } = await import('../src/ui/theme.mjs');
const { setNow } = await import('../src/ui/draw.mjs');
const { width } = await import('../src/text.mjs');
const { writeFileSync, mkdtempSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const H = ACT_MS;
const hour = Math.floor(at / H) * H;

test('같은 1시간 칸에는 더하고, 가장 새 칸에서 24시간 넘은 칸은 버린다. 0 이하는 넣지 않는다', () => {
  const act = {};
  addActivity(act, hour - 30 * H, 7);
  addActivity(act, hour + 60_000, 10);
  addActivity(act, hour + 120_000, 5);
  addActivity(act, hour - 2 * H, 3);
  addActivity(act, hour - 1 * H, 0);
  addActivity(act, hour - 1 * H, -4);
  addActivity(act, NaN, 9);
  assert.deepEqual(act, { [hour]: 15, [hour - 2 * H]: 3 }, '30시간 전 칸은 새 칸이 생길 때 버린다');
  addActivity(act, hour - 24 * H, 1);
  assert.equal(act[hour - 24 * H], undefined, '늦게 온 아주 오래된 줄은 칸을 만들지 않는다');
  for (let i = 0; i < 100; i++) addActivity(act, hour + i * H, 1);
  assert.ok(Object.keys(act).length <= ACT_HOURS, '칸 수는 24개를 넘지 않는다');
});

test('지금보다 5분 넘게 앞선 시각은 버려서 앞 칸을 지우지 않는다', () => {
  const act = { [hour]: 10, [hour - 3 * H]: 4 };
  addActivity(act, at + 30 * H, 99, at);
  assert.deepEqual(act, { [hour]: 10, [hour - 3 * H]: 4 }, '미래 줄 하나로 지워지지 않는다');
  addActivity(act, at + 2 * 60_000, 1, at);
  assert.equal(act[Math.floor((at + 2 * 60_000) / H) * H] >= 1, true, '조금 앞선 시각(5분 안)은 받는다');
});

test('합치기와 지금까지 24칸 (오래된 칸 → 지금 칸)', () => {
  const merged = mergeActivity([{ [hour]: 1, [hour - H]: 2 }, undefined, { [hour]: 4 }]);
  assert.deepEqual(merged, { [hour]: 5, [hour - H]: 2 });
  const series = activitySeries(merged, at);
  assert.equal(series.length, 24);
  assert.deepEqual(series.slice(-3), [0, 2, 5]);
  assert.deepEqual(activitySeries(merged, at + 3 * H).slice(-5), [2, 5, 0, 0, 0], '시간이 지나면 왼쪽으로 밀린다');
  assert.deepEqual(activitySeries(undefined, at), Array(24).fill(0));
});

test('Claude: 같은 message.id 가 여러 줄이어도 토큰 차이만 그 줄 시각 칸에 더하고, 캐시에 남는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aitop-act-'));
  const path = join(dir, 's.jsonl');
  const t0 = new Date(hour - 2 * H + 60_000).toISOString();
  const t1 = new Date(hour + 60_000).toISOString();
  const row = (id, u, ts) => ({ ...assistant(id, [], u), timestamp: ts });
  const rows = [row('m1', usage(100, 20), t0), row('m1', usage(100, 50), t0), row('m2', usage(1000, 1), t1)];
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const t = new ClaudeTracker(path);
  t.update({ left: Infinity, read: 0 });
  const total = Object.values(t.activity).reduce((a, b) => a + b, 0);
  assert.equal(total, t.tokens.total, '칸 합계 = 세션 토큰');
  assert.equal(t.activity[hour - 2 * H], 150);
  assert.equal(t.activity[hour], 1001);
  assert.deepEqual(t.snapshot().activity, t.activity);
});

test('Codex: token_count 누적값의 차이를 그 줄 시각 칸에 더한다', () => {
  const st = codex.newState('/nonexistent/rollout-x.jsonl');
  const tc = (iso, total) => ({ type: 'event_msg', timestamp: iso, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total } } } });
  codex.applyLine(st, tc(new Date(hour - H + 1000).toISOString(), 500));
  codex.applyLine(st, tc(new Date(hour - H + 2000).toISOString(), 500));
  codex.applyLine(st, tc(new Date(hour + 1000).toISOString(), 1700));
  assert.deepEqual(st.activity, { [hour - H]: 500, [hour]: 1200 });
  assert.deepEqual(codex.snapshot(st).activity, st.activity);
});

const drawWith = (W, Hh, act, view = { tab: 'now' }) => {
  setNow(at);
  return detail({ ...session(), activity: act }, W, Hh, 0, view).map(strip);
};
const ruleOf = (lines) => lines.find((l) => l.includes('최근 활동'));

test('상세 패널: 최근 활동 가로줄에 24시간 막대, 좁으면 12시간, 더 좁으면 뺀다. 폭을 넘지 않는다', () => {
  const act = { [hour]: 5000, [hour - H]: 20000, [hour - 5 * H]: 800, [hour - 23 * H]: 100 };
  const wide = ruleOf(drawWith(140, 30, act));
  assert.match(wide, /최근 활동 {2}▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▂▁▁▁█▃ 24시간 ─/);
  for (let W = 36; W <= 160; W++) {
    const lines = drawWith(W, 24, act);
    assert.ok(lines.every((l) => width(l) <= W), `W=${W}`);
    const r = ruleOf(lines);
    assert.ok(r, `W=${W}`);
    assert.match(r, /최근 활동( {2}[▁-█]{24} 24시간| {2}[▁-█]{12} 12시간)? ─/, `W=${W}: ${r}`);
  }
  assert.match(ruleOf(drawWith(56, 24, act)), /[▁-█]{24} 24시간/, '56칸은 24시간');
  assert.match(ruleOf(drawWith(44, 24, act)), /[▁-█]{12} 12시간/, '44칸은 12시간');
  assert.doesNotMatch(ruleOf(drawWith(38, 24, act)), /시간/, '38칸은 막대 없음');
});

test('상세 패널: 24시간 안에 토큰이 없으면 막대를 그리지 않는다 (예전 상세 화면 그대로)', () => {
  assert.doesNotMatch(ruleOf(drawWith(140, 30, {})), /시간/);
  assert.doesNotMatch(ruleOf(drawWith(140, 30, undefined)), /시간/);
  assert.doesNotMatch(ruleOf(drawWith(140, 30, { [hour - 30 * H]: 99 })), /시간/);
});

test('상세 패널: 파일 목록에 들어가 있으면 막대도 제목처럼 흐리게', () => {
  setNow(at);
  const s = { activity: { [hour]: 5, [hour - H]: 9 } };
  assert.ok(activitySpark(s, 80).some((x) => x.fg === PALETTE.info));
  const dim = activitySpark(s, 80, true);
  assert.ok(dim.length && dim.filter((x) => x.t.trim()).every((x) => x.fg === PALETTE.faint));
});
