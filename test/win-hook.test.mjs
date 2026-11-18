// Windows --on-waiting 실행과 종료 (#196). 가짜 spawn 과 platform 주입으로 어느 OS 에서나 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hookCommand, createNotifier, createRunner, killAllChildren, taskkillPath } from '../src/notify.mjs';

// 끝나지 않는 가짜 자식. calls 에 spawn 호출을 남긴다.
function fakeSpawn() {
  const calls = [];
  let pid = 4000;
  const fn = (file, args, opts) => {
    const c = new EventEmitter();
    c.pid = ++pid;
    c.killed = 0;
    c.kill = () => c.killed++;
    calls.push({ file, args, opts, child: c });
    return c;
  };
  return { fn, calls };
}

const session = { tool: 'claude', project: 'demo', id: 's1', cwd: 'C:\\work\\demo', phase: null };

test('hookCommand: Linux·macOS 는 /bin/sh -c, Windows 는 COMSPEC /d /v:on /s /c "명령"', () => {
  assert.deepEqual(hookCommand('echo hi', { platform: 'linux' }), ['/bin/sh', ['-c', 'echo hi'], {}]);
  assert.deepEqual(hookCommand('echo hi', { platform: 'darwin' }), ['/bin/sh', ['-c', 'echo hi'], {}]);
  assert.deepEqual(hookCommand('echo "a b" & echo c', { platform: 'win32', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } }), [
    'C:\\Windows\\system32\\cmd.exe',
    ['/d', '/v:on', '/s', '/c', '"echo "a b" & echo c"'],
    { windowsVerbatimArguments: true },
  ]);
  assert.equal(hookCommand('x', { platform: 'win32', env: { COMSPEC: 'D:\\cmd.exe' } })[0], 'D:\\cmd.exe');
  assert.equal(hookCommand('x', { platform: 'win32', env: {} })[0], 'cmd.exe');
});

test('taskkill 경로는 SystemRoot 아래 System32', () => {
  assert.equal(taskkillPath({ SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\taskkill.exe');
  assert.equal(taskkillPath({}), 'taskkill.exe');
});

test('win32: --on-waiting 은 창 없이(windowsHide) detached 없이 cmd 로 띄우고 세션 값은 환경 변수로만 넘긴다', () => {
  const sp = fakeSpawn();
  const n = createNotifier({ onWaiting: 'echo !AITOP_PROJECT!', platform: 'win32', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, spawnFn: sp.fn });
  n.fire([session], 'waiting');
  assert.equal(sp.calls.length, 1);
  const { file, args, opts } = sp.calls[0];
  assert.equal(file, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(args, ['/d', '/v:on', '/s', '/c', '"echo !AITOP_PROJECT!"']);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.windowsVerbatimArguments, true);
  assert.equal(opts.detached, undefined);
  assert.equal(opts.env.AITOP_PROJECT, 'demo');
  assert.equal(opts.env.AITOP_EVENT, 'waiting');
  assert.ok(!args.join(' ').includes('demo'), '세션 값은 명령에 들어가지 않는다');
  n.killAll();
});

test('Linux 는 예전처럼 /bin/sh -c 를 detached 로 띄운다', () => {
  const sp = fakeSpawn();
  const n = createNotifier({ onWaiting: 'echo hi', platform: 'linux', env: {}, spawnFn: sp.fn });
  n.fire([session], 'waiting');
  const { file, args, opts } = sp.calls[0];
  assert.equal(file, '/bin/sh');
  assert.deepEqual(args, ['-c', 'echo hi']);
  assert.equal(opts.detached, true);
  assert.equal(opts.windowsHide, undefined);
  sp.calls[0].child.emit('exit', 0);
});

test('win32: 시간을 넘기면 taskkill /T /F /PID 로 자식까지 끝낸다', async () => {
  const sp = fakeSpawn();
  const r = createRunner({ timeoutMs: 30, platform: 'win32', spawnFn: sp.fn });
  r.run({ file: 'cmd.exe', args: ['/d', '/v:on', '/s', '/c', '"x"'], env: {} });
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(r.stats.timedOut, 1);
  const kill = sp.calls[1];
  assert.match(kill.file, /taskkill\.exe$/i);
  assert.deepEqual(kill.args, ['/T', '/F', '/PID', String(sp.calls[0].child.pid)]);
  assert.equal(kill.opts.windowsHide, true);
  sp.calls[0].child.emit('exit', 1);
  assert.equal(r.busy, false);
});

test('win32: killAll 과 끝날 때 정리도 taskkill 을 쓴다 (끝날 때는 동기)', () => {
  const sp = fakeSpawn();
  const syncCalls = [];
  const spawnSyncFn = (file, args) => syncCalls.push({ file, args });
  const a = createRunner({ platform: 'win32', spawnFn: sp.fn, spawnSyncFn });
  a.run({ file: 'cmd.exe', args: [], env: {} });
  a.killAll();
  assert.deepEqual(sp.calls[1].args, ['/T', '/F', '/PID', String(sp.calls[0].child.pid)]);

  const b = createRunner({ platform: 'win32', spawnFn: sp.fn, spawnSyncFn });
  b.run({ file: 'cmd.exe', args: [], env: {} });
  const pid = sp.calls.at(-1).child.pid;
  killAllChildren();
  assert.deepEqual(syncCalls.map((c) => c.args), [['/T', '/F', '/PID', String(pid)]]);
});

test('win32: taskkill 을 부르지 못하면 자식 하나라도 끝낸다', () => {
  let n = 0;
  let first;
  const spawnFn = (file, args, opts) => {
    if (n++ > 0) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    first = new EventEmitter();
    first.pid = 77;
    first.killed = 0;
    first.kill = () => first.killed++;
    return first;
  };
  const r = createRunner({ platform: 'win32', spawnFn });
  r.run({ file: 'cmd.exe', args: [], env: {} });
  r.killAll();
  assert.equal(first.killed, 1);
});

test('win32: 뒤에서 부른 taskkill 이 error 로 실패해도 자식 하나는 끝내고, 끝날 때는 2초까지만 기다린다', () => {
  let child;
  let tk;
  const spawnFn = (file, args) => {
    const c = new EventEmitter();
    c.pid = 88;
    c.killed = 0;
    c.kill = () => c.killed++;
    if (/taskkill/i.test(file)) tk = c;
    else child = c;
    return c;
  };
  const r = createRunner({ platform: 'win32', spawnFn });
  r.run({ file: 'cmd.exe', args: [], env: {} });
  r.killAll();
  assert.equal(child.killed, 0);
  tk.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  assert.equal(child.killed, 1);

  const seen = [];
  const b = createRunner({ platform: 'win32', spawnFn, spawnSyncFn: (f, a, o) => seen.push(o.timeout) });
  b.run({ file: 'cmd.exe', args: [], env: {} });
  killAllChildren();
  assert.deepEqual(seen, [2000]);
});

// 아래는 실제 cmd.exe 로 돌린다 (Windows 만).
const WIN = process.platform === 'win32';
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

test('Windows 실제 실행: !AITOP_*! 로 읽은 세션 값은 명령이 되지 않는다', { skip: !WIN && 'Windows 전용' }, async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'aitop-hook-')), 'out.txt');
  const n = createNotifier({ onWaiting: 'echo !AITOP_EVENT! !AITOP_PROJECT!>"%OUT%"', env: { ...process.env, OUT: out } });
  n.fire([{ ...session, project: 'demo & echo injected | x > y' }], 'done');
  for (let i = 0; i < 100 && n.hook.busy; i++) await wait(50);
  // !변수! 는 & | > 를 읽은 뒤에 펼쳐지므로 값이 글자 그대로 들어간다 (%변수% 였다면 echo injected 가 실행된다).
  assert.equal(readFileSync(out, 'utf8').trim(), 'done demo & echo injected | x > y');
});

test('Windows 실제 실행: 시간을 넘긴 명령은 손자 프로세스까지 끝낸다', { skip: !WIN && 'Windows 전용' }, async () => {
  const late = join(mkdtempSync(join(tmpdir(), 'aitop-hook-')), 'late.txt');
  const [file, args, opts] = hookCommand('powershell -NoProfile -NonInteractive -Command "Start-Sleep 3; Set-Content -Path $env:LATE -Value late"');
  const r = createRunner({ timeoutMs: 1500 });
  r.run({ file, args, opts, env: { ...process.env, LATE: late } });
  for (let i = 0; i < 60 && r.busy; i++) await wait(100);
  assert.equal(r.stats.timedOut, 1);
  await wait(3000);
  assert.equal(existsSync(late), false, '손자 powershell 이 살아남아 파일을 썼다');
});
