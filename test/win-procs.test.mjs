// Windows 프로세스 목록 (PowerShell CIM, #195). 가짜 실행기와 _setWinScanner 로 어느 OS 에서나 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeClaudeHome } from './fixture.mjs';

makeClaudeHome();
const root = mkdtempSync(join(tmpdir(), 'aitop-win-procs-'));
process.env.CODEX_HOME = join(root, 'codex');
const procs = await import('../src/procs.mjs');
const { splitCommandLine, parseCim, createWinScanner, _setWinScanner, findProcesses, isCodex, canListProcesses, processStart, sameProcess, processMethod, CIM_SCRIPT } = procs;
const { collectCodex, pairByStart } = await import('../src/sources/codex.mjs');
const { doctorText } = await import('../src/doctor.mjs');

const b64 = (v) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');

test('splitCommandLine: CommandLineToArgvW 규칙', () => {
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" C:\\npm\\codex.js --model x'), ['C:\\Program Files\\nodejs\\node.exe', 'C:\\npm\\codex.js', '--model', 'x']);
  assert.deepEqual(splitCommandLine('C:\\a\\codex.exe "a b" c'), ['C:\\a\\codex.exe', 'a b', 'c']);
  // 첫 칸은 \ 를 풀지 않는다.
  assert.deepEqual(splitCommandLine('C:\\x\\ y'), ['C:\\x\\', 'y']);
  // 2n 개의 \ 뒤 " 는 \ n 개, 2n+1 개면 글자 ", 따옴표 안의 "" 는 글자 ".
  assert.deepEqual(splitCommandLine('p a\\\\"b c" d\\"e "x""y" f\\g'), ['p', 'a\\b c', 'd"e', 'x"y', 'f\\g']);
  assert.deepEqual(splitCommandLine('  '), []);
  assert.deepEqual(splitCommandLine('"C:\\only one.exe"'), ['C:\\only one.exe']);
});

test('parseCim: base64 JSON, 객체 하나, 명령줄 없는 프로세스, 이상한 pid', () => {
  const list = parseCim(b64([
    { p: 10, q: 4, n: 'node.exe', c: '"C:\\node.exe" C:\\npm\\codex.js', s: 1_700_000_000_000 },
    { p: 11, q: 10, n: 'System', c: null, s: null },
    { p: 0, q: 0, n: 'Idle', c: null },
    { p: 12, q: 1, n: '한글.exe', c: 'C:\\사용자\\한글.exe', s: 5 },
  ]));
  assert.deepEqual(list.map((p) => p.pid), [10, 11, 12]);
  assert.deepEqual(list[0], { pid: 10, ppid: 4, name: 'node.exe', argv: ['C:\\node.exe', 'C:\\npm\\codex.js'], start: 1_700_000_000_000 });
  assert.deepEqual(list[1].argv, ['System']);
  assert.equal(list[1].start, null);
  assert.equal(list[2].argv[0], 'C:\\사용자\\한글.exe');
  assert.equal(parseCim(JSON.stringify({ p: 7, n: 'a.exe', c: 'a.exe' })).length, 1);
  assert.deepEqual(parseCim(''), []);
});

test('CIM 스크립트는 한 번의 Get-CimInstance 로 pid·부모·이름·명령줄·시작 시각을 받는다', () => {
  assert.equal(CIM_SCRIPT.match(/Get-CimInstance/g).length, 1);
  for (const k of ['ProcessId', 'ParentProcessId', 'Name', 'CommandLine', 'CreationDate']) assert.match(CIM_SCRIPT, new RegExp(k));
});

test('목록기: 첫 호출만 기다려 받고, TTL 이 지나면 뒤에서 새로 받으며 그동안 직전 목록을 준다', async () => {
  let t = 1000;
  const calls = { sync: 0, async: 0 };
  let next = [{ p: 1, n: 'a.exe', c: 'a.exe', s: 1 }];
  const s = createWinScanner({ now: () => t, ttl: 5000, runSync: () => (calls.sync++, b64(next)), runAsync: async () => (calls.async++, b64(next)) });
  assert.deepEqual(s.list().map((p) => p.pid), [1]);
  assert.equal(s.ok(), true);
  assert.equal(calls.sync, 1);
  t += 4999;
  s.list();
  assert.equal(calls.async, 0, 'TTL 안에서는 부르지 않는다');
  next = [{ p: 2, n: 'b.exe', c: 'b.exe', s: 2 }];
  t += 1;
  assert.deepEqual(s.list().map((p) => p.pid), [1], '새 목록을 받는 동안은 직전 목록');
  s.list();
  await s.settle();
  assert.equal(calls.async, 1, '받는 중에는 한 번만 부른다');
  assert.deepEqual(s.list().map((p) => p.pid), [2]);
  assert.equal(s.startOf(2), 2);
  assert.equal(s.startOf(1), null);
  assert.equal(calls.sync, 1);
});

test('목록기: 실패하면 ok 가 false 이고 목록을 비우며, 한참 뒤에 다시 해 본다', async () => {
  let t = 0;
  let fail = true;
  let n = 0;
  const run = () => {
    n++;
    if (fail) throw new Error('no powershell');
    return b64([{ p: 3, n: 'c.exe', c: 'c.exe' }]);
  };
  const s = createWinScanner({ now: () => t, ttl: 5000, retry: 60_000, runSync: run, runAsync: async () => run() });
  assert.equal(s.ok(), false);
  assert.deepEqual(s.list(), []);
  t += 10_000;
  s.list();
  await s.settle();
  assert.equal(n, 1, '실패 뒤에는 TTL 이 아니라 retry 를 기다린다');
  fail = false;
  t += 60_000;
  s.list();
  await s.settle();
  assert.equal(s.ok(), true);
  assert.deepEqual(s.list().map((p) => p.pid), [3]);
});

test('목록기: 뒤에서 받기가 한두 번 실패하면 직전 목록을 두고, 3번 이어 실패해야 버린다', async () => {
  let t = 0;
  let fail = false;
  const run = () => {
    if (fail) throw new Error('timeout');
    return b64([{ p: 4, n: 'd.exe', c: 'd.exe', s: 1 }]);
  };
  const s = createWinScanner({ now: () => t, ttl: 5000, runSync: run, runAsync: async () => run() });
  assert.deepEqual(s.list().map((p) => p.pid), [4]);
  fail = true;
  for (let i = 1; i <= 2; i++) {
    t += 5000;
    s.list();
    await s.settle();
    assert.equal(s.ok(), true, `${i}번 실패`);
    assert.deepEqual(s.list().map((p) => p.pid), [4]);
    assert.equal(s.startOf(4), 1);
  }
  t += 5000;
  s.list();
  await s.settle();
  assert.equal(s.ok(), false, '3번 이어 실패');
  assert.deepEqual(s.list(), []);
  // 성공하면 실패 수를 다시 센다.
  fail = false;
  t += 60_000;
  s.list();
  await s.settle();
  assert.equal(s.ok(), true);
  fail = true;
  t += 5000;
  s.list();
  await s.settle();
  assert.equal(s.ok(), true);
});

test('부모 pid 가 codex 여도 부모가 자식보다 늦게 떴으면(pid 재사용) 자식을 따로 센다', () => {
  const fake = createWinScanner({
    runSync: () =>
      b64([
        { p: 700, q: 1, n: 'codex.exe', c: 'C:\\t\\codex.exe', s: 9000 },
        { p: 701, q: 700, n: 'codex.exe', c: 'C:\\t\\codex.exe', s: 5000 },
        { p: 702, q: 700, n: 'codex.exe', c: 'C:\\t\\codex.exe', s: 9500 },
      ]),
    runAsync: async () => '[]',
  });
  const prev = _setWinScanner(fake);
  try {
    assert.deepEqual(findProcesses(isCodex).map((p) => p.pid), [700, 701]);
  } finally {
    _setWinScanner(prev);
  }
});

test('_setWinScanner: findProcesses 는 cwd 없이 돌려주고, 부모도 맞는 자식(node → codex.exe)은 한 번만 센다', () => {
  const fake = createWinScanner({
    runSync: () =>
      b64([
        { p: 100, q: 50, n: 'node.exe', c: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', s: 1000 },
        { p: 101, q: 100, n: 'codex-x86_64-pc-windows-msvc.exe', c: 'C:\\Users\\u\\npm\\codex-x86_64-pc-windows-msvc.exe', s: 1100 },
        { p: 200, q: 50, n: 'codex.exe', c: 'C:\\tools\\codex.exe resume', s: 2000 },
        { p: process.pid, q: 1, n: 'node.exe', c: 'node codex.js', s: 1 },
        { p: 300, q: 1, n: 'notepad.exe', c: 'notepad.exe', s: 3 },
      ]),
    runAsync: async () => '[]',
  });
  const prev = _setWinScanner(fake);
  try {
    assert.equal(canListProcesses(), true);
    const found = findProcesses(isCodex);
    assert.deepEqual(found, [
      { pid: 100, argv: found[0].argv, cwd: null, cwdUnknown: true },
      { pid: 200, argv: ['C:\\tools\\codex.exe', 'resume'], cwd: null, cwdUnknown: true },
    ]);
    assert.equal(processStart(200), 2000);
    assert.deepEqual(processMethod().kind, 'cim');
    // pid 재사용: 세션 파일에 마지막으로 쓰인 뒤 5초 넘게 지나 뜬 프로세스는 다른 프로세스다.
    assert.equal(sameProcess(200, undefined, 1000), true);
    assert.equal(sameProcess(200, undefined, -3000), true);
    assert.equal(sameProcess(200, undefined, -3001), false);
    assert.equal(sameProcess(200, undefined, undefined), true, '쓰인 시각이 없으면 알 수 없으니 같은 프로세스');
    assert.equal(sameProcess(999, undefined, 0), true, '목록에 없는 pid 는 알 수 없음');
  } finally {
    _setWinScanner(prev);
  }
});

test('Linux·macOS 는 목록기가 없어 예전 방식 그대로다', { skip: process.platform === 'win32' && 'Windows 는 목록기가 있다' }, () => {
  assert.equal(processMethod(), null);
  assert.equal(sameProcess(process.pid, undefined, 0), true);
});

test('--doctor: Windows 는 프로세스 목록 방식과 걸린 시간을 보인다', () => {
  const base = { platform: 'win32', processes: true, processMethod: { kind: 'cim', ms: 812 }, tools: {} };
  assert.match(doctorText(base, '0.0.0', Date.now(), 'ko'), /win32, 프로세스 확인 가능 · PowerShell CIM 0\.8초/);
  assert.match(doctorText(base, '0.0.0', Date.now(), 'en'), /win32, processes visible · PowerShell CIM 0\.8s/);
  assert.match(doctorText({ ...base, processes: false, processMethod: { kind: 'cim', ms: null } }, '0.0.0', Date.now(), 'ko'), /프로세스 확인 불가 · PowerShell CIM \?초/);
  assert.doesNotMatch(doctorText({ platform: 'linux', processes: true, tools: {} }, '0.0.0', Date.now(), 'ko'), /CIM/);
});

// files 는 [이름, 세션 시작, 마지막 쓰기] 목록. 최근에 바뀐 순서로 넘긴다.
function pair(pids, start, rows) {
  const files = rows.map(([path, s, mtime]) => ({ path, s, mtime })).sort((a, b) => b.mtime - a.mtime);
  const sess = Object.fromEntries(files.map((f) => [f.path, f.s]));
  return Object.fromEntries(pairByStart(pids, files, (p) => sess[p], (pid) => start[pid] ?? null));
}

test('pairByStart: 프로세스마다 그 프로세스가 뜬 뒤 시작한 세션 중 가장 최근에 기록된 것을 준다', () => {
  const M = 60_000;
  // /new: codex 하나가 60분 전에 떠 S1(59분 전 시작, 40분 전 마지막 기록) 뒤 /new 로 S2(30분 전 시작, 1분 전 기록)를 열었다.
  assert.deepEqual(pair([501], { 501: -60 * M }, [['s1', -59 * M, -40 * M], ['s2', -30 * M, -1 * M]]), { s2: 501 });
  // /new 를 한 쪽이 오래된 프로세스이고 다른 codex 도 있을 때: 지금 쓰는 두 세션이 모두 실행 중이다.
  const two = pair([501, 502], { 501: -60 * M, 502: -20 * M }, [['s1', -59 * M, -40 * M], ['s2', -30 * M, -1 * M], ['s3', -19 * M, -2 * M]]);
  assert.deepEqual(two, { s2: 501, s3: 502 });
  // 오래된 쪽의 /new 가 새 프로세스보다 늦게 시작했으면 pid 는 서로 바뀔 수 있지만, 실행 중인 세션은 맞다.
  const late = pair([501, 502], { 501: -60 * M, 502: -20 * M }, [['s1', -59 * M, -40 * M], ['s2', -10 * M, -1 * M], ['s3', -19 * M, -2 * M]]);
  assert.deepEqual(Object.keys(late).sort(), ['s2', 's3']);
  assert.deepEqual(Object.values(late).sort(), [501, 502]);
  // 같은 작업 폴더에서 띄운 codex 둘(Windows 는 폴더를 보지 않는다): 각자 뜬 뒤 시작한 세션.
  assert.deepEqual(pair([601, 602], { 601: -50 * M, 602: -10 * M }, [['a', -49 * M, -3 * M], ['b', -9 * M, -1 * M]]), { a: 601, b: 602 });
  // 알려진 한계 (1회차 재현): A(501) 는 60분 전에 떠 그 직후 시작한 세션이 50분째 쉬고, 다른 터미널의 B 는 30분 전에 떠
  // 1분 전에 끝났다. 시각만으로는 /new 와 구별할 수 없어 끝난 B 세션이 잠시 실행 중으로 보인다. A 가 다시 기록하면 바로잡힌다.
  assert.deepEqual(pair([501], { 501: -60 * M }, [['long', -59 * M, -50 * M], ['closed', -30 * M, -1 * M]]), { closed: 501 });
  assert.deepEqual(pair([501], { 501: -60 * M }, [['long', -59 * M, 0], ['closed', -30 * M, -1 * M]]), { long: 501 });
  // 둘 다 살아 있으면 각자 자기 세션.
  assert.deepEqual(pair([501, 502], { 501: -60 * M, 502: -30 * M }, [['long', -59 * M, -50 * M], ['b', -30 * M, -1 * M]]), { long: 501, b: 502 });
  // 이어 연 세션(프로세스보다 먼저 시작): 뜬 뒤에 쓰인 가장 최근 파일. 뜨기 전에 마지막으로 쓰인 파일은 받지 않는다.
  assert.deepEqual(pair([7], { 7: 1000 }, [['old', 0, 500], ['resumed', 0, 3000], ['older', 0, 2000]]), { resumed: 7 });
  assert.deepEqual(pair([7], { 7: 1000 }, [['old', 0, 500]]), {});
  // 시작 시각을 모르면 이어 연 세션 규칙으로만, 가장 최근 파일.
  assert.deepEqual(pair([9], {}, [['x', 0, 10], ['y', 0, 20]]), { y: 9 });
});

// Codex rollout 하나를 쓴다. ageMs 전에 시작해 mtimeAgo 전에 마지막으로 쓰였다.
function rollout(name, ageMs, mtimeAgo) {
  const d = new Date(Date.now() - ageMs);
  const dir = join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${name}.jsonl`);
  const cwd = `C:\\work\\${name}`;
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: name, timestamp: d.toISOString(), cwd } }) + '\n');
  const t = (Date.now() - mtimeAgo) / 1000;
  utimesSync(path, t, t);
}

test('Codex: 프로세스 목록이 있으면 10분 규칙 대신 시작 시각으로 짝짓는다', () => {
  const min = 60_000;
  rollout('long', 60 * min, 20 * min); // 20분 동안 기록이 없지만 프로세스가 살아 있다
  rollout('newer', 5 * min, 1 * min);
  rollout('closed', 90 * min, 2 * min); // 2분 전에 끝난 세션: 맞는 프로세스가 없다
  const start = { 501: Date.now() - 61 * min, 502: Date.now() - 6 * min };
  const rows = collectCodex({
    showEnded: false,
    canList: () => true,
    filesOf: () => null,
    startOf: (pid) => start[pid] ?? null,
    procsOf: () => [
      { pid: 501, argv: ['codex.exe'], cwd: null, cwdUnknown: true },
      { pid: 502, argv: ['codex.exe'], cwd: null, cwdUnknown: true },
    ],
  });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.pid]));
  assert.deepEqual(byId, { long: 501, newer: 502 });
  // 같은 기록을 프로세스 목록 없이 보면 예전 10분 규칙이다.
  const blind = collectCodex({ showEnded: false, canList: () => false });
  assert.deepEqual(blind.map((r) => r.id).sort(), ['closed', 'newer']);
});
