// Windows 경로 규칙 (#194). platform·env 를 넣어 Linux 에서도 win32 동작을 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appDir, exeName, lastName, tildeIn } from '../src/paths.mjs';
import { configPath } from '../src/config.mjs';
import { logPath } from '../src/log.mjs';
import { isAgy, isCodex, isGemini, joinPaths } from '../src/procs.mjs';
import { arrange } from '../src/order.mjs';

test('lastName·exeName: win32 는 / 와 \\ 를 나누고 Windows 확장자를 뗀다', () => {
  assert.equal(lastName('C:\\Users\\u\\dev\\aitop\\', 'win32'), 'aitop');
  assert.equal(lastName('C:/Users/u/repo', 'win32'), 'repo');
  assert.equal(lastName(null, 'win32'), '');
  assert.equal(exeName('C:\\Program Files\\nodejs\\codex.cmd', 'win32'), 'codex');
  assert.equal(exeName('C:\\tools\\AGY.EXE', 'win32'), 'AGY');
  assert.equal(exeName('C:\\x\\codex.js', 'win32'), 'codex.js');
});

test('lastName·exeName: Linux·macOS 는 예전처럼 / 만 나누고 확장자를 그대로 둔다', () => {
  for (const plat of ['linux', 'darwin']) {
    assert.equal(lastName('/home/u/dev/aitop/', plat), 'aitop');
    assert.equal(lastName('/home/u/a\\b', plat), 'a\\b');
    assert.equal(lastName(null, plat), '');
    assert.equal(exeName('/usr/local/bin/codex', plat), 'codex');
    assert.equal(exeName('/opt/codex.cmd', plat), 'codex.cmd');
    assert.equal(exeName('dir\\agy.exe', plat), 'dir\\agy.exe');
    assert.equal(exeName('/usr/bin/', plat), '');
  }
});

test('프로세스 판정: Windows 의 codex.cmd, codex.js, agy.exe, gemini.cmd', { skip: process.platform !== 'win32' && 'win32 에서만 \\ 와 .exe·.cmd 를 다룬다 (exeName 은 위에서 platform 을 넣어 본다)' }, () => {
  assert.ok(isCodex(['C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd']));
  assert.ok(isCodex(['C:\\nodejs\\node.exe', 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js']));
  assert.ok(isCodex(['C:\\x\\codex-x86_64-pc-windows-msvc.exe']));
  assert.ok(isAgy(['C:\\tools\\agy.exe', 'chat']));
  assert.ok(isGemini(['node.exe', 'D:\\npm\\gemini.cmd']));
  assert.ok(!isCodex(['C:\\x\\codexy.exe']));
});

test('joinPaths: 드라이브 문자로 시작하는 경로도 공백을 이어 붙인다', () => {
  const real = new Set(['C:\\Program Files\\nodejs\\node.exe']);
  assert.deepEqual(joinPaths(['C:\\Program', 'Files\\nodejs\\node.exe', 'x'], (p) => real.has(p)), ['C:\\Program Files\\nodejs\\node.exe', 'x']);
  // POSIX 동작은 그대로
  assert.deepEqual(joinPaths(['/a', 'b', 'c'], (p) => p === '/a b'), ['/a b', 'c']);
});

test('tildeIn: POSIX 는 home + / 로 시작할 때만 줄인다', () => {
  assert.equal(tildeIn('/home/u/dev/x', '/home/u', 'linux'), '~/dev/x');
  assert.equal(tildeIn('/home/u', '/home/u', 'linux'), '~');
  assert.equal(tildeIn('/home/user2/x', '/home/u', 'linux'), '/home/user2/x');
  assert.equal(tildeIn('/HOME/U/x', '/home/u', 'linux'), '/HOME/U/x');
  assert.equal(tildeIn('/srv/home/u/x', '/home/u', 'linux'), '/srv/home/u/x');
  assert.equal(tildeIn(null, '/home/u', 'linux'), '');
});

test('tildeIn: win32 는 \\ 와 /, 대소문자를 같게 본다', () => {
  const home = 'C:\\Users\\Kim';
  assert.equal(tildeIn('C:\\Users\\Kim\\.codex\\sessions', home, 'win32'), '~\\.codex\\sessions');
  assert.equal(tildeIn('c:\\users\\kim\\repo', home, 'win32'), '~\\repo');
  assert.equal(tildeIn('C:/Users/Kim/repo', home, 'win32'), '~/repo');
  assert.equal(tildeIn('C:\\Users\\Kimchi\\repo', home, 'win32'), 'C:\\Users\\Kimchi\\repo');
  assert.equal(tildeIn('D:\\Users\\Kim\\repo', home, 'win32'), 'D:\\Users\\Kim\\repo');
});

test('기본 폴더: Linux·macOS 는 그대로 ~/.cache, ~/.local/state, ~/.config', () => {
  for (const platform of ['linux', 'darwin']) {
    const o = { env: {}, home: '/home/u', platform };
    assert.equal(appDir('cache', o), '/home/u/.cache/aitop');
    assert.equal(appDir('state', o), '/home/u/.local/state/aitop');
    assert.equal(appDir('config', o), '/home/u/.config/aitop');
  }
  // Linux 에서 APPDATA 가 있어도 쓰지 않는다
  assert.equal(appDir('cache', { env: { LOCALAPPDATA: '/x' }, home: '/home/u', platform: 'linux' }), '/home/u/.cache/aitop');
});

test('기본 폴더: win32 는 %LOCALAPPDATA%\\aitop\\{cache,state}, %APPDATA%\\aitop', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\Kim\\AppData\\Local', APPDATA: 'C:\\Users\\Kim\\AppData\\Roaming' };
  const o = { env, home: 'C:\\Users\\Kim', platform: 'win32' };
  assert.equal(appDir('cache', o), 'C:\\Users\\Kim\\AppData\\Local\\aitop\\cache');
  assert.equal(appDir('state', o), 'C:\\Users\\Kim\\AppData\\Local\\aitop\\state');
  assert.equal(appDir('config', o), 'C:\\Users\\Kim\\AppData\\Roaming\\aitop');
  assert.equal(configPath(env, 'C:\\Users\\Kim', 'win32'), 'C:\\Users\\Kim\\AppData\\Roaming\\aitop\\config.json');
  assert.equal(logPath(env, 'C:\\Users\\Kim', 'win32'), 'C:\\Users\\Kim\\AppData\\Local\\aitop\\state\\aitop.log');
  // APPDATA·LOCALAPPDATA 가 없거나 상대 경로면 home 아래 AppData 를 쓴다
  const bare = { env: { LOCALAPPDATA: 'rel' }, home: 'C:\\Users\\Kim', platform: 'win32' };
  assert.equal(appDir('cache', bare), 'C:\\Users\\Kim\\AppData\\Local\\aitop\\cache');
  assert.equal(appDir('config', bare), 'C:\\Users\\Kim\\AppData\\Roaming\\aitop');
});

test('기본 폴더: XDG_* 가 있으면 win32 에서도 그것을 쓴다', () => {
  const env = { XDG_CACHE_HOME: 'D:\\t\\cache', XDG_STATE_HOME: 'D:\\t\\state', XDG_CONFIG_HOME: 'D:\\t\\cfg', LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\R' };
  const o = { env, home: 'C:\\Users\\Kim', platform: 'win32' };
  assert.equal(appDir('cache', o), 'D:\\t\\cache\\aitop');
  assert.equal(appDir('state', o), 'D:\\t\\state\\aitop');
  assert.equal(appDir('config', o), 'D:\\t\\cfg\\aitop');
  // 상대 경로 XDG_STATE_HOME·XDG_CONFIG_HOME 은 무시한다 (POSIX 와 같은 규칙)
  assert.equal(appDir('state', { ...o, env: { XDG_STATE_HOME: 'rel', LOCALAPPDATA: 'C:\\L' } }), 'C:\\L\\aitop\\state');
});

test('묶기: 작업 폴더의 마지막 이름으로 묶는다 (win32 는 \\ 경로도)', () => {
  const s = (id, cwd) => ({ id, cwd, tool: 'codex', status: 'idle' });
  const win = process.platform === 'win32';
  const a = win ? 'C:\\Users\\u\\dev\\aitop' : '/home/u/dev/aitop';
  const { groups } = arrange([s('a', a), s('b', a + (win ? '\\' : '/')), s('c', '/home/u/other')], { group: 'project' });
  assert.deepEqual(groups.map((g) => [g.name, g.count]), [['aitop', 2], ['other', 1]]);
});
