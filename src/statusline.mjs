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
import { spawn } from 'node:child_process';
import { parseLimits, saveLimits, statusText } from './limits.mjs';

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

// 명령 하나를 실행해 { code, stdout, error } 를 돌려준다. input 을 stdin 으로 넘긴다. deadline(ms 시각)을 넘으면 끈다.
function runOnce({ file, args, shell }, input, deadline) {
  return new Promise((resolve) => {
    let child;
    try {
      // shell:true 일 때는 인자 배열을 넘기지 않는다 (Node 가 따옴표 없이 이어 붙이므로 문자열 하나로만 쓴다).
      child = shell ? spawn(file, { shell: true, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true }) : spawn(file, args, { shell: false, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    } catch (e) {
      resolve({ code: null, stdout: Buffer.alloc(0), error: e });
      return;
    }
    const out = [];
    let settled = false;
    const end = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), ...r });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      end({ code: null, timedOut: true });
    }, Math.max(0, deadline - Date.now()));
    child.stdout.on('data', (c) => out.push(c));
    child.on('error', (e) => end({ code: null, error: e }));
    child.on('close', (code, signal) => end({ code: code ?? (signal ? 1 : 0) }));
    // 명령이 stdin 을 읽지 않고 끝나도 EPIPE 로 죽지 않게 한다.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// 사용자 상태줄 명령을 실행한다. Windows 에서 셸 없이 못 찾은 명령은 cmd.exe 로 한 번 더 해 본다.
export async function runCommand(cmd, input, { ms = CHILD_MS, platform = process.platform } = {}) {
  const deadline = Date.now() + ms;
  const plan = commandPlan(cmd);
  let r = await runOnce(plan, input, deadline);
  if (platform === 'win32' && !plan.shell && ['ENOENT', 'EINVAL'].includes(r.error?.code)) {
    r = await runOnce({ file: cmd.map(winQuote).join(' '), args: [], shell: true }, input, deadline);
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
    limits = parseLimits(JSON.parse(input.toString('utf8')));
  } catch {}
  // 저장이 실패해도 상태줄 출력은 막지 않는다.
  if (limits) saveLimits(limits, { ...(file ? { file } : {}), now: now() });
  if (!cmd.length) {
    await write(stdout, Buffer.from(statusText(limits, now()) + '\n'));
    return 0;
  }
  const r = await runCommand(cmd, input);
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
