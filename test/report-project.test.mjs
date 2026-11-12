// 기간 리포트 --by project (#164): 기록 파일마다 프로젝트(작업 폴더)를 찾고, 짧은 이름으로 열을 만든다.
// Claude 는 기록의 cwd (없으면 폴더 이름), Codex 는 turn_context.cwd, agy 는 workspace_uris. 못 찾으면 (unknown).
process.env.TZ = 'Asia/Seoul';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeClaudeHome, assistant, usage } from './fixture.mjs';
import { loadSqlite } from '../src/sqlite.mjs';

const fx = makeClaudeHome();
const root = realpathSync(mkdtempSync(join(tmpdir(), 'aitop-report-project-')));
process.env.CODEX_HOME = join(root, 'codex');
process.env.AITOP_AGY_HOME = join(root, 'agy');
mkdirSync(join(root, 'agy', 'conversations'), { recursive: true });
const { collectDaily } = await import('../src/sources/claude-ledger.mjs');
const { attachProjects, agyWorkspaces, projectLabels, projectRoot, claudeProject, claudeFolder, codexProject } = await import('../src/sources/projects.mjs');
const { buildReport, formatReport, reportJson, fitReport, collectReport, UNKNOWN, OTHERS } = await import('../src/report.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { width } = await import('../src/text.mjs');
const { setLang } = await import('../src/i18n.mjs');

const NOW = Date.parse('2026-11-02T12:00:00+09:00');
const at = (iso, row) => ({ ...row, timestamp: new Date(iso).toISOString() });
const OPUS = 'claude-opus-5-5';
const withCwd = (cwd, row) => ({ ...row, cwd });

// Claude: 같은 마지막 이름(aitop)의 두 프로젝트, cwd 가 없는 기록(폴더 이름으로), 서브에이전트(부모와 같은 cwd).
const a1 = fx.transcript('pppppppp-1', [{ type: 'user', cwd: '/home/u/dev/aitop', message: { content: 'x' } }, at('2026-11-02T09:00:00+09:00', assistant('p1', [], usage(3_000_000, 0), OPUS))], '-home-u-dev-aitop');
const a2 = fx.transcript('pppppppp-2', [at('2026-11-01T09:00:00+09:00', withCwd('/home/u/old/aitop', assistant('p2', [], usage(1_000_000, 0), OPUS)))], '-home-u-old-aitop');
const a3 = fx.transcript('pppppppp-3', [at('2026-11-01T10:00:00+09:00', assistant('p3', [], usage(500_000, 0), OPUS))], '-srv-legacy');
const sub = fx.subagent('pppppppp-1', 'aa', {}, [at('2026-11-02T10:00:00+09:00', withCwd('/home/u/dev/aitop', assistant('p4', [], usage(200_000, 0), OPUS)))], '-home-u-dev-aitop');

// cwd 가 없는 작업 트리 기록: 폴더 이름(--claude-worktrees-<이름>)을 떼고, cwd 로 찾은 같은 저장소(a1)와 한 열로 묶인다.
const wt0 = fx.transcript('pppppppp-5', [at('2026-11-02T08:00:00+09:00', assistant('p5', [], usage(300_000, 0), OPUS))], '-home-u-dev-aitop--claude-worktrees-agent-z');

// Codex: turn_context.cwd 가 있는 기록과, cwd 가 전혀 없는 기록 (unknown).
const d = new Date();
const dir = join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
mkdirSync(dir, { recursive: true });
const count = (iso, input) => ({ timestamp: new Date(iso).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 0, total_tokens: input } } } });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const c1 = join(dir, 'rollout-proj-1.jsonl');
writeFileSync(c1, jsonl([{ type: 'session_meta', payload: { id: 'proj-1', cwd: '/meta/only' } }, { type: 'turn_context', payload: { model: 'gpt-5.5-codex', cwd: '/work/web' } }, count('2026-11-01T10:00:00+09:00', 400_000)]));
const c2 = join(dir, 'rollout-proj-2.jsonl');
writeFileSync(c2, jsonl([{ type: 'turn_context', payload: { model: 'gpt-5.5-codex' } }, count('2026-11-02T10:00:00+09:00', 100_000)]));

const books = () => attachProjects(collectDaily({ budget: createBudget(), now: NOW, days: 30 }).books);

test('Claude: 기록의 cwd, 없으면 projects/ 아래 폴더 이름. 서브에이전트도 cwd 로', () => {
  assert.equal(claudeProject(a1), '/home/u/dev/aitop');
  assert.equal(claudeProject(a2), '/home/u/old/aitop');
  assert.equal(claudeProject(a3), null);
  assert.equal(claudeFolder(a3), '-srv-legacy');
  assert.equal(claudeProject(sub), '/home/u/dev/aitop');
  assert.equal(claudeFolder(wt0), '-home-u-dev-aitop');
  const got = attachProjects([a3, wt0, a1].map((path) => ({ tool: 'claude', path, days: {} }))).map((b) => b.project);
  assert.deepEqual(got, ['-srv-legacy', '/home/u/dev/aitop', '/home/u/dev/aitop'], '폴더 이름이 cwd 로 찾은 경로와 같으면 그 경로로');
});

test('한 폴더 이름에 서로 다른 cwd 가 둘 이상이면 묶지 않고 폴더 이름 그대로', () => {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-amb-b-c');
  mkdirSync(dir, { recursive: true });
  const nocwd = join(dir, 'x.jsonl');
  writeFileSync(nocwd, jsonl([{ type: 'user' }]));
  let n = 0;
  const c = (cwd) => {
    const p = join(root, `amb-${n++}.jsonl`);
    writeFileSync(p, jsonl([{ type: 'user', cwd }]));
    return { tool: 'claude', path: p, days: {} };
  };
  const one = attachProjects([{ tool: 'claude', path: nocwd, days: {} }, c('/amb/b-c')]);
  assert.equal(one[0].project, '/amb/b-c', '하나뿐이면 묶는다');
  const two = attachProjects([{ tool: 'claude', path: nocwd, days: {} }, c('/amb/b-c'), c('/amb/b/c')]);
  assert.equal(two[0].project, '-amb-b-c');
});

test('Codex: turn_context.cwd 가 session_meta.cwd 보다 앞서고, 둘 다 없으면 null', () => {
  assert.equal(codexProject(c1), '/work/web');
  assert.equal(codexProject(c2), null);
  const meta = join(root, 'meta.jsonl');
  writeFileSync(meta, jsonl([{ type: 'session_meta', payload: { cwd: '/meta/only' } }]));
  assert.equal(codexProject(meta), '/meta/only');
});

test('agy: workspace_uris, 서브에이전트는 부모 대화의 작업 폴더, 없으면 null', { skip: !loadSqlite() && 'node:sqlite 없음' }, () => {
  const db = new (loadSqlite().DatabaseSync)(join(root, 'agy', 'conversation_summaries.db'));
  db.exec("create table conversation_summaries (conversation_id text primary key, parent_conversation_id text not null default '', workspace_uris text not null)");
  const ins = db.prepare('insert into conversation_summaries values (?, ?, ?)');
  // workspace_uris 는 그 OS 의 file: 주소다 (Windows 는 file:///C:/…).
  const WIN = process.platform === 'win32';
  const app = WIN ? 'C:\\work\\agy-app' : '/work/agy-app';
  ins.run('g1', '', JSON.stringify([WIN ? 'file:///C:/work/agy-app' : 'file:///work/agy-app']));
  ins.run('g2', 'g1', '[]');
  ins.run('g3', '', '[]');
  db.close();
  const ws = agyWorkspaces();
  assert.equal(ws.get('g1'), app);
  assert.equal(ws.get('g2'), app);
  assert.equal(ws.get('g3'), null);
  const conv = (id) => ({ tool: 'agy', path: join(root, 'agy', 'conversations', `${id}.db`), days: {} });
  assert.deepEqual(attachProjects([conv('g2'), conv('g3'), conv('nope')]).map((b) => b.project), [app, null, null]);
});

test('짧은 이름: 마지막 폴더 이름, 겹치면 앞 폴더를 붙인다', () => {
  const l = projectLabels(['/home/u/dev/aitop', '/home/u/old/aitop', '/work/web', '-srv-legacy', 'C:\\src\\tool']);
  assert.deepEqual(Object.fromEntries(l), { '/home/u/dev/aitop': 'dev/aitop', '/home/u/old/aitop': 'old/aitop', '/work/web': 'web', '-srv-legacy': '-srv-legacy', 'C:\\src\\tool': 'tool' });
  assert.deepEqual(Object.fromEntries(projectLabels(['/a/x', '/b/a/x'])), { '/a/x': 'a/x', '/b/a/x': 'b/a/x' });
});

test('Claude Code 작업 트리(.claude/worktrees/<이름>) 는 저장소로 합친다', () => {
  assert.equal(projectRoot('/home/u/dev/aitop/.claude/worktrees/agent-1'), '/home/u/dev/aitop');
  assert.equal(projectRoot('/home/u/dev/aitop/.claude/worktrees/agent-1/src'), '/home/u/dev/aitop');
  assert.equal(projectRoot('C:\\src\\app\\.claude\\worktrees\\x'), 'C:\\src\\app');
  assert.equal(projectRoot('/home/u/dev/aitop/.claude'), '/home/u/dev/aitop/.claude');
  assert.equal(projectRoot(null), null);
  // 장부가 읽는 projects/ 밖에 두어 다른 테스트의 합계에 끼지 않게 한다.
  const wt = join(root, 'wt.jsonl');
  writeFileSync(wt, jsonl([{ type: 'user', cwd: '/home/u/dev/aitop/.claude/worktrees/agent-x' }]));
  assert.equal(attachProjects([{ tool: 'claude', path: wt, days: {} }])[0].project, '/home/u/dev/aitop');
});

test('프로젝트별 표: 열은 비용 순, 못 찾은 기록은 (unknown), 합계는 도구별 표와 같다', () => {
  const b = books();
  const r = buildReport(b, { by: 'project', days: 30, now: NOW });
  const byTool = buildReport(b, { by: 'tool', days: 30, now: NOW });
  assert.deepEqual(r.columns.slice(0, 2), ['dev/aitop', 'old/aitop']);
  assert.ok(r.columns.includes(UNKNOWN));
  assert.equal(r.total.items['dev/aitop'].tokens, 3_500_000, '서브에이전트·cwd 없는 작업 트리 기록도 같은 저장소에');
  assert.equal(r.total.items.web.tokens, 400_000);
  assert.equal(r.total.items[UNKNOWN].tokens, 100_000);
  assert.equal(r.total.items['-srv-legacy'].tokens, 500_000);
  assert.equal(r.total.tokens, byTool.total.tokens);
  assert.deepEqual(r.paths, { 'dev/aitop': '/home/u/dev/aitop', 'old/aitop': '/home/u/old/aitop', '-srv-legacy': '-srv-legacy', web: '/work/web' });
  const j = reportJson(r, '0.0.0');
  assert.equal(j.by, 'project');
  assert.deepEqual(j.paths, r.paths);
  assert.equal(j.total.items[UNKNOWN].tokens, 100_000);
});

test('열 수 상한: 나머지는 (others) 로 합치고, 날짜 줄·합계는 그대로', () => {
  const r = buildReport(books(), { by: 'project', days: 30, now: NOW, maxColumns: 3 });
  assert.equal(r.columns.length, 3);
  assert.equal(r.columns.at(-1), OTHERS);
  const kept = r.columns.slice(0, 2).reduce((a, c) => a + r.total.items[c].tokens, 0);
  assert.equal(kept + r.total.items[OTHERS].tokens, r.total.tokens);
  for (const row of r.rows) assert.equal(Object.values(row.items).reduce((a, x) => a + x.tokens, 0), row.tokens);
});

test('터미널 폭에 맞추기: 실제 칸 폭(긴 이름 포함)으로 들어가는 만큼만 남기고 나머지는 (others)', () => {
  const day = (tokens, cost) => ({ tokens, cost, unknown: false, models: {} });
  // 마지막 이름이 긴 프로젝트 여러 개 (머리글이 값 칸보다 넓다).
  const long = Array.from({ length: 8 }, (_, i) => ({ tool: 'claude', project: `/w/project-with-a-long-name-${i}`, days: { '2026-11-02': day(1_000_000 * (9 - i), 9 - i) } }));
  const short = Array.from({ length: 8 }, (_, i) => ({ tool: 'claude', project: `/w/p${i}`, days: { '2026-11-02': day(1_000_000 * (9 - i), 9 - i) } }));
  const tableLines = (out) => out.split('\n').slice(2).filter(Boolean);
  for (const books of [long, short]) {
    const r = buildReport(books, { by: 'project', days: 3, now: NOW });
    let prev = 0;
    for (const cols of [80, 100]) {
      const f = fitReport(r, cols);
      for (const l of tableLines(formatReport(f))) assert.ok(width(l) <= cols, `${cols}칸을 넘는 줄: ${l}`);
      assert.equal(f.columns.at(-1), OTHERS);
      assert.equal(f.total.tokens, r.total.tokens);
      assert.ok(f.columns.length >= prev);
      prev = f.columns.length;
    }
    assert.equal(r.columns.length, 8, '원래 표는 그대로');
  }
  // 긴 이름은 80칸에서 짧은 이름보다 열이 적다.
  const n = (books, cols) => fitReport(buildReport(books, { by: 'project', days: 3, now: NOW }), cols).columns.length;
  assert.ok(n(long, 80) < n(short, 80));
  // 열이 하나뿐이면 폭이 모자라도 접지 않는다 (빈 (others) 를 붙이지 않는다).
  const single = buildReport(long.slice(0, 1), { by: 'project', days: 3, now: NOW });
  assert.deepEqual(fitReport(single, 20).columns, single.columns);
  // 넉넉하면 접지 않는다.
  assert.equal(fitReport(buildReport(short, { by: 'project', days: 3, now: NOW }), 400).columns.includes(OTHERS), false);
});

test('표 문구: ko 와 en, (unknown)·(others) 는 번역', () => {
  const r = buildReport(books(), { by: 'project', days: 2, now: NOW, maxColumns: 4 });
  setLang('en');
  const en = formatReport(r);
  setLang('ko');
  const ko = formatReport(r);
  assert.match(en, /^Daily usage, last 2 days \(2026-11-01 to 2026-11-02\), by project, API list price/);
  assert.match(en, /^Date +dev\/aitop +old\/aitop +-srv-legacy +\(others\) +Total$/m);
  assert.doesNotMatch(en, /[가-힣]/);
  assert.match(ko, /^날짜별 사용량 · 최근 2일 .* 프로젝트별/);
  assert.match(ko, /\(그 외\) +합계$/m);
  const all = formatReport(buildReport(books(), { by: 'project', days: 2, now: NOW }));
  assert.match(all, /\(모름\)/);
});

test('collectReport by project 는 장부에 project 를 붙인다', async () => {
  const got = await collectReport({ days: 30, now: NOW, by: 'project' });
  assert.ok(got.books.some((x) => x.project === '/work/web'));
  const plain = await collectReport({ days: 30, now: NOW });
  assert.ok(plain.books.every((x) => !('project' in x)));
});
