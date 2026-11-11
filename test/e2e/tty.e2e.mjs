// 가상 터미널(util-linux script)에서 aitop 을 띄우고 실제 키를 보내 화면과 종료 동작을 확인한다.
// script 가 없는 환경(macOS 기본 script 는 옵션이 다르다)에서는 건너뛴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BIN, makeSession } from './session.mjs';
import { assistant, user, usage } from '../fixture.mjs';

const hasScript = spawnSync('script', ['--version'], { encoding: 'utf8' }).stdout?.includes('util-linux');

const KEY = { right: '\x1b[C', left: '\x1b[D', enter: '\r', esc: '\x1b' };

// 화면 하나를 기다리는 최대 시간. 기다림 7번을 다 써도 테스트 제한 시간 안에 끝나야 finally 의 정리가 돈다.
const WAIT_MS = 8_000;

test('f → ←/→ → Enter → Esc 로 오가고, Esc 로는 끝나지 않고 q 로 끝난다', { skip: !hasScript && 'util-linux script 없음', timeout: 120_000 }, async () => {
  makeSession();
  // 경로는 환경 변수로 넘겨 따옴표가 든 경로에서도 명령이 깨지지 않게 한다.
  const cmd = 'stty cols 140 rows 45; exec "$AITOP_NODE" "$AITOP_BIN"';
  const child = spawn('script', ['-qfec', cmd, '/dev/null'], { env: { ...process.env, AITOP_NODE: process.execPath, AITOP_BIN: BIN } });
  let out = '';
  // 한글이 출력 조각 경계에서 잘려도 깨지지 않게 문자열 스트림으로 받는다.
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  // 마지막으로 그린 한 화면(커서를 맨 위로 옮긴 뒤의 내용)만 본다.
  const screen = () => out.split('\x1b[H').at(-1).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const waitFor = async (re, what) => {
    const end = Date.now() + WAIT_MS;
    while (Date.now() < end) {
      if (re.test(screen())) return;
      await sleep(50);
    }
    throw new Error(`${what} 화면이 나오지 않음\n${screen()}`);
  };
  const press = async (key) => {
    child.stdin.write(key);
    await sleep(200);
  };

  try {
    await waitFor(/── 변경 파일 /, '첫');
    await press('f');
    await waitFor(/파일 선택/, '목록 포커스');
    await press(KEY.right);
    await waitFor(/‹전체›/, '전체 탭');
    await press(KEY.left);
    await waitFor(/‹이번 지시›/, '이번 지시 탭');
    await press(KEY.enter);
    await waitFor(/── ‹ src\/(app|footer)\.mjs/, 'diff');
    await press(KEY.esc);
    await waitFor(/파일 선택/, 'diff 에서 Esc');
    await press(KEY.esc);
    await waitFor(/n +다음/, '목록에서 Esc');
    await press(KEY.esc);
    await sleep(1_500);
    assert.equal(child.exitCode, null, 'Esc 로는 끝나지 않는다');
    await press('q');
    const code = await Promise.race([exited, sleep(5_000).then(() => 'timeout')]);
    assert.equal(code, 0, 'q 로 끝난다');
    assert.match(out, /\x1b\]0;\u{F06A9} (\(\d+[◆●][^)]*\) )?aitop\x07/u, '창 제목을 Nerd 아이콘과 함께 쓴다');
    assert.match(out, /\x1b\]1337;SetUserVar=aitop=MQ==\x07/, 'WezTerm user var 를 내보낸다');
    assert.ok(out.lastIndexOf('SetUserVar=aitop=\x07') > out.lastIndexOf('SetUserVar=aitop=MQ=='), '끝낼 때 user var 를 지운다');
    assert.ok(out.indexOf('\x1b[22;0t') < out.lastIndexOf('\x1b[23;0t'), '시작할 때 저장한 창 제목을 끝낼 때 되돌린다');
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
  }
});

// --on-waiting: 처음부터 응답 대기인 세션에는 실행하지 않고, 실행 중 새로 응답 대기가 된 세션에만 실행한다.
test('--on-waiting 은 새로 응답 대기가 된 세션에만 환경변수로 정보를 넘겨 명령을 실행한다', { skip: !hasScript && 'util-linux script 없음', timeout: 60_000 }, async () => {
  const fx = makeSession();
  const dir = mkdtempSync(join(tmpdir(), 'aitop-hook-'));
  const log = join(dir, 'hook.log');
  // 두 번째 세션은 다른 살아 있는 pid 가 필요하다.
  const other = spawn('sleep', ['60'], { stdio: 'ignore' });
  const wait = (id, name, pid) => {
    fx.session({ sessionId: id, pid, name, status: 'waiting', waitingFor: 'approve Bash', cwd: '/work/demo' });
    fx.transcript(id, [user('해줘'), assistant(id, [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }], usage(10, 5))]);
  };
  wait('e2eold00-1', '처음부터 대기', process.pid);
  const cmd = 'stty cols 140 rows 45; exec "$AITOP_NODE" "$AITOP_BIN" --on-waiting "$AITOP_HOOK"';
  const hook = `printf '%s|%s|%s\\n' "$AITOP_TOOL" "$AITOP_SESSION_ID" "$AITOP_WAITING_FOR" >> hook.log`;
  // 훅은 aitop 의 작업 폴더(dir)에서 돈다. 세션 id 속 $(touch pwned) 가 실행되면 dir/pwned 가 생긴다.
  const child = spawn('script', ['-qfec', cmd, '/dev/null'], { cwd: dir, env: { ...process.env, AITOP_NODE: process.execPath, AITOP_BIN: BIN, AITOP_HOOK: hook } });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => (out += d));
  try {
    const end = Date.now() + WAIT_MS;
    while (!out.includes('처음부터 대기') && Date.now() < end) await sleep(50);
    await sleep(1_500);
    const evil = 'e2enew00-$(touch pwned)';
    wait(evil, '새 대기', other.pid);
    const until = Date.now() + WAIT_MS;
    while (!(existsSync(log) && readFileSync(log, 'utf8').includes('e2enew00')) && Date.now() < until) await sleep(100);
    await sleep(500);
    const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    assert.deepEqual(lines, [`claude|${evil}|approve Bash`], '새 대기 세션에만 한 번 실행된다');
    assert.equal(existsSync(join(dir, 'pwned')), false, '세션 값이 명령으로 실행되지 않는다');
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
    other.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

// 처리되지 않은 Promise 거부: 터미널을 되돌리고, 로그(--debug)에 남기고, 0 이 아닌 코드로 끝난다.
test('unhandledRejection 이면 화면을 되돌리고 0 이 아닌 코드로 끝나며 디버그 로그에 남긴다', { skip: !hasScript && 'util-linux script 없음', timeout: 60_000 }, async () => {
  makeSession();
  const dir = mkdtempSync(join(tmpdir(), 'aitop-reject-'));
  const preload = join(dir, 'reject.mjs');
  // aitop 이 대체 화면에 들어가는 순서를 쓰면 그 다음 차례에 거부를 일으킨다 (시간에 기대지 않는다). aitop 코드는 건드리지 않는다.
  writeFileSync(
    preload,
    `const write = process.stdout.write;
let fired = false;
process.stdout.write = function (chunk, ...rest) {
  if (!fired && String(chunk).includes('\\x1b[?1049h')) {
    fired = true;
    setImmediate(() => Promise.reject(new Error('boom token=abcdef123456')));
  }
  return write.call(this, chunk, ...rest);
};
`,
  );
  const cmd = 'stty cols 140 rows 45; exec "$AITOP_NODE" --import "$AITOP_PRELOAD" "$AITOP_BIN" --debug';
  const child = spawn('script', ['-qfec', cmd, '/dev/null'], { env: { ...process.env, AITOP_NODE: process.execPath, AITOP_BIN: BIN, AITOP_PRELOAD: pathToFileURL(preload).href, XDG_STATE_HOME: dir } });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    const code = await Promise.race([exited, sleep(WAIT_MS * 2).then(() => 'timeout')]);
    assert.notEqual(code, 'timeout', '스스로 끝난다');
    assert.notEqual(code, 0, '0 이 아닌 코드로 끝난다');
    assert.ok(out.indexOf('\x1b[?1049h') >= 0, '실시간 화면에 들어갔다');
    assert.ok(out.lastIndexOf('\x1b[?1049l') > out.lastIndexOf('\x1b[?1049h'), '대체 화면에서 나온다');
    assert.ok(out.lastIndexOf('\x1b[?25h') > out.lastIndexOf('\x1b[?25l'), '커서를 되돌린다');
    assert.match(out, /aitop: 처리되지 않은 오류로 끝냅니다 \(boom token=••••\)/);
    assert.doesNotMatch(out, /abcdef123456/);
    const log = readFileSync(join(dir, 'aitop', 'aitop.log'), 'utf8');
    assert.match(log, /\[aitop\] unhandledRejection: Error: boom token=••••/);
    assert.doesNotMatch(log, /abcdef123456/);
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

// p: 고른 세션을 맨 위에 고정하고, 정렬(s)을 바꿔도 맨 위에 남으며, 다시 누르면 풀린다. 색 없이(NO_COLOR) 본다.
test('p 로 세션을 맨 위에 고정·해제하고, s 로 정렬을 바꿔도 고정은 맨 위에 남는다', { skip: !hasScript && 'util-linux script 없음', timeout: 60_000 }, async () => {
  const fx = makeSession();
  // 세션 파일은 pid 마다 하나라서 둘째 세션은 다른 살아 있는 프로세스의 pid 를 쓴다.
  const other = spawn('sleep', ['60'], { stdio: 'ignore' });
  fx.session({ sessionId: 'e2epin00-1', pid: other.pid, name: '둘째 세션', status: 'idle', cwd: '/work/top' });
  fx.transcript('e2epin00-1', [user('위'), assistant('p1', [{ type: 'text', text: '네' }], usage(50_000, 10))]);
  const cmd = 'stty cols 140 rows 30; exec "$AITOP_NODE" "$AITOP_BIN"';
  const child = spawn('script', ['-qfec', cmd, '/dev/null'], { env: { ...process.env, NO_COLOR: '1', AITOP_NODE: process.execPath, AITOP_BIN: BIN } });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => (out += d));
  const screen = () => out.split('\x1b[H').at(-1).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const NAMES = ['둘째 세션', 'e2e 세션'];
  const order = () => NAMES.map((n) => screen().split(/\r?\n/).findIndex((l) => l.includes(n)));
  const waitFor = async (ok, what) => {
    const end = Date.now() + WAIT_MS;
    while (Date.now() < end) {
      if (ok()) return;
      await sleep(50);
    }
    throw new Error(`${what} 화면이 나오지 않음\n${screen()}`);
  };
  const press = async (key) => {
    child.stdin.write(key);
    await sleep(200);
  };
  try {
    await waitFor(() => order().every((i) => i >= 0), '첫');
    // 처음에 아래에 있는 세션으로 내려가 고정한다.
    const [a, b] = order();
    const lower = a > b ? NAMES[0] : NAMES[1];
    const pinnedFirst = () => {
      const [x, y] = order();
      return lower === NAMES[0] ? x < y : y < x;
    };
    assert.ok(!pinnedFirst());
    await press('j');
    await press('p');
    await waitFor(() => screen().includes(`★ ${lower}`), '고정 표시');
    assert.ok(pinnedFirst(), '고정한 세션이 맨 위로');
    assert.match(screen(), /\[p\] 고정 해제/, '색이 없어도 키 안내에 보인다');
    await press('s');
    await waitFor(() => /s:비용/.test(screen()), '비용순');
    assert.ok(pinnedFirst(), '정렬을 바꿔도 맨 위');
    await press('p');
    await waitFor(() => !screen().includes('★'), '고정 해제');
    await press('q');
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
    other.kill('SIGKILL');
  }
});
