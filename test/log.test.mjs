import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeClaudeHome } from './fixture.mjs';

makeClaudeHome();
const { initLog, closeLog, debug, debugIo, logPath, REPEAT_MS } = await import('../src/log.mjs');
const { JsonlTail } = await import('../src/tail.mjs');
const { cwdOf } = await import('../src/sources/antigravity.mjs');
const BIN = fileURLToPath(new URL('../bin/aitop.mjs', import.meta.url));

const tmp = () => mkdtempSync(join(tmpdir(), 'aitop-log-'));
const lines = (p) => readFileSync(p, 'utf8').trim().split('\n');
const clock = (t = Date.parse('2026-01-01T00:00:00Z')) => {
  const c = () => t;
  c.add = (ms) => (t += ms);
  return c;
};

test('로그 위치: XDG_STATE_HOME, 없거나 상대 경로면 ~/.local/state', () => {
  assert.equal(logPath({ XDG_STATE_HOME: '/x/state' }, '/home/u'), '/x/state/aitop/aitop.log');
  assert.equal(logPath({}, '/home/u'), '/home/u/.local/state/aitop/aitop.log');
  assert.equal(logPath({ XDG_STATE_HOME: 'rel' }, '/home/u'), '/home/u/.local/state/aitop/aitop.log');
});

test('꺼져 있으면 폴더도 파일도 만들지 않는다', () => {
  const dir = join(tmp(), 'aitop');
  const path = join(dir, 'aitop.log');
  assert.equal(initLog({ enabled: false, path }).on, false);
  debug('codex', 'rollout parse failed', new Error('x'));
  debugIo('codex', 'stat failed', Object.assign(new Error('x'), { code: 'EACCES' }));
  assert.equal(existsSync(dir), false);
});

test('켜면 0700 폴더에 0600 파일을 만들고 비밀값과 기록 내용은 쓰지 않는다', () => {
  const dir = join(tmp(), 'aitop');
  const path = join(dir, 'aitop.log');
  assert.equal(initLog({ enabled: true, path, version: '9.9.9' }).on, true);
  debug('codex', 'rollout parse failed token=abcdef123456', new Error('bad token=abcdef123456'), '/home/u/.codex/sessions/rollout-1.jsonl');
  let parseErr;
  try {
    JSON.parse('{"prompt":"SECRET-PROMPT-TEXT"');
  } catch (e) {
    parseErr = e;
  }
  debug('claude', 'line parse failed', parseErr);
  debug('cache', 'esc\x1b[31m', new Error('a\nb'));
  closeLog();
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const text = readFileSync(path, 'utf8');
  assert.match(text, /aitop 9\.9\.9 디버그 로그 시작/);
  assert.match(text, /\[codex\] rollout parse failed token=••••: Error: bad token=•••• \(rollout-1\.jsonl\)/);
  assert.doesNotMatch(text, /abcdef123456/);
  assert.doesNotMatch(text, /\/home\/u/, '경로는 파일 이름만');
  assert.match(text, /\[claude\] line parse failed: SyntaxError\n/);
  assert.doesNotMatch(text, /SECRET-PROMPT-TEXT/, 'JSON 오류 문구 속 기록 내용은 쓰지 않는다');
  assert.doesNotMatch(text, /\x1b/);
  assert.equal(lines(path).length, 4, '오류 문구 속 줄바꿈으로 줄이 늘지 않는다');
});

test('ENOENT 는 debugIo 에서 남기지 않고 그 밖의 코드는 남긴다', () => {
  const path = join(tmp(), 'aitop.log');
  initLog({ enabled: true, path });
  debugIo('claude', 'gone', Object.assign(new Error('x'), { code: 'ENOENT' }));
  debugIo('claude', 'denied', Object.assign(new Error('open /secret/path'), { code: 'EACCES', syscall: 'open' }));
  closeLog();
  const ls = lines(path);
  assert.equal(ls.length, 2);
  assert.match(ls[1], /\[claude\] denied: EACCES open$/);
});

test('같은 출처·문구는 1분에 한 번만, 다음 줄에 생략한 수를 붙인다', () => {
  const path = join(tmp(), 'aitop.log');
  const now = clock();
  initLog({ enabled: true, path, now });
  for (let i = 0; i < 5; i++) debug('codex', 'rollout parse failed', new Error(`e${i}`));
  debug('claude', 'rollout parse failed', new Error('other source'));
  now.add(REPEAT_MS - 1);
  debug('codex', 'rollout parse failed', new Error('still quiet'));
  now.add(1);
  debug('codex', 'rollout parse failed', new Error('again'));
  closeLog();
  const ls = lines(path).slice(1);
  assert.equal(ls.length, 3);
  assert.match(ls[0], /\[codex\] rollout parse failed: Error: e0$/);
  assert.match(ls[1], /\[claude\]/);
  assert.match(ls[2], /Error: again \(\+5번 생략\)$/);
});

test('크기 한도를 넘으면 aitop.log.1 로 옮기고 하나만 남긴다', () => {
  const path = join(tmp(), 'aitop.log');
  initLog({ enabled: true, path, maxBytes: 400 });
  for (let i = 0; i < 40; i++) debug('codex', `message ${i}`, new Error('x'.repeat(20)));
  closeLog();
  assert.ok(statSync(path).size <= 400);
  assert.ok(statSync(path + '.1').size <= 400);
  assert.equal(existsSync(path + '.2'), false);
  assert.match(readFileSync(path, 'utf8'), /message 39/);
});

test('다른 aitop 이 먼저 옮겼으면 그 새 파일을 덮지 않고 이어 쓴다. 옮긴 파일이 사라져도 로그는 꺼지지 않는다', () => {
  const path = join(tmp(), 'aitop.log');
  initLog({ enabled: true, path, maxBytes: 400 });
  for (let i = 0; i < 3; i++) debug('codex', `mine ${i}`, new Error('x'.repeat(20)));
  // 다른 aitop 이 회전했다: 내 파일은 .1 로 가고 그쪽이 새 파일을 만들었다.
  renameSync(path, path + '.1');
  writeFileSync(path, 'other new\n');
  const old = readFileSync(path + '.1', 'utf8');
  for (let i = 3; i < 8; i++) debug('codex', `mine ${i}`, new Error('x'.repeat(20)));
  assert.equal(readFileSync(path + '.1', 'utf8').startsWith(old.slice(0, 50)), true, '.1 은 그대로 (내 줄이 덧붙을 수는 있다)');
  assert.match(readFileSync(path, 'utf8'), /^other new\n/, '다른 aitop 의 새 파일을 옮기지 않았다');
  assert.match(readFileSync(path, 'utf8'), /mine 7/);
  // 이름이 아예 없어졌다 (옮긴 직후 아직 새 파일이 없음).
  renameSync(path, path + '.gone');
  for (let i = 8; i < 14; i++) debug('codex', `mine ${i}`, new Error('x'.repeat(20)));
  closeLog();
  assert.match(readFileSync(path, 'utf8'), /mine 13/, 'ENOENT 여도 새로 열고 계속 쓴다');
});

test('기존 파일 권한이 넓어도 0600 으로 바꾼다', () => {
  const path = join(tmp(), 'aitop.log');
  writeFileSync(path, 'old\n', { mode: 0o644 });
  initLog({ enabled: true, path });
  closeLog();
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('기록 줄을 해석하지 못하면 줄 수와 상관없이 로그 한 줄만 남긴다', () => {
  const dir = tmp();
  const path = join(dir, 'aitop.log');
  const rollout = join(dir, 'rollout-broken.jsonl');
  writeFileSync(rollout, '{"ok":1}\n{broken SECRET-LINE\n{also broken\n{"ok":2}\n');
  initLog({ enabled: true, path });
  const seen = [];
  new JsonlTail(rollout).read((x) => seen.push(x));
  closeLog();
  assert.equal(seen.length, 2, '나머지 줄은 그대로 읽는다');
  const ls = lines(path).slice(1);
  assert.deepEqual(ls.map((l) => l.replace(/^\S+ /, '')), ['[jsonl] line parse failed: SyntaxError (rollout-broken.jsonl)']);
});

test('소스의 해석 실패: agy workspace_uris 가 깨져도 결과는 같고 로그에 남는다', () => {
  const path = join(tmp(), 'aitop.log');
  initLog({ enabled: true, path });
  assert.equal(cwdOf('[not json'), null);
  closeLog();
  assert.match(readFileSync(path, 'utf8'), /\[agy\] workspace_uris parse failed: SyntaxError\n/);
});

test('node:sqlite 오류는 SQLite 문구까지, 없는 DB 는 남기지 않는다', async () => {
  const { loadSqlite, openReadOnly } = await import('../src/sqlite.mjs');
  const dir = tmp();
  const path = join(dir, 'aitop.log');
  initLog({ enabled: true, path });
  if (loadSqlite()) {
    const db = new (loadSqlite().DatabaseSync)(':memory:');
    try {
      db.prepare('select * from gen_metadata').all();
    } catch (e) {
      debugIo('agy', 'conversation read failed', e, '/home/u/x.db');
    }
    db.close();
  }
  try {
    openReadOnly(join(dir, 'secret-user', 'missing.db'));
  } catch (e) {
    assert.equal(e.code, 'ENOENT');
    assert.doesNotMatch(e.message, /secret-user/, '오류 문구에 전체 경로를 넣지 않는다');
    debugIo('agy', 'missing db', e);
  }
  closeLog();
  const text = readFileSync(path, 'utf8');
  assert.doesNotMatch(text, /missing db/);
  if (loadSqlite()) assert.match(text, /\[agy\] conversation read failed: ERR_SQLITE_ERROR 1 .*no such table: gen_metadata \(x\.db\)/);
});

// 명령줄: --debug > AITOP_DEBUG > 설정 파일 debug.
const run = (args, env = {}) => {
  const state = tmp();
  const base = { ...process.env, XDG_STATE_HOME: state };
  delete base.AITOP_DEBUG;
  const r = spawnSync(process.execPath, [BIN, ...args], { env: { ...base, ...env }, encoding: 'utf8' });
  return { ...r, log: join(state, 'aitop', 'aitop.log') };
};

test('aitop: 기본은 로그를 만들지 않고 --debug · AITOP_DEBUG=1 이면 만든다', () => {
  assert.equal(existsSync(run(['--once']).log), false);
  const flagged = run(['--once', '--debug']);
  assert.equal(flagged.status, 0);
  assert.equal(statSync(flagged.log).mode & 0o777, 0o600);
  assert.equal(existsSync(run(['--once'], { AITOP_DEBUG: '1' }).log), true);
  assert.equal(existsSync(run(['--once', '--no-debug'], { AITOP_DEBUG: '1' }).log), false);
});

test('aitop --print-config 와 --doctor 에 debug 와 로그 위치가 보인다', () => {
  const cfg = run(['--print-config', '--json', '--debug']);
  assert.deepEqual(JSON.parse(cfg.stdout).values.debug, { value: true, source: 'flag' });
  assert.equal(existsSync(cfg.log), false, '--print-config 는 로그를 만들지 않는다');
  assert.deepEqual(JSON.parse(run(['--print-config', '--json'], { AITOP_DEBUG: '1' }).stdout).values.debug, { value: true, source: 'env' });
  const bad = run(['--print-config', '--json'], { AITOP_DEBUG: 'true' });
  const badCfg = JSON.parse(bad.stdout);
  assert.deepEqual(badCfg.values.debug, { value: false, source: 'default' });
  assert.ok(badCfg.problems.some((p) => /AITOP_DEBUG 값 "true" 이 잘못되어 무시합니다 \(1 또는 0\)/.test(p)));
  assert.match(run(['--doctor'], { AITOP_DEBUG: 'yes' }).stdout, /AITOP_DEBUG 값 "yes"/);
  const doc = run(['--doctor']);
  assert.match(doc.stdout, /○ 디버그 꺼짐 .*aitop\.log · --debug 로 켬/);
  const on = run(['--doctor', '--json', '--debug']);
  assert.deepEqual(JSON.parse(on.stdout).log, { on: true, path: on.log });
});
