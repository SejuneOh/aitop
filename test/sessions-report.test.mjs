// 세션 리포트 (--report sessions, #215): --since 해석, 옵션 오류, 세션 묶기(서브에이전트·agy 부모), 정렬, 기간 안 시작·끝,
// 고친 파일 수, 세션 이름 순서, 요약 카드(도구별 비중, --plan), 표·Markdown·JSON 모양, 첫 지시는 --show-prompts 일 때만,
// 기다린 시간 추정 (#243: 에이전트 응답 뒤 사용자 입력까지, 간격당 2시간 상한, 날짜 경계, 서브에이전트 제외).
process.env.TZ = 'Asia/Seoul';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';
import { loadSqlite } from '../src/sqlite.mjs';

const fx = makeClaudeHome();
const root = mkdtempSync(join(tmpdir(), 'aitop-sessions-'));
process.env.CODEX_HOME = join(root, 'codex');
const { reportOption, parseSince } = await import('../src/report.mjs');
const { KEEP_DAYS } = await import('../src/sources/common.mjs');
const { buildSessions, collectSessions, formatSessions, sessionsMarkdown, sessionsJson, mdCell, claudeSession } = await import('../src/sessions-report.mjs');
const { SessionSheet, WAIT_CAP_MS } = await import('../src/sources/sheets.mjs');
const { setLang } = await import('../src/i18n.mjs');

const NOW = Date.parse('2026-11-16T14:30:00+09:00');
const ms = (iso) => Date.parse(iso);

test('--since: yesterday·today·Nd·YYYY-MM-DD 는 로컬 0시, 30일 넘게 앞이면 줄이고, 잘못된 값·미래 날짜는 오류', () => {
  assert.equal(parseSince('yesterday', NOW).from, ms('2026-11-15T00:00:00+09:00'));
  assert.equal(parseSince('today', NOW).from, ms('2026-11-16T00:00:00+09:00'));
  assert.equal(parseSince('7d', NOW).from, ms('2026-11-09T00:00:00+09:00'));
  assert.equal(parseSince('2026-11-10', NOW).from, ms('2026-11-10T00:00:00+09:00'));
  const cap = parseSince('90d', NOW);
  assert.equal(cap.capped, true);
  assert.equal(cap.back, KEEP_DAYS);
  assert.equal(parseSince('2026-01-01', NOW).capped, true);
  for (const bad of ['', 'week', '-3d', '2026-02-30', '2026-11-17']) assert.ok(parseSince(bad, NOW).error, bad);
  assert.match(parseSince('2026-11-17', NOW).error, /오늘보다 뒤/);
});

test('옵션: sessions 는 --since·--plan·--md·--show-prompts 를 받고, 다른 리포트와 섞으면 오류', () => {
  const r = reportOption(['--report', 'sessions', '--since', '7d', '--plan', '200', '--md', '--show-prompts', '--json'], NOW);
  assert.equal(r.error, null);
  assert.equal(r.kind, 'sessions');
  assert.equal(r.since, ms('2026-11-09T00:00:00+09:00'));
  assert.equal(r.plan, 200);
  assert.equal(r.md, true);
  assert.equal(r.prompts, true);
  assert.deepEqual(r.rest, ['--json']);
  // 기본은 어제 0시부터.
  assert.equal(reportOption(['--report=sessions'], NOW).since, ms('2026-11-15T00:00:00+09:00'));
  assert.match(reportOption(['--report', 'sessions', '--since', 'soon'], NOW).error, /--since 값 "soon"/);
  assert.match(reportOption(['--report', 'sessions', '--since'], NOW).error, /--since 값이 없습니다/);
  assert.match(reportOption(['--report', 'sessions', '--plan', 'abc'], NOW).error, /--plan/);
  assert.match(reportOption(['--report', 'daily', '--md'], NOW).error, /--md 는 --report sessions/);
  assert.match(reportOption(['--since', '7d'], NOW).error, /--since 는 --report sessions/);
  assert.match(reportOption(['--report', 'sessions', '--days', '3'], NOW).error, /--days 는 --report sessions 와 함께 쓸 수 없다/);
  assert.match(reportOption(['--report', 'sessions', '--by', 'model'], NOW).error, /--by/);
  assert.equal(reportOption(['--report', 'sessions', '--since', '45d'], NOW).capped, true);
  // daily·monthly 는 그대로.
  assert.equal(reportOption(['--report', 'daily', '--by', 'model', '--days', '3'], NOW).error, null);
  assert.ok(reportOption(['--report', 'monthly', '--by', 'model', '--days', '3'], NOW).error);
});

test('Claude 기록 경로: 서브에이전트는 부모 세션 id 와 부모 기록', () => {
  // 경로는 OS 구분자로 만든다 (Windows 에서는 \\).
  const main = join('/c', 'projects', '-w', 'abc.jsonl');
  assert.deepEqual(claudeSession(main), { sid: 'abc', main, sub: false });
  assert.deepEqual(claudeSession(join('/c', 'projects', '-w', 'abc', 'subagents', 'agent-1.jsonl')), { sid: 'abc', main, sub: true });
});

// 장부 하루 몫.
const day = (tokens, cost, model = 'claude-opus-5-5', extra = {}) => ({ tokens, cost, costNoCache: 0, unknown: false, models: { [model]: { tokens, cost } }, ...extra });
const SINCE = ms('2026-11-15T00:00:00+09:00');

function sample() {
  const books = [
    // Claude 세션 A: 메인 + 서브에이전트(다른 모델). 기간 밖(11-14) 사용량은 빠진다.
    { tool: 'claude', path: '/c/projects/-w/aaa.jsonl', project: '/work/app', days: { '2026-11-14': day(9e6, 90), '2026-11-15': day(1e6, 5) } },
    { tool: 'claude', path: '/c/projects/-w/aaa/subagents/agent-x.jsonl', project: '/work/app', days: { '2026-11-16': day(5e5, 1, 'claude-sonnet-5-5') } },
    // Claude 세션 B: 비용이 더 크다. 이름 없음 → 폴더 이름.
    { tool: 'claude', path: '/c/projects/-w/bbb.jsonl', project: '/work/web', days: { '2026-11-16': day(2e6, 20) } },
    // 기간 밖에만 쓴 세션은 없다.
    { tool: 'claude', path: '/c/projects/-w/old.jsonl', project: '/work/web', days: { '2026-11-10': day(1e6, 3) } },
    // Codex: 가격표에 없는 모델.
    { tool: 'codex', path: '/x/sessions/2026/11/16/rollout-1.jsonl', project: null, days: { '2026-11-16': { tokens: 1000, cost: 0, unknown: true, models: { 'gpt-x': { tokens: 1000, cost: 0, unknown: true } } } } },
    // agy: 서브에이전트 대화 g2 는 부모 g1 에 묶인다. 시각은 장부의 a·z.
    { tool: 'agy', path: '/a/conversations/g1.db', project: '/work/agy', days: { '2026-11-16': day(100, 2, 'gemini-3-pro', { a: ms('2026-11-16T09:00:00+09:00'), z: ms('2026-11-16T09:30:00+09:00') }) } },
    { tool: 'agy', path: '/a/conversations/g2.db', project: '/work/agy', days: { '2026-11-16': day(50, 1, 'gemini-3-pro', { a: ms('2026-11-16T10:00:00+09:00'), z: ms('2026-11-16T10:05:00+09:00') }) } },
  ];
  const extra = new Map([
    [
      '/c/projects/-w/aaa.jsonl',
      {
        custom: '리포트 | 작업',
        title: 'AI 제목',
        days: {
          '2026-11-14': { a: ms('2026-11-14T08:00:00+09:00'), z: ms('2026-11-14T09:00:00+09:00'), f: ['/work/app/old.mjs'], p: '지난 지시', w: 999_000 },
          '2026-11-15': { a: ms('2026-11-15T10:00:00+09:00'), z: ms('2026-11-15T11:00:00+09:00'), f: ['/work/app/a.mjs'], p: '비밀\n지시 sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA 입니다', w: 600_000 },
        },
      },
    ],
    // 서브에이전트 기록의 w 는 세지 않는다 (부모 세션 기준).
    ['/c/projects/-w/aaa/subagents/agent-x.jsonl', { custom: null, title: null, days: { '2026-11-16': { a: ms('2026-11-16T09:00:00+09:00'), z: ms('2026-11-16T09:10:00+09:00'), f: ['/work/app/a.mjs', '/work/app/b.mjs'], w: 5_000_000 } } }],
    ['/c/projects/-w/bbb.jsonl', { custom: null, title: null, days: { '2026-11-16': { a: ms('2026-11-16T12:00:00+09:00'), z: ms('2026-11-16T13:00:00+09:00'), f: [], w: 4_320_000 } } }],
    ['/x/sessions/2026/11/16/rollout-1.jsonl', { custom: 'codex 이름', title: null, days: { '2026-11-16': { a: ms('2026-11-16T11:00:00+09:00'), z: ms('2026-11-16T11:30:00+09:00'), f: ['/r/x.py'], w: 60_000 } } }],
  ]);
  const agy = new Map([
    ['g1', { cwd: '/work/agy', title: 'agy 대화', root: 'g1' }],
    ['g2', { cwd: '/work/agy', title: '서브', root: 'g1' }],
  ]);
  return { books, extra, agy };
}

test('세션 묶기·정렬·시작끝·파일·이름: 비용 큰 순, 기간 안 활동만, 서브에이전트는 부모 세션에', () => {
  const { books, extra, agy } = sample();
  const r = buildSessions(books, { since: SINCE, now: NOW, extra, agy });
  assert.deepEqual(
    r.sessions.map((s) => [s.tool, s.name]),
    [
      ['claude', 'web'],
      ['claude', '리포트 | 작업'],
      ['agy', 'agy 대화'],
      ['codex', 'codex 이름'],
    ],
  );
  const a = r.sessions[1];
  assert.equal(a.tokens, 1.5e6);
  assert.equal(a.cost, 6);
  assert.equal(a.model, 'claude-opus-5-5');
  assert.deepEqual(a.models, ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal(a.project, 'app');
  assert.equal(a.start, ms('2026-11-15T10:00:00+09:00'), '11-14 활동은 기간 밖');
  assert.equal(a.end, ms('2026-11-16T09:10:00+09:00'));
  assert.equal(a.files, 2, '메인과 서브에이전트가 고친 파일을 합친다 (같은 파일은 하나)');
  const g = r.sessions[2];
  assert.equal(g.cost, 3);
  assert.equal(g.start, ms('2026-11-16T09:00:00+09:00'));
  assert.equal(g.end, ms('2026-11-16T10:05:00+09:00'));
  assert.equal(g.files, null, 'agy 는 고친 파일을 모른다');
  const c = r.sessions[3];
  assert.equal(c.unpriced, true);
  assert.equal(c.project, '(unknown)');
  assert.equal(c.files, 1);
  assert.equal(r.summary.sessions, 4);
  assert.equal(r.summary.cost, 29);
  assert.equal(r.summary.unpriced, true);
  assert.deepEqual(Object.keys(r.summary.tools), ['claude', 'agy', 'codex']);
  assert.ok(Math.abs(r.summary.tools.claude.share - 26 / 29) < 1e-9);
  assert.equal(r.summary.plan, null);
  // 기다린 시간: 기간 안 날만, 부모 기록만. agy 는 모름.
  assert.equal(a.waited, 600_000, '11-14 몫과 서브에이전트 몫은 빠진다');
  assert.equal(r.sessions[0].waited, 4_320_000);
  assert.equal(g.waited, null);
  assert.equal(c.waited, 60_000);
  assert.equal(r.summary.waited, 4_980_000);
});

test('이름 순서: 사용자 이름 > 그 밖 이름(ai-title) > 폴더', () => {
  const books = [{ tool: 'claude', path: '/c/p/-w/s1.jsonl', project: '/work/demo', days: { '2026-11-16': day(10, 1) } }];
  const name = (e) => buildSessions(books, { since: SINCE, now: NOW, extra: new Map([['/c/p/-w/s1.jsonl', { days: {}, ...e }]]) }).sessions[0].name;
  assert.equal(name({ custom: '내 이름', title: 'AI' }), '내 이름');
  assert.equal(name({ custom: null, title: 'AI' }), 'AI');
  assert.equal(name({ custom: null, title: null }), 'demo');
  // 기록 요약을 못 읽었으면 파일 수는 모름.
  assert.equal(buildSessions(books, { since: SINCE, now: NOW }).sessions[0].files, null);
});

test('--plan: 구독료를 경과 일수/30 으로 나눈 몫의 몇 배', () => {
  const { books, extra, agy } = sample();
  const r = buildSessions(books, { since: SINCE, now: NOW, extra, agy, plan: 300 });
  const days = (NOW - SINCE) / 86400_000;
  assert.ok(Math.abs(r.summary.plan.prorated - (300 * days) / 30) < 1e-9);
  assert.ok(Math.abs(r.summary.plan.ratio - 29 / ((300 * days) / 30)) < 1e-9);
  setLang('ko');
  const text = formatSessions(r);
  assert.match(text, /구독료 \$300\/월의 1\.6일 몫 \$16\.04 대비 1\.8x \(API 정가 환산, 실제 청구액이 아님\)/);
});

test('표: 요약 카드, 머리글, 첫 지시는 --show-prompts 일 때만 (한 줄, 비밀값 가림, 약 60 폭)', () => {
  setLang('ko');
  const { books, extra, agy } = sample();
  const r = buildSessions(books, { since: SINCE, now: NOW, extra, agy });
  const text = formatSessions(r, { cols: 160 });
  assert.match(text, /^세션 리포트 · 2026-11-15 00:00 ~ 2026-11-16 14:30 \(1\.6일\)/);
  assert.match(text, /합계 \$29\.00 \(API 정가 환산\) · 토큰 3\.5M · 세션 4개/);
  assert.match(text, /도구별 비용 비중: claude 90% · agy 10% · codex 0%/);
  assert.match(text, /에이전트가 기다린 시간 1h23m \(추정\)/);
  assert.match(text, /^도구 +모델 +프로젝트 +세션 +시작 +끝 +기다림 +토큰 +비용 +파일$/m);
  assert.match(text, /^claude +claude-opus-5-5 \+1 +app +리포트 \| 작업 +11-15 10:00 +11-16 09:10 +10m00s +1\.5M +\$6\.00 +2$/m);
  assert.match(text, /^claude +.* web +11-16 12:00 +13:00 +1h12m +2\.0M/m);
  assert.match(text, /^agy .* 11-16 09:00 +10:05 +- .* -$/m);
  assert.match(text, /기다림은 .*추정.*자리 비움과 구분하지 못함/);
  assert.doesNotMatch(text, /지시|비밀/);
  const shown = formatSessions(r, { cols: 200, prompts: true });
  assert.match(shown, /첫 지시/);
  assert.match(shown, /비밀 지시 /);
  assert.doesNotMatch(shown, /sk-ant-api03-AAAA/);
  assert.doesNotMatch(shown, /지난 지시/, '기간 밖 날의 지시는 쓰지 않는다');
  setLang('en');
  assert.match(formatSessions(r), /^Tool +Model +Project +Session +Start +End +Waited +Tokens +Cost +Files$/m);
  assert.match(formatSessions(r), /Agents waited for you 1h23m \(estimate\)/);
  // 기다린 시간을 아는 세션이 없으면 카드 줄을 두지 않는다.
  assert.doesNotMatch(formatSessions(buildSessions(books, { since: SINCE, now: NOW })), /Agents waited/);
  // 좁은 터미널: 세션 이름 칸만 줄고 기다림 칸은 남는다.
  const narrow = formatSessions(r, { cols: 80 });
  assert.match(narrow, /^Tool +Model +Project +Session +Start +End +Waited +Tokens +Cost +Files$/m);
  assert.match(formatSessions(buildSessions([], { since: SINCE, now: NOW })), /No session used tokens in this period/);
  setLang('ko');
});

test('Markdown: 요약 줄과 표, 칸 안의 | 와 줄바꿈은 이스케이프', () => {
  setLang('ko');
  assert.equal(mdCell('a|b\nc'), 'a\\|b c');
  assert.equal(mdCell(''), '-');
  const { books, extra, agy } = sample();
  const md = sessionsMarkdown(buildSessions(books, { since: SINCE, now: NOW, extra, agy, plan: 100 }));
  const lines = md.split('\n');
  assert.match(lines[0], /^\*\*세션 리포트/);
  assert.ok(lines.some((l) => /^- 합계 \*\*\$29\.00\*\* \(API 정가 환산\)/.test(l)));
  assert.ok(lines.some((l) => /^- 구독료 .*API 정가 환산, 실제 청구액이 아님/.test(l)));
  assert.ok(lines.some((l) => /^- 에이전트가 기다린 시간 \*\*1h23m\*\* \(추정\)$/.test(l)));
  assert.ok(lines.includes('| 도구 | 모델 | 프로젝트 | 세션 | 시작 | 끝 | 기다림 | 토큰 | 비용 | 파일 |'));
  assert.ok(lines.includes('| claude | claude-opus-5-5 +1 | app | 리포트 \\| 작업 | 11-15 10:00 | 11-16 09:10 | 10m00s | 1.5M | $6.00 | 2 |'));
  // 표 줄은 모두 같은 칸 수 (이스케이프한 | 는 세지 않는다).
  const cells = (l) => l.replace(/\\\|/g, '').split('|').length;
  const rows = lines.filter((l) => l.startsWith('|'));
  assert.equal(new Set(rows.map(cells)).size, 1);
  assert.doesNotMatch(md, /지시/);
  assert.match(sessionsMarkdown(buildSessions(books, { since: SINCE, now: NOW, extra, agy }), { prompts: true }), /\| 첫 지시 \|/);
});

test('--json: 숫자는 숫자로, 시각은 ISO, 첫 지시는 --show-prompts 일 때만', () => {
  const { books, extra, agy } = sample();
  const r = buildSessions(books, { since: SINCE, now: NOW, extra, agy, plan: 200 });
  const j = sessionsJson(r, '9.9.9');
  assert.equal(j.version, '9.9.9');
  assert.equal(j.report, 'sessions');
  assert.equal(j.since, '2026-11-15');
  assert.equal(j.basis, 'api');
  assert.equal(j.partial, false);
  assert.equal(j.summary.sessions, 4);
  assert.equal(typeof j.summary.cost, 'number');
  assert.equal(j.summary.plan.monthly, 200);
  assert.equal(j.sessions[1].start, '2026-11-15T01:00:00.000Z');
  assert.equal(j.sessions[1].files, 2);
  assert.equal(j.sessions[2].files, null);
  assert.equal(j.summary.waitedMs, 4_980_000);
  assert.equal(j.sessions[1].waitedMs, 600_000);
  assert.equal(j.sessions[2].waitedMs, null);
  assert.ok(j.sessions.every((s) => !('prompt' in s)));
  const p = sessionsJson(r, '9.9.9', { prompts: true, partial: true });
  assert.equal(p.partial, true);
  assert.ok(p.sessions.every((s) => 'prompt' in s));
});

test('기록 요약(Claude): 날짜별 첫·마지막 활동, 고친 파일, 첫 지시, 마지막 /rename 이름, ai-title', () => {
  const at = (iso, row) => ({ ...row, timestamp: new Date(iso).toISOString() });
  const edit = (iso, filePath) => at(iso, { ...user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]), toolUseResult: { filePath, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] } });
  const p = fx.transcript('sheet000-1', [
    at('2026-11-15T09:00:00+09:00', user('<command-name>/clear</command-name>')),
    at('2026-11-15T09:01:00+09:00', user('첫 지시입니다')),
    at('2026-11-15T09:02:00+09:00', assistant('m1', [], usage(10, 10))),
    edit('2026-11-15T09:03:00+09:00', '/w/a.mjs'),
    edit('2026-11-15T09:04:00+09:00', '/w/a.mjs'),
    { type: 'ai-title', aiTitle: '자동 제목' },
    { type: 'custom-title', customTitle: '처음 이름' },
    { type: 'custom-title', customTitle: '나중 이름' },
    at('2026-11-16T10:00:00+09:00', user('둘째 날 지시')),
    edit('2026-11-16T10:05:00+09:00', '/w/b.mjs'),
  ]);
  const s = new SessionSheet(p, 'claude');
  s.update();
  assert.equal(s.custom, '나중 이름');
  assert.equal(s.title, '자동 제목');
  // 09:04 도구 결과 뒤 다음 날 10:00 지시: 간격이 길어 앞 2시간만 11-15 에 센다.
  assert.deepEqual(s.days['2026-11-15'], { a: ms('2026-11-15T09:00:00+09:00'), z: ms('2026-11-15T09:04:00+09:00'), f: ['/w/a.mjs'], p: '첫 지시입니다', w: WAIT_CAP_MS });
  assert.deepEqual(s.days['2026-11-16'].f, ['/w/b.mjs']);
  assert.equal(s.days['2026-11-16'].p, '둘째 날 지시');
  // 서브에이전트 기록의 지시는 세션 첫 지시로 쓰지 않는다.
  const sub = new SessionSheet(p, 'claude', { sub: true });
  sub.update();
  assert.equal(sub.days['2026-11-15'].p, undefined);
});

test('기다린 시간(Claude): 응답 뒤 지시·허락 답까지, 큐·알림·끊기·사이드체인 제외, 2시간 상한은 날짜별로 나눈다', () => {
  const at = (iso, row) => ({ ...row, timestamp: new Date(iso).toISOString() });
  const T = (hm, day = '15') => `2026-11-${day}T${hm}:00+09:00`;
  const human = (hm, text, extra = {}, day) => at(T(hm, day), { ...user(text), origin: { kind: 'human' }, ...extra });
  const reply = (hm, day) => at(T(hm, day), assistant(`m${hm}${day ?? ''}`, [], usage(1, 1)));
  const result = (hm, extra = {}) => at(T(hm), { ...user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]), ...extra });
  const rows = [
    human('10:00', '시작'),
    reply('10:01'),
    result('10:02'),
    reply('10:03'),
    // 허락 창에서 사용자가 고른 결과: 10:03 → 10:08 (5분).
    result('10:08', { permissionDecision: { decision: 'accept', source: 'user_temporary' } }),
    // 설정으로 자동 허락된 결과는 에이전트 쪽이다.
    result('10:09', { permissionDecision: { decision: 'accept', source: 'config' } }),
    // 백그라운드 작업 알림은 사람 입력이 아니다.
    at(T('10:10'), { ...user('<task-notification>끝</task-notification>'), origin: { kind: 'task-notification' } }),
    reply('10:11'),
    // 10:11 → 10:20 (9분).
    human('10:20', '다음'),
    reply('10:21'),
    // 일하는 동안 넣어 둔 지시는 기다림이 아니다.
    human('10:25', '큐', { promptSource: 'queued' }),
    reply('10:26'),
    // 끊은 때부터 다음 지시까지 (10:30 → 10:32, 2분).
    at(T('10:30'), user('[Request interrupted by user]')),
    // 예전 기록의 사이드체인 줄은 세지 않는다.
    at(T('10:31'), { ...assistant('side', [], usage(1, 1)), isSidechain: true }),
    human('10:32', '다시'),
    // 질문 도구의 답 (예전 기록이라 permissionDecision 이 없다): 10:33 → 10:36 (3분).
    reply('10:33'),
    result('10:36', { toolUseResult: { questions: [], answers: {} } }),
    // 23:00 응답, 다음 날 03:00 지시: 2시간 상한, 11-15 에 1시간, 11-16 에 1시간.
    reply('23:00'),
    human('03:00', '아침', {}, '16'),
    // 예전 기록(origin 없음)의 슬래시 명령은 사람 입력이다: 03:01 → 03:05 (4분).
    reply('03:01', '16'),
    at(T('03:05', '16'), user('<command-name>/clear</command-name>')),
  ];
  const p = fx.transcript('wait0000-1', rows);
  const s = new SessionSheet(p, 'claude');
  s.update();
  const min = 60_000;
  assert.equal(s.days['2026-11-15'].w, (5 + 9 + 2 + 3 + 60) * min);
  assert.equal(s.days['2026-11-16'].w, (60 + 4) * min);
  assert.equal(s.agentAt, null);
  // 이어 읽기: 응답 뒤에 끊긴 상태(agentAt)를 남겨 두었다가 다음 줄에서 센다.
  writeFileSync(p, [...rows, reply('04:00', '16')].map((r) => JSON.stringify(r)).join('\n') + '\n');
  s.update();
  assert.equal(s.agentAt, ms(T('04:00', '16')));
  assert.equal(s.snapshot().agentAt, ms(T('04:00', '16')));
  writeFileSync(p, [...rows, reply('04:00', '16'), human('04:30', '이어서', {}, '16')].map((r) => JSON.stringify(r)).join('\n') + '\n');
  s.update();
  assert.equal(s.days['2026-11-16'].w, (60 + 4 + 30) * min);
  // 서브에이전트 기록은 세지 않는다.
  const sub = new SessionSheet(p, 'claude', { sub: true });
  sub.update();
  assert.ok(Object.values(sub.days).every((d) => d.w == null));
});

test('기다린 시간(Codex): 에이전트 줄 뒤 user_message 까지, 사용자 메시지 줄은 에이전트 쪽이 아니고 turn_aborted 부터 다시 센다', () => {
  const p = join(root, 'rollout-wait.jsonl');
  const ts = (min) => new Date(ms('2026-11-16T10:00:00+09:00') + min * 60_000).toISOString();
  const ev = (min, payload) => ({ timestamp: ts(min), type: 'event_msg', payload });
  const item = (min, payload) => ({ timestamp: ts(min), type: 'response_item', payload });
  const rows = [
    { timestamp: ts(0), type: 'session_meta', payload: { id: 'cx-w', cwd: '/repo' } },
    item(0, { type: 'message', role: 'user', content: [] }),
    ev(0, { type: 'user_message', message: '시작' }),
    item(1, { type: 'message', role: 'assistant', content: [] }),
    ev(1, { type: 'agent_message', message: '끝냈어요' }),
    ev(2, { type: 'token_count' }),
    // 2분 → 10분 (8분). 사용자 메시지 줄이 먼저 와도 간격은 그대로.
    item(10, { type: 'message', role: 'user', content: [] }),
    ev(10, { type: 'user_message', message: '다음' }),
    item(11, { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'f1' }),
    ev(12, { type: 'turn_aborted' }),
    // 12분 → 15분 (3분).
    ev(15, { type: 'user_message', message: '다시' }),
  ];
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const s = new SessionSheet(p, 'codex');
  s.update();
  assert.equal(s.days['2026-11-16'].w, 11 * 60_000);
});

test('기록 요약(Codex): 성공한 패치의 파일만, thread_name_updated 이름, user_message 지시', () => {
  const p = join(root, 'rollout-test.jsonl');
  const ts = (min) => new Date(ms('2026-11-16T10:00:00+09:00') + min * 60_000).toISOString();
  const patch = (id, file) => ({ timestamp: ts(2), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: id, input: `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch` } });
  const out = (id, output, min) => ({ timestamp: ts(min), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output } });
  const rows = [
    { timestamp: ts(0), type: 'session_meta', payload: { id: 'cx-1', cwd: '/repo' } },
    { timestamp: ts(1), type: 'event_msg', payload: { type: 'user_message', message: '코덱스 지시' } },
    patch('c1', 'src/ok.py'),
    out('c1', JSON.stringify({ output: 'Success', metadata: { exit_code: 0 } }), 3),
    patch('c2', 'src/fail.py'),
    out('c2', JSON.stringify({ output: 'error', metadata: { exit_code: 1 } }), 4),
    { timestamp: ts(5), type: 'event_msg', payload: { type: 'thread_name_updated', thread_name: '코덱스 이름' } },
  ];
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const s = new SessionSheet(p, 'codex');
  s.update();
  assert.equal(s.id, 'cx-1');
  assert.equal(s.custom, '코덱스 이름');
  const d = s.days['2026-11-16'];
  // patch 경로는 Windows 에서 OS 구분자로 바뀐다 (0.28.0).
  assert.deepEqual(d.f, [normalize('/repo/src/ok.py')]);
  assert.equal(d.p, '코덱스 지시');
  assert.equal(d.a, ms('2026-11-16T10:01:00+09:00'));
  assert.equal(d.z, ms('2026-11-16T10:05:00+09:00'));
});

test('collectSessions: 장부와 기록 요약을 함께 읽어 세션 표를 만든다 (이름·파일·서브에이전트)', async () => {
  const now = Date.now();
  const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();
  fx.transcript('coll0000-1', [
    { ...user('수집 지시'), timestamp: iso(30) },
    { ...assistant('k1', [], usage(1000, 100)), timestamp: iso(29) },
    { ...user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]), timestamp: iso(28), toolUseResult: { filePath: '/w/x.mjs', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] } },
    { type: 'custom-title', customTitle: '수집 세션' },
  ], '-work-coll');
  fx.subagent('coll0000-1', 'z1', { agentType: 'x' }, [{ ...assistant('k2', [], usage(500, 0), 'claude-sonnet-5-5'), timestamp: iso(20) }], '-work-coll');
  const since = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime() - 86400_000;
  const got = await collectSessions({ since, now });
  assert.equal(got.partial, false);
  const r = buildSessions(got.books, { since, now, extra: got.extra, agy: got.agy });
  const s = r.sessions.find((x) => x.name === '수집 세션');
  assert.ok(s, JSON.stringify(r.sessions.map((x) => x.name)));
  assert.equal(s.tokens, 1600);
  assert.equal(s.files, 1);
  assert.deepEqual(s.models, ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal(s.prompt, '수집 지시');
  assert.equal(s.start, Date.parse(iso(30)));
  assert.equal(s.end, Date.parse(iso(20)));
});

test('데이터 폴더가 여럿이고 같은 세션 기록이 두 곳에 있으면 한 번만 센다 (#212)', async () => {
  const { setDataDirs } = await import('../src/sources/dirs.mjs');
  const home2 = join(root, 'claude2');
  const now = Date.now();
  const rows = [
    { ...user('복사된 세션'), timestamp: new Date(now - 5 * 60_000).toISOString() },
    { ...assistant('d1', [], usage(7000, 0)), timestamp: new Date(now - 4 * 60_000).toISOString() },
    { type: 'custom-title', customTitle: '복사본' },
  ];
  fx.transcript('dup00000-1', rows, '-work-dup');
  mkdirSync(join(home2, 'projects', '-work-dup'), { recursive: true });
  writeFileSync(join(home2, 'projects', '-work-dup', 'dup00000-1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  setDataDirs({ claude: [fx.home, home2] });
  try {
    // 앞 테스트와 다른 기간이라 기록 목록을 새로 만든다.
    const since = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime() - 10 * 86400_000;
    const got = await collectSessions({ since, now });
    const r = buildSessions(got.books, { since, now, extra: got.extra, agy: got.agy });
    const dup = r.sessions.filter((x) => x.name === '복사본');
    assert.equal(dup.length, 1);
    assert.equal(dup[0].tokens, 7000);
  } finally {
    setDataDirs({ claude: [fx.home] });
  }
});

test('시작을 모르는 세션(예전 agy 캐시): 표는 -, 끝은 보이고, --json 은 start null, 정렬은 비용 순 그대로', () => {
  setLang('ko');
  const books = [
    { tool: 'agy', path: '/a/conversations/o1.db', project: '/work/agy', days: { '2026-11-16': day(100, 5, 'gemini-3-pro', { z: ms('2026-11-16T11:00:00+09:00') }) } },
    { tool: 'claude', path: '/c/p/-w/s9.jsonl', project: '/work/web', days: { '2026-11-16': day(100, 1) } },
  ];
  const r = buildSessions(books, { since: SINCE, now: NOW, agy: new Map([['o1', { title: '예전 대화', root: 'o1' }]]) });
  assert.deepEqual(r.sessions.map((x) => x.tool), ['agy', 'claude']);
  assert.equal(r.sessions[0].start, null);
  assert.equal(r.sessions[0].end, ms('2026-11-16T11:00:00+09:00'));
  assert.match(formatSessions(r), /^agy .*예전 대화 +- +11-16 11:00 /m);
  const j = sessionsJson(r, 'x');
  assert.equal(j.sessions[0].start, null);
  assert.equal(j.sessions[0].end, '2026-11-16T02:00:00.000Z');
  assert.match(sessionsMarkdown(r), /\| 예전 대화 \| - \| 11-16 11:00 \|/);
});

test('Markdown 칸: 서식 글자를 이스케이프해 이름이 굵게·링크·HTML 로 바뀌지 않는다', () => {
  assert.equal(mdCell('**굵게** _기울임_ `코드`'), '\\*\\*굵게\\*\\* \\_기울임\\_ \\`코드\\`');
  assert.equal(mdCell('[링크](http://x) <b>html</b> # 제목 ~~취소~~ ![그림]'), '\\[링크\\](http://x) \\<b\\>html\\</b\\> \\# 제목 \\~\\~취소\\~\\~ \\!\\[그림\\]');
  assert.equal(mdCell('a\\b|c'), 'a\\\\b\\|c');
  const books = [{ tool: 'claude', path: '/c/p/-w/m1.jsonl', project: '/work/demo', days: { '2026-11-16': day(10, 1) } }];
  const md = sessionsMarkdown(buildSessions(books, { since: SINCE, now: NOW, extra: new Map([['/c/p/-w/m1.jsonl', { days: {}, custom: '<img src=x> [a](b) *c*' }]]) }));
  assert.ok(md.includes('| \\<img src=x\\> \\[a\\](b) \\*c\\* |'), md);
});

test('--json projectPath: 홈 아래 경로는 ~ 로', async () => {
  const { homedir } = await import('node:os');
  const books = [{ tool: 'claude', path: '/c/p/-w/h1.jsonl', project: join(homedir(), 'dev', 'app'), days: { '2026-11-16': day(10, 1) } }];
  const j = sessionsJson(buildSessions(books, { since: SINCE, now: NOW }), 'x');
  assert.equal(j.sessions[0].projectPath, join('~', 'dev', 'app'));
  assert.equal(j.sessions[0].project, 'app');
});

test('agy: 서브 대화(손자까지)는 맨 위 대화로 묶고, 이름은 맨 위 대화의 제목', { skip: !loadSqlite() && 'node:sqlite 없음' }, async () => {
  const { agyConversations } = await import('../src/sources/projects.mjs');
  const dir = join(root, 'agy-sum');
  mkdirSync(dir, { recursive: true });
  const db = new (loadSqlite().DatabaseSync)(join(dir, 'conversation_summaries.db'));
  db.exec("create table conversation_summaries (conversation_id text primary key, title text not null default '', parent_conversation_id text not null default '', workspace_uris text not null)");
  const ins = db.prepare('insert into conversation_summaries values (?, ?, ?, ?)');
  ins.run('top', '맨 위 대화', '', JSON.stringify(['file:///work/agy']));
  ins.run('kid', '서브', 'top', '[]');
  ins.run('grand', '손자', 'kid', '[]');
  ins.run('solo', '', '', '[]');
  db.close();
  const conv = agyConversations(dir);
  assert.equal(conv.get('grand').root, 'top');
  assert.equal(conv.get('kid').root, 'top');
  assert.equal(conv.get('solo').title, null);
  const book = (id, cost) => ({ tool: 'agy', path: `/a/conversations/${id}.db`, project: '/work/agy', days: { '2026-11-16': day(10, cost, 'gemini-3-pro') } });
  const r = buildSessions([book('kid', 1), book('grand', 2), book('solo', 1)], { since: SINCE, now: NOW, agy: conv });
  assert.deepEqual(
    r.sessions.map((x) => [x.name, x.cost]),
    [
      ['맨 위 대화', 3],
      ['agy', 1],
    ],
  );
});
