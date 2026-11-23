import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createWaitWatch, takeNewlyWaiting } from '../src/attention.mjs';
import { notifyOptions, findNotifier, notifierCommand, waitingEnv, createRunner, createNotifier, isWsl, busProblem, toastScript, encodePowerShell, PS_APP_ID } from '../src/notify.mjs';

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
  assert.deepEqual(notifyOptions(['--all']), { notify: false, events: ['waiting'], eventsSet: false, onWaiting: null, rest: ['--all'], error: null });
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
  assert.deepEqual(notifyOptions(['--theme', 'light', '--notify']), { notify: true, events: ['waiting'], eventsSet: false, onWaiting: null, rest: ['--theme', 'light'], error: null });
  assert.deepEqual(notifyOptions(['--theme', '--on-waiting=x']).rest, ['--theme']);
  const odd = notifyOptions(['--theme', '--notify', 'x']);
  assert.deepEqual([odd.notify, odd.rest], [true, ['--theme', 'x']]);
  // 설정 파일 값도 같은 함수로 받는다 (명령행이 이긴다).
  assert.deepEqual(notifyOptions(['--on-waiting', 'b'], { notify: true, onWaiting: 'a' }).onWaiting, 'b');
  assert.equal(notifyOptions([], { notify: true }).notify, true);
  // --no-notify 는 설정 파일의 notify 를 끄고, --notify 와 함께 주면 뒤에 준 쪽을 따른다.
  assert.deepEqual(notifyOptions(['--no-notify', '--all'], { notify: true }), { notify: false, events: ['waiting'], eventsSet: false, onWaiting: null, rest: ['--all'], error: null });
  assert.equal(notifyOptions(['--no-notify', '--notify']).notify, true);
  assert.equal(notifyOptions(['--notify', '--no-notify']).notify, false);
  assert.equal(notifyOptions(['--no-on-waiting'], { onWaiting: 'a' }).onWaiting, null);
  assert.equal(notifyOptions(['--no-on-waiting', '--on-waiting', 'b'], { onWaiting: 'a' }).onWaiting, 'b');
});

test('환경변수에 세션 정보를 넣고, 대기 사유는 짧게·가려서 넣는다', () => {
  const env = waitingEnv(s('sid-1', 'waiting', { phase: { kind: 'waiting', args: { what: 'Bash token=abcdefghijkl\nnext' } } }));
  assert.deepEqual(Object.keys(env).sort(), ['AITOP_CWD', 'AITOP_HOST', 'AITOP_PROJECT', 'AITOP_SESSION_ID', 'AITOP_TOOL', 'AITOP_WAITING_FOR']);
  assert.equal(env.AITOP_TOOL, 'claude');
  assert.equal(env.AITOP_PROJECT, 'demo');
  assert.equal(env.AITOP_SESSION_ID, 'sid-1');
  assert.equal(env.AITOP_CWD, '/work/demo');
  assert.doesNotMatch(env.AITOP_WAITING_FOR, /abcdefghijkl/);
  assert.doesNotMatch(env.AITOP_WAITING_FOR, /\n/);
  assert.match(env.AITOP_WAITING_FOR, /^Bash token=/);
  assert.ok(waitingEnv(s('x', 'waiting', { phase: { kind: 'waiting', args: { what: 'a'.repeat(500) } } })).AITOP_WAITING_FOR.length <= 120);
});

test('--on-waiting 은 세션 값을 명령에 끼워 넣지 않는다 ($(touch …) 가 실행되지 않는다)', { skip: process.platform === 'win32' && 'Windows: /bin/sh·실행 권한 스크립트가 필요 (Windows 는 test/win-hook·win-notify.test.mjs)' }, async () => {
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

test('시간을 넘긴 명령은 자식까지 끝낸다', { skip: process.platform === 'win32' && 'Windows: /bin/sh·실행 권한 스크립트가 필요 (Windows 는 test/win-hook·win-notify.test.mjs)' }, async () => {
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

test('한 번에 하나만 실행하고, 실행 중 들어온 일은 가장 최근 것 하나만 이어서 실행한다', { skip: process.platform === 'win32' && 'Windows: /bin/sh·실행 권한 스크립트가 필요 (Windows 는 test/win-hook·win-notify.test.mjs)' }, async () => {
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

test('알림 도구는 PATH 에서 찾고, WSL 은 powershell.exe 를 먼저, 없으면 notify-send, 둘 다 없으면 null', { skip: process.platform === 'win32' && 'Windows: /bin/sh·실행 권한 스크립트가 필요 (Windows 는 test/win-hook·win-notify.test.mjs)' }, () => {
  const dir = tmp();
  const onlyPs = tmp();
  const onlyNs = tmp();
  const empty = tmp();
  for (const [d, names] of [[dir, ['notify-send', 'osascript', 'powershell.exe']], [onlyPs, ['powershell.exe']], [onlyNs, ['notify-send']]]) {
    for (const name of names) {
      writeFileSync(join(d, name), '#!/bin/sh\n');
      chmodSync(join(d, name), 0o755);
    }
  }
  // 일반 Linux 는 powershell.exe 가 있어도 notify-send 만 쓴다.
  assert.deepEqual(findNotifier({ platform: 'linux', env: { PATH: dir }, wsl: false }), { kind: 'notify-send', path: join(dir, 'notify-send') });
  assert.equal(findNotifier({ platform: 'linux', env: { PATH: onlyPs }, wsl: false }), null);
  // WSL 은 powershell.exe(Windows 토스트)가 먼저다 (#250).
  assert.deepEqual(findNotifier({ platform: 'linux', env: { PATH: dir }, wsl: true }), { kind: 'powershell', path: join(dir, 'powershell.exe') });
  assert.deepEqual(findNotifier({ platform: 'linux', env: { PATH: onlyPs }, wsl: true }), { kind: 'powershell', path: join(onlyPs, 'powershell.exe') });
  assert.deepEqual(findNotifier({ platform: 'linux', env: { PATH: onlyNs }, wsl: true }), { kind: 'notify-send', path: join(onlyNs, 'notify-send') });
  assert.equal(findNotifier({ platform: 'linux', env: { PATH: empty }, wsl: true }), null);
  // wsl 을 주지 않으면 env 의 WSL_DISTRO_NAME 으로 판단한다.
  assert.equal(findNotifier({ platform: 'linux', env: { PATH: dir, WSL_DISTRO_NAME: 'Ubuntu' } }).kind, 'powershell');
  assert.deepEqual(findNotifier({ platform: 'darwin', env: { PATH: dir } }), { kind: 'osascript', path: join(dir, 'osascript') });
  assert.equal(findNotifier({ platform: 'darwin', env: { PATH: onlyPs } }), null);
  // Windows 네이티브는 test/win-notify.test.mjs 에서 본다 (#197).
  for (const d of [dir, onlyPs, onlyNs, empty]) rmSync(d, { recursive: true, force: true });
});

test('busProblem: 주소가 없거나 unix:path= 소켓이 없으면 문제, abstract·tcp 는 확인할 수 없으니 문제로 보지 않는다', () => {
  const have = new Set(['/run/user/1000/bus', '/tmp/x y']);
  const exists = (p) => have.has(p);
  assert.deepEqual(busProblem({}, exists), { reason: 'missing' });
  assert.deepEqual(busProblem({ DBUS_SESSION_BUS_ADDRESS: '' }, exists), { reason: 'missing' });
  // 주소가 없어도 GLib 처럼 $XDG_RUNTIME_DIR/bus 가 있으면 쓴다.
  assert.equal(busProblem({ XDG_RUNTIME_DIR: '/run/user/1000' }, exists), null);
  assert.deepEqual(busProblem({ XDG_RUNTIME_DIR: '/run/user/1001' }, exists), { reason: 'missing' });
  assert.equal(busProblem({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }, exists), null);
  assert.deepEqual(busProblem({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1001/bus' }, exists), { reason: 'socket', path: '/run/user/1001/bus' });
  assert.equal(busProblem({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/x%20y,guid=abc' }, exists), null, '%xx 를 풀고 guid 같은 다른 키는 무시한다');
  assert.equal(busProblem({ DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/dbus-XXXX,guid=1' }, exists), null);
  assert.equal(busProblem({ DBUS_SESSION_BUS_ADDRESS: 'tcp:host=localhost,port=1234' }, exists), null);
  assert.equal(busProblem({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nope;unix:path=/run/user/1000/bus' }, exists), null, '여러 주소 중 하나라도 있으면 된다');
});

// PowerShell 스크립트에서 디코드 함수($d)에 넘기는 base64 값을 모두 지운 모양. 사용자 글이 그 밖에 들어가면 이 모양이 달라진다.
const skeleton = (script) => script.replace(/& \$d '[A-Za-z0-9+/=]*'/g, "& $d ''");
const decodeEncoded = (args) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');

test('Windows 토스트: 제목·본문은 base64 로만 스크립트에 들어가 따옴표·$()·XML 특수문자가 명령을 바꾸지 못한다', () => {
  const evils = [`'; Remove-Item C:\\ -Recurse; '`, '$(Start-Process calc)', '`$env:USERPROFILE`', '"; & calc; "', '</text><text>x</text>', '<![CDATA[x]]> & &amp; 줄\n바꿈', "@'\nhere\n'@"];
  const base = skeleton(toastScript('t', 'b'));
  for (const evil of evils) {
    const script = toastScript(evil, `${evil} · Bash`);
    assert.equal(skeleton(script), base, evil);
    assert.ok(!script.includes(evil), evil);
    // 스크립트 안의 base64 값을 풀면 원래 글로 돌아온다 (글 노드 CreateTextNode 로 넣으므로 XML 로 읽히지 않는다).
    const vals = [...script.matchAll(/& \$d '([A-Za-z0-9+/=]+)'/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8'));
    assert.deepEqual(vals, [evil, `${evil} · Bash`, PS_APP_ID]);
  }
  assert.match(toastScript('a', 'b'), /CreateTextNode/);
  assert.match(toastScript('a', 'b'), /ToastText02/);
  assert.doesNotMatch(toastScript('a', 'b'), /LoadXml/);
  // 너무 긴 글은 잘라 명령줄 길이를 넘지 않게 한다.
  const long = encodePowerShell(toastScript('x'.repeat(100_000), 'y'.repeat(100_000)));
  assert.ok(long.length < 8_000, String(long.length));
});

test('Windows 토스트 실행 인자: -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <UTF-16LE base64>', () => {
  const [file, args] = notifierCommand({ kind: 'powershell', path: '/mnt/c/ps/powershell.exe' }, 'aitop: 응답 대기 (claude)', '$(id) · Bash');
  assert.equal(file, '/mnt/c/ps/powershell.exe');
  assert.deepEqual(args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  assert.match(args.at(-1), /^[A-Za-z0-9+/]+=*$/);
  assert.equal(decodeEncoded(args), toastScript('aitop: 응답 대기 (claude)', '$(id) · Bash'));
  assert.ok(args.every((a) => !a.includes('$(id)')));
});

test('--notify 는 WSL 에서 가짜 powershell.exe 를 runner 로 부른다', { skip: process.platform === 'win32' && 'Windows: /bin/sh·실행 권한 스크립트가 필요 (Windows 는 test/win-hook·win-notify.test.mjs)' }, async () => {
  const dir = tmp();
  const out = join(dir, 'args');
  writeFileSync(join(dir, 'powershell.exe'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${out}\n`);
  chmodSync(join(dir, 'powershell.exe'), 0o755);
  writeFileSync(join(dir, 'notify-send'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'notify-send'), 0o755);
  const n = createNotifier({ notify: true, notifier: findNotifier({ platform: 'linux', env: { PATH: dir }, wsl: true }), env: { PATH: process.env.PATH } });
  n.fire([s('a', 'waiting', { project: `'; $(calc) "<x>` })]);
  await until(() => !n.desk.busy && existsSync(out));
  const args = readFileSync(out, 'utf8').trim().split('\n');
  assert.equal(args.length, 6);
  assert.equal(decodeEncoded(args), toastScript('aitop: 응답 대기 (claude)', `'; $(calc) "<x> · Bash`));
  assert.equal(n.desk.stats.started, 1);
  rmSync(dir, { recursive: true, force: true });
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

test('--notify 는 가짜 notify-send 를 인자로 부른다', { skip: process.platform === 'win32' && 'Windows: /bin/sh·실행 권한 스크립트가 필요 (Windows 는 test/win-hook·win-notify.test.mjs)' }, async () => {
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
test('--notify 는 macOS 에서 PATH 앞의 가짜 osascript 를 인자로 부른다', { skip: process.platform === 'win32' && 'Windows: /bin/sh·실행 권한 스크립트가 필요 (Windows 는 test/win-hook·win-notify.test.mjs)' }, async () => {
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

test('aitop 이 끝나면(process.exit) 실행 중인 명령과 그 자식도 끝난다', { skip: process.platform === 'win32' && 'Windows: /bin/sh 와 POSIX 신호·프로세스 그룹이 필요' }, async () => {
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

test('killAll 은 실행 중인 명령을 그룹째 끝내고 대기열을 비운다', { skip: process.platform === 'win32' && 'Windows: /bin/sh 와 POSIX 신호·프로세스 그룹이 필요' }, async () => {
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
