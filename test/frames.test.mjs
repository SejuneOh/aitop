import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameTimer } from '../src/frames.mjs';
import { animating } from '../src/ui.mjs';

// setInterval 을 바꿔 끼워 시간을 직접 흘린다.
function fakeTimers() {
  const timers = new Map();
  let seq = 0;
  return {
    setInterval: (fn, ms) => (timers.set(++seq, { fn, ms }), seq),
    clearInterval: (id) => timers.delete(id),
    advance(ms) {
      for (const t of [...timers.values()]) for (let i = 0; i < Math.floor(ms / t.ms); i++) t.fn();
    },
    get count() {
      return timers.size;
    },
  };
}

const session = (over = {}) => ({ id: 's1', name: 'demo', status: 'live', phase: { kind: 'idle' }, members: [], ...over });
const view = (sessions, extra = {}) => ({ data: { sessions }, filter: '', help: false, frame: 0, ...extra });

// bin/aitop.mjs 처럼 그릴 때마다 sync() 를 부른다.
function setup(v) {
  const timers = fakeTimers();
  let draws = 0;
  const frames = frameTimer({
    animating: () => animating(v),
    onFrame: () => {
      v.frame++;
      draws++;
      frames.sync();
    },
    timers,
  });
  return { timers, frames, draws: () => draws };
}

test('움직이는 표시가 없으면 프레임 타이머가 그리지 않는다', () => {
  const v = view([session(), session({ id: 's2', phase: { kind: 'done' } }), session({ id: 's3', status: 'ended', phase: { kind: 'ended' } })]);
  const { timers, frames, draws } = setup(v);
  frames.sync();
  timers.advance(10_000);
  assert.equal(draws(), 0);
  assert.equal(timers.count, 0);
  assert.equal(v.frame, 0);
});

test('작업 중 세션이 있으면 120ms 마다 그리고, 멈추면 타이머도 멈춘다', () => {
  const s = session({ phase: { kind: 'tool' } });
  const v = view([s]);
  const { timers, frames, draws } = setup(v);
  frames.sync();
  timers.advance(1200);
  assert.equal(draws(), 10);
  s.phase = { kind: 'idle' };
  timers.advance(1200);
  assert.equal(draws(), 10);
  assert.equal(frames.running, false);
  assert.equal(timers.count, 0);
});

test('sync 를 여러 번 불러도 타이머는 하나만 돈다', () => {
  const v = view([session({ status: 'waiting', phase: { kind: 'waiting' } })]);
  const { timers, frames } = setup(v);
  for (let i = 0; i < 5; i++) frames.sync();
  assert.equal(timers.count, 1);
});

test('animating: 응답 대기 깜빡임·스피너·일하는 팀원만 움직이는 표시로 본다', () => {
  assert.equal(animating(view([session()])), false);
  assert.equal(animating(view([session({ phase: { kind: 'unseen' } })])), false);
  assert.equal(animating(view([session({ status: 'waiting', phase: { kind: 'waiting' } })])), true);
  assert.equal(animating(view([session({ phase: { kind: 'thinking' } })])), true);
  assert.equal(animating(view([session({ members: [{ status: 'done' }] })])), false);
  assert.equal(animating(view([session({ members: [{ status: 'running' }] })])), true);
  // 도움말 화면, 첫 수집 전, 검색으로 가려진 세션은 움직이지 않는다.
  assert.equal(animating(view([session({ phase: { kind: 'tool' } })], { help: true })), false);
  assert.equal(animating({ data: null }), false);
  assert.equal(animating(view([session({ phase: { kind: 'tool' } })], { filter: 'zzz-no-match' })), false);
});
