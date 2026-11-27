// aitop --statusline [-- <사용자 상태줄 명령> [인자...]] (#332).
// Claude Code settings.json 의 statusLine.command 에 사용자가 직접 넣는다. 하는 일:
// 1. stdin(Claude Code 가 주는 JSON)을 끝까지 읽는다. 1MB 를 넘으면 거기까지, 1초 안에 안 끝나면 있는 만큼.
// 2. rate_limits 의 숫자·시각만 꺼내 claude-limits.json 에 저장한다 (limits.mjs). 값이 없으면 파일을 그대로 둔다.
// 3. `--` 뒤 명령이 있으면 같은 stdin 바이트를 그 명령에 넘기고, 그 stdout 을 그대로 내고 종료 코드도 따른다 (2초 제한).
//    없으면 짧은 기본 줄(limits.mjs statusText)을 낸다.
// 명령 실행 규칙:
// - `--` 뒤가 인자 하나이고 그 안에 공백이 있으면 셸 문자열로 보고 플랫폼 셸(Linux·macOS /bin/sh, Windows cmd.exe)로 실행한다.
//   예) aitop --statusline -- "npx -y ccstatusline"
// - 그 밖에는 인자 배열 그대로 셸 없이 실행한다 (shell:false). 예) aitop --statusline -- npx -y ccstatusline
//   Windows 에서 셸 없이 찾을 수 없는 명령(npx.cmd 같은 .cmd·.bat)은 cmd.exe 로 한 번 더 해 본다.
// 화면 모듈·수집기·설정·i18n 은 불러오지 않는다 (상태줄은 응답마다 불리므로 빨리 끝나야 한다).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { freshLimits, parseLimits, saveLimits, statusText } from './limits.mjs';

export const STDIN_MAX = 1024 * 1024;
export const STDIN_MS = 1000;
export const CHILD_MS = 2000;

// stdin 을 Buffer 로. 상한을 넘거나 시간이 지나면 있는 만큼 돌려준다.
export function readInput(stream = process.stdin, { max = STDIN_MAX, ms = STDIN_MS } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', finish);
      stream.off('error', finish);
      stream.pause();
      resolve(Buffer.concat(chunks).subarray(0, max));
    };
    const onData = (c) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      chunks.push(b);
      size += b.length;
      if (size >= max) finish();
    };
    const timer = setTimeout(finish, ms);
    stream.on('data', onData);
    stream.once('end', finish);
    stream.once('error', finish);
    stream.resume();
  });
}

// Windows cmd.exe 에 넘길 인자 하나를 따옴표로 감싼다 (공백·특수 문자가 있을 때만). 명령은 사용자 자신의 설정에서 온다.
const winQuote = (a) => (/^[\w.:\\/=@+-]+$/.test(a) ? a : `"${a.replaceAll('"', '""')}"`);

// 실행 방법을 고른다. 돌려주는 값: { file, args, shell }.
export function commandPlan(cmd) {
  if (cmd.length === 1 && /\s/.test(cmd[0])) return { file: cmd[0], args: [], shell: true };
  return { file: cmd[0], args: cmd.slice(1), shell: false };
}

// 자식 stdout 상한. 상태줄은 몇 줄이면 되므로 넘는 부분은 버린다.
export const STDOUT_MAX = 64 * 1024;
// 그룹에 SIGTERM 을 보낸 뒤 SIGKILL 까지 기다리는 시간.
export const KILL_GRACE_MS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 프로세스 그룹에 아직 살아 있는 프로세스가 있는지 (신호 0).
const groupAlive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

// 자식을 손자까지 끈다. 시간 초과와 aitop 이 신호를 받았을 때 쓴다.
// - POSIX: detached 로 띄워 자식이 자기 프로세스 그룹의 우두머리다. 그룹째 SIGTERM, KILL_GRACE_MS 뒤에도 남아 있으면 SIGKILL.
//   셸 문자열(`sleep 30; echo hi`)의 sleep 이나 TERM 을 무시하는 자식도 남지 않는다.
// - Windows: 프로세스 그룹이 없으므로 taskkill /T /F 로 자식 트리를 끈다 (notify.mjs 와 같은 방법.
//   그 모듈은 i18n 을 불러오므로 여기서는 따로 둔다). taskkill 을 부르지 못하면 자식 하나라도 끈다.
// sync 이면 기다리지 않는다 (신호 처리 중에는 SIGKILL 을 바로 보낸다).
export async function stopTree(child, { platform = process.platform, spawnFn = spawn, grace = KILL_GRACE_MS, sync = false } = {}) {
  const pid = child?.pid;
  if (!pid) return;
  if (platform === 'win32') {
    try {
      const root = process.env.SystemRoot;
      const tk = root ? win32.join(root, 'System32', 'taskkill.exe') : 'taskkill.exe';
      const args = ['/pid', String(pid), '/T', '/F'];
      // 신호 처리 중에는 곧 process.exit 하므로 taskkill 이 끝날 때까지(2초까지) 기다린다.
      if (sync) spawnSync(tk, args, { stdio: 'ignore', windowsHide: true, timeout: 2000 });
      else spawnFn(tk, args, { stdio: 'ignore', windowsHide: true }).on?.('error', () => child.kill());
    } catch {
      try {
        child.kill();
      } catch {}
    }
    return;
  }
  try {
    process.kill(-pid, sync ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try {
      child.kill(sync ? 'SIGKILL' : 'SIGTERM');
    } catch {}
  }
  if (sync) return;
  await sleep(grace);
  if (groupAlive(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }
}

// 지금 돌고 있는 사용자 명령. aitop 이 신호를 받으면 이것들을 그룹째 끈다.
const running = new Set();

// 명령 하나를 실행해 { code, stdout, error } 를 돌려준다. input 을 stdin 으로 넘긴다. deadline(ms 시각)을 넘으면 끈다.
function runOnce({ file, args, shell }, input, deadline, { platform = process.platform, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    // POSIX 는 detached 로 새 프로세스 그룹을 만든다 (stdin·stdout 파이프는 그대로). Windows 의 detached 는 콘솔 창을 새로 열므로 쓰지 않는다.
    const opts = { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, detached: platform !== 'win32' };
    try {
      // shell:true 일 때는 인자 배열을 넘기지 않는다 (Node 가 따옴표 없이 이어 붙이므로 문자열 하나로만 쓴다).
      child = shell ? spawnFn(file, { ...opts, shell: true }) : spawnFn(file, args, { ...opts, shell: false });
    } catch (e) {
      resolve({ code: null, stdout: Buffer.alloc(0), error: e });
      return;
    }
    running.add(child);
    const out = [];
    let size = 0;
    let settled = false;
    // 시간을 넘겨 끄는 중이면 그 사이 자식이 끝나도(close) 기다리지 않고, 그룹 끄기(SIGKILL 까지)가 끝난 뒤 시간 초과로 끝낸다.
    // 먼저 끝내면 bin 이 process.exit 해서 TERM 을 무시한 손자에게 SIGKILL 을 보내지 못한다.
    let timedOut = false;
    const end = (r) => {
      if (settled || (timedOut && !r.timedOut)) return;
      settled = true;
      clearTimeout(timer);
      running.delete(child);
      resolve({ stdout: Buffer.concat(out).subarray(0, STDOUT_MAX), ...r });
    };
    const timer = setTimeout(async () => {
      timedOut = true;
      await stopTree(child, { platform, spawnFn });
      end({ code: null, timedOut: true });
    }, Math.max(0, deadline - Date.now()));
    child.stdout.on('data', (c) => {
      if (size >= STDOUT_MAX) return;
      out.push(c);
      size += c.length;
    });
    child.on('error', (e) => end({ code: null, error: e }));
    child.on('close', (code, signal) => end({ code: code ?? (signal ? 1 : 0) }));
    // 명령이 stdin 을 읽지 않고 끝나도 EPIPE 로 죽지 않게 한다.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// aitop 이 SIGTERM·SIGHUP·SIGINT 를 받으면(Claude Code 가 상태줄 실행을 취소할 때 등) 자식 그룹을 끄고 끝낸다.
const SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT'];
function onSignal(sig) {
  for (const c of running) stopTree(c, { sync: true });
  process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[sig] ?? 0));
}

// 명령이 경로로 적혔는지 (구분자가 있거나 . 으로 시작). 이름만 적은 명령(npx)은 PATH 에서 찾는다.
const isPathLike = (f, platform) => (platform === 'win32' ? /[\\/]/.test(f) || /^[a-z]:/i.test(f) : f.includes('/')) || f.startsWith('.');
// Windows 에서 경로로 적은 명령이 있는지. 확장자 없이 적었으면 PATHEXT 의 흔한 확장자도 본다.
function winPathExists(f, exists) {
  if (exists(f)) return true;
  return ['.exe', '.cmd', '.bat', '.com'].some((ext) => exists(f + ext));
}
// cmd.exe 가 명령을 찾지 못했을 때의 종료 코드.
const CMD_NOT_FOUND = 9009;

// 사용자 상태줄 명령을 실행한다. Windows 에서 셸 없이 못 찾은 명령은 cmd.exe 로 한 번 더 해 본다.
// 없는 명령은 플랫폼과 상관없이 error(ENOENT)로 돌려주어 127 로 끝나게 한다:
// - 경로로 적은 명령이 아예 없으면 cmd 로 다시 해 보지 않는다 (cmd 는 못 찾으면 9009 나 1 로 끝나 원인이 흐려진다).
// - cmd 로 다시 해 본 결과가 9009(명령을 찾지 못함)이면 처음 오류를 그대로 돌려준다.
// platform·spawnFn·exists 는 테스트에서 바꿔 끼운다.
export async function runCommand(cmd, input, { ms = CHILD_MS, platform = process.platform, spawnFn = spawn, exists = existsSync } = {}) {
  const deadline = Date.now() + ms;
  const plan = commandPlan(cmd);
  const env = { platform, spawnFn };
  let r = await runOnce(plan, input, deadline, env);
  if (platform === 'win32' && !plan.shell && ['ENOENT', 'EINVAL'].includes(r.error?.code)) {
    if (isPathLike(cmd[0], platform) && !winPathExists(cmd[0], exists)) return r;
    const first = r;
    r = await runOnce({ file: cmd.map(winQuote).join(' '), args: [], shell: true }, input, deadline, env);
    if (r.code === CMD_NOT_FOUND) return { ...first, stdout: r.stdout };
  }
  return r;
}

const write = (stream, data) => new Promise((resolve) => (data.length ? stream.write(data, resolve) : resolve()));

// 본체. argv 는 `--statusline` 뒤의 인자들 (`--` 포함). 돌려주는 값은 종료 코드.
export async function statusline(argv, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, file, now = Date.now } = {}) {
  const sep = argv.indexOf('--');
  const extra = sep < 0 ? argv : argv.slice(0, sep);
  const cmd = sep < 0 ? [] : argv.slice(sep + 1);
  if (extra.length || (sep >= 0 && !cmd.length)) {
    stderr.write(`aitop: usage: aitop --statusline [-- <command> [args...]]\n`);
    return 2;
  }
  const input = await readInput(stdin);
  let limits = null;
  try {
    limits = parseLimits(JSON.parse(input.toString('utf8')), now());
  } catch {}
  // 저장이 실패해도 상태줄 출력은 막지 않는다.
  if (limits) saveLimits(limits, { ...(file ? { file } : {}), now: now() });
  if (!cmd.length) {
    // 초기화 시각이 이미 지난 창은 뺀다 (Claude Code 가 빼 주지만 시계가 어긋날 수 있다).
    await write(stdout, Buffer.from(statusText(freshLimits(limits && { at: now(), ...limits }, now()), now()) + '\n'));
    return 0;
  }
  for (const sig of SIGNALS) process.on(sig, onSignal);
  let r;
  try {
    r = await runCommand(cmd, input);
  } finally {
    for (const sig of SIGNALS) process.off(sig, onSignal);
  }
  await write(stdout, r.stdout);
  if (r.error) {
    stderr.write(`aitop: --statusline: ${cmd[0]}: ${r.error.code ?? r.error.message}\n`);
    return 127;
  }
  if (r.timedOut) {
    stderr.write(`aitop: --statusline: ${cmd[0]}: timed out after ${CHILD_MS / 1000}s\n`);
    return 124;
  }
  return r.code;
}
