// aitop --report daily 를 새 프로세스로 실행한다: 빈 캐시 폴더에서도 0 으로 끝나고, 표의 합계 줄이 --json 과 같으며,
// 언어(en·ko)를 따르고, 잘못된 옵션은 2 로 끝낸다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIN } from './session.mjs';
import { makeClaudeHome, assistant, usage } from '../fixture.mjs';

const fx = makeClaudeHome();
const now = Date.now();
const ago = (days) => new Date(now - days * 86400_000).toISOString();
fx.transcript('rep00000-1', [
  { ...assistant('r1', [], usage(1_000_000, 10_000), 'claude-opus-5-5'), timestamp: ago(0) },
  { ...assistant('r2', [], usage(300_000, 0), 'claude-sonnet-5-5'), timestamp: ago(1) },
  { ...assistant('r3', [], usage(50_000, 0), 'claude-opus-5-5'), timestamp: ago(3) },
]);

const run = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, TZ: 'Asia/Seoul', ...env }, encoding: 'utf8', timeout: 30_000 });
const EN = { AITOP_LANG: '', LANG: 'C', LC_ALL: '', LC_MESSAGES: '' };

test('빈 캐시 폴더에서 --report daily 는 표를 내고 0 으로 끝나며, 쓰는 곳은 aitop 캐시뿐이다', () => {
  const cache = mkdtempSync(join(tmpdir(), 'aitop-report-cache-'));
  const r = run(['--report', 'daily'], { XDG_CACHE_HOME: cache, ...EN });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '', '파이프 stderr 에는 진행률을 쓰지 않는다');
  assert.match(r.stdout, /^Daily usage, last 30 days/);
  assert.equal(r.stdout.split('\n').filter((l) => /^\d{4}-\d\d-\d\d /.test(l)).length, 30);
  assert.doesNotMatch(r.stdout, /\x1b/);
  assert.deepEqual(readdirSync(cache), ['aitop']);
  // 캐시가 있는 두 번째 실행도 같은 표.
  assert.equal(run(['--report', 'daily'], { XDG_CACHE_HOME: cache, ...EN }).stdout, r.stdout);
});

test('--json 합계 = 날짜 줄의 합이고, 표의 합계 줄과 같다', () => {
  const j = JSON.parse(run(['--report', 'daily', '--by', 'model', '--days', '7', '--json']).stdout);
  assert.equal(j.report, 'daily');
  assert.equal(j.by, 'model');
  assert.equal(j.rows.length, 7);
  assert.equal(j.partial, false);
  assert.equal(j.total.tokens, 1_360_000);
  assert.equal(j.total.tokens, j.rows.reduce((a, x) => a + x.tokens, 0));
  assert.ok(Math.abs(j.total.cost - j.rows.reduce((a, x) => a + x.cost, 0)) < 1e-9);
  assert.deepEqual(j.columns, ['claude-opus-5-5', 'claude-sonnet-5-5']);
  const text = run(['--report', 'daily', '--by', 'model', '--days', '7'], EN).stdout;
  const total = text.split('\n').find((l) => l.startsWith('Total'));
  assert.ok(total.endsWith(`1.4M $${j.total.cost.toFixed(2)}`), total);
});

test('언어: 한국어 머리글과 영어 머리글', () => {
  const ko = run(['--report', 'daily', '--days', '3'], { AITOP_LANG: 'ko' }).stdout;
  assert.match(ko, /^날짜별 사용량 · 최근 3일/);
  assert.match(ko, /^날짜 +claude +합계$/m);
  const en = run(['--report', 'daily', '--days', '3'], EN).stdout;
  assert.match(en, /^Date +claude +Total$/m);
  assert.doesNotMatch(en, /[가-힣]/);
});

test('잘못된 옵션은 2 로 끝내고, 30일을 넘는 --days 는 30일로 줄인다고 알린다', () => {
  assert.equal(run(['--report', 'weekly']).status, 2);
  assert.equal(run(['--by', 'model']).status, 2);
  const capped = run(['--report', 'daily', '--days', '90', '--json'], EN);
  assert.equal(capped.status, 0);
  assert.equal(JSON.parse(capped.stdout).days, 30);
  assert.match(capped.stderr, /limited to the 30 days/);
});
