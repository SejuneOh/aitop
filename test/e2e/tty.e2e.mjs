// 가상 터미널(util-linux script)에서 aitop 을 띄우고 실제 키를 보내 화면과 종료 동작을 확인한다.
// script 가 없는 환경(macOS 기본 script 는 옵션이 다르다)에서는 건너뛴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { BIN, makeSession } from './session.mjs';

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
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
  }
});
