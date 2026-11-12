// 기간 리포트 (--report daily, #128): 장부의 날짜별·모델별 몫, 월 경계, 도구별·모델별 표, 합계, 옵션 해석.
// 날짜 키가 시간대를 따르므로 TZ 를 고정한다. 기록 시각은 고정한 NOW 기준이라 오늘 날짜와 상관없이 같은 표가 나온다.
process.env.TZ = 'Asia/Seoul';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeClaudeHome, assistant, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const root = mkdtempSync(join(tmpdir(), 'aitop-report-'));
process.env.CODEX_HOME = join(root, 'codex');
const { collectDaily } = await import('../src/sources/claude-ledger.mjs');
const { buildReport, formatReport, reportJson, reportOption, collectReport, MAX_DAYS } = await import('../src/report.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { setLang } = await import('../src/i18n.mjs');

// 11월 2일 낮. 30일 창은 10월 4일부터이고, 10월 31일 → 11월 1일 월 경계가 들어 있다.
const NOW = Date.parse('2026-11-02T12:00:00+09:00');
const at = (iso, row) => ({ ...row, timestamp: new Date(iso).toISOString() });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

// Claude: 월 경계 앞뒤로 opus·sonnet. 같은 메시지가 두 줄이어도 한 번만 센다.
fx.transcript('rrrrrrrr-1', [
  at('2026-10-31T23:50:00+09:00', assistant('a1', [], usage(1_000_000, 0), OPUS)),
  at('2026-10-31T23:50:01+09:00', assistant('a1', [], usage(1_000_000, 0), OPUS)),
  at('2026-11-01T00:10:00+09:00', assistant('a2', [], usage(0, 1_000_000), SONNET)),
  at('2026-11-02T09:00:00+09:00', assistant('a3', [], usage(500_000, 0), OPUS)),
  // 30일 창보다 오래된 줄은 표에 들어가지 않는다.
  at('2026-09-20T10:00:00+09:00', assistant('a0', [], usage(9_000_000, 0), OPUS)),
]);

// Codex: 오늘(실제 날짜) 폴더에 둔 기록. 줄의 시각은 NOW 기준 11월 1일.
const d = new Date();
const dir = join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
mkdirSync(dir, { recursive: true });
const count = (iso, input, output) => ({ timestamp: new Date(iso).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, total_tokens: input + output } } } });
writeFileSync(
  join(dir, 'rollout-report-1.jsonl'),
  [{ type: 'session_meta', payload: { id: 'report-1', cwd: '/work/demo' } }, { type: 'turn_context', payload: { model: 'gpt-5.5-codex', cwd: '/work/demo' } }, count('2026-11-01T10:00:00+09:00', 200_000, 10_000)]
    .map((r) => JSON.stringify(r))
    .join('\n') + '\n',
);

const books = () => collectDaily({ budget: createBudget(), now: NOW, days: 30 }).books;

test('장부의 하루 합계에 모델별 몫이 있고, 모델 몫의 합은 하루 합계와 같다', () => {
  const b = books();
  const claude = b.filter((x) => x.tool === 'claude');
  assert.equal(claude.length, 1);
  const days = claude[0].days;
  assert.deepEqual(Object.keys(days['2026-10-31'].models), [OPUS]);
  assert.equal(days['2026-10-31'].models[OPUS].tokens, 1_000_000, '같은 메시지는 한 번만');
  assert.deepEqual(Object.keys(days['2026-11-01'].models), [SONNET]);
  for (const book of b)
    for (const day of Object.values(book.days)) {
      const ms = Object.values(day.models);
      near(ms.reduce((a, m) => a + m.cost, 0), day.cost);
      assert.equal(ms.reduce((a, m) => a + m.tokens, 0), day.tokens);
    }
  assert.ok(b.some((x) => x.tool === 'codex'), 'Codex 장부도 들어간다');
});

test('도구별 표: 최근 날짜가 위, 월 경계 양쪽 날짜, 합계 = 날짜 줄의 합', () => {
  const r = buildReport(books(), { by: 'tool', days: 30, now: NOW });
  assert.equal(r.rows.length, 30);
  assert.equal(r.to, '2026-11-02');
  assert.equal(r.from, '2026-10-04');
  assert.equal(r.rows[0].date, '2026-11-02');
  assert.deepEqual(r.columns, ['claude', 'codex']);
  const day = (k) => r.rows.find((x) => x.date === k);
  assert.equal(day('2026-10-31').items.claude.tokens, 1_000_000);
  assert.equal(day('2026-11-01').items.claude.tokens, 1_000_000);
  assert.equal(day('2026-11-01').items.codex.tokens, 210_000);
  assert.equal(day('2026-11-02').tokens, 500_000);
  assert.equal(r.total.tokens, r.rows.reduce((a, x) => a + x.tokens, 0));
  near(r.total.cost, r.rows.reduce((a, x) => a + x.cost, 0));
  for (const c of r.columns) near(r.total.items[c].cost, r.rows.reduce((a, x) => a + (x.items[c]?.cost ?? 0), 0));
  // 9월 줄(창 밖)은 빠진다.
  assert.equal(r.total.tokens, 2_710_000);
});

test('모델별 표: 열은 모델, 합계는 도구별 표와 같다', () => {
  const byTool = buildReport(books(), { by: 'tool', days: 30, now: NOW });
  const byModel = buildReport(books(), { by: 'model', days: 30, now: NOW });
  assert.deepEqual([...byModel.columns].sort(), [OPUS, SONNET, 'gpt-5.5-codex'].sort());
  assert.equal(byModel.total.tokens, byTool.total.tokens);
  near(byModel.total.cost, byTool.total.cost);
  assert.equal(byModel.total.items[OPUS].tokens, 1_500_000);
});

test('--days 는 창을 줄인다: 3일이면 월 경계 앞 10월 31일만 남는다', () => {
  const r = buildReport(books(), { by: 'tool', days: 3, now: NOW });
  assert.deepEqual(r.rows.map((x) => x.date), ['2026-11-02', '2026-11-01', '2026-10-31']);
  assert.equal(r.total.tokens, 2_710_000);
  const two = buildReport(books(), { by: 'tool', days: 2, now: NOW });
  assert.equal(two.total.tokens, 1_710_000);
});

test('--json 모양: 영어 키, 값은 숫자, 합계는 표와 같다', () => {
  const r = buildReport(books(), { by: 'model', days: 30, now: NOW });
  const j = reportJson(r, '0.0.0');
  assert.deepEqual(Object.keys(j), ['version', 'report', 'by', 'days', 'from', 'to', 'basis', 'partial', 'unpriced', 'columns', 'rows', 'total']);
  assert.equal(j.rows.length, 30);
  for (const row of [...j.rows, j.total]) {
    assert.equal(typeof row.tokens, 'number');
    assert.equal(typeof row.cost, 'number');
    for (const c of j.columns) assert.equal(typeof row.items[c].cost, 'number');
  }
  assert.equal(j.total.tokens, j.rows.reduce((a, x) => a + x.tokens, 0));
  near(j.total.cost, j.rows.reduce((a, x) => a + x.cost, 0));
});

test('표 문구: ko 와 en', () => {
  const r = buildReport(books(), { by: 'tool', days: 3, now: NOW });
  setLang('en');
  const en = formatReport(r);
  setLang('ko');
  const ko = formatReport(r);
  assert.match(en, /^Daily usage, last 3 days \(2026-10-31 to 2026-11-02\), by tool, API list price/);
  assert.match(en, /^Date +claude +codex +Total$/m);
  assert.match(en, /^Total +/m);
  assert.doesNotMatch(en, /[가-힣]/);
  assert.match(ko, /^날짜별 사용량 · 최근 3일/);
  assert.match(ko, /^날짜 +claude +codex +합계$/m);
  // 날짜 줄: 최근 날짜가 위.
  const lines = en.split('\n');
  assert.ok(lines.findIndex((l) => l.startsWith('2026-11-02')) < lines.findIndex((l) => l.startsWith('2026-10-31')));
});

test('빈 장부는 열 없이 빈 기간 안내를 낸다', () => {
  setLang('en');
  const out = formatReport(buildReport([], { days: 2, now: NOW }));
  setLang('ko');
  assert.match(out, /No usage recorded in this period/);
});

test('collectReport 는 시간 상한 안에 다 읽고 partial 이 아니다', async () => {
  const seen = [];
  const got = await collectReport({ days: 30, now: NOW, onProgress: (p) => seen.push(p) });
  assert.equal(got.partial, false);
  assert.ok(got.books.length >= 2);
});

test('옵션: 두 모양, 기본값, 30일 상한, 잘못된 값, --report 없는 --by', () => {
  const a = reportOption(['--report', 'daily', '--json']);
  assert.deepEqual([a.kind, a.by, a.days, a.rest], ['daily', 'tool', 30, ['--json']]);
  const b = reportOption(['--report=daily', '--by=model', '--days=7']);
  assert.deepEqual([b.kind, b.by, b.days, b.error], ['daily', 'model', 7, null]);
  const c = reportOption(['--report', 'daily', '--days', '90']);
  assert.equal(c.days, MAX_DAYS);
  assert.equal(c.capped, true);
  assert.ok(reportOption(['--report', 'weekly']).error);
  assert.ok(reportOption(['--report']).error);
  assert.ok(reportOption(['--report', 'daily', '--by', 'repo']).error);
  assert.equal(reportOption(['--report', 'daily', '--by', 'project']).by, 'project');
  assert.ok(reportOption(['--report', 'daily', '--days', '0']).error);
  assert.ok(reportOption(['--by', 'model']).error);
  assert.equal(reportOption(['--once']).kind, null);
});

test('가격표에 없는 모델이 낀 칸은 비용 뒤에 ? 를 붙이고, --json 은 칸마다 unpriced 를 둔다', () => {
  const day = (models) => ({
    tokens: Object.values(models).reduce((a, m) => a + m.tokens, 0),
    cost: Object.values(models).reduce((a, m) => a + m.cost, 0),
    unknown: Object.values(models).some((m) => m.unknown),
    models,
  });
  const b = [
    { tool: 'claude', days: { '2026-11-02': day({ [OPUS]: { tokens: 1_000, cost: 12.3 } }) } },
    { tool: 'codex', days: { '2026-11-01': day({ 'mystery-1': { tokens: 2_000, cost: 0, unknown: true }, 'gpt-x': { tokens: 1_000, cost: 1 } }) } },
  ];
  setLang('en');
  const byTool = formatReport(buildReport(b, { by: 'tool', days: 2, now: NOW }));
  const byModel = formatReport(buildReport(b, { by: 'model', days: 2, now: NOW }));
  setLang('ko');
  const line = (out, start) => out.split('\n').find((l) => l.startsWith(start));
  assert.match(line(byTool, '2026-11-02'), /1\.0k \$12\.30 +- +1\.0k \$12\.30$/, '가격을 아는 칸에는 ? 가 없다');
  assert.match(line(byTool, '2026-11-01'), /3\.0k \$1\.00\? +3\.0k \$1\.00\?$/);
  assert.match(line(byTool, 'Total'), /\$1\.00\? +[\d.]+k \$13\.30\?$/);
  assert.match(line(byModel, 'Total'), /2\.0k \$0\.00\?/);
  assert.doesNotMatch(line(byModel, 'Total'), /1\.0k \$1\.00\?/, 'gpt-x 칸에는 ? 가 없다');
  const j = reportJson(buildReport(b, { by: 'model', days: 2, now: NOW }), '0.0.0');
  assert.equal(j.total.items['mystery-1'].unpriced, true);
  assert.equal(j.total.items['gpt-x'].unpriced, false);
  assert.equal(j.total.unpriced, true);
  assert.equal(j.rows[0].unpriced, false);
  assert.equal(typeof j.total.items['mystery-1'].cost, 'number');
});
