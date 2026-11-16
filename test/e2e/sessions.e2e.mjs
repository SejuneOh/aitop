// aitop --report sessions (#215) 를 새 프로세스로 실행한다: 요약 카드와 세션 줄, --md, --json, 지시 글은 --show-prompts 때만,
// 잘못된 옵션은 2 로 끝낸다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIN } from './session.mjs';
import { makeClaudeHome, assistant, user, usage } from '../fixture.mjs';

const fx = makeClaudeHome();
const now = Date.now();
const ago = (days) => new Date(now - days * 86400_000).toISOString();
fx.transcript('ses00000-1', [
  { ...assistant('r1', [], usage(1_000_000, 10_000), 'claude-opus-5-5'), timestamp: ago(0) },
  { ...assistant('r2', [], usage(300_000, 0), 'claude-sonnet-5-5'), timestamp: ago(1) },
  // 기본 기간(어제 0시부터) 밖.
  { ...assistant('r3', [], usage(50_000, 0), 'claude-opus-5-5'), timestamp: ago(3) },
]);
// --report sessions 용: 이름을 붙이고 파일을 고친 세션 (지시 글은 --show-prompts 때만 보여야 한다).
fx.transcript('ses00000-2', [
  { ...user('비밀스러운 첫 지시 | 표 깨기'), timestamp: ago(0.01) },
  { ...assistant('s1', [], usage(2_000_000, 0), 'claude-opus-5-5'), timestamp: ago(0.009) },
  { ...user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]), timestamp: ago(0.008), toolUseResult: { filePath: '/work/demo/a.mjs', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] } },
  { type: 'custom-title', customTitle: 'standup demo' },
]);


const run = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, TZ: 'Asia/Seoul', ...env }, encoding: 'utf8', timeout: 30_000 });
const EN = { AITOP_LANG: '', LANG: 'C', LC_ALL: '', LC_MESSAGES: '' };

test('--report sessions: 요약 카드와 세션 줄, 비용 큰 순, 지시 글은 기본으로 숨긴다', () => {
  const cache = mkdtempSync(join(tmpdir(), 'aitop-report-sessions-'));
  const r = run(['--report', 'sessions'], { XDG_CACHE_HOME: cache, ...EN });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^Sessions, \d{4}-\d\d-\d\d 00:00 to /);
  assert.match(r.stdout, /Total \$[\d.]+ \(API list price\) · 3\.3M tokens · 2 sessions/);
  assert.match(r.stdout, /Cost share by tool: claude 100%/);
  const rows = r.stdout.split('\n').filter((l) => l.startsWith('claude '));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /standup demo .* 2\.0M +\$[\d.]+ +1$/);
  assert.match(rows[1], /-work-demo .* 1\.3M +\$[\d.]+ +0$/);
  assert.doesNotMatch(r.stdout, /비밀스러운/);
  assert.match(run(['--report', 'sessions', '--show-prompts'], { XDG_CACHE_HOME: cache, ...EN }).stdout, /비밀스러운 첫 지시 \| 표 깨기/);
  const ko = run(['--report', 'sessions', '--since', 'today', '--plan', '200'], { XDG_CACHE_HOME: cache, AITOP_LANG: 'ko' }).stdout;
  assert.match(ko, /^세션 리포트 · /);
  assert.match(ko, /구독료 \$200\/월의 .* 대비 .*\(API 정가 환산, 실제 청구액이 아님\)/);
});

test('--report sessions --md: 붙여 넣을 Markdown, 칸 안의 | 는 이스케이프', () => {
  const md = run(['--report', 'sessions', '--md', '--show-prompts'], EN).stdout;
  const lines = md.split('\n');
  assert.match(lines[0], /^\*\*Sessions, /);
  assert.ok(lines.includes('| Tool | Model | Project | Session | Start | End | Tokens | Cost | Files | First prompt |'));
  assert.ok(lines.some((l) => l.includes('비밀스러운 첫 지시 \\| 표 깨기')));
  const cells = (l) => l.replace(/\\\|/g, '').split('|').length;
  assert.equal(new Set(lines.filter((l) => l.startsWith('|')).map(cells)).size, 1);
  assert.doesNotMatch(run(['--report', 'sessions', '--md'], EN).stdout, /비밀스러운/);
});

test('--report sessions --json: 메타·summary·sessions, 숫자는 숫자, prompt 는 --show-prompts 때만', () => {
  const j = JSON.parse(run(['--report', 'sessions', '--since', '7d', '--json']).stdout);
  assert.equal(j.report, 'sessions');
  assert.equal(j.basis, 'api');
  assert.equal(j.partial, false);
  assert.equal(j.summary.sessions, 2);
  assert.equal(j.summary.tokens, 3_360_000);
  assert.equal(typeof j.summary.cost, 'number');
  assert.equal(j.sessions[0].name, 'standup demo');
  assert.equal(j.sessions[0].files, 1);
  assert.ok(j.sessions.every((s) => !('prompt' in s)));
  const p = JSON.parse(run(['--report', 'sessions', '--json', '--show-prompts']).stdout);
  assert.equal(p.sessions[0].prompt, '비밀스러운 첫 지시 | 표 깨기');
});

test('--report sessions 옵션 오류는 2 로 끝낸다 (--since 잘못된 값, --md 와 --json, sessions 밖의 --md, --days)', () => {
  const bad = run(['--report', 'sessions', '--since', 'lastweek'], EN);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /bad --since value "lastweek"/);
  assert.equal(run(['--report', 'sessions', '--since', '2999-01-01']).status, 2);
  assert.equal(run(['--report', 'sessions', '--md', '--json']).status, 2);
  assert.equal(run(['--report', 'daily', '--md']).status, 2);
  assert.equal(run(['--report', 'sessions', '--days', '3']).status, 2);
  const capped = run(['--report', 'sessions', '--since', '60d', '--json'], EN);
  assert.equal(capped.status, 0);
  assert.match(capped.stderr, /--since is limited to 30 days back/);
});
