// Windows 파일 교체 재시도와 구형 콘솔 안내 (#198). 가짜 rename·sleep 과 platform 주입으로 어느 OS 에서나 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renameSync, RENAME_RETRIES } from '../src/rename.mjs';
import { consoleCheck, doctorText } from '../src/doctor.mjs';

const err = (code) => Object.assign(new Error(code), { code });

// fails 번 code 로 실패한 뒤 성공하는 가짜 rename.
function fake(fails, code) {
  const calls = { rename: 0, sleep: [] };
  const rename = () => {
    calls.rename++;
    if (calls.rename <= fails) throw err(code);
  };
  return { calls, rename, sleep: (ms) => calls.sleep.push(ms) };
}

test('win32: EPERM·EBUSY·EACCES 는 50ms 쉬고 다시 해서 성공한다', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const f = fake(2, code);
    renameSync('a', 'b', { platform: 'win32', rename: f.rename, sleep: f.sleep });
    assert.equal(f.calls.rename, 3, code);
    assert.deepEqual(f.calls.sleep, [50, 50], code);
  }
});

test('win32: 재시도 3번까지 실패하면 마지막 오류를 던진다', () => {
  const f = fake(99, 'EBUSY');
  assert.throws(() => renameSync('a', 'b', { platform: 'win32', rename: f.rename, sleep: f.sleep }), { code: 'EBUSY' });
  assert.equal(f.calls.rename, RENAME_RETRIES + 1);
  assert.equal(f.calls.sleep.length, RENAME_RETRIES);
});

test('win32: retries 0 이면 한 번만 해 본다 (캐시 저장에서 이미 영구 실패가 난 뒤)', () => {
  const f = fake(1, 'EACCES');
  assert.throws(() => renameSync('a', 'b', { platform: 'win32', rename: f.rename, sleep: f.sleep, retries: 0 }), { code: 'EACCES' });
  assert.equal(f.calls.rename, 1);
  assert.deepEqual(f.calls.sleep, []);
});

test('win32: 잠김이 아닌 오류(ENOENT)는 바로 던진다', () => {
  const f = fake(1, 'ENOENT');
  assert.throws(() => renameSync('a', 'b', { platform: 'win32', rename: f.rename, sleep: f.sleep }), { code: 'ENOENT' });
  assert.equal(f.calls.rename, 1);
  assert.deepEqual(f.calls.sleep, []);
});

test('Linux·macOS 는 예전처럼 한 번만 부르고 쉬지 않는다', () => {
  for (const platform of ['linux', 'darwin']) {
    const f = fake(1, 'EPERM');
    assert.throws(() => renameSync('a', 'b', { platform, rename: f.rename, sleep: f.sleep }), { code: 'EPERM' });
    assert.equal(f.calls.rename, 1);
    assert.deepEqual(f.calls.sleep, []);
  }
});

test('실제 파일 교체: 기본 rename 으로 대상 파일을 바꾼다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aitop-rename-'));
  const from = join(dir, 'x.tmp');
  const to = join(dir, 'x.json');
  writeFileSync(to, 'old');
  writeFileSync(from, 'new');
  renameSync(from, to);
  assert.equal(readFileSync(to, 'utf8'), 'new');
  assert.equal(existsSync(from), false);
});

test('구형 콘솔: win32 에서 터미널 표시가 없으면 legacy, 그 밖의 OS 는 null', () => {
  assert.deepEqual(consoleCheck({ platform: 'win32', env: {} }), { legacy: true });
  for (const env of [{ WT_SESSION: 'x' }, { TERM_PROGRAM: 'vscode' }, { ConEmuANSI: 'ON' }, { TERM: 'xterm-256color' }]) {
    assert.deepEqual(consoleCheck({ platform: 'win32', env }), { legacy: false }, JSON.stringify(env));
  }
  assert.equal(consoleCheck({ platform: 'linux', env: {} }), null);
  assert.equal(consoleCheck({ platform: 'darwin', env: {} }), null);
});

test('--doctor 글: 구형 콘솔이면 Windows Terminal 과 AITOP_AMBIGUOUS·NO_COLOR 를 안내한다', () => {
  const base = { platform: 'win32', processes: false, tools: {} };
  for (const lang of ['ko', 'en']) {
    const text = doctorText({ ...base, console: { legacy: true } }, '0.0.0', Date.now(), lang);
    assert.match(text, /conhost/);
    assert.match(text, /Windows Terminal/);
    assert.match(text, /AITOP_AMBIGUOUS=wide/);
    assert.match(text, /NO_COLOR/);
    assert.doesNotMatch(doctorText({ ...base, console: { legacy: false } }, '0.0.0', Date.now(), lang), /conhost/);
    assert.doesNotMatch(doctorText(base, '0.0.0', Date.now(), lang), /conhost/);
  }
});
