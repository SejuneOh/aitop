import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetDayOption, resolveConfig } from '../src/config.mjs';
import { CAUTION, hoursToMidnight, levelOf, projectBudget } from '../src/budget.mjs';
import { addSlot, lastHourOf, recentTodayOf } from '../src/sources/common.mjs';
import { header } from '../src/ui/table.mjs';
import { toJson } from '../src/json.mjs';
import { width } from '../src/text.mjs';

const file = (values = {}) => ({ path: '/x/config.json', exists: true, values, problems: [] });

test('budgetDay 는 옵션 > 환경 변수 > 설정 파일 순서로 고른다', () => {
  const pick = (flags, env, values) => {
    const v = resolveConfig({ flags, env, file: file(values) }).values.budgetDay;
    return `${v.value}@${v.source}`;
  };
  assert.equal(pick({}, {}, {}), 'null@default');
  assert.equal(pick({}, {}, { budgetDay: 50 }), '50@file');
  assert.equal(pick({}, { AITOP_BUDGET_DAY: '30' }, { budgetDay: 50 }), '30@env');
  assert.equal(pick({ budgetDay: 20 }, { AITOP_BUDGET_DAY: '30' }, { budgetDay: 50 }), '20@flag');
  assert.equal(pick({ budgetDay: null }, { AITOP_BUDGET_DAY: '30' }, { budgetDay: 50 }), 'null@flag', '--no-budget-day 은 끈다');
  assert.equal(pick({}, { AITOP_BUDGET_DAY: '$12.5' }, {}), '12.5@env');
  for (const bad of ['0', '-3', 'abc', '', '1e3', 'Infinity']) assert.equal(pick({}, { AITOP_BUDGET_DAY: bad }, { budgetDay: 50 }), '50@file', `env ${JSON.stringify(bad)} 는 무시`);
  const cfg = resolveConfig({ env: { AITOP_BUDGET_DAY: 'abc' }, file: file() });
  assert.deepEqual(cfg.problems, ['환경 변수 AITOP_BUDGET_DAY 값 "abc" 이 잘못되어 무시합니다 (0 보다 큰 수)']);
  assert.deepEqual(resolveConfig({ env: { AITOP_BUDGET_DAY: '5' }, file: file() }).problems, []);
});

test('--budget-day <usd>, --budget-day=<usd>, --no-budget-day 를 꺼내고 뒤에 준 쪽을 따른다', () => {
  assert.deepEqual(budgetDayOption(['--once', '--budget-day', '50', '--all']), { value: 50, rest: ['--once', '--all'], error: null });
  assert.deepEqual(budgetDayOption(['--budget-day=12.5']), { value: 12.5, rest: [], error: null });
  assert.equal(budgetDayOption(['--budget-day=$40']).value, 40);
  assert.equal(budgetDayOption(['--budget-day=5', '--no-budget-day']).value, null);
  assert.equal(budgetDayOption(['--no-budget-day', '--budget-day', '7']).value, 7);
  assert.equal(budgetDayOption(['--json']).value, undefined);
  assert.match(budgetDayOption(['--budget-day']).error, /값이 없습니다/);
  assert.match(budgetDayOption(['--budget-day', '--json']).error, /값이 없습니다/);
  assert.match(budgetDayOption(['--budget-day', '-5']).error, /값 "-5" 이 잘못되었습니다/, '음수는 빠진 값이 아니라 잘못된 값');
  assert.deepEqual(budgetDayOption(['--budget-day', '-5']).rest, []);
  assert.deepEqual(budgetDayOption(['--budget-day', '--json']).rest, ['--json'], '다음 옵션은 값으로 먹지 않는다');
  for (const bad of ['0', '-5', 'x', '1e3']) assert.match(budgetDayOption([`--budget-day=${bad}`]).error, /잘못되었습니다/, bad);
});

const local = (h, m = 0, s = 0, ms = 0) => new Date(2026, 10, 10, h, m, s, ms).getTime();
const HOUR = 3600_000;
const usage = (today, recentToday, loading = null) => ({ today: { cost: 10, costNoCache: 2, tokens: 1, ...today }, week: { cost: 70, costNoCache: 14, tokens: 7 }, lastHour: recentToday, recentToday, loading });

test('자정까지 남은 시간은 로컬 시각 기준이다', () => {
  assert.equal(hoursToMidnight(local(18)), 6);
  assert.equal(hoursToMidnight(local(0)), 24);
  assert.ok(hoursToMidnight(local(23, 59, 59, 999)) < 1e-6);
  assert.equal(hoursToMidnight(local(23, 30)), 0.5);
});

test('예상 = 오늘 비용 + 최근 지출 속도 × 자정까지 남은 시간, 늘 API 기준', () => {
  const u = usage({}, { cost: 4, costNoCache: 1, unknown: false, ms: HOUR });
  assert.deepEqual(projectBudget(u, 50, { now: local(18) }), { day: 50, spent: 10, projected: 34, unknown: false, level: 'ok' });
  assert.equal(projectBudget(u, 50, { now: local(18), mode: 'net' }).projected, 34, '비용 기준과 상관없이 API 기준');
  assert.equal(projectBudget(u, 50, { now: local(23, 59, 59, 999) }).projected.toFixed(4), '10.0000', '자정 직전에는 오늘 비용과 같다');
  assert.equal(projectBudget(usage({}, { cost: 2, costNoCache: 1, ms: 30 * 60_000 }), 50, { now: local(0, 30) }).projected, 10 + 4 * 23.5, '30분 몫을 시간당으로 늘린다');
  assert.equal(projectBudget(usage({}, { cost: 1, costNoCache: 1, ms: 14 * 60_000 }), 50, { now: local(0, 14) }).projected, 10, '자정 뒤 15분 전에는 오늘 비용');
  assert.equal(projectBudget(usage({}, null), 50, { now: local(18) }).projected, 10, '속도 값이 없으면 오늘 비용');
  assert.equal(projectBudget(usage({}, { cost: 4, costNoCache: 1, ms: HOUR }, 0.4), 50, { now: local(18) }).projected, 10, '집계 중이면 오늘 비용');
  assert.equal(projectBudget(usage({ unknown: true }, null), 50).unknown, true, '가격 모르는 사용량은 ? 표시를 이어 간다');
  assert.equal(projectBudget(usage({}, { cost: 1, costNoCache: 1, unknown: true, ms: HOUR }), 50, { now: local(18) }).unknown, true);
  assert.equal(projectBudget(u, null), null);
  assert.equal(projectBudget(null, 50), null);
});

// 장부의 5분 칸에서: 최근 1시간 중 로컬 자정 이후 몫만 속도로 쓴다.
const ledger = (spends) => {
  const slots = {};
  for (const [at, cost] of spends) addSlot(slots, at, cost, cost / 4, false);
  return [slots];
};
const fromSlots = (spends, now, todayCost) => {
  const books = ledger(spends);
  return { today: { cost: todayCost, costNoCache: todayCost / 4, tokens: 1 }, week: { cost: 0, costNoCache: 0, tokens: 0 }, lastHour: lastHourOf(books, now), recentToday: recentTodayOf(books, now), loading: null };
};

test('자정 경계: 00:05 에는 어젯밤 23시대 지출이 커도 경고하지 않는다', () => {
  const now = local(0, 5);
  const u = fromSlots([[local(23, 30) - 24 * HOUR, 200], [local(23, 50) - 24 * HOUR, 200], [local(0, 1), 0.5]], now, 0.5);
  assert.ok(u.lastHour.cost > 400, '지출 속도(헤더 $/h)는 그대로 최근 1시간');
  assert.equal(u.recentToday.ms, 5 * 60_000);
  const b = projectBudget(u, 30, { now });
  assert.equal(b.projected, 0.5, '15분이 안 지났으면 오늘 비용');
  assert.equal(b.level, 'ok');
});

test('자정 경계: 00:40 에는 오늘 몫(00:20~00:40 지출)만으로 속도를 잡는다', () => {
  const now = local(0, 40);
  const u = fromSlots([[local(23, 50) - 24 * HOUR, 500], [local(0, 20), 2], [local(0, 30), 2]], now, 4);
  assert.equal(u.recentToday.cost, 4, '어젯밤 몫은 빠진다');
  assert.equal(u.recentToday.ms, 40 * 60_000);
  const b = projectBudget(u, 170, { now });
  const perHour = 4 / (40 / 60);
  assert.ok(Math.abs(b.projected - (4 + perHour * (23 + 20 / 60))) < 1e-9, String(b.projected));
  assert.equal(b.level, 'caution');
});

test('속도의 분모는 실제로 센 5분 칸이 덮는 길이다', () => {
  const now = local(18, 2);
  const r = recentTodayOf(ledger([[local(17, 3), 50], [local(17, 5), 3], [local(18, 0), 2]]), now);
  assert.equal(r.cost, 5, '17:00 칸(17:02 이전 시작)은 빠진다');
  assert.equal(r.ms, 57 * 60_000, '17:05 부터 18:02 까지');
  assert.equal(recentTodayOf(ledger([]), local(18)).ms, 60 * 60_000);
});

test('단계: 예산의 80% 이상은 caution, 100% 이상은 warn', () => {
  assert.equal(CAUTION, 0.8);
  assert.equal(levelOf(39.99, 50), 'ok');
  assert.equal(levelOf(40, 50), 'caution');
  assert.equal(levelOf(49.99, 50), 'caution');
  assert.equal(levelOf(50, 50), 'warn');
  assert.equal(levelOf(120, 50), 'warn');
});

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const AT = local(18);
const sess = { tool: 'claude', id: 'a', name: 'a', cwd: '/w', status: 'busy', live: true, phase: { kind: 'think', text: '' }, updatedAt: AT, tokens: { total: 1 }, cost: 1, context: {}, members: [], events: [] };
// 오늘 $12.30, 시간당 $5 → 18시 기준 예상 $42.30.
const U = { today: { cost: 12.3, costNoCache: 3, tokens: 5.8e7 }, week: { cost: 208, costNoCache: 18, tokens: 2.2e9 }, lastHour: { cost: 5, costNoCache: 1, unknown: false }, recentToday: { cost: 5, costNoCache: 1, unknown: false, ms: HOUR }, loading: null };
const head = (W, budgetDay, costMode = 'api', u = U) => strip(header({ data: { sessions: [sess, { ...sess, id: 'b', status: 'idle' }], usage: u, at: AT }, costMode, budgetDay }, W));

test('예산이 없으면 헤더는 그대로다', () => {
  for (const W of [60, 80, 120]) {
    assert.equal(head(W, undefined), head(W, null));
    assert.doesNotMatch(head(W, undefined), /예상|\/\$/);
  }
});

test('헤더: 오늘 금액 옆에 예산, 80% 이상이면 예상, 100% 이상이면 ! (60·80·120칸)', () => {
  assert.match(head(120, 100), /오늘 \$12\.30\/\$100 \(\$5\.00\/h\)/);
  assert.doesNotMatch(head(120, 100), /예상/);
  assert.match(head(120, 50), /오늘 \$12\.30\/\$50 \(\$5\.00\/h\) 58\.0M · 예상 \$42 · 7일/, '지출 속도는 오늘 금액 옆, 예상은 · 로 나눈다');
  assert.match(head(120, 30), /오늘 \$12\.30\/\$30 \(\$5\.00\/h\) 58\.0M · 예상 \$42! · 7일/);
  assert.match(head(80, 50), /예상 \$42 ·/);
  assert.match(head(80, 30), /예상 \$42! ·/);
  assert.match(head(60, 50), /예상 \$42 ·/);
  assert.match(head(60, 30), /예상 \$42! ·/);
  assert.match(head(120, 12.5), /\/\$12\.50/);
  assert.match(head(120, 30, 'api', { ...U, today: { ...U.today, unknown: true } }), /\$12\.30\?\/\$30 \(\$5\.00\/h\) 58\.0M · 예상 \$42\?!/);
});

test('캐시 제외 화면에서도 예산은 API 기준이라 화면과 --json 의 단계가 같다', () => {
  for (const W of [60, 80, 120]) assert.match(head(W, 30, 'net'), /예상 \$42!/, `W=${W}`);
  for (const W of [60, 80]) assert.match(head(W, 30, 'net'), /API 예상 \$42! · 18:00:00/, `W=${W}: 예상만 남으면 API 기준이라고 적는다`);
  for (let W = 30; W <= 160; W++) if (/오늘 \$/.test(head(W, 30, 'net'))) assert.match(head(W, 30, 'net'), /예상 \$42!/, `net W=${W}`);
  assert.match(head(160, 30, 'net'), /캐시 제외 {2}오늘 \$3\.00 \(\$1\.00\/h\) 58\.0M · 예산 \$12\.30\/\$30 예상 \$42! · 7일/);
  assert.doesNotMatch(head(160, 30, 'net'), /\$3\.00\/\$30/);
  assert.equal(toJson({ at: AT, sessions: [], usage: U }, null, { budgetDay: 30 }).usage.budget.level, 'warn');
  assert.doesNotMatch(head(160, 100, 'net'), /예상/);
});

test('폭이 모자라도 넘치지 않고, 예산 경고 ! 는 시각 다음으로 오래 남는다', () => {
  for (let W = 30; W <= 160; W++)
    for (const mode of ['api', 'net'])
      for (const day of [undefined, 100, 50, 30, 5]) {
        const line = head(W, day, mode);
        assert.ok(width(line) <= W, `W=${W} ${mode} ${day}: ${line}`);
      }
  // 오늘 금액이 보이는 폭이면 경고도 보인다.
  for (let W = 30; W <= 160; W++) if (/오늘 \$/.test(head(W, 30))) assert.match(head(W, 30), /예상 \$42!/, `W=${W}`);
  assert.match(head(50, 30), /예상 \$42!/);
});

test('--json: 예산이 있을 때만 usage.budget 을 넣는다', () => {
  const data = { at: AT, sessions: [], usage: U };
  assert.ok(!('budget' in toJson(data).usage));
  assert.ok(!('budget' in toJson(data, null, { budgetDay: null }).usage));
  assert.deepEqual(toJson(data, null, { budgetDay: 50 }).usage.budget, { day: 50, projected: 42.3, unknown: false, level: 'caution' });
  assert.equal(toJson(data, null, { budgetDay: 40 }).usage.budget.level, 'warn');
  assert.equal(toJson(data, null, { budgetDay: 100 }).usage.budget.level, 'ok');
  assert.equal(toJson({ ...data, usage: null }, null, { budgetDay: 50 }).usage, null);
});
