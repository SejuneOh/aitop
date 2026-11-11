import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createWaitWatch, takeNewlyWaiting } from '../src/attention.mjs';
import { notifyOptions, findNotifier, notifierCommand, waitingEnv, createRunner, createNotifier, isWsl } from '../src/notify.mjs';

const s = (id, status, extra = {}) => ({ id, status, live: true, tool: 'claude', project: 'demo', cwd: '/work/demo', phase: status === 'waiting' ? { kind: 'waiting', args: { what: 'Bash' } } : { kind: 'idle' }, ...extra });
const tmp = () => mkdtempSync(join(tmpdir(), 'aitop-notify-'));
const until = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('시간 초과');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('첫 갱신의 응답 대기는 알리지 않고, 그 뒤 새로 응답 대기가 된 세션만 돌려준다', () => {
  const w = createWaitWatch();
  assert.deepEqual(takeNewlyWaiting(w, [s('a', 'waiting'), s('b', 'idle')]), []);
  assert.deepEqual(takeNewlyWaiting(w, [s('a', 'waiting'), s('b', 'idle')]), []);
  assert.deepEqual(takeNewlyWaiting(w, [s('a', 'waiting'), s('b', 'waiting'), s('c', 'waiting', { live: false })]).map((x) => x.id), ['b']);
  // 대기에서 벗어났다 다시 대기가 되면 또 알린다.
  takeNewlyWaiting(w, [s('a', 'idle'), s('b', 'waiting')]);
  assert.deepEqual(takeNewlyWaiting(w, [s('a', 'waiting'), s('b', 'waiting')]).map((x) => x.id), ['a']);
});

test('--notify, --on-waiting <cmd>, --on-waiting=<cmd> 를 한 곳에서 해석하고 나머지는 남긴다', () => {
  assert.deepEqual(notifyOptions(['--all']), { notify: false, onWaiting: null, rest: ['--all'], error: null });
  const a = notifyOptions(['--notify', '--on-waiting', 'echo hi', '--bell']);
  assert.equal(a.notify, true);
  assert.equal(a.onWaiting, 'echo hi');
  assert.deepEqual(a.rest, ['--bell']);
  assert.equal(notifyOptions(['--on-waiting=say "x"']).onWaiting, 'say "x"');
  assert.ok(notifyOptions(['--on-waiting']).error);
  assert.ok(notifyOptions(['--on-waiting=']).error);
  // 따로 쓴 값이 - 로 시작하면 옵션을 잘못 먹은 것일 수 있어 막는다. = 로 붙이면 받는다.
  assert.match(notifyOptions(['--on-waiting', '--all']).error, /--on-waiting=/);
  assert.equal(notifyOptions(['--on-waiting=-x']).onWaiting, '-x');
  // --theme 의 값은 건드리지 않는다.
  assert.deepEqual(notifyOptions(['--theme', 'light', '--notify']), { notify: true, onWaiting: null, rest: ['--theme', 'light'], error: null });
  assert.deepEqual(notifyOptions(['--theme', '--on-waiting=x']).rest, ['--theme']);
  const odd = notifyOptions(['--theme', '--notify', 'x']);
  assert.deepEqual([odd.notify, odd.rest], [true, ['--theme', 'x']]);
  // 설정 파일 값도 같은 함수로 받는다 (명령행이 이긴다).
  assert.deepEqual(notifyOptions(['--on-waiting', 'b'], { notify: true, onWaiting: 'a' }).onWaiting, 'b');
  assert.equal(notifyOptions([], { notify: true }).notify, true);
  // --no-notify 는 설정 파일의 notify 를 끄고, --notify 와 함께 주면 뒤에 준 쪽을 따른다.
  assert.deepEqual(notifyOptions(['--no-notify', '--all'], { notify: true }), { notify: false, onWaiting: null, rest: ['--all'], error: null });
  assert.equal(notifyOptions(['--no-notify', '--notify']).notify, true);
  assert.equal(notifyOptions(['--notify', '--no-notify']).notify, false);
  assert.equal(notifyOptions(['--no-on-waiting'], { onWaiting: 'a' }).onWaiting, null);
  assert.equal(notifyOptions(['--no-on-waiting', '--on-waiting', 'b'], { onWaiting: 'a' }).onWaiting, 'b');
});

test('환경변수에 세션 정보를 넣고, 대기 사유는 짧게·가려서 넣는다', () => {
  const env = waitingEnv(s('sid-1', 'waiting', { phase: { kind: 'waiting', args: { what: 'Bash token=abcdefghijkl\nnext' } } }));
  assert.deepEqual(Object.keys(env).sort(), ['AITOP_CWD', 'AITOP_PROJECT', 'AITOP_SESSION_ID', 'AITOP_TOOL', 'AITOP_WAITING_FOR']);
  assert.equal(env.AITOP_TOOL, 'claude');
  assert.equal(env.AITOP_PROJECT, 'demo');
  assert.equal(env.AITOP_SESSION_ID, 'sid-1');
  assert.equal(env.AITOP_CWD, '/work/demo');
  assert.doesNotMatch(env.AITOP_WAITING_FOR, /abcdefghijkl/);
  assert.doesNotMatch(env.AITOP_WAITING_FOR, /\n/);
  assert.match(env.AITOP_WAITING_FOR, /^Bash token=/);
  assert.ok(waitingEnv(s('x', 'waiting', { phase: { kind: 'waiting', args: { what: 'a'.repeat(500) } } })).AITOP_WAITING_FOR.length <= 120);
});

test('--on-waiting 은 세션 값을 명령에 끼워 넣지 않는다 ($(touch …) 가 실행되지 않는다)', async () => {
  const dir = tmp();
  const marker = join(dir, 'pwned');
  const out = join(dir, 'env.txt');
  const evil = `$(touch ${marker})\`touch ${marker}\`;touch ${marker}`;
  let done = 0;
  const n = createNotifier({ onWaiting: `printf '%s\\n' "$AITOP_PROJECT" "$AITOP_SESSION_ID" "$AITOP_WAITING_FOR" > ${out}`, env: { PATH: process.env.PATH } });
  n.fire([s(evil, 'waiting', { project: evil, cwd: evil, phase: { kind: 'waiting', args: { what: evil } } })]);
  await until(() => !n.hook.busy && existsSync(out) && readFileSync(out, 'utf8').split('\n').length >= 3);
  done = readFileSync(out, 'utf8').split('\n');
  assert.equal(done[0], evil);
  assert.equal(done[1], evil);
  assert.equal(existsSync(marker), false, '세션 값 속 명령이 실행되지 않았다');
  rmSync(dir, { recursive: true, force: true });
});

test('시간을 넘긴 명령은 자식까지 끝낸다', async () => {
  const dir = tmp();
  const late = join(dir, 'late');
  const r = createRunner({ timeoutMs: 300 });
  const t0 = performance.now();
  r.run({ file: '/bin/sh', args: ['-c', `sleep 2; touch ${late}`], env: process.env });
  assert.equal(r.busy, true);
  await until(() => !r.busy, 3000);
  assert.ok(performance.now() - t0 < 1500, '시간 제한에 걸려 일찍 끝났다');
  assert.equal(r.stats.timedOut, 1);
  await new Promise((res) => setTimeout(res, 2200));
  assert.equal(existsSync(late), false, 'sleep 뒤의 명령이 돌지 않았다 (그룹째 종료)');
  rmSync(dir, { recursive: true, force: true });
});

test('한 번에 하나만 실행하고, 실행 중 들어온 일은 가장 최근 것 하나만 이어서 실행한다', async () => {
  const dir = tmp();
  const log = join(dir, 'log');
  const r = createRunner({ timeoutMs: 5000 });
  const job = (name) => ({ file: '/bin/sh', args: ['-c', `echo start-$N >> ${log}; sleep 0.3; echo end-$N >> ${log}`], env: { ...process.env, N: name } });
  assert.equal(r.run(job('1')), true);
  assert.equal(r.run(job('2')), false);
  assert.equal(r.run(job('3')), false);
  await until(() => r.stats.started === 2 && !r.busy);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['start-1', 'end-1', 'start-3', 'end-3']);
  assert.equal(r.stats.dropped, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('알림 도구는 PATH 에서 찾고, 없으면 null (WSL 에서도 다른 것으로 대신하지 않는다)', () => {
  const dir = tmp();
  const empty = tmp();
  for (const name of ['notify-send', 'osascript', 'powershell.exe']) {
    writeFileSync(join(dir, name), '#!/bin/sh\n');
    chmodSync(join(dir, name), 0o755);
  }
  writeFileSync(join(empty, 'powershell.exe'), '#!/bin/sh\n');
  chmodSync(join(empty, 'powershell.exe'), 0o755);
  assert.deepEqual(findNotifier({ platform: 'linux', env: { PATH: dir } }), { kind: 'notify-send', path: join(dir, 'notify-send') });
  assert.deepEqual(findNotifier({ platform: 'darwin', env: { PATH: dir } }), { kind: 'osascript', path: join(dir, 'osascript') });
  assert.equal(findNotifier({ platform: 'linux', env: { PATH: empty, WSL_DISTRO_NAME: 'Ubuntu' } }), null);
  assert.equal(findNotifier({ platform: 'darwin', env: { PATH: empty } }), null);
  assert.equal(findNotifier({ platform: 'win32', env: { PATH: dir } }), null);
  rmSync(dir, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

test('알림 제목·본문은 인자로만 넘기고 스크립트 문자열에 넣지 않는다', () => {
  const evil = '" & do shell script "touch /tmp/x" & "';
  const [file, args] = notifierCommand({ kind: 'osascript', path: '/usr/bin/osascript' }, 't', evil);
  assert.equal(file, '/usr/bin/osascript');
  assert.equal(args.at(-1), evil);
  assert.ok(args.filter((a, i) => args[i - 1] === '-e').every((script) => !script.includes(evil)));
  const [, ns] = notifierCommand({ kind: 'notify-send', path: '/usr/bin/notify-send' }, '-t', '--help');
  assert.deepEqual(ns.slice(-3), ['--', '-t', '--help']);
  const [, mk] = notifierCommand({ kind: 'notify-send', path: '/usr/bin/notify-send' }, 'a<b>', '<b>x</b> & y');
  assert.deepEqual(mk.slice(-2), ['a&lt;b&gt;', '&lt;b&gt;x&lt;/b&gt; &amp; y']);
});

test('--notify 는 가짜 notify-send 를 인자로 부른다', async () => {
  const dir = tmp();
  const out = join(dir, 'args');
  writeFileSync(join(dir, 'notify-send'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${out}\n`);
  chmodSync(join(dir, 'notify-send'), 0o755);
  const n = createNotifier({ notify: true, notifier: findNotifier({ platform: 'linux', env: { PATH: dir } }), env: { PATH: process.env.PATH } });
  n.fire([s('a', 'waiting', { project: '$(id)' })]);
  await until(() => !n.desk.busy && existsSync(out));
  const lines = readFileSync(out, 'utf8').trim().split('\n');
  assert.deepEqual(lines.slice(-3), ['--', 'aitop: 응답 대기 (claude)', '$(id) · Bash']);
  assert.equal(n.hook, null);
  rmSync(dir, { recursive: true, force: true });
});

// macOS 경로: PATH 맨 앞에 둔 가짜 osascript 가 AppleScript 와 제목·본문을 인자로 받는지 본다. TTY 없이 돌고 macOS CI 에서도 돈다.
test('--notify 는 macOS 에서 PATH 앞의 가짜 osascript 를 인자로 부른다', async () => {
  const dir = tmp();
  const out = join(dir, 'args');
  writeFileSync(join(dir, 'osascript'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${out}\n`);
  chmodSync(join(dir, 'osascript'), 0o755);
  const notifier = findNotifier({ platform: 'darwin', env: { PATH: dir + delimiter + process.env.PATH } });
  assert.deepEqual(notifier, { kind: 'osascript', path: join(dir, 'osascript') }, '진짜 osascript 보다 앞의 가짜를 고른다');
  const n = createNotifier({ notify: true, notifier, env: { PATH: process.env.PATH } });
  n.fire([s('a', 'waiting', { project: '" & do shell script "id" & "' })]);
  await until(() => !n.desk.busy && existsSync(out));
  assert.deepEqual(readFileSync(out, 'utf8').split('\n').slice(0, -1), [
    '-e',
    'on run argv',
    '-e',
    'display notification (item 2 of argv) with title (item 1 of argv)',
    '-e',
    'end run',
    'aitop: 응답 대기 (claude)',
    '" & do shell script "id" & " · Bash',
  ]);
  assert.equal(n.desk.stats.started, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('isWsl 은 WSL 환경변수나 /proc/version 의 microsoft 로 판단하고, 읽지 못하면 false', () => {
  const never = () => {
    throw new Error('읽지 않아야 한다');
  };
  assert.equal(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, never), true);
  assert.equal(isWsl({ WSL_INTEROP: '/run/WSL/1_interop' }, never), true);
  assert.equal(isWsl({}, () => 'Linux version 5.15.153.1-microsoft-standard-WSL2'), true);
  assert.equal(isWsl({}, () => 'Linux version 6.8.0-45-generic (buildd@lcy02-amd64-075)'), false);
  assert.equal(
    isWsl({}, () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
    false,
    'macOS 처럼 /proc/version 이 없으면 false',
  );
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

test('aitop 이 끝나면(process.exit) 실행 중인 명령과 그 자식도 끝난다', async () => {
  const dir = tmp();
  const pidFile = join(dir, 'pid');
  const mod = new URL('../src/notify.mjs', import.meta.url).href;
  const script = `import { createRunner } from ${JSON.stringify(mod)};
const r = createRunner();
r.run({ file: '/bin/sh', args: ['-c', 'echo $$ > "$PID_FILE"; exec sleep 37'], env: { ...process.env, PID_FILE: ${JSON.stringify(pidFile)} } });
setTimeout(() => process.exit(0), 300);`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(res.status, 0, res.stderr);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  await until(() => !alive(pid), 3000);
  rmSync(dir, { recursive: true, force: true });
});

test('killAll 은 실행 중인 명령을 그룹째 끝내고 대기열을 비운다', async () => {
  const dir = tmp();
  const pidFile = join(dir, 'pid');
  const n = createNotifier({ onWaiting: `echo $$ > ${pidFile}; sleep 37 & wait`, env: { PATH: process.env.PATH } });
  n.fire([s('a', 'waiting'), s('b', 'waiting', { project: 'later' })]);
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim());
  const pid = Number(readFileSync(pidFile, 'utf8'));
  n.killAll();
  assert.equal(n.hook.busy, false);
  await until(() => !alive(pid), 3000);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(n.hook.stats.started, 1, '대기열에 있던 것은 실행하지 않는다');
  rmSync(dir, { recursive: true, force: true });
});
