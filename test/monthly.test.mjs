// 월별 보관함과 --report monthly (#164): 한 번만 접기(되풀이·캐시 교체·동시 쓰기), 12개월 보관, 깨진 보관함,
// 가격 다시 계산, 달별 표(ko/en, 열 맞추기), 1년치 채우기의 시간 상한, 평소 화면의 접기.
// 날짜 키가 시간대를 따르므로 TZ 를 고정한다.
process.env.TZ = 'Asia/Seoul';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeClaudeHome, assistant, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const m = await import('../src/monthly.mjs');
const { buildMonthly, formatReport, reportJson, reportOption, fitReport, collectMonthly, OTHERS } = await import('../src/report.mjs');
const { collectLedger, _test: ledgerTest } = await import('../src/sources/claude-ledger.mjs');
const { claudeCost, vecCost, claudeVec, PRICE_TAG } = await import('../src/pricing.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { CACHE_ROOT, CACHE_DIR, flushCache } = await import('../src/cache.mjs');
const { dayKey } = await import('../src/sources/common.mjs');
const { setLang } = await import('../src/i18n.mjs');

const NOW = Date.parse('2026-11-12T12:00:00+09:00');
const OPUS = 'claude-opus-5-5';
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
let n = 0;
const tmpFile = () => join(CACHE_ROOT, `monthly-test-${++n}.json`);

// 하루 장부 한 칸: opus 입력 tokens 개 ($4/M).
const day = (tokens, model = OPUS) => ({ tokens, cost: (tokens * 4) / 1e6, costNoCache: 0, unknown: false, models: { [model]: { tokens, cost: (tokens * 4) / 1e6, u: [tokens, 0, 0, 0, 0] } } });
const book = (days, project = '/work/a', tool = 'claude') => ({ tool, project, days });
// 10월 1일 ~ 11월 10일 매일 1M 토큰.
const allDays = {};
for (let d = '2026-10-01'; d <= '2026-11-12'; d = m.addDays(d, 1)) allDays[d] = day(1_000_000);
const sumMonth = (a, k) => (a.months[k] ?? []).reduce((s, e) => s + e.n, 0);

test('날짜 산술: 달의 마지막 날, 최근 달, 보관 시작일, 접는 마지막 날', () => {
  assert.equal(m.monthEnd('2026-02'), '2026-02-28');
  assert.equal(m.monthEnd('2026-12'), '2026-12-31');
  assert.deepEqual(m.lastMonths(3, NOW), ['2026-11', '2026-10', '2026-09']);
  assert.equal(m.keepFrom(NOW), '2025-12-01');
  assert.equal(m.foldHi(NOW), '2026-11-10');
  assert.equal(m.addDays('2026-10-31', 1), '2026-11-01');
});

test('같은 범위를 여러 번 접어도, 겹치는 범위를 접어도 날마다 한 번만 센다', () => {
  const a = m.emptyArchive();
  assert.equal(m.foldInto(a, [book(allDays)], { lo: '2026-10-05', hi: '2026-10-20', now: NOW }), 'folded');
  assert.equal(m.foldInto(a, [book(allDays)], { lo: '2026-10-05', hi: '2026-10-20', now: NOW }), 'none');
  assert.equal(m.foldInto(a, [book(allDays)], { lo: '2026-10-15', hi: '2026-11-10', now: NOW }), 'folded');
  assert.deepEqual([a.since, a.from, a.through], ['2026-10-05', '2026-10-05', '2026-11-10']);
  assert.equal(sumMonth(a, '2026-10'), 27_000_000, '10월 5일 ~ 31일');
  assert.equal(sumMonth(a, '2026-11'), 10_000_000);
  // 앞으로 넓히기 (이어지면 받는다).
  assert.equal(m.foldInto(a, [book(allDays)], { lo: '2026-10-01', hi: '2026-10-10', now: NOW }), 'folded');
  assert.equal(sumMonth(a, '2026-10'), 31_000_000);
});

test('사이가 비면 접지 않는다 (평소 화면·daily), 1년치를 읽은 때만 빈 날을 holes 에 적는다', () => {
  const a = m.emptyArchive();
  m.foldInto(a, [book(allDays)], { lo: '2026-10-01', hi: '2026-10-05', now: NOW });
  assert.equal(m.foldInto(a, [book(allDays)], { lo: '2026-11-01', hi: '2026-11-10', now: NOW }), 'gap');
  assert.equal(a.through, '2026-10-05');
  assert.equal(m.foldInto(a, [book(allDays)], { lo: '2026-11-01', hi: '2026-11-10', now: NOW, gap: 'hole' }), 'folded');
  assert.deepEqual(a.holes, [['2026-10-06', '2026-10-31']]);
  const r = buildMonthly([], a, { months: 2, now: NOW, viewLo: '2026-11-11' });
  assert.equal(r.rows.find((x) => x.month === '2026-10').status, 'partial');
});

test('캐시가 바뀌어 장부를 다시 세도(같은 날이 장부에 또 있어도) 보관한 날은 보관함 값만 쓴다', () => {
  const a = m.emptyArchive();
  m.foldInto(a, [book(allDays)], { lo: '2026-10-14', hi: '2026-11-10', now: NOW });
  // 다시 센 장부: 30일 창 전체 (10월 14일 ~ 11월 12일).
  const rebuilt = [book(Object.fromEntries(Object.entries(allDays).filter(([k]) => k >= '2026-10-14')))];
  const r = buildMonthly(rebuilt, a, { months: 2, now: NOW, viewLo: '2026-10-14' });
  assert.equal(r.rows[0].tokens, 12_000_000, '11월 1~12일, 11·12일은 장부에서');
  assert.equal(r.rows[1].tokens, 18_000_000, '10월 14~31일');
  // 같은 장부로 다시 접어도 더해지지 않는다.
  assert.equal(m.foldInto(a, rebuilt, { lo: '2026-10-14', hi: '2026-11-10', now: NOW }), 'none');
  assert.equal(sumMonth(a, '2026-10') + sumMonth(a, '2026-11'), 28_000_000);
});

test('여러 aitop 이 함께 써도 먼저 쓴 쪽만 남고, 파일은 늘 since~through 의 합이다', () => {
  const file = tmpFile();
  const a = m.readArchive(file).archive;
  const b = m.readArchive(file).archive;
  m.foldInto(a, [book(allDays)], { lo: '2026-10-01', hi: '2026-10-10', now: NOW });
  m.foldInto(b, [book(allDays)], { lo: '2026-10-01', hi: '2026-10-20', now: NOW });
  assert.equal(m.writeArchive(a, 0, file), true);
  assert.equal(m.writeArchive(b, 0, file), false, '같은 rev 에서 시작한 두 번째 쓰기는 버린다');
  const saved = m.readArchive(file).archive;
  assert.equal(saved.rev, 1);
  assert.equal(saved.through, '2026-10-10');
  assert.equal(sumMonth(saved, '2026-10'), 10_000_000);
  // foldArchive 는 다시 읽어 이어 접는다. 임시 파일이 남지 않는다.
  assert.equal(m.foldArchive([book(allDays)], { lo: '2026-10-01', hi: '2026-10-20', now: NOW, file }), 'folded');
  assert.equal(sumMonth(m.readArchive(file).archive, '2026-10'), 20_000_000);
  assert.deepEqual(readdirSync(CACHE_ROOT).filter((f) => f.includes('.tmp')), []);
});

test('갱신이 실패한 agy 기록: 그 기록이 쓰였을 수 있는 날 전날까지만 접고, 7일 넘게 밀리면 빼고 접어 그 달을 일부로 둔다', () => {
  const claude = book(allDays, '/work/a');
  const agy = (from) => ({ tool: 'agy', project: '/work/g', days: { '2026-10-25': day(7, 'gemini-4-argon') }, staleFrom: from });
  // 11월 8일부터 실패: 11월 7일까지만 접는다.
  let file = tmpFile();
  assert.equal(m.foldArchive([claude, agy('2026-11-08')], { lo: '2026-10-01', hi: '2026-11-10', now: NOW, file }), 'folded');
  let a = m.readArchive(file).archive;
  assert.equal(a.through, '2026-11-07');
  assert.equal(sumMonth(a, '2026-10'), 31_000_007, '실패 범위 밖의 agy 몫도 접힌다');
  assert.deepEqual(a.holes, []);
  // 밀린 채로 다시: 더 접을 날이 없다.
  assert.equal(m.foldArchive([claude, agy('2026-11-08')], { lo: '2026-10-01', hi: '2026-11-10', now: NOW, file }), 'none');
  // 10월 20일부터 실패 (hi 보다 7일 넘게 앞): 그 agy 기록을 빼고 11월 10일까지 접고, 빠진 날을 holes 에 적는다.
  file = tmpFile();
  assert.equal(m.foldArchive([claude, agy('2026-10-20')], { lo: '2026-10-01', hi: '2026-11-10', now: NOW, file }), 'folded');
  a = m.readArchive(file).archive;
  assert.equal(a.through, '2026-11-10');
  assert.equal(sumMonth(a, '2026-10'), 31_000_000, 'agy 몫은 빠지고 Claude 몫은 접힌다');
  assert.deepEqual(a.holes, [['2026-10-20', '2026-11-10', 'agy']]);
  const r = buildMonthly([], a, { months: 3, now: NOW, viewLo: '2026-11-11' });
  assert.equal(r.rows.find((x) => x.month === '2026-10').status, 'partial');
  assert.equal(r.rows.find((x) => x.month === '2026-11').status, 'partial');
  // 이미 접은 날 위로 다시 접을 때 holes 는 새로 접는 날(through 다음 날부터)만 적는다.
  file = tmpFile();
  m.foldArchive([claude], { lo: '2026-10-01', hi: '2026-11-05', now: NOW, file });
  m.foldArchive([claude, agy('2026-10-20')], { lo: '2026-10-01', hi: '2026-11-10', now: NOW, file });
  assert.deepEqual(m.readArchive(file).archive.holes, [['2026-11-06', '2026-11-10', 'agy']]);
});

test('3월 말에 마지막으로 다 읽고 그 뒤 계속 실패하는 agy 기록: 첫 1년치 접기에 그 앞 몫은 들어가고 1·2월은 complete', () => {
  const file = tmpFile();
  const months = {};
  for (let d = '2025-12-01'; d <= '2026-11-12'; d = m.addDays(d, 1)) months[d] = day(1_000);
  const agy = { tool: 'agy', project: '/work/g', days: { '2026-01-10': day(5, 'gemini-4-argon'), '2026-02-10': day(6, 'gemini-4-argon'), '2026-03-10': day(7, 'gemini-4-argon') }, staleFrom: '2026-03-31' };
  assert.equal(m.foldArchive([book(months), agy], { lo: m.keepFrom(NOW), hi: '2026-11-10', now: NOW, gap: 'hole', backfilled: true, file }), 'folded');
  const a = m.readArchive(file).archive;
  const agyIn = (k) => a.months[k].filter((e) => e.t === 'agy').reduce((s, e) => s + e.n, 0);
  assert.deepEqual([agyIn('2026-01'), agyIn('2026-02'), agyIn('2026-03')], [5, 6, 7]);
  assert.deepEqual(a.holes, [['2026-03-31', '2026-11-10', 'agy']]);
  const r = buildMonthly([], a, { months: 12, now: NOW, viewLo: '2026-11-11' });
  const st = (k) => r.rows.find((x) => x.month === k).status;
  assert.deepEqual([st('2025-12'), st('2026-01'), st('2026-02')], ['complete', 'complete', 'complete']);
  assert.equal(st('2026-03'), 'partial', '3월 31일은 마지막으로 다 읽은 날이라 그 뒤 몫이 빠졌을 수 있다');
  assert.equal(st('2026-06'), 'partial');
});

test('12개월보다 오래된 달은 버린다', () => {
  const a = m.emptyArchive();
  const old = { '2025-10-15': day(1), '2025-11-30': day(1), '2025-12-01': day(5), '2026-01-10': day(7) };
  m.foldInto(a, [book(old)], { lo: '2025-10-01', hi: '2026-01-31', now: NOW });
  assert.deepEqual(Object.keys(a.months).sort(), ['2025-12', '2026-01']);
  assert.equal(a.since, '2025-12-01');
  // 1년 뒤에는 2026-01 도 빠진다.
  const later = Date.parse('2027-01-05T12:00:00+09:00');
  m.foldInto(a, [book({ '2027-01-02': day(3) })], { lo: '2026-02-01', hi: '2027-01-03', now: later });
  assert.ok(!a.months['2025-12'] && !a.months['2026-01']);
  assert.equal(a.since, '2026-02-01');
});

test('깨진 보관함은 옆으로 옮기고 빈 보관함으로 시작한다. 더 새 형식은 건드리지 않는다', () => {
  const file = tmpFile();
  writeFileSync(file, '{"v":1,"rev":');
  const r = m.readArchive(file);
  assert.equal(r.state, 'corrupt');
  assert.equal(r.archive.through, null);
  assert.ok(!existsSync(file));
  assert.equal(readdirSync(CACHE_ROOT).filter((f) => f.startsWith(`monthly-test-${n}.json.bad-`)).length, 1);
  // 모양이 틀린 것도 깨진 것으로 본다.
  writeFileSync(file, JSON.stringify({ v: 1, rev: 0, since: 'x', from: null, through: null, holes: [], months: {} }));
  assert.equal(m.readArchive(file).state, 'corrupt');
  const newer = JSON.stringify({ v: 99, anything: true });
  writeFileSync(file, newer);
  assert.equal(m.readArchive(file).state, 'newer');
  assert.equal(m.foldArchive([book(allDays)], { lo: '2026-10-01', hi: '2026-10-05', now: NOW, file }), 'newer');
  assert.equal(readFileSync(file, 'utf8'), newer);
});

test('보관함은 캐시 폴더 정리에서 지우지 않는다', () => {
  const file = join(CACHE_ROOT, 'monthly.json');
  const a = m.emptyArchive();
  m.foldInto(a, [book(allDays)], { lo: '2026-10-01', hi: '2026-10-02', now: NOW });
  assert.ok(m.writeArchive(a, m.readArchive(file).archive?.rev ?? 0, file) || existsSync(file));
  const bad = join(CACHE_ROOT, 'monthly.json.bad-1');
  writeFileSync(bad, 'x');
  const week = (Date.now() - 30 * 86400_000) / 1000;
  utimesSync(file, week, week);
  utimesSync(bad, week, week);
  // 정리는 첫 캐시 저장 때 한 번 돈다.
  fx.transcript('mmmmmmmm-0', [assistant('z0', [], usage(1, 0))]);
  collectLedger({ budget: createBudget(), fold: false });
  flushCache();
  assert.ok(existsSync(CACHE_DIR));
  assert.ok(existsSync(file) && existsSync(bad));
  rmSync(file);
  rmSync(join(fx.home, 'projects', '-work-demo', 'mmmmmmmm-0.jsonl'));
});

test('사용량 벡터로 다시 계산한 비용은 원래 비용과 같다 (fast·캐시 쓰기 1시간 포함)', () => {
  const u = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 30000, cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 500 } };
  near(vecCost('claude', OPUS, claudeVec(u), null), claudeCost(OPUS, u).total);
  near(vecCost('claude', OPUS, null, claudeVec(u)), claudeCost(OPUS, { ...u, speed: 'fast' }).total);
  near(vecCost('codex', 'gpt-5.5', [1e6, 1e6, 1e6, 0, 0]), 5 + 30 + 0.5);
  assert.equal(vecCost('claude', 'nope-1', [1, 0, 0, 0, 0]), null);
});

test('가격표가 바뀌었으면 읽을 때 벡터로 지금 가격을 다시 매긴다', () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({ v: 1, rev: 3, price: 'oldtag00', since: '2026-10-01', from: '2026-10-01', through: '2026-10-31', backfilled: null, holes: [], months: { '2026-10': [{ t: 'claude', m: OPUS, p: null, n: 1e6, c: 999, u: [1e6, 0, 0, 0, 0] }, { t: 'claude', m: 'gone-model', p: null, n: 5, c: 7 }] } }));
  const a = m.readArchive(file).archive;
  assert.equal(a.price, PRICE_TAG);
  assert.equal(a.months['2026-10'][0].c, 4, '지금 가격 $4/M');
  assert.equal(a.months['2026-10'][1].c, 7, '벡터가 없으면 그대로');
});

test('달별 표: 최근 달이 위, 이번 달 *, 일부 ~, 기록 없음, 합계 = 줄의 합 (ko/en)', () => {
  const a = m.emptyArchive();
  m.foldInto(a, [book(allDays), book({ '2026-10-03': day(2_000_000, 'gpt-5.5') }, '/work/b', 'codex')], { lo: '2026-10-01', hi: '2026-11-10', complete: '2026-10-03', now: NOW });
  const live = [book({ '2026-11-11': day(1_000_000), '2026-11-12': day(1_000_000), '2026-11-09': day(50_000_000) })];
  const r = buildMonthly(live, a, { by: 'tool', months: 3, now: NOW, viewLo: '2026-10-14' });
  assert.deepEqual(r.rows.map((x) => [x.month, x.status, x.current]), [['2026-11', 'complete', true], ['2026-10', 'partial', false], ['2026-09', 'missing', false]]);
  assert.equal(r.rows[0].tokens, 12_000_000, '11월 9일 장부 값(50M)은 보관함에 있는 날이라 쓰지 않는다');
  assert.equal(r.total.tokens, r.rows.reduce((s, x) => s + x.tokens, 0));
  assert.deepEqual(r.columns, ['claude', 'codex']);
  setLang('en');
  const en = formatReport(r);
  setLang('ko');
  const ko = formatReport(r);
  assert.match(en, /^Monthly usage, last 3 months \(2026-09 to 2026-11\), by tool, API list price/);
  assert.match(en, /^Month +claude +codex +Total$/m);
  assert.match(en, /^2026-11 \* /m);
  assert.match(en, /^2026-10 ~ /m);
  assert.match(en, /^2026-09 +no data$/m);
  assert.match(en, /^\* this month/m);
  assert.doesNotMatch(en, /[가-힣]/);
  assert.match(ko, /^달별 사용량 · 최근 3달/);
  assert.match(ko, /^달 +claude +codex +합계$/m);
  assert.match(ko, /^2026-09 +기록 없음$/m);
  const j = reportJson(r, '0.0.0');
  assert.deepEqual(Object.keys(j).slice(0, 5), ['version', 'report', 'by', 'months', 'from']);
  assert.deepEqual(Object.keys(j.rows[0]).slice(0, 3), ['month', 'current', 'status']);
  assert.equal(j.total.tokens, j.rows.reduce((s, x) => s + x.tokens, 0));
});

test('--by project 는 보관한 달도 프로젝트 이름으로 나누고, 좁은 폭에서는 (그 외) 로 접는다', () => {
  const a = m.emptyArchive();
  const projects = ['/w/alpha', '/w/beta', '/x/beta', '/w/gamma', '/w/delta'];
  m.foldInto(a, projects.map((p, i) => book({ '2026-10-05': day((i + 1) * 1_000_000) }, p)), { lo: '2026-10-01', hi: '2026-11-10', now: NOW });
  const live = [book({ '2026-11-12': day(1_000_000) }, '/w/alpha'), book({ '2026-11-12': day(1_000_000) }, null)];
  const r = buildMonthly(live, a, { by: 'project', months: 2, now: NOW, viewLo: '2026-10-14' });
  assert.ok(r.columns.includes('w/beta') && r.columns.includes('x/beta'), '겹치는 이름은 앞 폴더를 붙인다');
  assert.ok(r.columns.includes('(unknown)'));
  assert.equal(r.paths.alpha, '/w/alpha');
  assert.equal(r.rows[0].items.alpha.tokens, 1_000_000);
  assert.equal(r.rows[1].items.alpha.tokens, 1_000_000);
  const f = fitReport(r, 70);
  assert.ok(f.columns.at(-1) === OTHERS && f.columns.length < r.columns.length);
  assert.equal(f.total.tokens, r.total.tokens);
  for (const line of formatReport(f).split('\n').slice(2, -4)) assert.ok(line.length <= 70, line);
});

test('옵션: --months 는 12달까지, --days 와 --months 는 각자 종류와만 쓴다', () => {
  assert.deepEqual(reportOption(['--report', 'monthly']).months, 12);
  const r = reportOption(['--report=monthly', '--months', '20', '--by', 'model']);
  assert.equal(r.months, 12);
  assert.equal(r.capped, true);
  assert.equal(r.error, null);
  assert.equal(reportOption(['--report', 'monthly', '--months=3']).months, 3);
  assert.match(reportOption(['--report', 'monthly', '--days', '3']).error, /--days/);
  assert.match(reportOption(['--report', 'daily', '--months', '3']).error, /--months/);
  assert.match(reportOption(['--report', 'monthly', '--months', '0']).error, /--months/);
  assert.match(reportOption(['--months', '3']).error, /--report/);
});

// 실제 기록: 오늘·사흘 전·40일 전·50일 전, 그리고 120일 전에 시작해 오늘까지 이어 쓴 기록 하나.
// 평소 화면이 지난 날을 접고, 리포트가 1년치를 채운다.
const now = Date.now();
const ago = (d) => new Date(now - d * 86400_000).toISOString();
const recent = fx.transcript('mmmmmmmm-1', [
  { ...assistant('x1', [], usage(1_000_000, 0), OPUS), timestamp: ago(3) },
  { ...assistant('x2', [], usage(2_000_000, 0), OPUS), timestamp: ago(0) },
]);
const old = fx.transcript('mmmmmmmm-2', [{ ...assistant('x3', [], usage(4_000_000, 0), OPUS), timestamp: ago(40) }], '-work-old');
utimesSync(old, (now - 40 * 86400_000) / 1000, (now - 40 * 86400_000) / 1000);
const older = fx.transcript('mmmmmmmm-3', [{ ...assistant('x5', [], usage(8_000_000, 0), OPUS), timestamp: ago(50) }], '-work-older');
utimesSync(older, (now - 50 * 86400_000) / 1000, (now - 50 * 86400_000) / 1000);
const long = fx.transcript('mmmmmmmm-5', [
  { ...assistant('x6', [], usage(16_000_000, 0), OPUS), timestamp: ago(120) },
  { ...assistant('x7', [], usage(0, 0), OPUS), timestamp: ago(0) },
], '-work-long');
const ARCHIVE = join(CACHE_ROOT, 'monthly.json');
const tokensIn = (a) => Object.values(a.months).flat().reduce((s, e) => s + e.n, 0);

test('평소 화면(collectLedger)은 다 읽었을 때 그제까지를 한 번만 접고, 장부를 다시 세도 더하지 않는다', () => {
  rmSync(ARCHIVE, { force: true });
  ledgerTest.resetFold();
  collectLedger({ budget: createBudget(), now });
  let a = m.readArchive().archive;
  assert.equal(a.through, m.foldHi(now));
  assert.equal(a.since, dayKey(now - 6 * 86400_000));
  assert.equal(tokensIn(a), 1_000_000, '사흘 전 1M 만 (오늘 것은 아직)');
  assert.equal(a.months[dayKey(now - 3 * 86400_000).slice(0, 7)][0].p, '-work-demo', '프로젝트도 접는다');
  // 같은 날 다시: 파일만 읽고 끝난다.
  const before = statSync(ARCHIVE).mtimeMs;
  collectLedger({ budget: createBudget(), now });
  assert.equal(statSync(ARCHIVE).mtimeMs, before);
  // 캐시를 지우고(버전·가격 변경) 다시 세도 같은 값.
  flushCache();
  rmSync(CACHE_DIR, { recursive: true, force: true });
  ledgerTest.resetFold();
  collectLedger({ budget: createBudget(), now });
  a = m.readArchive().archive;
  assert.equal(tokensIn(a), 1_000_000);
  assert.equal(a.rev, 1);
  // 덜 읽었으면(한도 소진) 접지 않는다.
  rmSync(ARCHIVE);
  ledgerTest.resetFold();
  // 새 줄(토큰 0)이 붙어 읽을 것이 남은 상태에서 한도가 0 이면 덜 읽는다.
  fx.append(recent, [{ ...assistant('x4', [], usage(0, 0), OPUS), timestamp: ago(0) }]);
  const b = createBudget(0, Infinity);
  collectLedger({ budget: b, now });
  assert.ok(b.exhausted);
  assert.ok(!existsSync(ARCHIVE));
});

test('리포트는 처음에 1년치를 읽어 채우고(시간 상한이면 접지 않는다), 다음부터는 30일 창만 읽는다', async () => {
  rmSync(ARCHIVE, { force: true });
  rmSync(CACHE_DIR, { recursive: true, force: true });
  // 한 번에 읽는 시간 0: 기록 하나를 읽으면 멈추고, 시간 상한(1ms)을 넘었으니 덜 읽은 채로 낸다.
  const capped = await collectMonthly({ maxMs: 1, now, stepMs: 0 });
  assert.equal(capped.partial, true);
  assert.ok(!existsSync(ARCHIVE), '시간 상한에 걸리면 접지 않는다');
  // 덜 읽은 표에서는 장부 쪽 날을 센 날로 치지 않아 어떤 달도 complete 가 아니다.
  const cr = buildMonthly(capped.books, capped.archive, { months: 12, now, viewLo: capped.viewLo, liveLo: capped.liveLo, partial: true });
  assert.ok(cr.rows.every((x) => x.status !== 'complete'), cr.rows.map((x) => x.status).join(','));
  const got = await collectMonthly({ now });
  assert.equal(got.partial, false);
  const a = got.archive;
  assert.ok(a.backfilled);
  assert.equal(a.since, m.keepFrom(now));
  // 경계는 남은 Claude 기록의 가장 오래된 수정 시각(50일 전)의 다음 날이다. 120일 전에 시작해 이어 쓴 기록의 날짜가 아니다.
  assert.equal(a.from, m.addDays(dayKey(now - 50 * 86400_000), 1));
  assert.equal(tokensIn(a), 29_000_000, '120일 전 16M + 50일 전 8M + 40일 전 4M + 사흘 전 1M');
  const r = buildMonthly(got.books, a, { months: 12, now, viewLo: got.viewLo, liveLo: got.liveLo });
  assert.equal(r.total.tokens, 31_000_000);
  assert.equal(r.rows.at(-1).status, 'missing');
  const longMonth = r.rows.find((x) => x.month === dayKey(now - 120 * 86400_000).slice(0, 7));
  assert.equal(longMonth.status, 'partial', '지워졌을 수 있는 달은 값이 있어도 일부(~)');
  assert.equal(longMonth.items.claude.tokens, 16_000_000);
  // 두 번째: 30일 창만, 값은 같다.
  const again = await collectMonthly({ now });
  assert.equal(again.viewLo, dayKey(now - 29 * 86400_000));
  assert.equal(buildMonthly(again.books, again.archive, { months: 12, now, viewLo: again.viewLo, liveLo: again.liveLo }).total.tokens, 31_000_000);
  assert.equal(again.archive.rev, a.rev, '접을 날이 없으면 쓰지 않는다');
});
