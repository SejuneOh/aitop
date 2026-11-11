// aitop --line 을 새 프로세스로 실행해 한 줄 출력, ANSI 없음, 캐시 없는 첫 실행의 시간 상한을 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIN } from './session.mjs';
import { makeClaudeHome, assistant, user, usage } from '../fixture.mjs';

const fx = makeClaudeHome();
// 응답 대기 세션 하나와, 오늘 비용이 있는 기록. 세션 pid 는 이 테스트 프로세스라 살아 있는 세션으로 보인다.
fx.session({ sessionId: 'line0000-1', status: 'waiting', waitingFor: 'approve Bash' });
fx.transcript('line0000-1', [user('hi'), assistant('l1', [{ type: 'text', text: 'ok' }], usage(100_000, 20_000))]);

// stdout 은 파이프 (TTY 아님) 다.
const run = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20_000 });

test('--line 은 줄바꿈 하나로 끝나는 한 줄만 내고 0 으로 끝난다', () => {
  const r = run(['--line']);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^[^\n]*\n$/, '한 줄');
  assert.match(r.stdout, /^\$\d+\.\d\d wait 1 \$[\d.]+\/h\n$/);
  assert.doesNotMatch(r.stdout, /\x1b/, 'ANSI 없음');
  assert.match(r.stdout, /^[\x20-\x7e]*\n$/, 'ASCII 만');
});

test('--line=tmux 는 tmux 서식을 넣고 ANSI 는 넣지 않는다. NO_COLOR 면 서식도 없다', () => {
  const r = run(['--line=tmux', '--budget-day', '50']);
  assert.match(r.stdout, /^#\[fg=colour\d+\]\$\d+\.\d\d\/\$50#\[default\] #\[fg=colour\d+\]wait 1#\[default\]/);
  assert.doesNotMatch(r.stdout, /\x1b/);
  const plain = run(['--line=tmux'], { NO_COLOR: '1' });
  assert.doesNotMatch(plain.stdout, /#\[/);
  assert.match(plain.stdout, /^\$\d+\.\d\d wait 1/);
});

test('--line-width 를 넘으면 뒤 항목부터 뺀다', () => {
  assert.match(run(['--line', '--line-width', '8']).stdout, /^\$\d+\.\d\d\n$/);
});

test('잘못된 --line 값은 2 로 끝낸다', () => {
  assert.equal(run(['--line=bar']).status, 2);
});

test('캐시가 없고 시간 상한을 넘으면 ... 을 내고 0 으로 끝난다. 쓰는 곳은 aitop 캐시뿐이다', () => {
  // 1MB 청크 몇 개가 되는 큰 기록. 상한 1ms 면 첫 청크만 읽고 멈춘다.
  const rows = Array.from({ length: 12_000 }, (_, i) => assistant(`big${i}`, [{ type: 'text', text: 'x'.repeat(300) }], usage(10, 5)));
  fx.transcript('line0000-2', rows, '-work-big');
  const cache = mkdtempSync(join(tmpdir(), 'aitop-line-cache-'));
  const t0 = Date.now();
  const r = run(['--line'], { XDG_CACHE_HOME: cache, AITOP_LINE_MS: '1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '...\n');
  assert.ok(Date.now() - t0 < 10_000, '오래 막지 않는다');
  assert.deepEqual(readdirSync(cache), ['aitop'], '캐시 폴더 밖에는 쓰지 않는다');
  // 기본 상한(1.5초) 안에 다 읽으면 다음 실행은 값을 낸다.
  const t1 = Date.now();
  const again = run(['--line'], { XDG_CACHE_HOME: cache });
  assert.equal(again.status, 0);
  assert.ok(Date.now() - t1 < 10_000);
  assert.match(again.stdout, /^(\.\.\.|\$[\d.]+ wait 1.*)\n$/);
});
