// #202: 대기 프로세스(spare)와 pid 재사용으로 생기는 유령 세션, sessions 파일 캐시 (#135).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { makeClaudeHome } from './fixture.mjs';

const fx = makeClaudeHome();
const { collectClaude, _sessionReads } = await import('../src/sources/claude.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { _setStatReader, sameProcess, parseStartTicks } = await import('../src/procs.mjs');

const run = (opts = {}) => collectClaude({ showEnded: false, budget: createBudget(), ...opts });
// /proc/<pid>/stat 모양의 가짜 원문. 22번째 칸이 시작 틱이다.
const fakeStat = (ticks) => () => `${process.pid} (claude (x) y) S ${Array.from({ length: 18 }, (_, i) => i + 1).join(' ')} ${ticks} 0 0`;
const sessions = join(fx.home, 'sessions');

let prevReader;
afterEach(() => {
  if (prevReader !== undefined) _setStatReader(prevReader);
  prevReader = undefined;
  for (const f of readdirSync(sessions)) unlinkSync(join(sessions, f));
});
const withStat = (fn) => {
  const prev = _setStatReader(fn);
  if (prevReader === undefined) prevReader = prev;
};

test('stat 원문에서 시작 틱을 읽는다 (명령 이름에 괄호·공백이 있어도)', () => {
  assert.equal(parseStartTicks(fakeStat(4111425)()), 4111425);
  assert.equal(parseStartTicks('garbage'), null);
  assert.equal(parseStartTicks('1 x S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20'), null, "')' 없음");
});

test('대기 프로세스(spare 가 참)는 세션에서 뺀다', () => {
  fx.session({ sessionId: 'spare-0001', kind: 'bg', spare: true, jobId: 'j1' });
  assert.deepEqual(run(), []);
  assert.deepEqual(run({ showEnded: true }).filter((s) => s.id === 'spare-0001'), []);
});

test('작업을 맡은 bg 세션(spare 없음, 또는 거짓)은 남긴다', () => {
  fx.session({ sessionId: 'claimed-0001', kind: 'bg', jobId: 'j1' });
  fx.session({ sessionId: 'claimed-0002', kind: 'bg', jobId: 'j2', spare: false, pid: process.ppid });
  const ids = run().map((s) => s.id).sort();
  assert.deepEqual(ids, ['claimed-0001', 'claimed-0002']);
  assert.equal(run()[0].kind, 'background');
});

test('procStart 가 지금 프로세스의 시작 틱과 다르면 pid 재사용으로 보고 살아 있지 않다', () => {
  withStat(fakeStat(5000));
  fx.session({ sessionId: 'reuse-0001', procStart: '5000' });
  assert.equal(run()[0]?.live, true, '같은 시작 틱이면 살아 있다');
  withStat(fakeStat(9_000_000));
  assert.deepEqual(run(), [], '다른 프로세스가 pid 를 다시 씀');
  const [ended] = run({ showEnded: true });
  assert.equal(ended.live, false);
  assert.equal(ended.status, 'ended');
});

test('작은 차이는 같은 프로세스로 본다', () => {
  withStat(fakeStat(1050));
  assert.equal(sameProcess(process.pid, '1000'), true);
  withStat(fakeStat(2000));
  assert.equal(sameProcess(process.pid, '1000'), false);
});

test('procStart 가 없거나 /proc 를 못 읽으면 예전처럼 pid 만 본다', () => {
  withStat(fakeStat(9_000_000));
  fx.session({ sessionId: 'nostart-0001' });
  assert.equal(run()[0]?.live, true, 'procStart 없음');
  withStat(null);
  fx.session({ sessionId: 'noproc-0001', pid: process.ppid, procStart: '5000' });
  assert.deepEqual(run().map((s) => s.live), [true, true], '/proc 없음 (macOS·Windows)');
  withStat(() => {
    throw new Error('ENOENT');
  });
  assert.deepEqual(run().map((s) => s.live), [true, true], 'stat 읽기 실패');
});

test('sessions 파일은 수정 시각·크기가 그대로면 다시 읽지 않고, 바뀌면 다시 읽는다', () => {
  const p = join(sessions, `${process.pid}.json`);
  // 방금 바뀐 파일은 시각 단위가 거칠어 믿지 않으므로, 시각을 과거로 돌려 둔다.
  const past = (s) => utimesSync(p, new Date(Date.now() - s * 1000), new Date(Date.now() - s * 1000));
  fx.session({ sessionId: 'cache-0001', name: 'first' });
  past(60);
  run();
  const before = _sessionReads();
  run();
  run();
  assert.equal(_sessionReads(), before, '그대로면 다시 읽지 않음');
  fx.session({ sessionId: 'cache-0001', name: 'second-name' });
  past(30);
  const [s] = run();
  assert.equal(_sessionReads(), before + 1, '바뀐 파일 하나만 다시 읽음');
  assert.equal(s.name, 'second-name');
  run();
  assert.equal(_sessionReads(), before + 1);
});

test('방금 바뀐 파일은 같은 크기·시각이어도 다시 읽는다 (거친 수정 시각)', () => {
  fx.session({ sessionId: 'racy-0001', name: 'aaaa' });
  run();
  const before = _sessionReads();
  run();
  assert.equal(_sessionReads(), before + 1);
});

test('끝난 pid 의 파일은 다시 확인하지 않고, 파일이 사라지면 캐시에서도 지운다', () => {
  fx.session({ sessionId: 'dead-0001', pid: 2 ** 22 + 4321, updatedAt: Date.now() });
  fx.session({ sessionId: 'live-0001' });
  const ids = () => run({ showEnded: true }).filter((s) => s.id.endsWith('-0001')).map((s) => `${s.id}:${s.live}`).sort();
  assert.deepEqual(ids(), ['dead-0001:false', 'live-0001:true']);
  unlinkSync(join(sessions, `${2 ** 22 + 4321}.json`));
  assert.deepEqual(ids(), ['live-0001:true']);
});

test('끝난 것으로 캐시된 파일을 새 프로세스 내용이 덮어쓰면 다시 살아 있다', () => {
  withStat(fakeStat(7000));
  const p = join(sessions, `${process.pid}.json`);
  // 예전 프로세스: 같은 pid 지만 시작 틱이 다르다 (pid 재사용)
  fx.session({ sessionId: 'rewrite-old', procStart: '1000' });
  utimesSync(p, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.deepEqual(run(), []);
  assert.deepEqual(run(), [], '끝난 것으로 캐시');
  // 새 프로세스가 같은 이름의 파일을 덮어쓴다
  fx.session({ sessionId: 'rewrite-new', procStart: '7000' });
  utimesSync(p, new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
  const live = run();
  assert.deepEqual(live.map((s) => `${s.id}:${s.live}`), ['rewrite-new:true']);
});
