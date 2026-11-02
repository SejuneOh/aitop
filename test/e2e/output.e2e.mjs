// 큰 출력(변경 파일 60개 x 긴 경로)을 파이프로 받을 때와 명령줄 옵션 처리를 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { makeClaudeHome, assistant, user, usage } from '../fixture.mjs';
import { BIN } from './session.mjs';

const fx = makeClaudeHome();
const now = Date.now();
const ts = (sec) => new Date(now - 600_000 + sec * 100).toISOString();
const edit = (i) => ({
  ...user([{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }]),
  timestamp: ts(i + 2),
  toolUseResult: { filePath: `/work/big/${'deeply-nested-folder/'.repeat(60)}module-${String(i).padStart(4, '0')}.mjs`, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] },
});
fx.session({ sessionId: 'big00000-1', name: '큰 세션', status: 'idle', cwd: '/work/big' });
fx.transcript('big00000-1', [{ ...user('파일 많이 고쳐줘'), timestamp: ts(0) }, { ...assistant('m1', [{ type: 'text', text: '고치겠습니다' }], usage(1000, 10)), timestamp: ts(1) }, ...Array.from({ length: 60 }, (_, i) => edit(i))], '-work-big');

// 색 관련 환경변수는 테스트마다 정한 것만 넘긴다.
function run(args, extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of ['NO_COLOR', 'FORCE_COLOR']) if (!(k in extra)) delete env[k];
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 20_000, maxBuffer: 16 << 20 });
}

test('--json 을 파이프로 받아도 64KB 에서 잘리지 않는다', () => {
  const r = run(['--json']);
  assert.equal(r.status, 0);
  assert.ok(Buffer.byteLength(r.stdout) > 65536, `출력 ${Buffer.byteLength(r.stdout)} 바이트`);
  const s = JSON.parse(r.stdout).sessions.find((x) => x.id === 'big00000-1');
  assert.equal(s.files.length, 60);
});

test('파이프로 받는 --once 는 색 코드 없이 COLUMNS·LINES 크기를 따른다', () => {
  const r = run(['--once'], { COLUMNS: '72', LINES: '30' });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /\x1b\[/);
  assert.equal(r.stdout.trimEnd().split('\n').length, 30);
});

test('NO_COLOR 가 빈 값이어도 파이프로 받으면 색을 넣지 않는다', () => {
  assert.doesNotMatch(run(['--once'], { NO_COLOR: '' }).stdout, /\x1b\[/);
});

test('FORCE_COLOR 이면 파이프로 받아도 색을 넣는다', () => {
  assert.match(run(['--once'], { FORCE_COLOR: '1' }).stdout, /\x1b\[/);
});

test('--version 은 package.json 버전을 보인다', () => {
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const r = run(['--version']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), version);
});

test('모르는 옵션은 오류와 도움말을 보이고 2 로 끝난다', () => {
  const r = run(['--doctorr']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /모르는 옵션 --doctorr/);
  assert.match(r.stderr, /aitop --once/);
});
