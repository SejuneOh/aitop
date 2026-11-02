import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { parsePs, parseLsofCwd, isAlive, findProcesses, isCodex, isGemini, canListProcesses } from '../src/procs.mjs';

test('ps -axo pid=,command= 출력을 pid 와 인자로 나눈다', () => {
  const out = '    1 /sbin/launchd\n  512 node /usr/local/bin/codex --model x\n\n 7001 /Applications/Codex/codex-aarch64-apple-darwin\n';
  const real = new Set(['/sbin/launchd', '/usr/local/bin/codex', '/Applications/Codex/codex-aarch64-apple-darwin']);
  const exists = (p) => real.has(p);
  assert.deepEqual(parsePs(out, exists), [
    { pid: 1, argv: ['/sbin/launchd'] },
    { pid: 512, argv: ['node', '/usr/local/bin/codex', '--model', 'x'] },
    { pid: 7001, argv: ['/Applications/Codex/codex-aarch64-apple-darwin'] },
  ]);
  assert.ok(isCodex(parsePs(out, exists)[1].argv));
  assert.ok(isCodex(parsePs(out, exists)[2].argv));
});

test('ps 출력에서 공백이 든 경로를 이어 붙인다', () => {
  const node = '/Users/a/Library/Application Support/fnm/node-versions/v22/installation/bin/node';
  const script = '/Users/a/Library/Application Support/fnm/node-versions/v22/installation/bin/gemini';
  const real = new Set([node, script, '/Applications/My Tools/Codex App/codex']);
  const out = `  10 ${node} ${script} --yolo\n  11 /Applications/My Tools/Codex App/codex resume\n`;
  const [a, b] = parsePs(out, (p) => real.has(p));
  assert.deepEqual(a.argv, [node, script, '--yolo']);
  assert.ok(isGemini(a.argv));
  assert.deepEqual(b.argv, ['/Applications/My Tools/Codex App/codex', 'resume']);
  assert.ok(isCodex(b.argv));
});

test('lsof -Fn 출력에서 작업 폴더를 꺼낸다', () => {
  assert.equal(parseLsofCwd('p512\nfcwd\nn/Users/me/work/my project\n'), '/Users/me/work/my project');
  assert.equal(parseLsofCwd(''), null);
});

test('isAlive 는 신호 없이 프로세스가 있는지만 본다', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(1), true, '다른 사용자 프로세스(EPERM)도 살아 있다');
  assert.equal(isAlive(2 ** 22 + 12345), false);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(NaN), false);
});

test('실행 중인 codex 프로세스와 작업 폴더를 찾는다 (Linux /proc, macOS ps·lsof)', { skip: !canListProcesses() && '이 OS 는 프로세스 목록을 지원하지 않음' }, async () => {
  // 공백이 든 폴더에서 띄워 macOS ps 출력의 경로 이어 붙이기도 확인한다.
  const dir = mkdtempSync(join(tmpdir(), 'aitop procs '));
  writeFileSync(join(dir, 'codex.js'), 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [join(dir, 'codex.js')], { cwd: dir, stdio: 'ignore' });
  try {
    let found;
    for (let i = 0; i < 40 && !found; i++) {
      await sleep(100);
      found = findProcesses(isCodex).find((p) => p.pid === child.pid);
    }
    assert.ok(found, 'codex.js 프로세스를 찾는다');
    assert.equal(realpathSync(found.cwd), realpathSync(dir));
  } finally {
    child.kill();
  }
});
