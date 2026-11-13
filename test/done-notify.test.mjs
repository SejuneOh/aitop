// 작업 끝남(done)·context 경고 알림 (#204). 실제 알림은 띄우지 않고 가짜 spawnFn 으로 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventWatch, takeEvents } from '../src/attention.mjs';
import { notifyOptions, parseEvents, createNotifier, notifyText } from '../src/notify.mjs';
import { readConfigFile, resolveConfig, configText } from '../src/config.mjs';
import { settingsLine } from '../src/help.mjs';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const S = 1000;
const M = 60 * S;
const s = (id, status, extra = {}) => ({ id, status, live: status !== 'ended', tool: 'claude', project: 'demo', context: { used: 0, window: 200_000 }, ...extra });

// 상태 목록을 시간 순서로 흘려 보내고 나온 알림을 모은다. steps: [[ms, status, extra?], ...]
function run(steps, opts = {}) {
  const w = createEventWatch(opts);
  const out = [];
  for (const [at, status, extra] of steps) out.push(...takeEvents(w, [s('a', status, extra)], { now: at }).map((e) => `${e.kind}@${at}`));
  return out;
}

test('3분 넘게 작업한 뒤 대기가 5초 이어지면 done 을 한 번만 알린다', () => {
  assert.deepEqual(run([[0, 'busy'], [2 * M, 'shell'], [4 * M, 'idle'], [4 * M + 2 * S, 'idle'], [4 * M + 5 * S, 'idle'], [5 * M, 'idle'], [6 * M, 'idle']]), ['done@245000']);
});

test('짧은 작업은 알리지 않는다', () => {
  assert.deepEqual(run([[0, 'busy'], [2 * M, 'idle'], [2 * M + 10 * S, 'idle']]), []);
});

test('도구 호출 사이의 잠깐 대기는 끝남이 아니고, 같은 작업으로 이어 센다', () => {
  // 1분마다 2초씩 대기로 깜빡여도 알리지 않다가, 진짜로 멈춘 뒤에 한 번 알린다 (작업 시간은 처음부터 센다).
  const steps = [];
  for (let m = 0; m < 4; m++) steps.push([m * M, 'busy'], [m * M + 30 * S, 'idle'], [m * M + 32 * S, 'busy']);
  steps.push([4 * M, 'idle'], [4 * M + 6 * S, 'idle']);
  assert.deepEqual(run(steps), ['done@246000']);
  // 깜빡임만 있는 짧은 작업은 알리지 않는다.
  assert.deepEqual(run([[0, 'busy'], [10 * S, 'idle'], [12 * S, 'busy'], [20 * S, 'idle'], [30 * S, 'idle']]), []);
});

test('응답 대기는 done 이 아니다 (응답 대기 알림이 따로 있다)', () => {
  assert.deepEqual(run([[0, 'busy'], [4 * M, 'waiting'], [5 * M, 'waiting'], [6 * M, 'waiting']]), []);
  // 허락하고 이어서 일하다 끝나면 한 번 알린다.
  assert.deepEqual(run([[0, 'busy'], [2 * M, 'waiting'], [3 * M, 'busy'], [4 * M, 'idle'], [4 * M + 5 * S, 'idle']]), ['done@245000']);
});

test('응답 대기 시간은 작업 시간에 넣지 않는다 (10초 작업 + 1시간 허락 대기 뒤 끝나도 알리지 않는다)', () => {
  const H = 60 * M;
  assert.deepEqual(run([[0, 'busy'], [10 * S, 'waiting'], [H, 'waiting'], [H + 1 * S, 'busy'], [H + 3 * S, 'idle'], [H + 9 * S, 'idle']]), []);
  // 허락 대기 뒤 바로 대기(idle)로 끝나도 마찬가지다.
  assert.deepEqual(run([[0, 'busy'], [10 * S, 'waiting'], [H, 'idle'], [H + 6 * S, 'idle']]), []);
  // 작업 시간 합(2분 + 1분 30초)이 3분을 넘으면 사이의 응답 대기와 상관없이 알린다.
  assert.deepEqual(run([[0, 'busy'], [2 * M, 'waiting'], [H, 'busy'], [H + 90 * S, 'idle'], [H + 95 * S, 'idle']]), [`done@${H + 95 * S}`]);
});

test('끝난 세션, 하위 에이전트 줄, 상태를 추측한 세션은 알리지 않는다', () => {
  assert.deepEqual(run([[0, 'busy'], [4 * M, 'ended'], [4 * M + 10 * S, 'ended']]), []);
  assert.deepEqual(run([[0, 'busy', { live: false }], [4 * M, 'idle', { live: false }], [4 * M + 10 * S, 'idle', { live: false }]]), []);
  assert.deepEqual(run([[0, 'busy', { parentId: 'p' }], [4 * M, 'idle', { parentId: 'p' }], [4 * M + 10 * S, 'idle', { parentId: 'p' }]]), []);
  assert.deepEqual(run([[0, 'busy', { statusGuessed: true }], [4 * M, 'idle'], [4 * M + 10 * S, 'idle']]), []);
  // 세션 안의 하위 에이전트(members)가 바뀌어도 세션 상태가 그대로면 따로 알리지 않는다.
  const w = createEventWatch();
  takeEvents(w, [s('a', 'idle', { members: [{ name: 'x', status: 'busy' }] })], { now: 0 });
  assert.deepEqual(takeEvents(w, [s('a', 'idle', { members: [{ name: 'x', status: 'idle' }] })], { now: 10 * M }), []);
});

test('같은 작업은 다시 알리지 않고, 새 작업이 길게 이어지면 다시 알린다', () => {
  const steps = [[0, 'busy'], [4 * M, 'idle'], [4 * M + 5 * S, 'idle'], [5 * M, 'busy'], [5 * M + 10 * S, 'idle'], [5 * M + 20 * S, 'idle'], [6 * M, 'busy'], [10 * M, 'idle'], [10 * M + 5 * S, 'idle']];
  assert.deepEqual(run(steps), ['done@245000', 'done@605000']);
});

test('doneMs 로 기준 시간을 바꾸고, 준비 전(ready=false)에는 알리지 않는다', () => {
  assert.deepEqual(run([[0, 'busy'], [2 * M, 'idle'], [2 * M + 5 * S, 'idle']], { doneMs: 1 * M }), ['done@125000']);
  const w = createEventWatch();
  takeEvents(w, [s('a', 'busy')], { now: 0, ready: false });
  takeEvents(w, [s('a', 'idle')], { now: 4 * M, ready: false });
  assert.deepEqual(takeEvents(w, [s('a', 'idle')], { now: 4 * M + 5 * S, ready: false }), []);
});

test('context 는 90% 를 넘을 때 한 번 알리고, 85% 아래로 내려간 뒤에야 다시 알린다', () => {
  const ctx = (pct) => ({ context: { used: pct * 2000, window: 200_000 } });
  const steps = [[0, 'busy', ctx(50)], [1, 'busy', ctx(91)], [2, 'busy', ctx(95)], [3, 'busy', ctx(88)], [4, 'busy', ctx(92)], [5, 'busy', ctx(20)], [6, 'busy', ctx(90)]];
  assert.deepEqual(run(steps), ['context@1', 'context@6']);
  // 처음 본 세션이 이미 넘었으면 알리지 않는다. 창 크기를 모르면 건너뛴다.
  assert.deepEqual(run([[0, 'idle', ctx(95)], [1, 'idle', ctx(96)]]), []);
  assert.deepEqual(run([[0, 'idle', { context: { used: 10, window: 0 } }], [1, 'idle', { context: { used: 999, window: 0 } }]]), []);
});

test('기록을 다 읽기 전(loading)의 새 세션은 context 기준선만 잡고, 다 읽었을 때 이미 넘었으면 알리지 않는다', () => {
  const ctx = (pct, loading) => ({ context: { used: pct * 2000, window: 200_000 }, ...(loading ? { loading: true } : {}) });
  // 여러 틱에 걸쳐 읽는 동안 값이 올라가 다 읽은 첫 틱에 95% 여도 알리지 않는다.
  assert.deepEqual(run([[0, 'idle', ctx(10, true)], [1, 'idle', ctx(60, true)], [2, 'idle', ctx(95)], [3, 'idle', ctx(96)]]), []);
  // 읽는 중에 이미 높았다가 다 읽은 뒤에도 높으면 알리지 않고, 내려갔다 다시 넘으면 알린다.
  assert.deepEqual(run([[0, 'idle', ctx(92, true)], [1, 'idle', ctx(93)], [2, 'idle', ctx(40)], [3, 'busy', ctx(91)]]), ['context@3']);
  // 다 읽은 뒤 기준선이 낮았으면 그 뒤 넘을 때 알린다.
  assert.deepEqual(run([[0, 'idle', ctx(10, true)], [1, 'idle', ctx(50)], [2, 'busy', ctx(91)]]), ['context@2']);
});

test('도움말 설정 줄은 알림이 꺼져 있으면 종류를 보이지 않는다', () => {
  assert.equal(settingsLine({ budgetDay: null, notify: false, events: ['waiting', 'done'], onWaiting: true, debug: false }, 'ko'), '예산 없음 · 알림 꺼짐 · 대기 명령 있음 · 디버그 꺼짐');
});

test('--notify=<종류> 와 설정 파일 notify 배열을 해석하고, --notify 만 주면 기본(waiting)은 그대로다', () => {
  assert.deepEqual(parseEvents('waiting, done,context'), ['waiting', 'done', 'context']);
  assert.equal(parseEvents('done,stalled'), null);
  assert.equal(parseEvents(''), null);
  assert.deepEqual(notifyOptions(['--notify']).events, ['waiting']);
  assert.deepEqual(notifyOptions([]), { notify: false, events: ['waiting'], eventsSet: false, onWaiting: null, rest: [], error: null });
  const a = notifyOptions(['--notify=done,context', '--all']);
  assert.deepEqual([a.notify, a.events, a.eventsSet, a.rest], [true, ['done', 'context'], true, ['--all']]);
  assert.match(notifyOptions(['--notify=stall']).error, /waiting,done,context/);
  assert.ok(notifyOptions(['--notify=']).error);
  // 설정 파일: 배열이면 켜고 종류를 정한다. 명령줄 --notify=<종류> 가 이긴다. --no-notify 는 데스크톱만 끈다.
  assert.deepEqual(notifyOptions([], { notify: ['done'] }).events, ['done']);
  assert.equal(notifyOptions([], { notify: ['done'] }).notify, true);
  assert.deepEqual(notifyOptions(['--notify=context'], { notify: ['done'] }).events, ['context']);
  assert.deepEqual(notifyOptions(['--notify'], { notify: ['done'] }).events, ['done']);
  const off = notifyOptions(['--no-notify'], { notify: ['waiting', 'done'], onWaiting: 'x' });
  assert.deepEqual([off.notify, off.events, off.onWaiting], [false, ['waiting', 'done'], 'x']);
});

test('설정 파일 notify 배열·doneMinutes 를 받고, 잘못된 값은 무시한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aitop-done-'));
  const file = join(dir, 'config.json');
  const resolve = (body) => {
    writeFileSync(file, JSON.stringify(body));
    chmodSync(file, 0o600);
    return resolveConfig({ env: {}, file: readConfigFile(file) });
  };
  const ok = resolve({ notify: ['waiting', 'done'], doneMinutes: 5 });
  assert.deepEqual([ok.values.notify.value, ok.values.doneMinutes.value], [['waiting', 'done'], 5]);
  assert.match(configText(ok), /notify +waiting,done +file/);
  const bad = resolve({ notify: ['stall'], doneMinutes: 0 });
  assert.deepEqual([bad.values.notify.source, bad.values.doneMinutes.value], ['default', 3]);
  assert.equal(bad.problems.length, 2);
  assert.equal(resolve({ notify: [] }).values.notify.source, 'default');
  rmSync(dir, { recursive: true, force: true });
});

test('알리미는 종류별 문구를 쓰고 --on-waiting 명령에 AITOP_EVENT 를 넘긴다', () => {
  // 가짜 자식은 pid 가 없다 (그룹 종료가 aitop 자신에게 가지 않게).
  const calls = [];
  const fake = (file, args, opts) => {
    calls.push({ file, args, env: opts.env });
    return { once() {}, kill() {} };
  };
  const n = createNotifier({ notify: true, onWaiting: 'echo', notifier: { kind: 'notify-send', path: '/x/notify-send' }, env: { PATH: '/bin' }, spawnFn: fake });
  n.fire([s('a', 'idle')], 'done');
  assert.equal(calls[0].file, '/x/notify-send');
  assert.deepEqual(calls[0].args.slice(-2), ['aitop: 작업 끝남 (claude)', 'demo']);
  assert.equal(calls[1].env.AITOP_EVENT, 'done');
  const w = [];
  const m = createNotifier({ onWaiting: 'echo', env: {}, spawnFn: (f, a, o) => (w.push(o.env), { once() {}, kill() {} }) });
  m.fire([s('a', 'waiting')]);
  assert.equal(w[0].AITOP_EVENT, 'waiting', '종류를 주지 않으면 예전처럼 waiting');
  assert.deepEqual(notifyText([s('a', 'busy', { context: { used: 186_000, window: 200_000 } })], 'en', 'context'), { title: 'aitop: context over 90% (claude)', body: 'demo · 93%' });
  assert.equal(notifyText([s('a', 'idle'), s('b', 'idle')], 'en', 'done').body, '2 sessions finished their work');
});

test('도움말 설정 줄은 기본 종류면 예전 그대로, 종류를 정하면 함께 보인다', () => {
  assert.equal(settingsLine({ budgetDay: null, notify: true, events: ['waiting'], onWaiting: false, debug: false }, 'ko'), '예산 없음 · 알림 켜짐 · 디버그 꺼짐');
  assert.equal(settingsLine({ budgetDay: null, notify: true, events: ['waiting', 'done'], onWaiting: false, debug: false }, 'ko'), '예산 없음 · 알림 켜짐 (waiting,done) · 디버그 꺼짐');
});
